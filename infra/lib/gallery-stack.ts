import * as path from 'path';
import * as fs from 'fs';
import { Duration, RemovalPolicy, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

export class GalleryStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const artistsTable = new dynamodb.Table(this, 'ArtistsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const galleriesTable = new dynamodb.Table(this, 'GalleriesTable', {
      partitionKey: { name: 'galleryId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });
    galleriesTable.addGlobalSecondaryIndex({
      indexName: 'slugIndex',
      partitionKey: { name: 'slug', type: dynamodb.AttributeType.STRING }
    });
    galleriesTable.addGlobalSecondaryIndex({
      indexName: 'artistSlugIndex',
      partitionKey: { name: 'artistSlug', type: dynamodb.AttributeType.STRING }
    });

    const imagesTable = new dynamodb.Table(this, 'ImagesTable', {
      partitionKey: { name: 'galleryId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'imageId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const commentsTable = new dynamodb.Table(this, 'CommentsTable', {
      partitionKey: { name: 'targetKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdSort', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });
    commentsTable.addGlobalSecondaryIndex({
      indexName: 'commentIdIndex',
      partitionKey: { name: 'commentId', type: dynamodb.AttributeType.STRING }
    });

    const favoritesTable = new dynamodb.Table(this, 'FavoritesTable', {
      partitionKey: { name: 'userKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'targetKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });
    favoritesTable.addGlobalSecondaryIndex({
      indexName: 'targetKeyIndex',
      partitionKey: { name: 'targetKey', type: dynamodb.AttributeType.STRING }
    });

    const blockedUsersTable = new dynamodb.Table(this, 'BlockedUsersTable', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const siteSettingsTable = new dynamodb.Table(this, 'SiteSettingsTable', {
      partitionKey: { name: 'settingId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const imageStatsTable = new dynamodb.Table(this, 'ImageStatsTable', {
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

    const galleryCoreTable = new dynamodb.Table(this, 'GalleryCoreTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });
    galleryCoreTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING }
    });
    galleryCoreTable.addGlobalSecondaryIndex({
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
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedHeaders: ['*']
        }
      ]
    });

    const mediaOrigin = origins.S3BucketOrigin.withOriginAccessControl(mediaBucket);
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
            trustedKeyGroups: [keyGroup],
            compress: true
          },
          comment: 'Ubeeq premium media CDN'
        })
      : undefined;

    const userPool = new cognito.UserPool(this, 'GalleryUserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } }
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'GalleryUserPoolClient', {
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

    const adminsGroup = new cognito.CfnUserPoolGroup(this, 'AdminsGroup', {
      groupName: 'Admins',
      userPoolId: userPool.userPoolId,
      description: 'Admin users allowed to access orchestration endpoints'
    });

    const artistsGroup = new cognito.CfnUserPoolGroup(this, 'ArtistsGroup', {
      groupName: 'Artists',
      userPoolId: userPool.userPoolId,
      description: 'Artist users allowed to create galleries and media'
    });

    const usersGroup = new cognito.CfnUserPoolGroup(this, 'UsersGroup', {
      groupName: 'Users',
      userPoolId: userPool.userPoolId,
      description: 'General authenticated users'
    });

    const apiFn = new lambdaNodejs.NodejsFunction(this, 'GalleryApiFunction', {
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
        ARTISTS_TABLE: artistsTable.tableName,
        GALLERIES_TABLE: galleriesTable.tableName,
        IMAGES_TABLE: imagesTable.tableName,
        COMMENTS_TABLE: commentsTable.tableName,
        FAVORITES_TABLE: favoritesTable.tableName,
        BLOCKED_USERS_TABLE: blockedUsersTable.tableName,
        SITE_SETTINGS_TABLE: siteSettingsTable.tableName,
        IMAGE_STATS_TABLE: imageStatsTable.tableName,
        TRENDING_FEED_TABLE: trendingFeedTable.tableName,
        GALLERY_CORE_TABLE: galleryCoreTable.tableName,
        USE_GALLERY_CORE_TABLE: 'true',
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
        ARTISTS_TABLE: artistsTable.tableName,
        GALLERIES_TABLE: galleriesTable.tableName,
        IMAGES_TABLE: imagesTable.tableName,
        COMMENTS_TABLE: commentsTable.tableName,
        FAVORITES_TABLE: favoritesTable.tableName,
        BLOCKED_USERS_TABLE: blockedUsersTable.tableName,
        SITE_SETTINGS_TABLE: siteSettingsTable.tableName,
        IMAGE_STATS_TABLE: imageStatsTable.tableName,
        TRENDING_FEED_TABLE: trendingFeedTable.tableName,
        GALLERY_CORE_TABLE: galleryCoreTable.tableName,
        USE_GALLERY_CORE_TABLE: 'true',
        MEDIA_BUCKET: mediaBucket.bucketName,
        TRENDING_FEED_MAX_ITEMS: '600',
        TRENDING_CANDIDATE_LIMIT: '1500'
      }
    });
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminUpdateUserAttributes'],
        resources: [userPool.userPoolArn]
      })
    );

    artistsTable.grantReadWriteData(apiFn);
    galleriesTable.grantReadWriteData(apiFn);
    imagesTable.grantReadWriteData(apiFn);
    commentsTable.grantReadWriteData(apiFn);
    favoritesTable.grantReadWriteData(apiFn);
    blockedUsersTable.grantReadWriteData(apiFn);
    siteSettingsTable.grantReadWriteData(apiFn);
    imageStatsTable.grantReadWriteData(apiFn);
    trendingFeedTable.grantReadWriteData(apiFn);
    galleryCoreTable.grantReadWriteData(apiFn);
    mediaBucket.grantReadWrite(apiFn);
    artistsTable.grantReadData(trendingRankerFn);
    galleriesTable.grantReadData(trendingRankerFn);
    imagesTable.grantReadData(trendingRankerFn);
    favoritesTable.grantReadWriteData(trendingRankerFn);
    imageStatsTable.grantReadWriteData(trendingRankerFn);
    trendingFeedTable.grantReadWriteData(trendingRankerFn);
    galleryCoreTable.grantReadData(trendingRankerFn);

    new events.Rule(this, 'TrendingRankerSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(trendingRankerFn)]
    });

    const api = new apigw.LambdaRestApi(this, 'GalleryApi', {
      handler: apiFn,
      proxy: true
    });

    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'MediaBucketName', { value: mediaBucket.bucketName });
    new CfnOutput(this, 'MediaCdnDomainName', { value: mediaDistribution.distributionDomainName });
    if (premiumMediaDistribution) {
      new CfnOutput(this, 'PremiumMediaCdnDomainName', { value: premiumMediaDistribution.distributionDomainName });
      new CfnOutput(this, 'PremiumMediaKeyGroupId', { value: keyGroup!.keyGroupId });
      new CfnOutput(this, 'PremiumMediaPublicKeyId', { value: premiumPublicKey!.publicKeyId });
    }
    new CfnOutput(this, 'GalleryCoreTableName', { value: galleryCoreTable.tableName });
    new CfnOutput(this, 'ImageStatsTableName', { value: imageStatsTable.tableName });
    new CfnOutput(this, 'TrendingFeedTableName', { value: trendingFeedTable.tableName });
    new CfnOutput(this, 'SiteSettingsTableName', { value: siteSettingsTable.tableName });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'AdminsGroupName', { value: adminsGroup.groupName || 'Admins' });
    new CfnOutput(this, 'ArtistsGroupName', { value: artistsGroup.groupName || 'Artists' });
    new CfnOutput(this, 'UsersGroupName', { value: usersGroup.groupName || 'Users' });
  }
}
