import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'node:path';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';

export interface GlobalRoutingStackProps extends StackProps {
  environment: string;
  regionalEndpoints: Record<string, string>;
}

/** Minimal global control plane: identity and opaque data-home discovery only. */
export class GlobalRoutingStack extends Stack {
  constructor(scope: Construct, id: string, props: GlobalRoutingStackProps) {
    super(scope, id, props);
    const production = ['prod', 'production'].includes(props.environment.toLowerCase());
    const removalPolicy = production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const routing = new dynamodb.Table(this, 'RoutingDirectory', {
      partitionKey: { name: 'routingId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: production ? { pointInTimeRecoveryEnabled: true } : undefined,
      deletionProtection: production, removalPolicy
    });
    const identity = new cognito.UserPool(this, 'GlobalIdentity', { selfSignUpEnabled: true, signInAliases: { email: true }, removalPolicy });
    const client = identity.addClient('WebClient', { authFlows: { userSrp: true }, preventUserExistenceErrors: true });
    const worker = new lambdaNodejs.NodejsFunction(this, 'RoutingHandler', {
      runtime: lambda.Runtime.NODEJS_22_X, handler: 'handler', entry: path.join(__dirname, '../../apps/api/src/globalRoutingHandler.ts'),
      environment: { ROUTING_TABLE: routing.tableName, REGIONAL_ENDPOINTS_JSON: JSON.stringify(props.regionalEndpoints) }
    });
    routing.grantReadWriteData(worker);
    const api = new apigw.RestApi(this, 'RoutingApi', { endpointTypes: [apigw.EndpointType.EDGE] });
    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Authorizer', { cognitoUserPools: [identity] });
    const route = api.root.addResource('routing').addResource('{product}');
    for (const method of ['GET', 'POST']) route.addMethod(method, new apigw.LambdaIntegration(worker), { authorizer, authorizationType: apigw.AuthorizationType.COGNITO });
    new CfnOutput(this, 'RoutingApiUrl', { value: api.url });
    new CfnOutput(this, 'RoutingTableName', { value: routing.tableName });
    new CfnOutput(this, 'GlobalUserPoolArn', { value: identity.userPoolArn });
    new CfnOutput(this, 'GlobalUserPoolId', { value: identity.userPoolId });
    new CfnOutput(this, 'GlobalUserPoolClientId', { value: client.userPoolClientId });
  }
}
