import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GlobalRoutingStack } from '../lib/global-routing-stack';

describe('global routing control plane', () => {
  it('stores only opaque assignments and exposes authenticated discovery', () => {
    const stack = new GlobalRoutingStack(new cdk.App(), 'Routing', { environment: 'test', regionalEndpoints: { 'eversally:eu-central-1': 'https://eu.example/' }, env: { account: '111111111111', region: 'us-east-1' } });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({ Environment: { Variables: Match.objectLike({ REGIONAL_ENDPOINTS_JSON: '{"eversally:eu-central-1":"https://eu.example/"}' }) } }));
    template.hasResourceProperties('AWS::ApiGateway::Method', Match.objectLike({ HttpMethod: 'GET', AuthorizationType: 'COGNITO_USER_POOLS' }));
    template.hasResourceProperties('AWS::ApiGateway::Method', Match.objectLike({ HttpMethod: 'POST', AuthorizationType: 'COGNITO_USER_POOLS' }));
  });
});
