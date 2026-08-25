import { CfnOutput, Duration, RemovalPolicy, Size, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'node:path';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

export const LAUNCH_REGIONS = ['us-east-2', 'eu-central-1', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2'] as const;
export type LaunchRegion = typeof LAUNCH_REGIONS[number];
export type ManagedProduct = 'eversally' | 'nightframe';

export interface RegionalCellStackProps extends StackProps {
  product: ManagedProduct;
  environment: string;
  dataHomeRegion: LaunchRegion;
  temporaryFrameRetentionDays?: number;
  workerConcurrency?: number;
  ffmpegLayerArn?: string;
  regionalPolicyProfileJson?: string;
}

/** A private, independently deployable product × region cell. No replication or VPC is configured. */
export class RegionalCellStack extends Stack {
  constructor(scope: Construct, id: string, props: RegionalCellStackProps) {
    super(scope, id, props);
    if (!props.product || !props.environment || !LAUNCH_REGIONS.includes(props.dataHomeRegion)) throw new Error('product, environment, and an approved dataHomeRegion are required');
    if (props.env?.region && props.env.region !== props.dataHomeRegion) throw new Error('Stack region must equal dataHomeRegion');

    const prefix = `${props.product}-${props.environment}-${props.dataHomeRegion}`;
    const production = ['prod', 'production'].includes(props.environment.toLowerCase());
    if (production && !props.ffmpegLayerArn) throw new Error('Production regional cells require a region-local FFMPEG_LAYER_ARN');
    if (production && !props.regionalPolicyProfileJson) throw new Error('Production regional cells require REGIONAL_POLICY_PROFILE_JSON');
    const regionalPolicyProfile = props.regionalPolicyProfileJson || JSON.stringify({ version: 'development-policy-v1', highRiskModerationLabels: [], ageSensitiveUpperBound: 18 });
    try {
      const parsed = JSON.parse(regionalPolicyProfile);
      if (typeof parsed.version !== 'string' || !parsed.version.trim() || !Array.isArray(parsed.highRiskModerationLabels) || typeof parsed.ageSensitiveUpperBound !== 'number') throw new Error();
    } catch { throw new Error('REGIONAL_POLICY_PROFILE_JSON must define version, highRiskModerationLabels, and ageSensitiveUpperBound'); }
    const removalPolicy = production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    Tags.of(this).add('Product', props.product);
    Tags.of(this).add('Environment', props.environment);
    Tags.of(this).add('DataHomeRegion', props.dataHomeRegion);

    const contentKey = new kms.Key(this, 'RegionalContentKey', { alias: `alias/${prefix}-content`, enableKeyRotation: true, removalPolicy });
    contentKey.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal('s3.amazonaws.com')], actions: ['kms:GenerateDataKey', 'kms:Decrypt'], resources: ['*'], conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }));
    const messagingKey = new kms.Key(this, 'RegionalMessagingKey', { alias: `alias/${prefix}-messaging`, enableKeyRotation: true, removalPolicy });
    const bucket = (name: string, temporary = false) => new s3.Bucket(this, `${name}Bucket`, {
      bucketName: `${prefix}-${name}-${this.account}`.toLowerCase(), blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      eventBridgeEnabled: name === 'quarantine',
      encryption: s3.BucketEncryption.KMS, encryptionKey: contentKey, enforceSSL: true, versioned: production && !temporary,
      removalPolicy, autoDeleteObjects: !production,
      lifecycleRules: temporary ? [{ id: 'BoundedRetention', expiration: Duration.days(props.temporaryFrameRetentionDays || 7), abortIncompleteMultipartUploadAfter: Duration.days(1) }] : undefined
    });
    const quarantine = bucket('quarantine');
    const originals = bucket('originals');
    const privateDerivatives = bucket('private-derivatives');
    const publicDerivatives = bucket('public-derivatives');
    const exportsBucket = bucket('exports');
    const scanFrames = bucket('scan-frames', true);
    const evidence = bucket('restricted-evidence');
    const regionalSecrets = new secretsmanager.Secret(this, 'RegionalProviderSecrets', { secretName: `${prefix}/providers`, encryptionKey: contentKey });

    const table = (name: string, partitionKey: string, stream?: dynamodb.StreamViewType) => new dynamodb.Table(this, `${name}Table`, {
      tableName: `${prefix}-${name}`, partitionKey: { name: partitionKey, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED, encryptionKey: contentKey,
      timeToLiveAttribute: 'expiresAtEpochSeconds',
      pointInTimeRecoverySpecification: production ? { pointInTimeRecoveryEnabled: true } : undefined,
      deletionProtection: production, removalPolicy, stream
    });
    const metadata = table('metadata', 'PK');
    const scanJobs = table('scan-jobs', 'id', dynamodb.StreamViewType.NEW_IMAGE);
    const auditUsage = table('audit-usage', 'PK', dynamodb.StreamViewType.NEW_IMAGE);

    const dlq = new sqs.Queue(this, 'ScanDlq', { queueName: `${prefix}-scan-dlq`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, retentionPeriod: Duration.days(14) });
    const queue = new sqs.Queue(this, 'ScanQueue', { queueName: `${prefix}-scan`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, visibilityTimeout: Duration.minutes(15), receiveMessageWaitTime: Duration.seconds(20), deadLetterQueue: { queue: dlq, maxReceiveCount: 5 } });
    const videoDlq = new sqs.Queue(this, 'VideoProcessingDlq', { queueName: `${prefix}-video-processing-dlq`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, retentionPeriod: Duration.days(14) });
    const videoQueue = new sqs.Queue(this, 'VideoProcessingQueue', { queueName: `${prefix}-video-processing`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, visibilityTimeout: Duration.minutes(15), receiveMessageWaitTime: Duration.seconds(20), deadLetterQueue: { queue: videoDlq, maxReceiveCount: 5 } });
    const imageIngestDlq = new sqs.Queue(this, 'ImageIngestDlq', { queueName: `${prefix}-image-ingest-dlq`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, retentionPeriod: Duration.days(14) });
    const imageIngestQueue = new sqs.Queue(this, 'ImageIngestQueue', { queueName: `${prefix}-image-ingest`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, visibilityTimeout: Duration.minutes(5), receiveMessageWaitTime: Duration.seconds(20), deadLetterQueue: { queue: imageIngestDlq, maxReceiveCount: 5 } });
    const publicationDlq = new sqs.Queue(this, 'PublicDeliveryDlq', { queueName: `${prefix}-public-delivery-dlq`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, retentionPeriod: Duration.days(14) });
    const publicationQueue = new sqs.Queue(this, 'PublicDeliveryQueue', { queueName: `${prefix}-public-delivery`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, visibilityTimeout: Duration.minutes(5), receiveMessageWaitTime: Duration.seconds(20), deadLetterQueue: { queue: publicationDlq, maxReceiveCount: 5 } });
    const scanOutboxFailureQueue = new sqs.Queue(this, 'ScanOutboxFailureQueue', { queueName: `${prefix}-scan-outbox-failures`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, retentionPeriod: Duration.days(14) });
    new events.Rule(this, 'QuarantineImageCreated', { eventPattern: { source: ['aws.s3'], detailType: ['Object Created'], detail: { bucket: { name: [quarantine.bucketName] }, object: { key: [{ prefix: 'images/' }] } } } as events.EventPattern, targets: [new eventTargets.SqsQueue(imageIngestQueue)] });
    new events.Rule(this, 'QuarantineVideoCreated', { eventPattern: { source: ['aws.s3'], detailType: ['Object Created'], detail: { bucket: { name: [quarantine.bucketName] }, object: { key: [{ prefix: 'videos/' }] } } } as events.EventPattern, targets: [new eventTargets.SqsQueue(videoQueue)] });
    new events.Rule(this, 'PublicDerivativeEligible', { eventPattern: { source: [`${props.product}.regional-media`], detailType: ['Regional Public Derivative Eligible'], detail: { product: [props.product], environment: [props.environment], dataHomeRegion: [props.dataHomeRegion] } }, targets: [new eventTargets.SqsQueue(publicationQueue, { message: events.RuleTargetInput.fromEventPath('$.detail') })] });

    const worker = new lambdaNodejs.NodejsFunction(this, 'ScanDispatcher', {
      functionName: `${prefix}-scan-dispatcher`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.seconds(30), memorySize: 512,
      reservedConcurrentExecutions: props.workerConcurrency || 20,
      entry: path.join(__dirname, '../../apps/api/src/regionalScanHandler.ts'),
      bundling: { externalModules: ['@aws-sdk/client-rekognition'] },
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, SCAN_PROFILE: 'REKOGNITION_FRAME_V1', VIDEO_FRAME_INTERVAL_SECONDS: '3', SCAN_QUEUE_URL: queue.queueUrl, SCAN_JOBS_TABLE: scanJobs.tableName, METADATA_TABLE: metadata.tableName, AUDIT_USAGE_TABLE: auditUsage.tableName, REGIONAL_POLICY_PROFILE: regionalPolicyProfile, QUARANTINE_BUCKET: quarantine.bucketName, SCAN_FRAMES_BUCKET: scanFrames.bucketName }
    });
    queue.grantConsumeMessages(worker);
    worker.addEventSource(new lambdaEventSources.SqsEventSource(queue, { batchSize: 1, reportBatchItemFailures: true }));
    quarantine.grantRead(worker);
    originals.grantReadWrite(worker);
    privateDerivatives.grantReadWrite(worker);
    scanFrames.grantReadWrite(worker);
    evidence.grantReadWrite(worker);
    scanJobs.grantReadWriteData(worker);
    metadata.grantReadWriteData(worker);
    auditUsage.grantWriteData(worker);
    regionalSecrets.grantRead(worker);
    worker.addToRolePolicy(new iam.PolicyStatement({ actions: ['rekognition:DetectModerationLabels', 'rekognition:DetectFaces'], resources: ['*'], conditions: { StringEquals: { 'aws:RequestedRegion': props.dataHomeRegion } } }));
    const scanOutboxWorker = new lambdaNodejs.NodejsFunction(this, 'ScanOutboxWorker', {
      functionName: `${prefix}-scan-outbox`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(2), memorySize: 512,
      reservedConcurrentExecutions: props.workerConcurrency || 20,
      entry: path.join(__dirname, '../../apps/api/src/regionalScanOutboxHandler.ts'),
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, SCAN_JOBS_TABLE: scanJobs.tableName, SCAN_QUEUE_URL: queue.queueUrl }
    });
    scanOutboxWorker.addEventSource(new lambdaEventSources.DynamoEventSource(scanJobs, { startingPosition: lambda.StartingPosition.LATEST, batchSize: 10, bisectBatchOnError: true, reportBatchItemFailures: true, retryAttempts: 10, onFailure: new lambdaEventSources.SqsDlq(scanOutboxFailureQueue) }));
    scanJobs.grantReadWriteData(scanOutboxWorker);
    queue.grantSendMessages(scanOutboxWorker);

    const ffmpegLayer = props.ffmpegLayerArn ? lambda.LayerVersion.fromLayerVersionArn(this, 'FfmpegLayer', props.ffmpegLayerArn) : undefined;
    const videoWorker = new lambdaNodejs.NodejsFunction(this, 'VideoProcessingWorker', {
      functionName: `${prefix}-video-processing`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(14), memorySize: 4096,
      ephemeralStorageSize: Size.mebibytes(10_240),
      reservedConcurrentExecutions: Math.max(1, Math.floor((props.workerConcurrency || 20) / 4)),
      entry: path.join(__dirname, '../../apps/api/src/regionalVideoHandler.ts'), layers: ffmpegLayer ? [ffmpegLayer] : undefined,
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, SCAN_PROFILE: 'REKOGNITION_FRAME_V1', VIDEO_PROCESSING_QUEUE_URL: videoQueue.queueUrl, SCAN_JOBS_TABLE: scanJobs.tableName, METADATA_TABLE: metadata.tableName, QUARANTINE_BUCKET: quarantine.bucketName, SCAN_FRAMES_BUCKET: scanFrames.bucketName, FFPROBE_PATH: '/opt/bin/ffprobe', FFMPEG_PATH: '/opt/bin/ffmpeg' }
    });
    videoWorker.addEventSource(new lambdaEventSources.SqsEventSource(videoQueue, { batchSize: 1, reportBatchItemFailures: true }));
    videoQueue.grantConsumeMessages(videoWorker);
    quarantine.grantRead(videoWorker);
    scanFrames.grantWrite(videoWorker);
    scanJobs.grantReadWriteData(videoWorker);
    metadata.grantReadWriteData(videoWorker);

    const imageIngestWorker = new lambdaNodejs.NodejsFunction(this, 'ImageIngestWorker', {
      functionName: `${prefix}-image-ingest`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(2), memorySize: 2048,
      reservedConcurrentExecutions: props.workerConcurrency || 20, entry: path.join(__dirname, '../../apps/api/src/regionalImageIngestHandler.ts'),
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, IMAGE_INGEST_QUEUE_URL: imageIngestQueue.queueUrl, SCAN_JOBS_TABLE: scanJobs.tableName, METADATA_TABLE: metadata.tableName, QUARANTINE_BUCKET: quarantine.bucketName }
    });
    imageIngestWorker.addEventSource(new lambdaEventSources.SqsEventSource(imageIngestQueue, { batchSize: 1, reportBatchItemFailures: true }));
    imageIngestQueue.grantConsumeMessages(imageIngestWorker); quarantine.grantRead(imageIngestWorker); scanJobs.grantReadWriteData(imageIngestWorker); metadata.grantReadWriteData(imageIngestWorker);

    const userPool = new cognito.UserPool(this, 'RegionalUserPool', { userPoolName: `${prefix}-users`, selfSignUpEnabled: true, signInAliases: { email: true }, removalPolicy });
    const userPoolClient = userPool.addClient('RegionalWebClient', { userPoolClientName: `${prefix}-web`, authFlows: { userSrp: true }, preventUserExistenceErrors: true });
    const api = new apigw.RestApi(this, 'RegionalApi', { restApiName: `${prefix}-api`, endpointTypes: [apigw.EndpointType.REGIONAL] });
    api.root.addResource('health').addMethod('GET', new apigw.MockIntegration({ integrationResponses: [{ statusCode: '200', responseTemplates: { 'application/json': '{"status":"ok"}' } }], requestTemplates: { 'application/json': '{"statusCode": 200}' } }), { methodResponses: [{ statusCode: '200' }] });
    const uploadWorker = new lambdaNodejs.NodejsFunction(this, 'RegionalUploadWorker', {
      functionName: `${prefix}-upload-api`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.seconds(15), memorySize: 512,
      reservedConcurrentExecutions: props.workerConcurrency || 20,
      entry: path.join(__dirname, '../../apps/api/src/regionalUploadHandler.ts'),
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, METADATA_TABLE: metadata.tableName, AUDIT_USAGE_TABLE: auditUsage.tableName, QUARANTINE_BUCKET: quarantine.bucketName }
    });
    const regionalAuthorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'RegionalApiAuthorizer', { cognitoUserPools: [userPool] });
    api.root.addResource('uploads').addMethod('POST', new apigw.LambdaIntegration(uploadWorker), { authorizer: regionalAuthorizer, authorizationType: apigw.AuthorizationType.COGNITO });
    quarantine.grantPut(uploadWorker);
    metadata.grantReadWriteData(uploadWorker);
    auditUsage.grantWriteData(uploadWorker);
    const webAcl = new wafv2.CfnWebACL(this, 'RegionalWebAcl', {
      name: `${prefix}-api`, scope: 'REGIONAL', defaultAction: { allow: {} }, visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${prefix}-waf`, sampledRequestsEnabled: true },
      rules: [{ name: 'AWSManagedCommon', priority: 1, overrideAction: { none: {} }, statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } }, visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${prefix}-common`, sampledRequestsEnabled: true } }]
    });
    new wafv2.CfnWebACLAssociation(this, 'RegionalWebAclAssociation', { resourceArn: api.deploymentStage.stageArn, webAclArn: webAcl.attrArn });

    const migrationDefinition = sfn.Chain.start(new sfn.Pass(this, 'Preparing', { result: sfn.Result.fromString('PREPARING'), resultPath: '$.state' }))
      .next(new sfn.Pass(this, 'CopyingAuthorizedTenantData', { result: sfn.Result.fromString('COPYING'), resultPath: '$.state' }))
      .next(new sfn.Pass(this, 'RescanningInDestination', { result: sfn.Result.fromString('RESCANNING'), resultPath: '$.state' }))
      .next(new sfn.Pass(this, 'VerifyingIntegrity', { result: sfn.Result.fromString('VERIFYING'), resultPath: '$.state' }))
      .next(new sfn.Succeed(this, 'MigrationComplete'));
    const migration = new sfn.StateMachine(this, 'DataHomeMigration', { stateMachineName: `${prefix}-data-home-migration`, definitionBody: sfn.DefinitionBody.fromChainable(migrationDefinition), timeout: Duration.days(7) });
    metadata.grantReadWriteData(migration);
    new events.Rule(this, 'CellOperationsRule', { ruleName: `${prefix}-operations`, eventPattern: { source: [`${props.product}.regional-media`], detail: { product: [props.product], environment: [props.environment], dataHomeRegion: [props.dataHomeRegion] } }, targets: [new eventTargets.SqsQueue(queue)] });

    const distribution = new cloudfront.Distribution(this, 'PublicDelivery', {
      comment: `${prefix}-public`, defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(publicDerivatives), viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS }
    });
    const revocationWorker = new lambdaNodejs.NodejsFunction(this, 'DeliveryRevocationWorker', {
      functionName: `${prefix}-delivery-revocation`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(2), memorySize: 512,
      entry: path.join(__dirname, '../../apps/api/src/regionalDeliveryRevocationHandler.ts'),
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, AUDIT_USAGE_TABLE: auditUsage.tableName, PUBLIC_DISTRIBUTION_ID: distribution.distributionId }
    });
    revocationWorker.addEventSource(new lambdaEventSources.DynamoEventSource(auditUsage, { startingPosition: lambda.StartingPosition.LATEST, batchSize: 10, bisectBatchOnError: true, retryAttempts: 5 }));
    auditUsage.grantReadWriteData(revocationWorker);
    revocationWorker.addToRolePolicy(new iam.PolicyStatement({ actions: ['cloudfront:CreateInvalidation'], resources: [`arn:${this.partition}:cloudfront::${this.account}:distribution/${distribution.distributionId}`] }));
    const publicationWorker = new lambdaNodejs.NodejsFunction(this, 'PublicDeliveryWorker', {
      functionName: `${prefix}-public-delivery`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(2), memorySize: 1024,
      reservedConcurrentExecutions: Math.max(1, Math.floor((props.workerConcurrency || 20) / 2)),
      entry: path.join(__dirname, '../../apps/api/src/regionalPublicDeliveryHandler.ts'),
      environment: {
        PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion,
        METADATA_TABLE: metadata.tableName, SCAN_JOBS_TABLE: scanJobs.tableName, AUDIT_USAGE_TABLE: auditUsage.tableName,
        PRIVATE_DERIVATIVES_BUCKET: privateDerivatives.bucketName, PUBLIC_DERIVATIVES_BUCKET: publicDerivatives.bucketName
      }
    });
    publicationWorker.addEventSource(new lambdaEventSources.SqsEventSource(publicationQueue, { batchSize: 5, reportBatchItemFailures: true }));
    publicationQueue.grantConsumeMessages(publicationWorker);
    privateDerivatives.grantRead(publicationWorker);
    publicDerivatives.grantReadWrite(publicationWorker);
    metadata.grantReadWriteData(publicationWorker);
    scanJobs.grantReadData(publicationWorker);
    auditUsage.grantReadWriteData(publicationWorker);
    const dashboard = new cloudwatch.Dashboard(this, 'CellDashboard', { dashboardName: `${prefix}-operations` });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Regional scan queue', left: [queue.metricApproximateNumberOfMessagesVisible(), dlq.metricApproximateNumberOfMessagesVisible()] }),
      new cloudwatch.GraphWidget({ title: 'Scan success and failures', left: [worker.metricInvocations(), worker.metricErrors()] }),
      new cloudwatch.GraphWidget({ title: 'Ingest and frame processing latency', left: [worker.metricDuration(), videoWorker.metricDuration()] })
    );
    new cloudwatch.Alarm(this, 'ScanDlqAlarm', { alarmName: `${prefix}-scan-dlq-depth`, metric: dlq.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1 });
    new cloudwatch.Alarm(this, 'ImageIngestDlqAlarm', { alarmName: `${prefix}-image-ingest-dlq-depth`, metric: imageIngestDlq.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1 });
    new cloudwatch.Alarm(this, 'VideoProcessingDlqAlarm', { alarmName: `${prefix}-video-processing-dlq-depth`, metric: videoDlq.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1 });
    new cloudwatch.Alarm(this, 'PublicDeliveryDlqAlarm', { alarmName: `${prefix}-public-delivery-dlq-depth`, metric: publicationDlq.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1 });
    new cloudwatch.Alarm(this, 'ScanOutboxFailureAlarm', { alarmName: `${prefix}-scan-outbox-failures`, metric: scanOutboxFailureQueue.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1 });
    new cloudwatch.Alarm(this, 'ScanQueueAgeAlarm', { alarmName: `${prefix}-scan-oldest-message`, metric: queue.metricApproximateAgeOfOldestMessage(), threshold: Duration.minutes(10).toSeconds(), evaluationPeriods: 2 });
    new cloudwatch.Alarm(this, 'VideoQueueAgeAlarm', { alarmName: `${prefix}-video-oldest-message`, metric: videoQueue.metricApproximateAgeOfOldestMessage(), threshold: Duration.minutes(20).toSeconds(), evaluationPeriods: 2 });
    new cloudwatch.Alarm(this, 'PublicDeliveryQueueAgeAlarm', { alarmName: `${prefix}-public-delivery-oldest-message`, metric: publicationQueue.metricApproximateAgeOfOldestMessage(), threshold: Duration.minutes(10).toSeconds(), evaluationPeriods: 2 });
    new cloudwatch.Alarm(this, 'WorkerConcurrencyAlarm', { alarmName: `${prefix}-worker-concurrency-70-percent`, metric: worker.metric('ConcurrentExecutions'), threshold: Math.max(1, Math.floor((props.workerConcurrency || 20) * 0.7)), evaluationPeriods: 3 });
    new logs.LogGroup(this, 'AuditLogGroup', { logGroupName: `/ubeeq/${prefix}/audit`, retention: production ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_WEEK, removalPolicy });

    new CfnOutput(this, 'CellIdentity', { value: prefix });
    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'PublicDistributionDomain', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'ScanQueueUrl', { value: queue.queueUrl });
    new CfnOutput(this, 'VideoProcessingQueueUrl', { value: videoQueue.queueUrl });
    new CfnOutput(this, 'ImageIngestQueueUrl', { value: imageIngestQueue.queueUrl });
    new CfnOutput(this, 'PublicDeliveryQueueUrl', { value: publicationQueue.queueUrl });
    new CfnOutput(this, 'QuarantineBucketName', { value: quarantine.bucketName });
    new CfnOutput(this, 'ExportsBucketName', { value: exportsBucket.bucketName });
    new CfnOutput(this, 'MigrationStateMachineArn', { value: migration.stateMachineArn });
  }
}
