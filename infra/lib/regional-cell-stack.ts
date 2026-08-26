import { CfnOutput, Duration, RemovalPolicy, Size, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'node:path';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
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
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
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
  globalUserPoolArn?: string;
  globalRoutingTableName?: string;
  globalRoutingRegion?: string;
  operationsAlarmEmail?: string;
  configurationVersion?: string;
  monthlyMediaBytesLimit?: number;
  monthlyUploadLimit?: number;
  allowedBrowserOrigins?: string[];
  apiDomainName?: string;
  publicDomainName?: string;
  hostedZoneId?: string;
  hostedZoneName?: string;
  apiCertificateArn?: string;
  publicCertificateArn?: string;
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
    if (production && !props.globalUserPoolArn) throw new Error('Production regional cells require GLOBAL_USER_POOL_ARN');
    if (production && !props.globalRoutingTableName) throw new Error('Production regional cells require GLOBAL_ROUTING_TABLE');
    if (production && !props.operationsAlarmEmail) throw new Error('Production regional cells require OPERATIONS_ALARM_EMAIL');
    if (production && !props.configurationVersion) throw new Error('Production regional cells require CONFIGURATION_VERSION');
    const regionalPolicyProfile = props.regionalPolicyProfileJson || JSON.stringify({ version: 'development-policy-v1', highRiskModerationLabels: [], ageSensitiveUpperBound: 18 });
    try {
      const parsed = JSON.parse(regionalPolicyProfile);
      if (typeof parsed.version !== 'string' || !parsed.version.trim() || !Array.isArray(parsed.highRiskModerationLabels) || typeof parsed.ageSensitiveUpperBound !== 'number') throw new Error();
    } catch { throw new Error('REGIONAL_POLICY_PROFILE_JSON must define version, highRiskModerationLabels, and ageSensitiveUpperBound'); }
    const removalPolicy = production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    Tags.of(this).add('Product', props.product);
    Tags.of(this).add('Environment', props.environment);
    Tags.of(this).add('DataHomeRegion', props.dataHomeRegion);
    Tags.of(this).add('ConfigurationVersion', props.configurationVersion || 'development');

    // Boundary is defense in depth for application roles. Global control-plane
    // and CDN calls are explicitly exempt because those services do not expose
    // regional endpoints compatible with aws:RequestedRegion.
    const regionalBoundary = new iam.ManagedPolicy(this, 'RegionalWorkloadBoundary', { statements: [
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['*'], resources: ['*'] }),
      new iam.PolicyStatement({ effect: iam.Effect.DENY, notActions: ['cloudfront:*', 'iam:*', 'route53:*', 'support:*', 'organizations:*'], resources: ['*'], conditions: { StringNotEquals: { 'aws:RequestedRegion': props.dataHomeRegion } } })
    ] });
    iam.PermissionsBoundary.of(this).apply(regionalBoundary);

    const contentKey = new kms.Key(this, 'RegionalContentKey', { alias: `alias/${prefix}-content`, enableKeyRotation: true, removalPolicy });
    contentKey.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal('s3.amazonaws.com')], actions: ['kms:GenerateDataKey', 'kms:Decrypt'], resources: ['*'], conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }));
    const messagingKey = new kms.Key(this, 'RegionalMessagingKey', { alias: `alias/${prefix}-messaging`, enableKeyRotation: true, removalPolicy });
    const retention: Record<string, number> = { quarantine: 30, originals: 2555, 'private-derivatives': 365, 'public-derivatives': 365, exports: 7, 'restricted-evidence': 2555 };
    const bucket = (name: string, temporary = false) => new s3.Bucket(this, `${name}Bucket`, {
      bucketName: `${prefix}-${name}-${this.account}`.toLowerCase(), blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      eventBridgeEnabled: name === 'quarantine',
      encryption: s3.BucketEncryption.KMS, encryptionKey: contentKey, enforceSSL: true, versioned: production && !temporary,
      objectLockEnabled: production && name === 'restricted-evidence', objectLockDefaultRetention: production && name === 'restricted-evidence' ? s3.ObjectLockRetention.governance(Duration.days(2555)) : undefined,
      removalPolicy, autoDeleteObjects: !production,
      lifecycleRules: [{ id: 'BoundedRetention', expiration: Duration.days(temporary ? props.temporaryFrameRetentionDays || 7 : retention[name]), noncurrentVersionExpiration: production && !temporary ? Duration.days(30) : undefined, abortIncompleteMultipartUploadAfter: Duration.days(1) }]
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
    const billingLedger = new dynamodb.Table(this, 'BillingLedgerTable', {
      tableName: `${prefix}-billing-ledger`, partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED, encryptionKey: contentKey,
      pointInTimeRecoverySpecification: production ? { pointInTimeRecoveryEnabled: true } : undefined,
      deletionProtection: production, removalPolicy, stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES
    });
    billingLedger.addGlobalSecondaryIndex({ indexName: 'account-period-index', partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    const auditLogGroup = new logs.LogGroup(this, 'AuditLogGroup', { logGroupName: `/ubeeq/${prefix}/audit`, retention: production ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_WEEK, removalPolicy });

    const backupVault = new backup.BackupVault(this, 'RegionalBackupVault', {
      backupVaultName: `${prefix}-recovery`, encryptionKey: contentKey, removalPolicy,
      ...(production ? { lockConfiguration: { minRetention: Duration.days(35), maxRetention: Duration.days(370) } } : {})
    });
    const backupPlan = new backup.BackupPlan(this, 'RegionalBackupPlan', { backupPlanName: `${prefix}-recovery` });
    backupPlan.addRule(new backup.BackupPlanRule({ ruleName: 'Daily35Day', backupVault, scheduleExpression: events.Schedule.cron({ minute: '0', hour: '3' }), deleteAfter: Duration.days(35) }));
    backupPlan.addRule(new backup.BackupPlanRule({ ruleName: 'MonthlyOneYear', backupVault, scheduleExpression: events.Schedule.cron({ minute: '0', hour: '4', day: '1' }), deleteAfter: Duration.days(365), moveToColdStorageAfter: Duration.days(30) }));
    backupPlan.addSelection('RegionalDurableData', { resources: [
      backup.BackupResource.fromDynamoDbTable(metadata), backup.BackupResource.fromDynamoDbTable(scanJobs), backup.BackupResource.fromDynamoDbTable(auditUsage),
      ...[quarantine, originals, privateDerivatives, publicDerivatives, exportsBucket, evidence].map(({ bucketArn }) => backup.BackupResource.fromArn(bucketArn))
    ] });

    const dlq = new sqs.Queue(this, 'ScanDlq', { queueName: `${prefix}-scan-dlq.fifo`, fifo: true, contentBasedDeduplication: true, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, retentionPeriod: Duration.days(14) });
    const queue = new sqs.Queue(this, 'ScanQueue', { queueName: `${prefix}-scan.fifo`, fifo: true, contentBasedDeduplication: true, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, visibilityTimeout: Duration.minutes(15), receiveMessageWaitTime: Duration.seconds(20), deadLetterQueue: { queue: dlq, maxReceiveCount: 5 } });
    const videoDlq = new sqs.Queue(this, 'VideoProcessingDlq', { queueName: `${prefix}-video-processing-dlq`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, retentionPeriod: Duration.days(14) });
    const videoQueue = new sqs.Queue(this, 'VideoProcessingQueue', { queueName: `${prefix}-video-processing`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, visibilityTimeout: Duration.minutes(15), receiveMessageWaitTime: Duration.seconds(20), deadLetterQueue: { queue: videoDlq, maxReceiveCount: 5 } });
    const imageIngestDlq = new sqs.Queue(this, 'ImageIngestDlq', { queueName: `${prefix}-image-ingest-dlq`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, retentionPeriod: Duration.days(14) });
    const imageIngestQueue = new sqs.Queue(this, 'ImageIngestQueue', { queueName: `${prefix}-image-ingest`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, visibilityTimeout: Duration.minutes(5), receiveMessageWaitTime: Duration.seconds(20), deadLetterQueue: { queue: imageIngestDlq, maxReceiveCount: 5 } });
    const publicationDlq = new sqs.Queue(this, 'PublicDeliveryDlq', { queueName: `${prefix}-public-delivery-dlq`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, retentionPeriod: Duration.days(14) });
    const publicationQueue = new sqs.Queue(this, 'PublicDeliveryQueue', { queueName: `${prefix}-public-delivery`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, visibilityTimeout: Duration.minutes(5), receiveMessageWaitTime: Duration.seconds(20), deadLetterQueue: { queue: publicationDlq, maxReceiveCount: 5 } });
    const scanOutboxFailureQueue = new sqs.Queue(this, 'ScanOutboxFailureQueue', { queueName: `${prefix}-scan-outbox-failures`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, retentionPeriod: Duration.days(14) });
    const streamFailureQueue = new sqs.Queue(this, 'CriticalStreamFailureQueue', { queueName: `${prefix}-critical-stream-failures`, encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: messagingKey, retentionPeriod: Duration.days(14) });
    const alarmTopic = new sns.Topic(this, 'OperationsAlarmTopic', { topicName: `${prefix}-operations`, masterKey: messagingKey });
    messagingKey.grantEncryptDecrypt(new iam.ServicePrincipal('cloudwatch.amazonaws.com'));
    if (props.operationsAlarmEmail) alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.operationsAlarmEmail));
    new events.Rule(this, 'QuarantineImageCreated', { eventPattern: { source: ['aws.s3'], detailType: ['Object Created'], detail: { bucket: { name: [quarantine.bucketName] }, object: { key: [{ prefix: 'images/' }] } } } as events.EventPattern, targets: [new eventTargets.SqsQueue(imageIngestQueue)] });
    new events.Rule(this, 'QuarantineVideoCreated', { eventPattern: { source: ['aws.s3'], detailType: ['Object Created'], detail: { bucket: { name: [quarantine.bucketName] }, object: { key: [{ prefix: 'videos/' }] } } } as events.EventPattern, targets: [new eventTargets.SqsQueue(videoQueue)] });
    new events.Rule(this, 'PublicDerivativeEligible', { eventPattern: { source: [`${props.product}.regional-media`], detailType: ['Regional Public Derivative Eligible'], detail: { product: [props.product], environment: [props.environment], dataHomeRegion: [props.dataHomeRegion] } }, targets: [new eventTargets.SqsQueue(publicationQueue, { message: events.RuleTargetInput.fromEventPath('$.detail') })] });
    const redriveWorker = new lambdaNodejs.NodejsFunction(this, 'DlqRedriveWorker', {
      functionName: `${prefix}-dlq-redrive`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(5), memorySize: 256,
      entry: path.join(__dirname, '../../apps/api/src/regionalDlqRedriveHandler.ts'),
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, AUDIT_USAGE_TABLE: auditUsage.tableName, REDRIVE_QUEUES_JSON: JSON.stringify({ scan: { source: dlq.queueUrl, destination: queue.queueUrl }, image: { source: imageIngestDlq.queueUrl, destination: imageIngestQueue.queueUrl }, video: { source: videoDlq.queueUrl, destination: videoQueue.queueUrl }, publication: { source: publicationDlq.queueUrl, destination: publicationQueue.queueUrl } }) }
    });
    for (const source of [dlq, imageIngestDlq, videoDlq, publicationDlq]) source.grantConsumeMessages(redriveWorker);
    for (const destination of [queue, imageIngestQueue, videoQueue, publicationQueue]) destination.grantSendMessages(redriveWorker);
    auditUsage.grantWriteData(redriveWorker);

    const worker = new lambdaNodejs.NodejsFunction(this, 'ScanDispatcher', {
      functionName: `${prefix}-scan-dispatcher`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.seconds(30), memorySize: 512,
      reservedConcurrentExecutions: props.workerConcurrency || 20,
      entry: path.join(__dirname, '../../apps/api/src/regionalScanHandler.ts'),
      bundling: { externalModules: ['@aws-sdk/client-rekognition'] },
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, SCAN_PROFILE: 'REKOGNITION_FRAME_V1', VIDEO_FRAME_INTERVAL_SECONDS: '3', SCAN_QUEUE_URL: queue.queueUrl, SCAN_JOBS_TABLE: scanJobs.tableName, METADATA_TABLE: metadata.tableName, AUDIT_USAGE_TABLE: auditUsage.tableName, BILLING_LEDGER_TABLE: billingLedger.tableName, REGIONAL_POLICY_PROFILE: regionalPolicyProfile, QUARANTINE_BUCKET: quarantine.bucketName, SCAN_FRAMES_BUCKET: scanFrames.bucketName }
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
    billingLedger.grantReadWriteData(worker);
    regionalSecrets.grantRead(worker);
    worker.addToRolePolicy(new iam.PolicyStatement({ actions: ['rekognition:DetectModerationLabels', 'rekognition:DetectFaces'], resources: ['*'], conditions: { StringEquals: { 'aws:RequestedRegion': props.dataHomeRegion } } }));
    const scanOutboxWorker = new lambdaNodejs.NodejsFunction(this, 'ScanOutboxWorker', {
      functionName: `${prefix}-scan-outbox`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(2), memorySize: 512,
      reservedConcurrentExecutions: props.workerConcurrency || 20,
      entry: path.join(__dirname, '../../apps/api/src/regionalScanOutboxHandler.ts'),
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, SCAN_JOBS_TABLE: scanJobs.tableName, METADATA_TABLE: metadata.tableName, SCAN_QUEUE_URL: queue.queueUrl }
    });
    scanOutboxWorker.addEventSource(new lambdaEventSources.DynamoEventSource(scanJobs, { startingPosition: lambda.StartingPosition.LATEST, batchSize: 10, bisectBatchOnError: true, reportBatchItemFailures: true, retryAttempts: 10, onFailure: new lambdaEventSources.SqsDlq(scanOutboxFailureQueue) }));
    scanJobs.grantReadWriteData(scanOutboxWorker);
    metadata.grantReadData(scanOutboxWorker);
    queue.grantSendMessages(scanOutboxWorker);

    const ffmpegLayer = props.ffmpegLayerArn ? lambda.LayerVersion.fromLayerVersionArn(this, 'FfmpegLayer', props.ffmpegLayerArn) : undefined;
    const videoWorker = new lambdaNodejs.NodejsFunction(this, 'VideoProcessingWorker', {
      functionName: `${prefix}-video-processing`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(14), memorySize: 4096,
      ephemeralStorageSize: Size.mebibytes(10_240),
      reservedConcurrentExecutions: Math.max(1, Math.floor((props.workerConcurrency || 20) / 4)),
      entry: path.join(__dirname, '../../apps/api/src/regionalVideoHandler.ts'), layers: ffmpegLayer ? [ffmpegLayer] : undefined,
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, SCAN_PROFILE: 'REKOGNITION_FRAME_V1', VIDEO_PROCESSING_QUEUE_URL: videoQueue.queueUrl, SCAN_JOBS_TABLE: scanJobs.tableName, METADATA_TABLE: metadata.tableName, BILLING_LEDGER_TABLE: billingLedger.tableName, QUARANTINE_BUCKET: quarantine.bucketName, SCAN_FRAMES_BUCKET: scanFrames.bucketName, FFPROBE_PATH: '/opt/bin/ffprobe', FFMPEG_PATH: '/opt/bin/ffmpeg' }
    });
    videoWorker.addEventSource(new lambdaEventSources.SqsEventSource(videoQueue, { batchSize: 1, reportBatchItemFailures: true }));
    videoQueue.grantConsumeMessages(videoWorker);
    quarantine.grantRead(videoWorker);
    scanFrames.grantWrite(videoWorker);
    scanJobs.grantReadWriteData(videoWorker);
    metadata.grantReadWriteData(videoWorker);
    billingLedger.grantReadWriteData(videoWorker);

    const imageIngestWorker = new lambdaNodejs.NodejsFunction(this, 'ImageIngestWorker', {
      functionName: `${prefix}-image-ingest`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(2), memorySize: 2048,
      reservedConcurrentExecutions: props.workerConcurrency || 20, entry: path.join(__dirname, '../../apps/api/src/regionalImageIngestHandler.ts'),
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, IMAGE_INGEST_QUEUE_URL: imageIngestQueue.queueUrl, SCAN_JOBS_TABLE: scanJobs.tableName, METADATA_TABLE: metadata.tableName, BILLING_LEDGER_TABLE: billingLedger.tableName, QUARANTINE_BUCKET: quarantine.bucketName, ORIGINALS_BUCKET: originals.bucketName, PRIVATE_DERIVATIVES_BUCKET: privateDerivatives.bucketName }
    });
    imageIngestWorker.addEventSource(new lambdaEventSources.SqsEventSource(imageIngestQueue, { batchSize: 1, reportBatchItemFailures: true }));
    imageIngestQueue.grantConsumeMessages(imageIngestWorker); quarantine.grantRead(imageIngestWorker); originals.grantPut(imageIngestWorker); privateDerivatives.grantPut(imageIngestWorker); scanJobs.grantReadWriteData(imageIngestWorker); metadata.grantReadWriteData(imageIngestWorker); billingLedger.grantReadWriteData(imageIngestWorker);

    const fallbackUserPool = props.globalUserPoolArn ? undefined : new cognito.UserPool(this, 'DevelopmentIdentity', { selfSignUpEnabled: false, removalPolicy });
    const userPool = props.globalUserPoolArn ? cognito.UserPool.fromUserPoolArn(this, 'GlobalIdentity', props.globalUserPoolArn) : fallbackUserPool!;
    const apiAccessLogs = new logs.LogGroup(this, 'RegionalApiAccessLogs', { logGroupName: `/ubeeq/${prefix}/api-access`, retention: production ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_WEEK, removalPolicy });
    const allowedOrigins = props.allowedBrowserOrigins?.length ? props.allowedBrowserOrigins : production ? [] : ['http://localhost:5174', 'https://fanadmin.top:5174'];
    if (production && !allowedOrigins.length) throw new Error('Production regional cells require ALLOWED_BROWSER_ORIGINS');
    const api = new apigw.RestApi(this, 'RegionalApi', {
      restApiName: `${prefix}-api`, endpointTypes: [apigw.EndpointType.REGIONAL],
      deployOptions: { accessLogDestination: new apigw.LogGroupLogDestination(apiAccessLogs), accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(), metricsEnabled: true, tracingEnabled: true, throttlingRateLimit: 100, throttlingBurstLimit: 200 },
      defaultCorsPreflightOptions: { allowOrigins: allowedOrigins, allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Authorization', 'Content-Type'], maxAge: Duration.hours(1) }
    });
    api.root.addResource('health').addMethod('GET', new apigw.MockIntegration({ integrationResponses: [{ statusCode: '200', responseTemplates: { 'application/json': '{"status":"ok"}' } }], requestTemplates: { 'application/json': '{"statusCode": 200}' } }), { methodResponses: [{ statusCode: '200' }] });
    const uploadWorker = new lambdaNodejs.NodejsFunction(this, 'RegionalUploadWorker', {
      functionName: `${prefix}-upload-api`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.seconds(15), memorySize: 512,
      reservedConcurrentExecutions: props.workerConcurrency || 20,
      entry: path.join(__dirname, '../../apps/api/src/regionalUploadHandler.ts'),
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, METADATA_TABLE: metadata.tableName, AUDIT_USAGE_TABLE: auditUsage.tableName, QUARANTINE_BUCKET: quarantine.bucketName, MONTHLY_MEDIA_BYTES_LIMIT: String(props.monthlyMediaBytesLimit || 100 * 1024 * 1024 * 1024), MONTHLY_UPLOAD_LIMIT: String(props.monthlyUploadLimit || 10_000) }
    });
    const regionalAuthorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'RegionalApiAuthorizer', { cognitoUserPools: [userPool] });
    api.root.addResource('uploads').addMethod('POST', new apigw.LambdaIntegration(uploadWorker), { authorizer: regionalAuthorizer, authorizationType: apigw.AuthorizationType.COGNITO });
    quarantine.grantPut(uploadWorker);
    metadata.grantReadWriteData(uploadWorker);
    auditUsage.grantWriteData(uploadWorker);
    const provisioningWorker = new lambdaNodejs.NodejsFunction(this, 'RegionalProvisioningWorker', {
      functionName: `${prefix}-provisioning-api`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.seconds(15), memorySize: 512,
      entry: path.join(__dirname, '../../apps/api/src/regionalProvisioningHandler.ts'),
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, METADATA_TABLE: metadata.tableName }
    });
    for (const resourceName of ['spaces', 'assets']) api.root.addResource(resourceName).addMethod('POST', new apigw.LambdaIntegration(provisioningWorker), { authorizer: regionalAuthorizer, authorizationType: apigw.AuthorizationType.COGNITO });
    metadata.grantReadWriteData(provisioningWorker);
    const privacyWorker = new lambdaNodejs.NodejsFunction(this, 'RegionalPrivacyWorker', {
      functionName: `${prefix}-privacy-api`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(5), memorySize: 1024,
      entry: path.join(__dirname, '../../apps/api/src/regionalPrivacyHandler.ts'),
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, METADATA_TABLE: metadata.tableName, EXPORTS_BUCKET: exportsBucket.bucketName, QUARANTINE_BUCKET: quarantine.bucketName, ORIGINALS_BUCKET: originals.bucketName, PRIVATE_DERIVATIVES_BUCKET: privateDerivatives.bucketName, PUBLIC_DERIVATIVES_BUCKET: publicDerivatives.bucketName, EVIDENCE_BUCKET: evidence.bucketName }
    });
    const privacy = api.root.addResource('privacy');
    for (const action of ['export', 'delete']) privacy.addResource(action).addMethod('POST', new apigw.LambdaIntegration(privacyWorker), { authorizer: regionalAuthorizer, authorizationType: apigw.AuthorizationType.COGNITO });
    metadata.grantReadWriteData(privacyWorker); exportsBucket.grantReadWrite(privacyWorker);
    for (const contentBucket of [quarantine, originals, privateDerivatives, publicDerivatives, evidence]) contentBucket.grantReadWrite(privacyWorker);
    const webAcl = new wafv2.CfnWebACL(this, 'RegionalWebAcl', {
      name: `${prefix}-api`, scope: 'REGIONAL', defaultAction: { allow: {} }, visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${prefix}-waf`, sampledRequestsEnabled: true },
      rules: [{ name: 'AWSManagedCommon', priority: 1, overrideAction: { none: {} }, statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } }, visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `${prefix}-common`, sampledRequestsEnabled: true } }]
    });
    new wafv2.CfnWebACLAssociation(this, 'RegionalWebAclAssociation', { resourceArn: api.deploymentStage.stageArn, webAclArn: webAcl.attrArn });
    const healthCanary = new lambdaNodejs.NodejsFunction(this, 'RegionalHealthCanary', {
      functionName: `${prefix}-health-canary`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.seconds(10), memorySize: 256,
      entry: path.join(__dirname, '../../apps/api/src/regionalHealthCanary.ts'), environment: { CELL_HEALTH_URL: `${api.url}health`, DATA_HOME_REGION: props.dataHomeRegion }
    });
    new events.Rule(this, 'HealthCanarySchedule', { schedule: events.Schedule.rate(Duration.minutes(5)), targets: [new eventTargets.LambdaFunction(healthCanary)] });
    const residencyCanary = new lambdaNodejs.NodejsFunction(this, 'RegionalResidencyCanary', {
      functionName: `${prefix}-residency-canary`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(1), memorySize: 256,
      entry: path.join(__dirname, '../../apps/api/src/regionalResidencyCanary.ts'),
      environment: { DATA_HOME_REGION: props.dataHomeRegion, REGIONAL_BUCKETS_JSON: JSON.stringify([quarantine.bucketName, originals.bucketName, privateDerivatives.bucketName, publicDerivatives.bucketName, exportsBucket.bucketName, scanFrames.bucketName, evidence.bucketName]), REGIONAL_TABLES_JSON: JSON.stringify([metadata.tableName, scanJobs.tableName, auditUsage.tableName]) }
    });
    residencyCanary.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetBucketLocation'], resources: [quarantine, originals, privateDerivatives, publicDerivatives, exportsBucket, scanFrames, evidence].map(({ bucketArn }) => bucketArn) }));
    for (const regionalTable of [metadata, scanJobs, auditUsage]) residencyCanary.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:DescribeTable'], resources: [regionalTable.tableArn] }));
    new events.Rule(this, 'ResidencyCanarySchedule', { schedule: events.Schedule.rate(Duration.hours(1)), targets: [new eventTargets.LambdaFunction(residencyCanary)] });

    const migrationWorker = new lambdaNodejs.NodejsFunction(this, 'DataHomeMigrationWorker', {
      functionName: `${prefix}-data-home-migration`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(15), memorySize: 1024,
      entry: path.join(__dirname, '../../apps/api/src/regionalMigrationHandler.ts'), environment: { DATA_HOME_REGION: props.dataHomeRegion, METADATA_TABLE: metadata.tableName, GLOBAL_ROUTING_TABLE: props.globalRoutingTableName || 'development-routing', GLOBAL_ROUTING_REGION: props.globalRoutingRegion || 'us-east-1' }
    });
    const migrationBoundary = new iam.ManagedPolicy(this, 'MigrationWorkloadBoundary', { statements: [
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['*'], resources: ['*'] }),
      new iam.PolicyStatement({ effect: iam.Effect.DENY, notActions: ['cloudfront:*', 'iam:*', 'route53:*', 'support:*', 'organizations:*'], resources: ['*'], conditions: { StringNotEquals: { 'aws:RequestedRegion': [...LAUNCH_REGIONS, props.globalRoutingRegion || 'us-east-1'] } } })
    ] });
    iam.PermissionsBoundary.of(migrationWorker).apply(migrationBoundary);
    metadata.grantReadWriteData(migrationWorker);
    migrationWorker.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject'], resources: [`arn:${this.partition}:s3:::*/*`] }));
    migrationWorker.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'], resources: [`arn:${this.partition}:dynamodb:*:${this.account}:table/*-metadata`, `arn:${this.partition}:dynamodb:${props.globalRoutingRegion || 'us-east-1'}:${this.account}:table/${props.globalRoutingTableName || 'development-routing'}`] }));
    migrationWorker.addToRolePolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [`arn:${this.partition}:sqs:*:${this.account}:*`] }));
    const stage = (name: string, value: string) => new sfn.Pass(this, `${name}Stage`, { parameters: { 'migrationId.$': '$.migrationId', 'routingId.$': '$.routingId', 'product.$': '$.product', 'environment.$': '$.environment', 'spaceId.$': '$.spaceId', 'sourceRegion.$': '$.sourceRegion', 'destinationRegion.$': '$.destinationRegion', 'destinationMetadataTable.$': '$.destinationMetadataTable', 'destinationScanJobsTable.$': '$.destinationScanJobsTable', 'destinationScanQueueUrl.$': '$.destinationScanQueueUrl', 'objects.$': '$.objects', 'records.$': '$.records', 'rescanJobs.$': '$.rescanJobs', stage: value } });
    const invoke = (name: string) => new sfnTasks.LambdaInvoke(this, name, { lambdaFunction: migrationWorker, payloadResponseOnly: true, retryOnServiceExceptions: true });
    const migrationDefinition = sfn.Chain.start(stage('Prepare', 'PREPARE')).next(invoke('PersistManifest'))
      .next(stage('Copy', 'COPY')).next(invoke('CopyAuthorizedTenantData'))
      .next(stage('Rescan', 'RESCAN')).next(invoke('RescanInDestination'))
      .next(stage('Verify', 'VERIFY')).next(invoke('VerifyIntegrity'))
      .next(stage('Cutover', 'CUTOVER')).next(invoke('CommitDirectoryCutover'))
      .next(new sfn.Succeed(this, 'MigrationComplete'));
    const migration = new sfn.StateMachine(this, 'DataHomeMigration', { stateMachineName: `${prefix}-data-home-migration`, definitionBody: sfn.DefinitionBody.fromChainable(migrationDefinition), timeout: Duration.days(7) });
    metadata.grantReadWriteData(migration);
    new events.Rule(this, 'CellOperationsRule', { ruleName: `${prefix}-operations`, eventPattern: { source: [`${props.product}.regional-media`], detail: { product: [props.product], environment: [props.environment], dataHomeRegion: [props.dataHomeRegion] } }, targets: [new eventTargets.SqsQueue(queue, { messageGroupId: 'cell-operations' })] });

    const hostedZone = props.hostedZoneId && props.hostedZoneName ? route53.HostedZone.fromHostedZoneAttributes(this, 'CellHostedZone', { hostedZoneId: props.hostedZoneId, zoneName: props.hostedZoneName }) : undefined;
    const publicCertificate = props.publicCertificateArn ? acm.Certificate.fromCertificateArn(this, 'PublicCertificate', props.publicCertificateArn) : undefined;
    const distribution = new cloudfront.Distribution(this, 'PublicDelivery', {
      comment: `${prefix}-public`, domainNames: props.publicDomainName ? [props.publicDomainName] : undefined, certificate: publicCertificate,
      defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(publicDerivatives), viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS, cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED, responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS }
    });
    if (props.apiDomainName && props.apiCertificateArn && hostedZone) {
      const apiDomain = new apigw.DomainName(this, 'RegionalApiDomain', { domainName: props.apiDomainName, certificate: acm.Certificate.fromCertificateArn(this, 'ApiCertificate', props.apiCertificateArn), endpointType: apigw.EndpointType.REGIONAL, securityPolicy: apigw.SecurityPolicy.TLS_1_2 });
      new apigw.BasePathMapping(this, 'RegionalApiMapping', { domainName: apiDomain, restApi: api });
      new route53.ARecord(this, 'RegionalApiAlias', { zone: hostedZone, recordName: props.apiDomainName, target: route53.RecordTarget.fromAlias(new route53Targets.ApiGatewayDomain(apiDomain)) });
    }
    if (props.publicDomainName && hostedZone) new route53.ARecord(this, 'PublicDeliveryAlias', { zone: hostedZone, recordName: props.publicDomainName, target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)) });
    const revocationWorker = new lambdaNodejs.NodejsFunction(this, 'DeliveryRevocationWorker', {
      functionName: `${prefix}-delivery-revocation`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(2), memorySize: 512,
      entry: path.join(__dirname, '../../apps/api/src/regionalDeliveryRevocationHandler.ts'),
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, AUDIT_USAGE_TABLE: auditUsage.tableName, PUBLIC_DISTRIBUTION_ID: distribution.distributionId }
    });
    revocationWorker.addEventSource(new lambdaEventSources.DynamoEventSource(auditUsage, { startingPosition: lambda.StartingPosition.LATEST, batchSize: 10, bisectBatchOnError: true, retryAttempts: 5, onFailure: new lambdaEventSources.SqsDlq(streamFailureQueue) }));
    auditUsage.grantReadWriteData(revocationWorker);
    revocationWorker.addToRolePolicy(new iam.PolicyStatement({ actions: ['cloudfront:CreateInvalidation'], resources: [`arn:${this.partition}:cloudfront::${this.account}:distribution/${distribution.distributionId}`] }));
    const publicationWorker = new lambdaNodejs.NodejsFunction(this, 'PublicDeliveryWorker', {
      functionName: `${prefix}-public-delivery`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(2), memorySize: 1024,
      reservedConcurrentExecutions: Math.max(1, Math.floor((props.workerConcurrency || 20) / 2)),
      entry: path.join(__dirname, '../../apps/api/src/regionalPublicDeliveryHandler.ts'),
      environment: {
        PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion,
        METADATA_TABLE: metadata.tableName, SCAN_JOBS_TABLE: scanJobs.tableName, AUDIT_USAGE_TABLE: auditUsage.tableName, BILLING_LEDGER_TABLE: billingLedger.tableName,
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
    billingLedger.grantReadData(publicationWorker);
    const billingRollupWorker = new lambdaNodejs.NodejsFunction(this, 'BillingRollupWorker', {
      functionName: `${prefix}-billing-rollup`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(2), memorySize: 512,
      entry: path.join(__dirname, '../../apps/api/src/regionalBillingRollupHandler.ts'),
      environment: { PRODUCT: props.product, ENVIRONMENT: props.environment, DATA_HOME_REGION: props.dataHomeRegion, BILLING_LEDGER_TABLE: billingLedger.tableName }
    });
    billingRollupWorker.addEventSource(new lambdaEventSources.DynamoEventSource(billingLedger, { startingPosition: lambda.StartingPosition.LATEST, batchSize: 50, bisectBatchOnError: true, reportBatchItemFailures: true, retryAttempts: 10 }));
    billingLedger.grantStreamRead(billingRollupWorker); billingLedger.grantReadWriteData(billingRollupWorker);
    const publicationOutboxWorker = new lambdaNodejs.NodejsFunction(this, 'PublicationOutboxWorker', {
      functionName: `${prefix}-publication-outbox`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(2), memorySize: 512,
      entry: path.join(__dirname, '../../apps/api/src/regionalPublicationOutboxHandler.ts'),
      environment: { DATA_HOME_REGION: props.dataHomeRegion, AUDIT_USAGE_TABLE: auditUsage.tableName, METADATA_TABLE: metadata.tableName, PUBLICATION_QUEUE_URL: publicationQueue.queueUrl }
    });
    publicationOutboxWorker.addEventSource(new lambdaEventSources.DynamoEventSource(auditUsage, { startingPosition: lambda.StartingPosition.LATEST, batchSize: 10, bisectBatchOnError: true, retryAttempts: 10, reportBatchItemFailures: true, onFailure: new lambdaEventSources.SqsDlq(scanOutboxFailureQueue) }));
    auditUsage.grantReadWriteData(publicationOutboxWorker); metadata.grantReadData(publicationOutboxWorker); publicationQueue.grantSendMessages(publicationOutboxWorker);
    const auditLogWorker = new lambdaNodejs.NodejsFunction(this, 'AuditLogWorker', {
      functionName: `${prefix}-audit-log`, runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', timeout: Duration.minutes(1), memorySize: 256,
      entry: path.join(__dirname, '../../apps/api/src/regionalAuditLogHandler.ts'), logGroup: auditLogGroup
    });
    auditLogWorker.addEventSource(new lambdaEventSources.DynamoEventSource(auditUsage, { startingPosition: lambda.StartingPosition.LATEST, batchSize: 25, bisectBatchOnError: true, retryAttempts: 10, onFailure: new lambdaEventSources.SqsDlq(streamFailureQueue) }));
    auditUsage.grantStreamRead(auditLogWorker);
    const dashboard = new cloudwatch.Dashboard(this, 'CellDashboard', { dashboardName: `${prefix}-operations` });
    const billingMetric = (name: string, statistic: string = 'Sum') => new cloudwatch.Metric({ namespace: 'Gallery/Billing', metricName: name, dimensionsMap: { Region: props.dataHomeRegion }, statistic, period: Duration.minutes(5) });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'Regional scan queue', left: [queue.metricApproximateNumberOfMessagesVisible(), dlq.metricApproximateNumberOfMessagesVisible()] }),
      new cloudwatch.GraphWidget({ title: 'Scan success and failures', left: [worker.metricInvocations(), worker.metricErrors()] }),
      new cloudwatch.GraphWidget({ title: 'Ingest and frame processing latency', left: [worker.metricDuration(), videoWorker.metricDuration()] }),
      new cloudwatch.GraphWidget({ title: 'Billing metering and reservations', left: [billingMetric('MeteredCreditUnits'), billingMetric('ReservedCreditUnits')] }),
      new cloudwatch.GraphWidget({ title: 'Provider cost and credit balance', left: [billingMetric('EstimatedProviderCostUsd')], right: [billingMetric('AvailableCreditBalance', 'Minimum')] }),
      new cloudwatch.SingleValueWidget({ title: 'Billing integrity', metrics: [billingMetric('NegativeCreditBalance'), billingMetric('EntitlementRejections'), billingRollupWorker.metricErrors()] })
    );
    const alarm = (id: string, alarmName: string, metric: cloudwatch.IMetric, threshold: number, evaluationPeriods = 1) => { const value = new cloudwatch.Alarm(this, id, { alarmName, metric, threshold, evaluationPeriods, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING }); value.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic)); return value; };
    alarm('ScanDlqAlarm', `${prefix}-scan-dlq-depth`, dlq.metricApproximateNumberOfMessagesVisible(), 1);
    alarm('ImageIngestDlqAlarm', `${prefix}-image-ingest-dlq-depth`, imageIngestDlq.metricApproximateNumberOfMessagesVisible(), 1);
    alarm('VideoProcessingDlqAlarm', `${prefix}-video-processing-dlq-depth`, videoDlq.metricApproximateNumberOfMessagesVisible(), 1);
    alarm('BillingRollupErrorsAlarm', `${prefix}-billing-rollup-errors`, billingRollupWorker.metricErrors(), 1);
    alarm('NegativeCreditBalanceAlarm', `${prefix}-negative-credit-balance`, billingMetric('NegativeCreditBalance'), 1);
    alarm('EntitlementRejectionsAlarm', `${prefix}-entitlement-rejections`, billingMetric('EntitlementRejections'), 5);
    alarm('PublicDeliveryDlqAlarm', `${prefix}-public-delivery-dlq-depth`, publicationDlq.metricApproximateNumberOfMessagesVisible(), 1);
    alarm('ScanOutboxFailureAlarm', `${prefix}-scan-outbox-failures`, scanOutboxFailureQueue.metricApproximateNumberOfMessagesVisible(), 1);
    alarm('CriticalStreamFailureAlarm', `${prefix}-critical-stream-failures`, streamFailureQueue.metricApproximateNumberOfMessagesVisible(), 1);
    alarm('ScanQueueAgeAlarm', `${prefix}-scan-oldest-message`, queue.metricApproximateAgeOfOldestMessage(), Duration.minutes(10).toSeconds(), 2);
    alarm('ImageQueueAgeAlarm', `${prefix}-image-oldest-message`, imageIngestQueue.metricApproximateAgeOfOldestMessage(), Duration.minutes(10).toSeconds(), 2);
    alarm('VideoQueueAgeAlarm', `${prefix}-video-oldest-message`, videoQueue.metricApproximateAgeOfOldestMessage(), Duration.minutes(20).toSeconds(), 2);
    alarm('PublicDeliveryQueueAgeAlarm', `${prefix}-public-delivery-oldest-message`, publicationQueue.metricApproximateAgeOfOldestMessage(), Duration.minutes(10).toSeconds(), 2);
    alarm('ApiServerErrorsAlarm', `${prefix}-api-5xx`, api.metricServerError(), 5, 2);
    alarm('ApiLatencyAlarm', `${prefix}-api-latency`, api.metricLatency({ statistic: 'p95' }), 2000, 3);
    alarm('HealthCanaryAlarm', `${prefix}-health-canary-errors`, healthCanary.metricErrors(), 1, 1);
    alarm('ResidencyCanaryAlarm', `${prefix}-residency-canary-errors`, residencyCanary.metricErrors(), 1, 1);
    for (const [name, fn, limit] of [['Scan', worker, props.workerConcurrency || 20], ['Image', imageIngestWorker, props.workerConcurrency || 20], ['Video', videoWorker, Math.max(1, Math.floor((props.workerConcurrency || 20) / 4))], ['Publication', publicationWorker, Math.max(1, Math.floor((props.workerConcurrency || 20) / 2))]] as const) alarm(`${name}ConcurrencyAlarm`, `${prefix}-${name.toLowerCase()}-concurrency-70-percent`, fn.metric('ConcurrentExecutions'), Math.max(1, Math.floor(limit * 0.7)), 3);

    new CfnOutput(this, 'CellIdentity', { value: prefix });
    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'IdentityUserPoolArn', { value: userPool.userPoolArn });
    new CfnOutput(this, 'PublicDistributionDomain', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'ScanQueueUrl', { value: queue.queueUrl });
    new CfnOutput(this, 'VideoProcessingQueueUrl', { value: videoQueue.queueUrl });
    new CfnOutput(this, 'ImageIngestQueueUrl', { value: imageIngestQueue.queueUrl });
    new CfnOutput(this, 'PublicDeliveryQueueUrl', { value: publicationQueue.queueUrl });
    new CfnOutput(this, 'QuarantineBucketName', { value: quarantine.bucketName });
    new CfnOutput(this, 'ExportsBucketName', { value: exportsBucket.bucketName });
    new CfnOutput(this, 'MigrationStateMachineArn', { value: migration.stateMachineArn });
    new CfnOutput(this, 'DlqRedriveFunctionName', { value: redriveWorker.functionName });
    new CfnOutput(this, 'OperationsAlarmTopicArn', { value: alarmTopic.topicArn });
    new CfnOutput(this, 'RegionalBackupVaultName', { value: backupVault.backupVaultName });
  }
}
