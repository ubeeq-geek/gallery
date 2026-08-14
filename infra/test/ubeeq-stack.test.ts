import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { UbeeqStack } from '../lib/ubeeq-stack';

const managedVariables = [
  'DEPLOYMENT_STAGE',
  'WEB_APP_URL',
  'APP_ORIGIN',
  'APP_SECRETS_NAME',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'APPLE_SERVICE_ID',
  'APPLE_TEAM_ID',
  'APPLE_KEY_ID',
  'APPLE_PRIVATE_KEY',
  'CLOUDFRONT_PUBLIC_KEY',
  'CLOUDFRONT_PRIVATE_KEY',
  'EXTERNAL_TOKEN_ENCRYPTION_KEY',
  'UNLOCK_JWT_SECRET',
  'ALARM_NOTIFICATION_EMAIL'
];

const synthTemplate = (id: string): Template => {
  const app = new cdk.App();
  return Template.fromStack(new UbeeqStack(app, id));
};

describe('production survivability profile', () => {
  beforeEach(() => managedVariables.forEach((name) => delete process.env[name]));

  it('keeps development stacks disposable and free of production operations resources', () => {
    const template = synthTemplate('DevelopmentStack');
    const tables = Object.values(template.findResources('AWS::DynamoDB::Table')) as Array<Record<string, unknown>>;
    expect(tables).toHaveLength(4);
    tables.forEach((table) => {
      expect(table.DeletionPolicy).toBe('Delete');
      expect((table.Properties as Record<string, unknown>).PointInTimeRecoverySpecification).toBeUndefined();
      expect((table.Properties as Record<string, unknown>).DeletionProtectionEnabled).toBe(false);
    });
    const buckets = Object.values(template.findResources('AWS::S3::Bucket')) as Array<Record<string, unknown>>;
    expect(buckets[0].DeletionPolicy).toBe('Delete');
    expect((buckets[0].Properties as Record<string, unknown>).VersioningConfiguration).toBeUndefined();
    template.resourceCountIs('AWS::Backup::BackupPlan', 0);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
  });

  it('requires explicit production origins and managed secrets', () => {
    process.env.DEPLOYMENT_STAGE = 'production';
    expect(() => synthTemplate('MissingSecretsStack')).toThrow('APP_SECRETS_NAME');
    process.env.APP_SECRETS_NAME = 'eversally/production/application';
    expect(() => synthTemplate('MissingOriginStack')).toThrow('WEB_APP_URL');
  });

  it('adds retention, backups, restricted origins, observability, and secret references only in production', () => {
    process.env.DEPLOYMENT_STAGE = 'production';
    process.env.WEB_APP_URL = 'https://eversally.com';
    process.env.APP_SECRETS_NAME = 'eversally/production/application';
    const template = synthTemplate('ProductionStack');
    const tables = Object.values(template.findResources('AWS::DynamoDB::Table')) as Array<Record<string, unknown>>;
    expect(tables).toHaveLength(4);
    tables.forEach((table) => {
      expect(table.DeletionPolicy).toBe('Retain');
      expect((table.Properties as Record<string, unknown>).PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
      expect((table.Properties as Record<string, unknown>).DeletionProtectionEnabled).toBe(true);
    });
    const buckets = Object.values(template.findResources('AWS::S3::Bucket')) as Array<Record<string, unknown>>;
    expect(buckets[0].DeletionPolicy).toBe('Retain');
    expect((buckets[0].Properties as Record<string, unknown>).VersioningConfiguration).toEqual({ Status: 'Enabled' });
    template.resourceCountIs('AWS::Backup::BackupPlan', 1);
    template.resourceCountIs('AWS::Backup::BackupVault', 1);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 12);
    template.resourceCountIs('AWS::Logs::MetricFilter', 1);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.resourceCountIs('AWS::SNS::Topic', 1);

    const serialized = JSON.stringify(template.toJSON());
    expect(serialized).toContain('https://eversally.com');
    expect(serialized).not.toContain('https://fanadmin.top:5174');
    expect(serialized).toContain('eversally/production/application');
    expect(serialized).toContain('externalTokenEncryptionKey');
    expect(serialized).toContain('unlockJwtSecret');
  });
});
