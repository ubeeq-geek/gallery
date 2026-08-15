import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BlueskyOAuthStack, PublicLandingStack } from '../lib/public-launch-stack';

const props = {
  env: { account: '024505387948', region: 'ca-central-1' },
  brand: 'eversally' as const,
  rootDomain: 'eversally.com',
  apiDomain: 'api.eversally.com',
  hostedZoneId: 'Z0933147166BL9EKW6HNC',
  webCertificateArn: 'arn:aws:acm:us-east-1:024505387948:certificate/25ddb503-6b4a-49ad-8a71-475307fa819a',
  apiCertificateArn: 'arn:aws:acm:ca-central-1:024505387948:certificate/a112c104-4d43-4604-aed8-ecaecfd43f61',
  blueskyOAuthSecretName: 'eversally/production/bluesky-oauth'
};

describe('minimal public launch stacks', () => {
  it('hosts a static landing page without product infrastructure', () => {
    const app = new cdk.App();
    const stack = new PublicLandingStack(app, 'EversallyLanding', props);
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
    template.resourceCountIs('AWS::Cognito::UserPool', 0);
    template.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'eversally.com.' });
  });

  it('keeps Bluesky OAuth isolated to one Lambda and one session table', () => {
    const app = new cdk.App();
    const stack = new BlueskyOAuthStack(app, 'EversallyBlueskyOAuth', props);
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.resourceCountIs('AWS::Cognito::UserPool', 0);
    template.resourceCountIs('AWS::SQS::Queue', 0);
    template.hasResourceProperties('AWS::ApiGateway::DomainName', { DomainName: 'api.eversally.com' });
  });
});
