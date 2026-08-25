import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RegionalCellStack } from '../lib/regional-cell-stack';

const template = () => Template.fromStack(new RegionalCellStack(new cdk.App(), 'Cell', { product: 'eversally', environment: 'test', dataHomeRegion: 'eu-central-1', env: { account: '111111111111', region: 'eu-central-1' } }));

describe('regional cell', () => {
  it('creates isolated encrypted regional stores without replication or a VPC', () => {
    const value = template();
    value.resourceCountIs('AWS::S3::Bucket', 7);
    value.resourceCountIs('AWS::DynamoDB::Table', 3);
    value.allResourcesProperties('AWS::DynamoDB::Table', Match.objectLike({ TimeToLiveSpecification: { AttributeName: 'expiresAtEpochSeconds', Enabled: true } }));
    value.resourceCountIs('AWS::EC2::VPC', 0);
    value.resourceCountIs('AWS::S3::BucketPolicy', 7);
    value.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    value.resourceCountIs('AWS::WAFv2::WebACL', 1);
    value.resourceCountIs('AWS::SecretsManager::Secret', 1);
    value.resourceCountIs('AWS::KMS::Key', 2);
    value.resourceCountIs('AWS::Events::Rule', 6);
    value.resourceCountIs('AWS::CloudWatch::Alarm', 18);
    // Cell workers (including privacy) plus CDK's bucket auto-delete provider.
    value.resourceCountIs('AWS::Lambda::Function', 17);
    value.resourceCountIs('AWS::Backup::BackupVault', 1);
    value.resourceCountIs('AWS::Backup::BackupPlan', 1);
    value.resourceCountIs('AWS::SNS::Topic', 1);
    const rendered = JSON.stringify(value.toJSON());
    expect(rendered).not.toContain('ReplicationConfiguration');
    expect(rendered).not.toContain('AWS::DynamoDB::GlobalTable');
    expect(rendered).not.toContain('AWS::EC2::NatGateway');
    value.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({ LifecycleConfiguration: Match.objectLike({ Rules: Match.arrayWith([Match.objectLike({ Id: 'BoundedRetention', Status: 'Enabled' })]) }) }));
  });

  it('only exposes the approved derivative bucket through CloudFront', () => {
    const value = template();
    value.hasResourceProperties('AWS::CloudFront::Distribution', Match.objectLike({ DistributionConfig: Match.objectLike({ Comment: 'eversally-test-eu-central-1-public' }) }));
    value.hasResourceProperties('AWS::SQS::Queue', Match.objectLike({ QueueName: 'eversally-test-eu-central-1-scan.fifo', FifoQueue: true }));
    value.hasResourceProperties('AWS::SQS::Queue', Match.objectLike({ QueueName: 'eversally-test-eu-central-1-public-delivery' }));
    value.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Environment: { Variables: Match.objectLike({ PRODUCT: 'eversally', DATA_HOME_REGION: 'eu-central-1', PUBLIC_DISTRIBUTION_ID: Match.anyValue() }) }
    }));
    value.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({ PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Action: 'cloudfront:CreateInvalidation' })]) }) }));
    value.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Environment: { Variables: Match.objectLike({ PRODUCT: 'eversally', ENVIRONMENT: 'test', DATA_HOME_REGION: 'eu-central-1', SCAN_JOBS_TABLE: Match.anyValue(), QUARANTINE_BUCKET: Match.anyValue(), SCAN_FRAMES_BUCKET: Match.anyValue() }) },
      ReservedConcurrentExecutions: 20
    }));
    value.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Environment: { Variables: Match.objectLike({ PRODUCT: 'eversally', ENVIRONMENT: 'test', DATA_HOME_REGION: 'eu-central-1', PRIVATE_DERIVATIVES_BUCKET: Match.anyValue(), PUBLIC_DERIVATIVES_BUCKET: Match.anyValue(), METADATA_TABLE: Match.anyValue() }) },
      ReservedConcurrentExecutions: 10
    }));
    value.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      Environment: { Variables: Match.objectLike({ PRODUCT: 'eversally', ENVIRONMENT: 'test', DATA_HOME_REGION: 'eu-central-1', METADATA_TABLE: Match.anyValue(), QUARANTINE_BUCKET: Match.anyValue() }) },
      ReservedConcurrentExecutions: 20
    }));
    value.hasResourceProperties('AWS::ApiGateway::Method', Match.objectLike({ HttpMethod: 'POST', AuthorizationType: 'COGNITO_USER_POOLS' }));
    value.hasResourceProperties('AWS::ApiGateway::Stage', Match.objectLike({ AccessLogSetting: Match.anyValue(), MethodSettings: Match.arrayWith([Match.objectLike({ MetricsEnabled: true, ThrottlingRateLimit: 100, ThrottlingBurstLimit: 200 })]) }));
    value.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({ Environment: { Variables: Match.objectLike({ EXPORTS_BUCKET: Match.anyValue(), EVIDENCE_BUCKET: Match.anyValue(), DATA_HOME_REGION: 'eu-central-1' }) } }));
    value.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
    value.hasResourceProperties('AWS::DynamoDB::Table', Match.objectLike({ TableName: 'eversally-test-eu-central-1-scan-jobs', StreamSpecification: { StreamViewType: 'NEW_IMAGE' } }));
    value.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({ Environment: { Variables: Match.objectLike({ SCAN_JOBS_TABLE: Match.anyValue(), SCAN_QUEUE_URL: Match.anyValue(), PRODUCT: 'eversally', DATA_HOME_REGION: 'eu-central-1' }) } }));
    value.hasResourceProperties('AWS::IAM::ManagedPolicy', Match.objectLike({ PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { StringNotEquals: { 'aws:RequestedRegion': 'eu-central-1' } } })]) }) }));
    expect(Object.values(value.findResources('AWS::IAM::Role')).every(({ Properties }: any) => Boolean(Properties.PermissionsBoundary))).toBe(true);
    expect(Object.values(value.findResources('AWS::CloudWatch::Alarm')).every(({ Properties }: any) => Properties.AlarmActions?.length === 1)).toBe(true);
  });

  it('rejects a stack deployed outside its data home', () => {
    expect(() => new RegionalCellStack(new cdk.App(), 'Bad', { product: 'nightframe', environment: 'prod', dataHomeRegion: 'us-east-2', env: { region: 'eu-central-1' } })).toThrow('Stack region must equal dataHomeRegion');
  });

  it('requires an explicit region-local FFmpeg layer for production cells', () => {
    expect(() => new RegionalCellStack(new cdk.App(), 'MissingFfmpeg', { product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2', env: { region: 'us-east-2' } })).toThrow('FFMPEG_LAYER_ARN');
    expect(() => new RegionalCellStack(new cdk.App(), 'MissingPolicy', { product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2', ffmpegLayerArn: 'arn:aws:lambda:us-east-2:111111111111:layer:ffmpeg:1', env: { account: '111111111111', region: 'us-east-2' } })).toThrow('REGIONAL_POLICY_PROFILE_JSON');
  });
});
