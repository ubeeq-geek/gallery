import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export type PublicBrand = 'eversally' | 'ubeeq';

export interface PublicLaunchProps extends StackProps {
  brand: PublicBrand;
  rootDomain: string;
  apiDomain: string;
  hostedZoneId: string;
  webCertificateArn: string;
  apiCertificateArn: string;
  blueskyOAuthSecretName: string;
}

const nameFor = (brand: PublicBrand): string => brand === 'eversally' ? 'Eversally' : 'Ubeeq';

const hostedZone = (scope: Construct, props: PublicLaunchProps): route53.IHostedZone => route53.HostedZone.fromHostedZoneAttributes(scope, 'HostedZone', {
  hostedZoneId: props.hostedZoneId,
  zoneName: props.rootDomain
});

export class PublicLandingStack extends Stack {
  constructor(scope: Construct, id: string, props: PublicLaunchProps) {
    super(scope, id, props);
    const zone = hostedZone(this, props);
    const bucket = new s3.Bucket(this, 'LandingBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN
    });
    const directoryIndexFunction = new cloudfront.Function(this, 'LandingDirectoryIndexFunction', {
      comment: 'Serve directory index documents for static landing-page routes.',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (!uri.includes('.')) {
    request.uri = uri + '/index.html';
  }
  return request;
}`)
    });
    const distribution = new cloudfront.Distribution(this, 'LandingDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          function: directoryIndexFunction
        }]
      },
      defaultRootObject: 'index.html',
      domainNames: [props.rootDomain],
      certificate: acm.Certificate.fromCertificateArn(this, 'LandingCertificate', props.webCertificateArn),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021
    });
    new s3deploy.BucketDeployment(this, 'LandingFiles', {
      sources: [s3deploy.Source.asset(path.join(__dirname, `../../apps/landing/${props.brand}`))],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
      prune: true
    });
    new route53.ARecord(this, 'LandingAlias', {
      zone,
      recordName: props.rootDomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution))
    });
    new route53.AaaaRecord(this, 'LandingIpv6Alias', {
      zone,
      recordName: props.rootDomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution))
    });
    new CfnOutput(this, 'LandingUrl', { value: `https://${props.rootDomain}` });
    new CfnOutput(this, 'LandingDistributionDomainName', { value: distribution.distributionDomainName });
  }
}

export class BlueskyOAuthStack extends Stack {
  constructor(scope: Construct, id: string, props: PublicLaunchProps) {
    super(scope, id, props);
    const zone = hostedZone(this, props);
    const oauthSecret = secretsmanager.Secret.fromSecretNameV2(this, 'BlueskyOAuthSecret', props.blueskyOAuthSecretName);
    const sessions = new dynamodb.Table(this, 'BlueskyOAuthSessions', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN
    });
    const logGroup = new logs.LogGroup(this, 'BlueskyOAuthLogs', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN
    });
    const functionName = `${props.brand}-bluesky-oauth`;
    const oauthFunction = new lambdaNodejs.NodejsFunction(this, 'BlueskyOAuthFunction', {
      functionName,
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../apps/bluesky-oauth/src/handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 512,
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      bundling: { target: 'node22', externalModules: ['@aws-sdk/*'] },
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
      systemLogLevelV2: lambda.SystemLogLevel.WARN,
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      environment: {
        BLUESKY_OAUTH_TABLE: sessions.tableName,
        BLUESKY_OAUTH_CLIENT_ID: `https://${props.apiDomain}/oauth/bluesky/client-metadata.json`,
        BLUESKY_OAUTH_CALLBACK_URL: `https://${props.apiDomain}/oauth/bluesky/callback`,
        // atproto OAuth requires client_uri and client_id to share an origin.
        BLUESKY_OAUTH_CLIENT_URI: `https://${props.apiDomain}/oauth/bluesky`,
        // The OAuth broker only redirects to this fixed, product-owned URL with
        // a short-lived signed connection proof; it never accepts return URLs
        // from a browser request.
        BLUESKY_OAUTH_STUDIO_RETURN_URL: `https://${props.rootDomain}/studio/workspace?section=integrations`,
        BLUESKY_OAUTH_BRAND: props.brand,
        BLUESKY_OAUTH_PRIVATE_JWK: oauthSecret.secretValueFromJson('blueskyOAuthPrivateJwk').unsafeUnwrap()
      }
    });
    sessions.grantReadWriteData(oauthFunction);
    oauthSecret.grantRead(oauthFunction);
    const apiLogGroup = new logs.LogGroup(this, 'BlueskyOAuthAccessLogs', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN
    });
    const api = new apigw.LambdaRestApi(this, 'BlueskyOAuthApi', {
      handler: oauthFunction,
      proxy: true,
      deployOptions: {
        accessLogDestination: new apigw.LogGroupLogDestination(apiLogGroup),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields({
          caller: false, httpMethod: true, ip: true, protocol: true, requestTime: true, resourcePath: true, responseLength: true, status: true, user: false
        }),
        loggingLevel: apigw.MethodLoggingLevel.ERROR,
        metricsEnabled: true,
        tracingEnabled: true
      }
    });
    const domain = api.addDomainName('BlueskyOAuthDomain', {
      domainName: props.apiDomain,
      certificate: acm.Certificate.fromCertificateArn(this, 'BlueskyOAuthCertificate', props.apiCertificateArn),
      endpointType: apigw.EndpointType.REGIONAL,
      securityPolicy: apigw.SecurityPolicy.TLS_1_2
    });
    new route53.ARecord(this, 'BlueskyOAuthAlias', {
      zone,
      recordName: props.apiDomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.ApiGatewayDomain(domain))
    });
    new route53.AaaaRecord(this, 'BlueskyOAuthIpv6Alias', {
      zone,
      recordName: props.apiDomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.ApiGatewayDomain(domain))
    });
    new CfnOutput(this, 'BlueskyOAuthApiUrl', { value: `https://${props.apiDomain}` });
    new CfnOutput(this, 'BlueskyOAuthClientMetadataUrl', { value: `https://${props.apiDomain}/oauth/bluesky/client-metadata.json` });
    new CfnOutput(this, 'BlueskyOAuthAuthorizeUrl', { value: `https://${props.apiDomain}/oauth/bluesky/authorize?handle={handle}` });
  }
}

export const publicLaunchStackName = (brand: PublicBrand, kind: 'landing' | 'bluesky'): string => `${nameFor(brand)}${kind === 'landing' ? 'Landing' : 'BlueskyOAuth'}`;
