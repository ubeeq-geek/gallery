import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as targets from 'aws-cdk-lib/aws-events-targets';

export interface SyndicationSourceStackProps extends StackProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  galleryCoreTable: dynamodb.ITable;
}

export class SyndicationSourceStack extends Stack {
  constructor(scope: Construct, id: string, props: SyndicationSourceStackProps) {
    super(scope, id, props);

    const sourcesTable = new dynamodb.Table(this, 'SyndicationSourcesTable', {
      partitionKey: { name: 'sourceId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const usedAssetsTable = new dynamodb.Table(this, 'SyndicationUsedAssetsTable', {
      partitionKey: { name: 'source', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const apiFn = new lambdaNodejs.NodejsFunction(this, 'SyndicationSourceApiFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../apps/syndication-api/src/handler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 1024,
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      bundling: {
        target: 'node22',
        externalModules: ['@aws-sdk/*']
      },
      environment: {
        SYNDICATION_SOURCES_TABLE: sourcesTable.tableName,
        SYNDICATION_USED_ASSETS_TABLE: usedAssetsTable.tableName,
        GALLERY_CORE_TABLE: props.galleryCoreTable.tableName,
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,
        COGNITO_TOKEN_USE: 'id',
        OPENVERSE_CLIENT_ID: process.env.OPENVERSE_CLIENT_ID || '',
        OPENVERSE_CLIENT_SECRET: process.env.OPENVERSE_CLIENT_SECRET || ''
      }
    });

    sourcesTable.grantReadWriteData(apiFn);
    usedAssetsTable.grantReadWriteData(apiFn);
    props.galleryCoreTable.grantReadWriteData(apiFn);

    const api = new apigw.LambdaRestApi(this, 'SyndicationSourceApi', {
      handler: apiFn,
      proxy: true
    });

    new events.Rule(this, 'SyndicationWeeklySaturdayRule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '8', weekDay: 'SAT' }),
      targets: [
        new targets.LambdaFunction(apiFn, {
          event: events.RuleTargetInput.fromObject({
            trigger: 'weekly-sync'
          })
        })
      ]
    });

    new CfnOutput(this, 'SyndicationApiUrl', { value: api.url });
    new CfnOutput(this, 'SyndicationSourcesTableName', { value: sourcesTable.tableName });
    new CfnOutput(this, 'SyndicationUsedAssetsTableName', { value: usedAssetsTable.tableName });
  }
}
