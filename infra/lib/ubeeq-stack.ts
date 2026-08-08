import * as path from 'path';
import * as fs from 'fs';
import { Duration, RemovalPolicy, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

export class UbeeqStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const siteSettingsTable = new dynamodb.Table(this, 'SiteSettingsTable', {
      partitionKey: { name: 'settingId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const contentStatsTable = new dynamodb.Table(this, 'ContentStatsTable', {
      partitionKey: { name: 'imageId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const trendingFeedTable = new dynamodb.Table(this, 'TrendingFeedTable', {
      partitionKey: { name: 'period', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'rankKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });
    trendingFeedTable.addGlobalSecondaryIndex({
      indexName: 'PeriodSurfaceRank',
      partitionKey: { name: 'periodSurface', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'rankKey', type: dynamodb.AttributeType.STRING }
    });

    const contentCoreTable = new dynamodb.Table(this, 'ContentCoreTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });
    contentCoreTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING }
    });
    contentCoreTable.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING }
    });

    const mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedOrigins: ['*'],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.PUT],
          allowedHeaders: ['*'],
          exposedHeaders: ['Accept-Ranges', 'Content-Range', 'Content-Length', 'Content-Type', 'ETag'],
          maxAge: 86400
        }
      ]
    });
    const videoPosterIngestDlq = new sqs.Queue(this, 'VideoPosterIngestDlq', {
      retentionPeriod: Duration.days(14)
    });
    const videoPosterIngestQueue = new sqs.Queue(this, 'VideoPosterIngestQueue', {
      visibilityTimeout: Duration.minutes(5),
      receiveMessageWaitTime: Duration.seconds(20),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: videoPosterIngestDlq
      }
    });
    mediaBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(videoPosterIngestQueue)
    );

    const mediaOrigin = origins.S3BucketOrigin.withOriginAccessControl(mediaBucket);
    const mediaResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'MediaResponseHeadersPolicy', {
      comment: 'CORS and range headers for MP4 byte-range playback',
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ['*'],
        accessControlAllowMethods: ['GET', 'HEAD', 'OPTIONS'],
        accessControlAllowOrigins: ['*'],
        accessControlExposeHeaders: ['Accept-Ranges', 'Content-Range', 'Content-Length', 'Content-Type', 'ETag'],
        accessControlMaxAge: Duration.days(1),
        originOverride: true
      }
    });
    const publicKeyFile = process.env.CLOUDFRONT_PUBLIC_KEY_FILE;
    const privateKeyFile = process.env.CLOUDFRONT_PRIVATE_KEY_FILE;
    const cloudFrontPublicKeyPem = (
      publicKeyFile && fs.existsSync(publicKeyFile)
        ? fs.readFileSync(publicKeyFile, 'utf8')
        : (process.env.CLOUDFRONT_PUBLIC_KEY || '')
    ).replace(/\\n/g, '\n').trim();
    const cloudFrontPrivateKey = (
      privateKeyFile && fs.existsSync(privateKeyFile)
        ? fs.readFileSync(privateKeyFile, 'utf8')
        : (process.env.CLOUDFRONT_PRIVATE_KEY || '')
    ).replace(/\\n/g, '\n').trim();
    const premiumPublicKey = cloudFrontPublicKeyPem
      ? new cloudfront.PublicKey(this, 'PremiumMediaPublicKey', {
          encodedKey: cloudFrontPublicKeyPem,
          comment: 'Public key for premium media CloudFront signed URLs'
        })
      : undefined;
    const keyGroup = premiumPublicKey
      ? new cloudfront.KeyGroup(this, 'PremiumMediaKeyGroup', {
          items: [premiumPublicKey]
        })
      : undefined;

    const mediaDistribution = new cloudfront.Distribution(this, 'MediaDistribution', {
      defaultBehavior: {
        origin: mediaOrigin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: mediaResponseHeadersPolicy,
        compress: true
      },
      comment: 'Ubeeq media CDN'
    });
    const premiumMediaDistribution = keyGroup
      ? new cloudfront.Distribution(this, 'PremiumMediaDistribution', {
          defaultBehavior: {
            origin: mediaOrigin,
            allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            responseHeadersPolicy: mediaResponseHeadersPolicy,
            trustedKeyGroups: [keyGroup],
            compress: true
          },
          comment: 'Ubeeq premium media CDN'
        })
      : undefined;

    const userPool = new cognito.UserPool(this, 'UbeeqUserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } }
    });
    const userPoolCfn = userPool.node.defaultChild as cognito.CfnUserPool;
    userPoolCfn.addPropertyOverride('Policies.SignInPolicy.AllowedFirstAuthFactors', [
      'PASSWORD',
      'EMAIL_OTP'
    ]);

    const userPoolClient = new cognito.UserPoolClient(this, 'UbeeqUserPoolClient', {
      userPool,
      authFlows: {
        userPassword: true,
        userSrp: true
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls: ['http://localhost:5173/callback', 'http://localhost:5174/callback'],
        logoutUrls: ['http://localhost:5173', 'http://localhost:5174']
      },
      readAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true, preferredUsername: true }),
      writeAttributes: new cognito.ClientAttributes()
        .withStandardAttributes({ email: true, preferredUsername: true })
    });
    const userPoolClientCfn = userPoolClient.node.defaultChild as cognito.CfnUserPoolClient;
    userPoolClientCfn.addPropertyOverride('ExplicitAuthFlows', [
      'ALLOW_USER_AUTH',
      'ALLOW_USER_SRP_AUTH',
      'ALLOW_USER_PASSWORD_AUTH',
      'ALLOW_REFRESH_TOKEN_AUTH'
    ]);

    const adminsGroup = new cognito.CfnUserPoolGroup(this, 'AdminsGroup', {
      groupName: 'Admins',
      userPoolId: userPool.userPoolId,
      description: 'Admin users allowed to access orchestration endpoints'
    });

    const creatorsGroup = new cognito.CfnUserPoolGroup(this, 'CreatorsGroup', {
      groupName: 'Creators',
      userPoolId: userPool.userPoolId,
      description: 'Creator users allowed to create groupings and media'
    });

    const usersGroup = new cognito.CfnUserPoolGroup(this, 'UsersGroup', {
      groupName: 'Users',
      userPoolId: userPool.userPoolId,
      description: 'General authenticated users'
    });

    const apiFn = new lambdaNodejs.NodejsFunction(this, 'UbeeqApiFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../apps/api/src/handler.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      bundling: {
        target: 'node22',
        externalModules: ['@aws-sdk/*']
      },
      environment: {
        SITE_SETTINGS_TABLE: siteSettingsTable.tableName,
        CONTENT_STATS_TABLE: contentStatsTable.tableName,
        TRENDING_FEED_TABLE: trendingFeedTable.tableName,
        CONTENT_CORE_TABLE: contentCoreTable.tableName,
        USE_CONTENT_CORE_TABLE: 'true',
        MEDIA_BUCKET: mediaBucket.bucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        COGNITO_TOKEN_USE: 'id',
        TRENDING_FEED_MAX_ITEMS: '600',
        TRENDING_CANDIDATE_LIMIT: '1500',
        MEDIA_CDN_DOMAIN: mediaDistribution.distributionDomainName,
        PREMIUM_MEDIA_CDN_DOMAIN: premiumMediaDistribution?.distributionDomainName || '',
        CLOUDFRONT_KEY_PAIR_ID: premiumPublicKey?.publicKeyId || '',
        CLOUDFRONT_PRIVATE_KEY: cloudFrontPrivateKey
      }
    });
    const trendingRankerFn = new lambdaNodejs.NodejsFunction(this, 'TrendingRankerFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../apps/api/src/trendingRanker.ts'),
      handler: 'handler',
      timeout: Duration.seconds(120),
      memorySize: 1024,
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      bundling: {
        target: 'node22',
        externalModules: ['@aws-sdk/*']
      },
      environment: {
        SITE_SETTINGS_TABLE: siteSettingsTable.tableName,
        CONTENT_STATS_TABLE: contentStatsTable.tableName,
        TRENDING_FEED_TABLE: trendingFeedTable.tableName,
        CONTENT_CORE_TABLE: contentCoreTable.tableName,
        USE_CONTENT_CORE_TABLE: 'true',
        MEDIA_BUCKET: mediaBucket.bucketName,
        TRENDING_FEED_MAX_ITEMS: '600',
        TRENDING_CANDIDATE_LIMIT: '1500'
      }
    });
    const ffmpegLayerArn = process.env.FFMPEG_LAYER_ARN;
    const videoPosterIngestFn = new lambdaNodejs.NodejsFunction(this, 'VideoPosterIngestFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../apps/api/src/videoPosterIngest.ts'),
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 1536,
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      bundling: {
        target: 'node22',
        externalModules: ['@aws-sdk/*']
      },
      layers: ffmpegLayerArn
        ? [lambda.LayerVersion.fromLayerVersionArn(this, 'VideoPosterFfmpegLayer', ffmpegLayerArn)]
        : undefined,
      environment: {
        CONTENT_CORE_TABLE: contentCoreTable.tableName,
        MEDIA_BUCKET: mediaBucket.bucketName,
        VIDEO_POSTER_OUTPUT_PREFIX: 'posters',
        VIDEO_POSTER_FFMPEG_PATH: '/opt/bin/ffmpeg',
        VIDEO_POSTER_CAPTURE_AT_SECONDS: '1'
      }
    });
    videoPosterIngestFn.addEventSource(
      new lambdaEventSources.SqsEventSource(videoPosterIngestQueue, {
        batchSize: 5,
        maxBatchingWindow: Duration.seconds(2),
        reportBatchItemFailures: true
      })
    );
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminUpdateUserAttributes'],
        resources: [userPool.userPoolArn]
      })
    );

    siteSettingsTable.grantReadWriteData(apiFn);
    contentStatsTable.grantReadWriteData(apiFn);
    trendingFeedTable.grantReadWriteData(apiFn);
    contentCoreTable.grantReadWriteData(apiFn);
    mediaBucket.grantReadWrite(apiFn);
    contentStatsTable.grantReadWriteData(trendingRankerFn);
    trendingFeedTable.grantReadWriteData(trendingRankerFn);
    contentCoreTable.grantReadData(trendingRankerFn);
    contentCoreTable.grantReadWriteData(videoPosterIngestFn);
    mediaBucket.grantReadWrite(videoPosterIngestFn);
    videoPosterIngestQueue.grantConsumeMessages(videoPosterIngestFn);

    new events.Rule(this, 'TrendingRankerSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(trendingRankerFn)]
    });

    const api = new apigw.LambdaRestApi(this, 'UbeeqApi', {
      handler: apiFn,
      proxy: true,
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: [
          'Authorization',
          'Content-Type',
          'If-None-Match',
          'Cache-Control',
          'Range',
          'X-Grouping-Access-Token',
          'X-Unlock-Token',
          'X-Idempotency-Key'
        ],
        exposeHeaders: [
          'Accept-Ranges',
          'Content-Range',
          'Content-Length',
          'Content-Type',
          'ETag',
          'Server-Timing',
          'X-Request-Id',
          'X-Handler-Ms',
          'X-Runtime-Uptime-Ms',
          'X-Cold-Start',
          'X-Store-Ms',
          'X-Media-Ms'
        ],
        maxAge: Duration.minutes(10)
      }
    });

    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'MediaBucketName', { value: mediaBucket.bucketName });
    new CfnOutput(this, 'VideoPosterIngestQueueUrl', { value: videoPosterIngestQueue.queueUrl });
    new CfnOutput(this, 'VideoPosterIngestQueueArn', { value: videoPosterIngestQueue.queueArn });
    new CfnOutput(this, 'VideoPosterIngestDlqUrl', { value: videoPosterIngestDlq.queueUrl });
    new CfnOutput(this, 'MediaCdnDomainName', { value: mediaDistribution.distributionDomainName });
    if (premiumMediaDistribution) {
      new CfnOutput(this, 'PremiumMediaCdnDomainName', { value: premiumMediaDistribution.distributionDomainName });
      new CfnOutput(this, 'PremiumMediaKeyGroupId', { value: keyGroup!.keyGroupId });
      new CfnOutput(this, 'PremiumMediaPublicKeyId', { value: premiumPublicKey!.publicKeyId });
    }
    new CfnOutput(this, 'ContentCoreTableName', { value: contentCoreTable.tableName });
    new CfnOutput(this, 'ContentStatsTableName', { value: contentStatsTable.tableName });
    new CfnOutput(this, 'TrendingFeedTableName', { value: trendingFeedTable.tableName });
    new CfnOutput(this, 'SiteSettingsTableName', { value: siteSettingsTable.tableName });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'AdminsGroupName', { value: adminsGroup.groupName || 'Admins' });
    new CfnOutput(this, 'CreatorsGroupName', { value: creatorsGroup.ref });
    new CfnOutput(this, 'UsersGroupName', { value: usersGroup.groupName || 'Users' });
  }
}
