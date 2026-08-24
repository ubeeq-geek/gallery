import * as path from 'path';
import * as fs from 'fs';
import { Duration, RemovalPolicy, Stack, StackProps, CfnOutput, SecretValue, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
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
import * as backup from 'aws-cdk-lib/aws-backup';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';

export class UbeeqStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const deploymentStage = (process.env.DEPLOYMENT_STAGE || 'development').trim().toLowerCase();
    const isProduction = deploymentStage === 'production' || deploymentStage === 'prod';
    const dataRemovalPolicy = isProduction ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const appSecretsName = process.env.APP_SECRETS_NAME?.trim();
    if (isProduction && !appSecretsName) {
      throw new Error('APP_SECRETS_NAME is required when DEPLOYMENT_STAGE=production.');
    }
    const appSecrets = isProduction
      ? secretsmanager.Secret.fromSecretNameV2(this, 'ApplicationSecrets', appSecretsName!)
      : undefined;
    const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
    const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
    const appleServiceId = process.env.APPLE_SERVICE_ID?.trim();
    const appleTeamId = process.env.APPLE_TEAM_ID?.trim();
    const appleKeyId = process.env.APPLE_KEY_ID?.trim();
    const applePrivateKey = process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
    const socialGoogleEnabled = Boolean(googleClientId && (isProduction || googleClientSecret));
    const socialAppleEnabled = Boolean(appleServiceId && appleTeamId && appleKeyId && (isProduction || applePrivateKey));
    const cognitoDomainPrefix = process.env.COGNITO_DOMAIN_PREFIX?.trim();
    const sesFromAddress = process.env.SES_FROM_ADDRESS?.trim();
    // A verified domain authorizes every sender at that domain. Prefer it to
    // an individual mailbox identity so Cognito does not depend on a mailbox
    // verification that may still be pending.
    const sesVerifiedDomain = process.env.SES_VERIFIED_DOMAIN?.trim() || sesFromAddress?.split('@').at(-1);
    const webAppUrl = process.env.WEB_APP_URL?.trim().replace(/\/$/, '');
    const rootDomain = process.env.ROOT_DOMAIN?.trim().toLowerCase();
    const apiDomain = process.env.API_DOMAIN?.trim().toLowerCase();
    const hostedZoneId = process.env.HOSTED_ZONE_ID?.trim();
    const apiCertificateArn = process.env.API_CERTIFICATE_ARN?.trim();
    const webCertificateArn = process.env.WEB_CERTIFICATE_ARN?.trim();
    const manageFullProductDomains = process.env.ENABLE_FULL_PRODUCT_DOMAINS === 'true';
    // Development can optionally publish the built web app behind a disposable
    // CloudFront URL without requiring Route53, ACM, or a DNS cutover. This is
    // intentionally opt-in so a normal local/dev API deploy remains unchanged.
    const manageDevWebHosting = !isProduction && process.env.ENABLE_DEV_WEB_HOSTING === 'true';
    if (isProduction && !webAppUrl) {
      throw new Error('WEB_APP_URL is required when DEPLOYMENT_STAGE=production so CORS can be restricted.');
    }
    const domainValues = [rootDomain, apiDomain, hostedZoneId, apiCertificateArn, webCertificateArn];
    if (manageFullProductDomains && domainValues.some((value) => !value)) {
      throw new Error('ROOT_DOMAIN, API_DOMAIN, HOSTED_ZONE_ID, API_CERTIFICATE_ARN, and WEB_CERTIFICATE_ARN must be supplied together.');
    }
    const developmentOrigins = ['http://localhost:5173', 'https://fanadmin.top:5174', 'https://fanadmin.top:5175'];
    const mediaCorsOrigins = isProduction ? [webAppUrl!] : [...new Set([...(webAppUrl ? [webAppUrl] : []), ...developmentOrigins])];
    const productBrand = process.env.PRODUCT_BRAND === 'eversally' ? 'eversally' : 'ubeeq';
    const productName = productBrand === 'eversally' ? 'Eversally' : 'Ubeeq';
    const adminEmail = process.env.ADMIN_EMAIL?.trim()
      || (productBrand === 'eversally' ? 'admin@eversally.com' : 'admin@ubeeq.site');
    const emailTheme = productBrand === 'eversally'
      ? { accent: '#7756a8', panel: '#f4effa', text: '#21182f', tagline: 'Creativity, everywhere.' }
      : { accent: '#0f766e', panel: '#eaf6f4', text: '#102a2a', tagline: 'Your creative space, on your terms.' };
    const cognitoCallbackUrls = isProduction
      ? [`${webAppUrl}/auth/callback`]
      : ['http://localhost:5173/auth/callback', 'http://localhost:5174/auth/callback', ...(webAppUrl ? [`${webAppUrl}/auth/callback`] : [])];
    const cognitoLogoutUrls = isProduction
      ? [webAppUrl!]
      : ['http://localhost:5173', 'http://localhost:5174', ...(webAppUrl ? [webAppUrl] : [])];

    Tags.of(this).add('DeploymentStage', isProduction ? 'production' : deploymentStage);
    Tags.of(this).add('ProductBrand', productBrand);

    const siteSettingsTable = new dynamodb.Table(this, 'SiteSettingsTable', {
      partitionKey: { name: 'settingId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: isProduction ? { pointInTimeRecoveryEnabled: true } : undefined,
      deletionProtection: isProduction,
      removalPolicy: dataRemovalPolicy
    });

    const contentStatsTable = new dynamodb.Table(this, 'ContentStatsTable', {
      partitionKey: { name: 'imageId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: isProduction ? { pointInTimeRecoveryEnabled: true } : undefined,
      deletionProtection: isProduction,
      removalPolicy: dataRemovalPolicy
    });

    const trendingFeedTable = new dynamodb.Table(this, 'TrendingFeedTable', {
      partitionKey: { name: 'period', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'rankKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: isProduction ? { pointInTimeRecoveryEnabled: true } : undefined,
      deletionProtection: isProduction,
      removalPolicy: dataRemovalPolicy
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
      timeToLiveAttribute: 'ttlEpochSeconds',
      pointInTimeRecoverySpecification: isProduction ? { pointInTimeRecoveryEnabled: true } : undefined,
      deletionProtection: isProduction,
      removalPolicy: dataRemovalPolicy
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
      enforceSSL: true,
      versioned: isProduction,
      removalPolicy: dataRemovalPolicy,
      autoDeleteObjects: !isProduction,
      lifecycleRules: isProduction ? [{
        id: 'RetainRecoverableVersions',
        enabled: true,
        abortIncompleteMultipartUploadAfter: Duration.days(7),
        noncurrentVersionExpiration: Duration.days(Number(process.env.MEDIA_NONCURRENT_VERSION_RETENTION_DAYS || 90))
      }] : undefined,
      cors: [
        {
          allowedOrigins: mediaCorsOrigins,
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD, s3.HttpMethods.PUT],
          allowedHeaders: ['*'],
          exposedHeaders: ['Accept-Ranges', 'Content-Range', 'Content-Length', 'Content-Type', 'ETag'],
          maxAge: 86400
        }
      ]
    });
    let productionBackupPlan: backup.BackupPlan | undefined;
    let productionBackupVault: backup.BackupVault | undefined;
    if (isProduction) {
      productionBackupVault = new backup.BackupVault(this, 'ProductionBackupVault', {
        removalPolicy: RemovalPolicy.RETAIN,
        lockConfiguration: {
          minRetention: Duration.days(35),
          maxRetention: Duration.days(366)
        }
      });
      productionBackupPlan = new backup.BackupPlan(this, 'ProductionBackupPlan', {
        backupVault: productionBackupVault,
        backupPlanRules: [
          new backup.BackupPlanRule({
            ruleName: 'Daily35DayRetention',
            scheduleExpression: events.Schedule.cron({ minute: '0', hour: '5' }),
            deleteAfter: Duration.days(35)
          }),
          new backup.BackupPlanRule({
            ruleName: 'Monthly1YearRetention',
            scheduleExpression: events.Schedule.cron({ minute: '0', hour: '6', day: '1' }),
            deleteAfter: Duration.days(365)
          })
        ]
      });
      productionBackupPlan.addSelection('ProductionData', {
        resources: [
          backup.BackupResource.fromDynamoDbTable(siteSettingsTable),
          backup.BackupResource.fromDynamoDbTable(contentStatsTable),
          backup.BackupResource.fromDynamoDbTable(trendingFeedTable),
          backup.BackupResource.fromDynamoDbTable(contentCoreTable),
          backup.BackupResource.fromArn(mediaBucket.bucketArn)
        ]
      });
    }
    const videoPosterIngestDlq = new sqs.Queue(this, 'VideoPosterIngestDlq', {
      retentionPeriod: Duration.days(isProduction ? 14 : 1)
    });
    const videoPosterIngestQueue = new sqs.Queue(this, 'VideoPosterIngestQueue', {
      visibilityTimeout: Duration.minutes(5),
      receiveMessageWaitTime: Duration.seconds(20),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: videoPosterIngestDlq
      }
    });
    const externalSyncDlq = new sqs.Queue(this, 'ExternalSyncDlq', {
      retentionPeriod: Duration.days(isProduction ? 14 : 1)
    });
    const externalSyncQueue = new sqs.Queue(this, 'ExternalSyncQueue', {
      visibilityTimeout: Duration.minutes(15),
      receiveMessageWaitTime: Duration.seconds(20),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: externalSyncDlq
      }
    });
    const vimeoUploadDlq = new sqs.Queue(this, 'VimeoUploadDlq', {
      retentionPeriod: Duration.days(isProduction ? 14 : 1),
      encryption: sqs.QueueEncryption.SQS_MANAGED
    });
    const vimeoUploadQueue = new sqs.Queue(this, 'VimeoUploadQueue', {
      // Leave enough time for Lambda shutdown and SQS redelivery bookkeeping.
      visibilityTimeout: Duration.minutes(20),
      receiveMessageWaitTime: Duration.seconds(20),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { maxReceiveCount: 5, queue: vimeoUploadDlq }
    });

    const tumblrPublishDlq = new sqs.Queue(this, 'TumblrPublishDlq', { retentionPeriod: Duration.days(isProduction ? 14 : 1) });
    const tumblrPublishQueue = new sqs.Queue(this, 'TumblrPublishQueue', {
      visibilityTimeout: Duration.minutes(2),
      receiveMessageWaitTime: Duration.seconds(20),
      deadLetterQueue: { maxReceiveCount: 5, queue: tumblrPublishDlq }
    });
    const discordCommunityDeliveryDlq = new sqs.Queue(this, 'DiscordCommunityDeliveryDlq', {
      retentionPeriod: Duration.days(isProduction ? 14 : 1)
    });
    const discordCommunityDeliveryQueue = new sqs.Queue(this, 'DiscordCommunityDeliveryQueue', {
      visibilityTimeout: Duration.minutes(2),
      receiveMessageWaitTime: Duration.seconds(20),
      deadLetterQueue: { maxReceiveCount: 5, queue: discordCommunityDeliveryDlq }
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
        accessControlAllowOrigins: isProduction ? [webAppUrl!] : ['*'],
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
    const cloudFrontPrivateKey = isProduction && cloudFrontPublicKeyPem
      ? appSecrets!.secretValueFromJson('cloudFrontPrivateKey').unsafeUnwrap()
      : (
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
      removalPolicy: dataRemovalPolicy,
      deletionProtection: isProduction,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      email: sesFromAddress
        ? cognito.UserPoolEmail.withSES({
            fromEmail: sesFromAddress,
            fromName: productName,
            replyTo: sesFromAddress,
            sesVerifiedDomain
          })
        : undefined,
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE,
        emailSubject: `Confirm your ${productName} account`,
        emailBody: `<div style="margin:0;padding:32px 16px;background:#f7f7f8;font-family:Arial,Helvetica,sans-serif;color:${emailTheme.text}"><div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e2e7;border-radius:16px;overflow:hidden"><div style="padding:28px 32px;background:${emailTheme.panel};border-bottom:4px solid ${emailTheme.accent}"><div style="font-size:24px;font-weight:700;color:${emailTheme.accent}">${productName}</div><div style="margin-top:6px;font-size:14px;color:${emailTheme.text}">${emailTheme.tagline}</div></div><div style="padding:32px"><h1 style="margin:0 0 12px;font-size:26px;line-height:1.2">Confirm your email</h1><p style="margin:0;font-size:16px;line-height:1.55">Use this code to verify your email and finish setting up your ${productName} account.</p><div style="margin:28px 0;padding:18px;background:${emailTheme.panel};border-radius:10px;font-size:28px;font-weight:700;letter-spacing:5px;text-align:center">{####}</div><p style="margin:0;font-size:13px;line-height:1.5;color:#625d69">If you did not create an account, you can safely ignore this email.</p></div></div></div>`
      }
    });
    const userPoolCfn = userPool.node.defaultChild as cognito.CfnUserPool;
    userPoolCfn.addPropertyOverride('Policies.SignInPolicy.AllowedFirstAuthFactors', [
      'PASSWORD',
      'EMAIL_OTP'
    ]);

    const googleProvider = socialGoogleEnabled
      ? new cognito.UserPoolIdentityProviderGoogle(this, 'GoogleIdentityProvider', {
          userPool,
          clientId: googleClientId!,
          clientSecretValue: isProduction
            ? appSecrets!.secretValueFromJson('googleClientSecret')
            : SecretValue.unsafePlainText(googleClientSecret!),
          scopes: ['openid', 'email', 'profile'],
          attributeMapping: {
            email: cognito.ProviderAttribute.GOOGLE_EMAIL,
            fullname: cognito.ProviderAttribute.GOOGLE_NAME
          }
        })
      : undefined;
    const appleProvider = socialAppleEnabled
      ? new cognito.UserPoolIdentityProviderApple(this, 'AppleIdentityProvider', {
          userPool,
          clientId: appleServiceId!,
          teamId: appleTeamId!,
          keyId: appleKeyId!,
          privateKeyValue: isProduction
            ? appSecrets!.secretValueFromJson('applePrivateKey')
            : SecretValue.unsafePlainText(applePrivateKey!),
          scopes: ['name', 'email'],
          attributeMapping: {
            email: cognito.ProviderAttribute.APPLE_EMAIL,
            fullname: cognito.ProviderAttribute.APPLE_NAME
          }
        })
      : undefined;
    const userPoolDomain = cognitoDomainPrefix
      ? userPool.addDomain('UbeeqCognitoDomain', {
          cognitoDomain: { domainPrefix: cognitoDomainPrefix },
          managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN
        })
      : undefined;

    const userPoolClient = new cognito.UserPoolClient(this, 'UbeeqUserPoolClient', {
      userPool,
      authFlows: {
        userPassword: true,
        userSrp: true
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls: cognitoCallbackUrls,
        logoutUrls: cognitoLogoutUrls
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
        ...(googleProvider ? [cognito.UserPoolClientIdentityProvider.GOOGLE] : []),
        ...(appleProvider ? [cognito.UserPoolClientIdentityProvider.APPLE] : [])
      ],
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
    if (googleProvider) userPoolClient.node.addDependency(googleProvider);
    if (appleProvider) userPoolClient.node.addDependency(appleProvider);

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

    const externalTokenEncryptionKey = isProduction
      ? appSecrets!.secretValueFromJson('externalTokenEncryptionKey').unsafeUnwrap()
      : (process.env.EXTERNAL_TOKEN_ENCRYPTION_KEY || '');
    const unlockJwtSecret = isProduction
      ? appSecrets!.secretValueFromJson('unlockJwtSecret').unsafeUnwrap()
      : (process.env.UNLOCK_JWT_SECRET || 'dev-secret');
    const vimeoClientId = process.env.VIMEO_CLIENT_ID?.trim() || '';
    const vimeoOAuthRedirectUri = process.env.VIMEO_OAUTH_REDIRECT_URI?.trim() || '';
    const vimeoClientSecret = isProduction
      ? appSecrets!.secretValueFromJson('vimeoClientSecret').unsafeUnwrap()
      : (process.env.VIMEO_CLIENT_SECRET?.trim() || '');
    const vimeoWebhookSecret = isProduction
      ? appSecrets!.secretValueFromJson('vimeoWebhookSecret').unsafeUnwrap()
      : (process.env.VIMEO_WEBHOOK_SECRET?.trim() || '');
    const discordClientId = process.env.DISCORD_CLIENT_ID?.trim() || '';
    const discordOAuthRedirectUri = process.env.DISCORD_OAUTH_REDIRECT_URI?.trim() || '';
    const tumblrClientId = process.env.TUMBLR_CLIENT_ID?.trim() || '';
    const tumblrClientSecret = tumblrClientId && isProduction
      ? appSecrets!.secretValueFromJson('tumblrClientSecret').unsafeUnwrap()
      : (process.env.TUMBLR_CLIENT_SECRET || '');
    const tumblrOAuthRedirectUri = process.env.TUMBLR_OAUTH_REDIRECT_URI?.trim() || '';
    // A shared development Discord app is still a confidential OAuth client:
    // let any deployment use a dedicated secret rather than putting its bot
    // token or client secret in CDK configuration. Production defaults to the
    // application secret, while development opts in with DISCORD_SECRETS_NAME.
    const discordSecretsName = process.env.DISCORD_SECRETS_NAME?.trim()
      || (isProduction ? appSecretsName : undefined);
    const discordSecrets = discordSecretsName
      ? secretsmanager.Secret.fromSecretNameV2(this, 'DiscordIntegrationSecrets', discordSecretsName)
      : undefined;
    const discordEnabled = Boolean(
      discordClientId
      && discordOAuthRedirectUri
      && (discordSecrets || (process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_BOT_TOKEN))
    );
    const discordClientSecret = discordEnabled && discordSecrets
      ? discordSecrets.secretValueFromJson('discordClientSecret').unsafeUnwrap()
      : (process.env.DISCORD_CLIENT_SECRET?.trim() || '');
    const discordBotToken = discordEnabled && discordSecrets
      ? discordSecrets.secretValueFromJson('discordBotToken').unsafeUnwrap()
      : (process.env.DISCORD_BOT_TOKEN?.trim() || '');
    // YouTube is optional. Unlike the product's core secrets, do not assume
    // APP_SECRETS_NAME contains this field: enabling a new optional adapter
    // must not break an existing deployment. Point YOUTUBE_SECRETS_NAME at a
    // JSON secret with youtubeOAuthClientSecret when the adapter is enabled.
    const youtubeOAuthClientId = process.env.YOUTUBE_OAUTH_CLIENT_ID?.trim() || '';
    const youtubeOAuthRedirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI?.trim() || '';
    const youtubeSecretsName = process.env.YOUTUBE_SECRETS_NAME?.trim();
    const youtubeSecrets = youtubeSecretsName
      ? secretsmanager.Secret.fromSecretNameV2(this, 'YouTubeIntegrationSecrets', youtubeSecretsName)
      : undefined;
    const youtubeOAuthClientSecret = youtubeSecrets
      ? youtubeSecrets.secretValueFromJson('youtubeOAuthClientSecret').unsafeUnwrap()
      : (process.env.YOUTUBE_OAUTH_CLIENT_SECRET?.trim() || '');
    // Keep the bootstrap password out of source control and plain-text CDK
    // configuration in production. Local/development deployments may provide
    // ADMIN_PASSWORD directly; production reads adminPassword from the
    // existing application secret JSON document.
    const adminPassword = process.env.ADMIN_PASSWORD?.trim()
      || (isProduction ? appSecrets!.secretValueFromJson('adminPassword').unsafeUnwrap() : '');
    const productionFunctionLogGroups = new Map<string, logs.LogGroup>();
    const productionFunctionOptions = (logGroupId: string) => {
      if (!isProduction) return {};
      const logGroup = new logs.LogGroup(this, logGroupId, {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.RETAIN
      });
      productionFunctionLogGroups.set(logGroupId, logGroup);
      return {
        loggingFormat: lambda.LoggingFormat.JSON,
        applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
        systemLogLevelV2: lambda.SystemLogLevel.INFO,
        logGroup,
        tracing: lambda.Tracing.ACTIVE
      };
    };

    // Cognito only permits custom messages when email is delivered through SES
    // (the Developer email configuration). Without SES the managed sender still
    // receives the branded sign-up template above, but reset/auth codes remain
    // Cognito-managed rather than failing delivery.
    if (sesFromAddress) {
      const cognitoCustomMessageFn = new lambdaNodejs.NodejsFunction(this, 'CognitoCustomMessageFunction', {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: path.join(__dirname, '../../apps/api/src/cognitoCustomMessage.ts'),
        handler: 'handler',
        timeout: Duration.seconds(10),
        depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
        bundling: { target: 'node22', externalModules: ['@aws-sdk/*'] },
        ...productionFunctionOptions('CognitoCustomMessageFunctionLogs'),
        environment: { PRODUCT_BRAND: productBrand }
      });
      userPool.addTrigger(cognito.UserPoolOperation.CUSTOM_MESSAGE, cognitoCustomMessageFn);
    }

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
      ...productionFunctionOptions('ApiFunctionLogs'),
      environment: {
        DEPLOYMENT_STAGE: isProduction ? 'production' : deploymentStage,
        SITE_SETTINGS_TABLE: siteSettingsTable.tableName,
        CONTENT_STATS_TABLE: contentStatsTable.tableName,
        TRENDING_FEED_TABLE: trendingFeedTable.tableName,
        CONTENT_CORE_TABLE: contentCoreTable.tableName,
        USE_CONTENT_CORE_TABLE: 'true',
        MEDIA_BUCKET: mediaBucket.bucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        COGNITO_TOKEN_USE: 'id',
        ADMIN_EMAIL: adminEmail,
        ADMIN_PASSWORD: adminPassword,
        SES_FROM_ADDRESS: sesFromAddress || '',
        INTEGRATION_REQUEST_TO_ADDRESS: process.env.INTEGRATION_REQUEST_TO_ADDRESS?.trim()
          || (productBrand === 'eversally' ? 'hello@eversally.com' : 'hello@ubeeq.site'),
        EXTERNAL_SYNC_QUEUE_URL: externalSyncQueue.queueUrl,
        VIMEO_UPLOAD_QUEUE_URL: vimeoUploadQueue.queueUrl,
        VIMEO_CLIENT_ID: vimeoClientId,
        VIMEO_CLIENT_SECRET: vimeoClientSecret,
        VIMEO_OAUTH_REDIRECT_URI: vimeoOAuthRedirectUri,
        VIMEO_WEBHOOK_SECRET: vimeoWebhookSecret,
        DISCORD_COMMUNITY_QUEUE_URL: discordCommunityDeliveryQueue.queueUrl,
        DISCORD_CLIENT_ID: discordClientId,
        DISCORD_CLIENT_SECRET: discordClientSecret,
        DISCORD_BOT_TOKEN: discordBotToken,
        DISCORD_OAUTH_REDIRECT_URI: discordOAuthRedirectUri,
        YOUTUBE_OAUTH_CLIENT_ID: youtubeOAuthClientId,
        YOUTUBE_OAUTH_CLIENT_SECRET: youtubeOAuthClientSecret,
        YOUTUBE_OAUTH_REDIRECT_URI: youtubeOAuthRedirectUri,
        YOUTUBE_MIN_REQUEST_INTERVAL_MS: process.env.YOUTUBE_MIN_REQUEST_INTERVAL_MS || '1000',
        YOUTUBE_API_BASE_URL: process.env.YOUTUBE_API_BASE_URL || 'https://www.googleapis.com/youtube/v3',
        TUMBLR_CLIENT_ID: tumblrClientId,
        TUMBLR_CLIENT_SECRET: tumblrClientSecret,
        TUMBLR_OAUTH_REDIRECT_URI: tumblrOAuthRedirectUri,
        TUMBLR_PUBLISH_QUEUE_URL: tumblrPublishQueue.queueUrl,
        TUMBLR_POLICY_RULES_JSON: process.env.TUMBLR_POLICY_RULES_JSON || '[]',
        EXTERNAL_ACCOUNT_SCAN_INTERVAL_SECONDS: '21600',
        EXTERNAL_ACTIVITY_SCAN_INTERVAL_SECONDS: '120',
        DEVIANTART_MIN_REQUEST_INTERVAL_MS: process.env.DEVIANTART_MIN_REQUEST_INTERVAL_MS || '2000',
        DEVIANTART_PUBLISHED_DESCRIPTION_UPDATE: process.env.DEVIANTART_PUBLISHED_DESCRIPTION_UPDATE || 'true',
        PRODUCT_BRAND: productBrand,
        TENANT_ID: process.env.TENANT_ID || productBrand,
        EXTERNAL_OAUTH_REDIRECT_URI: process.env.EXTERNAL_OAUTH_REDIRECT_URI || '',
        SOUNDCLOUD_ENABLED: process.env.SOUNDCLOUD_ENABLED || 'false',
        SOUNDCLOUD_OAUTH_REDIRECT_URI: process.env.SOUNDCLOUD_OAUTH_REDIRECT_URI || '',
        EXTERNAL_TOKEN_ENCRYPTION_KEY: externalTokenEncryptionKey,
        // The Bluesky broker is separately deployed so DPoP refresh tokens do
        // not enter the main product API. These are public endpoints only.
        BLUESKY_OAUTH_SERVICE_URL: process.env.BLUESKY_OAUTH_SERVICE_URL || '',
        BLUESKY_OAUTH_SERVICE_JWKS_URL: process.env.BLUESKY_OAUTH_SERVICE_JWKS_URL || '',
        UNLOCK_JWT_SECRET: unlockJwtSecret,
        // Keep the API's browser origin aligned with the deployed web host in
        // development as well as production.  Without this fallback, a
        // disposable CloudFront deployment has a valid API Gateway preflight
        // but Express rejects the subsequent GET/POST requests as CORS
        // violations because APP_ORIGIN is empty.
        APP_ORIGIN: isProduction ? webAppUrl! : (process.env.APP_ORIGIN || webAppUrl || ''),
        TRENDING_FEED_MAX_ITEMS: '600',
        TRENDING_CANDIDATE_LIMIT: '1500',
        MEDIA_CDN_DOMAIN: mediaDistribution.distributionDomainName,
        PREMIUM_MEDIA_CDN_DOMAIN: premiumMediaDistribution?.distributionDomainName || '',
        CLOUDFRONT_KEY_PAIR_ID: premiumPublicKey?.publicKeyId || '',
        CLOUDFRONT_PRIVATE_KEY: cloudFrontPrivateKey
      }
    });
    if (sesFromAddress) {
      apiFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*']
      }));
    }
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
      ...productionFunctionOptions('TrendingRankerFunctionLogs'),
      environment: {
        DEPLOYMENT_STAGE: isProduction ? 'production' : deploymentStage,
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
    const externalSyncFn = new lambdaNodejs.NodejsFunction(this, 'ExternalSyncFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../apps/api/src/externalSyncHandler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(15),
      memorySize: 1024,
      // Reserve a worker only when the account has spare Lambda capacity.
      // Small/development accounts can require all unreserved capacity to stay
      // available. Provider pacing still applies per request in the worker.
      reservedConcurrentExecutions: process.env.EXTERNAL_SYNC_RESERVED_CONCURRENCY === '1' ? 1 : undefined,
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      bundling: {
        target: 'node22',
        externalModules: ['@aws-sdk/*']
      },
      ...productionFunctionOptions('ExternalSyncFunctionLogs'),
      environment: {
        DEPLOYMENT_STAGE: isProduction ? 'production' : deploymentStage,
        CONTENT_CORE_TABLE: contentCoreTable.tableName,
        USE_CONTENT_CORE_TABLE: 'true',
        MEDIA_BUCKET: mediaBucket.bucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        EXTERNAL_SYNC_QUEUE_URL: externalSyncQueue.queueUrl,
        EXTERNAL_TOKEN_ENCRYPTION_KEY: externalTokenEncryptionKey,
        UNLOCK_JWT_SECRET: unlockJwtSecret,
        EXTERNAL_SYNC_BASE_DELAY_SECONDS: '60',
        EXTERNAL_SCHEDULED_SCANS_ENABLED: process.env.EXTERNAL_SCHEDULED_SCANS_ENABLED || (isProduction ? 'true' : 'false'),
        EXTERNAL_ACCOUNT_SCAN_INTERVAL_SECONDS: '21600',
        EXTERNAL_ACTIVITY_SCAN_INTERVAL_SECONDS: '120',
        DEVIANTART_MIN_REQUEST_INTERVAL_MS: process.env.DEVIANTART_MIN_REQUEST_INTERVAL_MS || '2000',
        DEVIANTART_PUBLISHED_DESCRIPTION_UPDATE: process.env.DEVIANTART_PUBLISHED_DESCRIPTION_UPDATE || 'true',
        YOUTUBE_MIN_REQUEST_INTERVAL_MS: process.env.YOUTUBE_MIN_REQUEST_INTERVAL_MS || '1000',
        YOUTUBE_API_BASE_URL: process.env.YOUTUBE_API_BASE_URL || 'https://www.googleapis.com/youtube/v3',
        PRODUCT_BRAND: productBrand,
        TENANT_ID: process.env.TENANT_ID || productBrand,
        APP_ORIGIN: isProduction ? webAppUrl! : (process.env.APP_ORIGIN || webAppUrl || '')
      }
    });
    const vimeoUploadFn = new lambdaNodejs.NodejsFunction(this, 'VimeoUploadFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../apps/api/src/vimeoUploadHandler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(15),
      memorySize: 1024,
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      bundling: { target: 'node22', externalModules: ['@aws-sdk/*'] },
      ...productionFunctionOptions('VimeoUploadFunctionLogs'),
      environment: {
        DEPLOYMENT_STAGE: isProduction ? 'production' : deploymentStage,
        CONTENT_CORE_TABLE: contentCoreTable.tableName,
        USE_CONTENT_CORE_TABLE: 'true',
        MEDIA_BUCKET: mediaBucket.bucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        EXTERNAL_TOKEN_ENCRYPTION_KEY: externalTokenEncryptionKey,
        UNLOCK_JWT_SECRET: unlockJwtSecret,
        PRODUCT_BRAND: productBrand,
        TENANT_ID: process.env.TENANT_ID || productBrand,
        APP_ORIGIN: isProduction ? webAppUrl! : (process.env.APP_ORIGIN || '')
      }
    });
    const vimeoReconciliationFn = new lambdaNodejs.NodejsFunction(this, 'VimeoReconciliationFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../apps/api/src/vimeoReconciliationHandler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(5),
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      bundling: { target: 'node22', externalModules: ['@aws-sdk/*'] },
      ...productionFunctionOptions('VimeoReconciliationFunctionLogs'),
      environment: {
        DEPLOYMENT_STAGE: isProduction ? 'production' : deploymentStage,
        CONTENT_CORE_TABLE: contentCoreTable.tableName,
        USE_CONTENT_CORE_TABLE: 'true',
        MEDIA_BUCKET: mediaBucket.bucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        EXTERNAL_TOKEN_ENCRYPTION_KEY: externalTokenEncryptionKey,
        UNLOCK_JWT_SECRET: unlockJwtSecret,
        PRODUCT_BRAND: productBrand,
        TENANT_ID: process.env.TENANT_ID || productBrand,
        APP_ORIGIN: isProduction ? webAppUrl! : (process.env.APP_ORIGIN || '')
      }
    });
    new events.Rule(this, 'VimeoReconciliationSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(15)),
      targets: [new targets.LambdaFunction(vimeoReconciliationFn)]
    });
    const externalSyncSchedulerFn = new lambdaNodejs.NodejsFunction(this, 'ExternalSyncSchedulerFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../apps/api/src/externalSyncScheduler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(2),
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      bundling: {
        target: 'node22',
        externalModules: ['@aws-sdk/*']
      },
      ...productionFunctionOptions('ExternalSyncSchedulerFunctionLogs'),
      environment: {
        DEPLOYMENT_STAGE: isProduction ? 'production' : deploymentStage,
        CONTENT_CORE_TABLE: contentCoreTable.tableName,
        USE_CONTENT_CORE_TABLE: 'true',
        MEDIA_BUCKET: mediaBucket.bucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        EXTERNAL_SYNC_QUEUE_URL: externalSyncQueue.queueUrl,
        EXTERNAL_TOKEN_ENCRYPTION_KEY: externalTokenEncryptionKey,
        UNLOCK_JWT_SECRET: unlockJwtSecret,
        EXTERNAL_SYNC_BASE_DELAY_SECONDS: '60',
        EXTERNAL_ACCOUNT_SCAN_INTERVAL_SECONDS: '21600',
        EXTERNAL_ACTIVITY_SCAN_INTERVAL_SECONDS: '120',
        PRODUCT_BRAND: productBrand,
        TENANT_ID: process.env.TENANT_ID || productBrand,
        APP_ORIGIN: isProduction ? webAppUrl! : (process.env.APP_ORIGIN || webAppUrl || '')
      }
    });
    const discordCommunityDeliveryFn = new lambdaNodejs.NodejsFunction(this, 'DiscordCommunityDeliveryFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../apps/api/src/communityDeliveryHandler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 512,
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      bundling: { target: 'node22', externalModules: ['@aws-sdk/*'] },
      ...productionFunctionOptions('DiscordCommunityDeliveryFunctionLogs'),
      environment: {
        DEPLOYMENT_STAGE: isProduction ? 'production' : deploymentStage,
        CONTENT_CORE_TABLE: contentCoreTable.tableName,
        USE_CONTENT_CORE_TABLE: 'true',
        DISCORD_COMMUNITY_QUEUE_URL: discordCommunityDeliveryQueue.queueUrl,
        DISCORD_BOT_TOKEN: discordBotToken,
        DISCORD_API_BASE_URL: process.env.DISCORD_API_BASE_URL || 'https://discord.com/api/v10',
        PRODUCT_BRAND: productBrand,
        TENANT_ID: process.env.TENANT_ID || productBrand
      }
    });
    const tumblrPublishFn = new lambdaNodejs.NodejsFunction(this, 'TumblrPublishFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../apps/api/src/tumblrPublishHandler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 512,
      reservedConcurrentExecutions: 1,
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      bundling: { target: 'node22', externalModules: ['@aws-sdk/*'] },
      ...productionFunctionOptions('TumblrPublishFunctionLogs'),
      environment: {
        DEPLOYMENT_STAGE: isProduction ? 'production' : deploymentStage,
        CONTENT_CORE_TABLE: contentCoreTable.tableName,
        USE_CONTENT_CORE_TABLE: 'true',
        MEDIA_BUCKET: mediaBucket.bucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        EXTERNAL_TOKEN_ENCRYPTION_KEY: externalTokenEncryptionKey,
        UNLOCK_JWT_SECRET: unlockJwtSecret,
        TUMBLR_CLIENT_ID: tumblrClientId,
        TUMBLR_CLIENT_SECRET: tumblrClientSecret,
        TUMBLR_OAUTH_REDIRECT_URI: tumblrOAuthRedirectUri,
        TUMBLR_PUBLISH_QUEUE_URL: tumblrPublishQueue.queueUrl,
        TUMBLR_API_BASE_URL: process.env.TUMBLR_API_BASE_URL || 'https://api.tumblr.com',
        TUMBLR_POLICY_RULES_JSON: process.env.TUMBLR_POLICY_RULES_JSON || '[]',
        TUMBLR_HOURLY_REQUEST_LIMIT: process.env.TUMBLR_HOURLY_REQUEST_LIMIT || '1000',
        TUMBLR_DAILY_REQUEST_LIMIT: process.env.TUMBLR_DAILY_REQUEST_LIMIT || '5000',
        TUMBLR_PUBLISH_MAX_ATTEMPTS: process.env.TUMBLR_PUBLISH_MAX_ATTEMPTS || '5',
        TUMBLR_RETRY_BASE_DELAY_SECONDS: process.env.TUMBLR_RETRY_BASE_DELAY_SECONDS || '60',
        PRODUCT_BRAND: productBrand,
        TENANT_ID: process.env.TENANT_ID || productBrand,
        APP_ORIGIN: isProduction ? webAppUrl! : (process.env.APP_ORIGIN || '')
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
      ...productionFunctionOptions('VideoPosterIngestFunctionLogs'),
      layers: ffmpegLayerArn
        ? [lambda.LayerVersion.fromLayerVersionArn(this, 'VideoPosterFfmpegLayer', ffmpegLayerArn)]
        : undefined,
      environment: {
        DEPLOYMENT_STAGE: isProduction ? 'production' : deploymentStage,
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
        actions: [
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminUpdateUserAttributes'
        ],
        resources: [userPool.userPoolArn]
      })
    );

    siteSettingsTable.grantReadWriteData(apiFn);
    contentStatsTable.grantReadWriteData(apiFn);
    trendingFeedTable.grantReadWriteData(apiFn);
    contentCoreTable.grantReadWriteData(apiFn);
    contentCoreTable.grantReadWriteData(externalSyncFn);
    contentCoreTable.grantReadWriteData(externalSyncSchedulerFn);
    contentCoreTable.grantReadWriteData(discordCommunityDeliveryFn);
    const externalPublicationTransactionPolicy = new iam.PolicyStatement({
      actions: ['dynamodb:TransactWriteItems'],
      resources: [contentCoreTable.tableArn]
    });
    apiFn.addToRolePolicy(externalPublicationTransactionPolicy);
    externalSyncFn.addToRolePolicy(externalPublicationTransactionPolicy);
    mediaBucket.grantReadWrite(apiFn);
    mediaBucket.grantReadWrite(externalSyncFn);
    contentStatsTable.grantReadWriteData(trendingRankerFn);
    trendingFeedTable.grantReadWriteData(trendingRankerFn);
    contentCoreTable.grantReadData(trendingRankerFn);
    contentCoreTable.grantReadWriteData(videoPosterIngestFn);
    mediaBucket.grantReadWrite(videoPosterIngestFn);
    videoPosterIngestQueue.grantConsumeMessages(videoPosterIngestFn);
    externalSyncQueue.grantSendMessages(apiFn);
    vimeoUploadQueue.grantSendMessages(apiFn);
    discordCommunityDeliveryQueue.grantSendMessages(apiFn);
    tumblrPublishQueue.grantSendMessages(apiFn);
    externalSyncQueue.grantConsumeMessages(externalSyncFn);
    vimeoUploadQueue.grantConsumeMessages(vimeoUploadFn);
    contentCoreTable.grantReadWriteData(vimeoUploadFn);
    contentCoreTable.grantReadWriteData(vimeoReconciliationFn);
    mediaBucket.grantRead(vimeoUploadFn);
    externalSyncQueue.grantSendMessages(externalSyncSchedulerFn);
    discordCommunityDeliveryQueue.grantConsumeMessages(discordCommunityDeliveryFn);
    discordCommunityDeliveryQueue.grantSendMessages(discordCommunityDeliveryFn);
    contentCoreTable.grantReadWriteData(tumblrPublishFn);
    tumblrPublishQueue.grantConsumeMessages(tumblrPublishFn);
    tumblrPublishQueue.grantSendMessages(tumblrPublishFn);
    externalSyncFn.addEventSource(new lambdaEventSources.SqsEventSource(externalSyncQueue, {
      batchSize: 1,
      reportBatchItemFailures: true
    }));
    vimeoUploadFn.addEventSource(new lambdaEventSources.SqsEventSource(vimeoUploadQueue, {
      batchSize: 1,
      reportBatchItemFailures: true
    }));
    discordCommunityDeliveryFn.addEventSource(new lambdaEventSources.SqsEventSource(discordCommunityDeliveryQueue, {
      batchSize: 5,
      reportBatchItemFailures: true
    }));
    tumblrPublishFn.addEventSource(new lambdaEventSources.SqsEventSource(tumblrPublishQueue, { batchSize: 5, maxBatchingWindow: Duration.seconds(2), reportBatchItemFailures: true }));

    new events.Rule(this, 'TrendingRankerSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(trendingRankerFn)]
    });
    new events.Rule(this, 'ExternalSyncRetrySchedule', {
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new targets.LambdaFunction(externalSyncSchedulerFn)]
    });

    const apiAccessLogGroup = isProduction
      ? new logs.LogGroup(this, 'ApiAccessLogs', {
          retention: logs.RetentionDays.THREE_MONTHS,
          removalPolicy: RemovalPolicy.RETAIN
        })
      : undefined;
    const api = new apigw.LambdaRestApi(this, 'UbeeqApi', {
      handler: apiFn,
      proxy: true,
      deployOptions: isProduction ? {
        accessLogDestination: new apigw.LogGroupLogDestination(apiAccessLogGroup!),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false
        }),
        dataTraceEnabled: false,
        loggingLevel: apigw.MethodLoggingLevel.ERROR,
        metricsEnabled: true,
        tracingEnabled: true
      } : undefined,
      defaultCorsPreflightOptions: {
        allowOrigins: isProduction ? [webAppUrl!] : apigw.Cors.ALL_ORIGINS,
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
          'Content-Disposition',
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
    let apiCustomDomain: apigw.DomainName | undefined;
    let publicWebDistribution: cloudfront.Distribution | undefined;
    if (manageFullProductDomains && rootDomain && apiDomain && hostedZoneId && apiCertificateArn) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'PublicHostedZone', {
        hostedZoneId,
        zoneName: rootDomain
      });
      apiCustomDomain = api.addDomainName('PublicApiDomain', {
        domainName: apiDomain,
        certificate: acm.Certificate.fromCertificateArn(this, 'PublicApiCertificate', apiCertificateArn),
        endpointType: apigw.EndpointType.REGIONAL,
        securityPolicy: apigw.SecurityPolicy.TLS_1_2
      });
      new route53.ARecord(this, 'PublicApiAliasRecord', {
        zone,
        recordName: apiDomain,
        target: route53.RecordTarget.fromAlias(new route53Targets.ApiGatewayDomain(apiCustomDomain))
      });
      new route53.AaaaRecord(this, 'PublicApiIpv6AliasRecord', {
        zone,
        recordName: apiDomain,
        target: route53.RecordTarget.fromAlias(new route53Targets.ApiGatewayDomain(apiCustomDomain))
      });
    }

    if (manageFullProductDomains || manageDevWebHosting) {
      const webBucket = new s3.Bucket(this, 'PublicWebBucket', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        versioned: isProduction,
        removalPolicy: dataRemovalPolicy,
        autoDeleteObjects: !isProduction
      });
      publicWebDistribution = new cloudfront.Distribution(this, 'PublicWebDistribution', {
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true
        },
        defaultRootObject: 'index.html',
        errorResponses: [
          { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(1) },
          { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(1) }
        ],
        ...(manageFullProductDomains && rootDomain && webCertificateArn ? {
          domainNames: [rootDomain],
          certificate: acm.Certificate.fromCertificateArn(this, 'PublicWebCertificate', webCertificateArn)
        } : {}),
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021
      });
      new s3deploy.BucketDeployment(this, 'PublicWebDeployment', {
        sources: [s3deploy.Source.asset(path.join(__dirname, '../../apps/web/dist'))],
        destinationBucket: webBucket,
        distribution: publicWebDistribution,
        distributionPaths: ['/*'],
        prune: true
      });
      if (manageFullProductDomains && rootDomain && hostedZoneId) {
        const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'PublicHostedZoneForWeb', {
          hostedZoneId,
          zoneName: rootDomain
        });
        new route53.ARecord(this, 'PublicWebAliasRecord', {
          zone,
          recordName: rootDomain,
          target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(publicWebDistribution))
        });
        new route53.AaaaRecord(this, 'PublicWebIpv6AliasRecord', {
          zone,
          recordName: rootDomain,
          target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(publicWebDistribution))
        });
      }
    }

    let operationsTopic: sns.Topic | undefined;
    if (isProduction) {
      operationsTopic = new sns.Topic(this, 'OperationsAlarmTopic', {
        displayName: `${productName} production operations alarms`
      });
      operationsTopic.applyRemovalPolicy(RemovalPolicy.RETAIN);
      const alarmEmail = process.env.ALARM_NOTIFICATION_EMAIL?.trim();
      if (alarmEmail) operationsTopic.addSubscription(new subscriptions.EmailSubscription(alarmEmail));
      const alarmAction = new cloudwatchActions.SnsAction(operationsTopic);
      const alarmDefaults = {
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      };
      const alarm = (id: string, props: cloudwatch.AlarmProps) => {
        const created = new cloudwatch.Alarm(this, id, props);
        created.addAlarmAction(alarmAction);
        return created;
      };

      alarm('ExternalSyncQueueDepthAlarm', {
        ...alarmDefaults,
        alarmDescription: 'External synchronization is accumulating more work than workers are draining.',
        metric: externalSyncQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
        threshold: 100,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
      });
      alarm('ExternalSyncQueueAgeAlarm', {
        ...alarmDefaults,
        alarmDescription: 'The oldest external synchronization job has waited at least 15 minutes.',
        metric: externalSyncQueue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(5), statistic: 'Maximum' }),
        threshold: 900,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
      });
      alarm('ExternalSyncDeadLetterAlarm', {
        ...alarmDefaults,
        alarmDescription: 'At least one external synchronization job exhausted its retries.',
        metric: externalSyncDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: 'Maximum' }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
      });
      alarm('DiscordCommunityDeliveryDeadLetterAlarm', {
        ...alarmDefaults,
        alarmDescription: 'At least one Discord community delivery exhausted its retries.',
        metric: discordCommunityDeliveryDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: 'Maximum' }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
      });
      const externalSyncFailureFilter = new logs.MetricFilter(this, 'ExternalSyncJobFailureMetric', {
        logGroup: productionFunctionLogGroups.get('ExternalSyncFunctionLogs')!,
        filterPattern: logs.FilterPattern.literal('"job failed"'),
        metricNamespace: `${productName}/ExternalSync`,
        metricName: 'JobFailures',
        metricValue: '1',
        defaultValue: 0
      });
      alarm('ExternalSyncJobFailuresAlarm', {
        ...alarmDefaults,
        alarmDescription: 'An external synchronization job failed and will be retried or sent to the dead-letter queue.',
        metric: externalSyncFailureFilter.metric({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
      });
      alarm('VideoPosterQueueDepthAlarm', {
        ...alarmDefaults,
        alarmDescription: 'Video poster generation is accumulating more work than workers are draining.',
        metric: videoPosterIngestQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5), statistic: 'Maximum' }),
        threshold: 100,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
      });
      alarm('VideoPosterDeadLetterAlarm', {
        ...alarmDefaults,
        alarmDescription: 'At least one video poster job exhausted its retries.',
        metric: videoPosterIngestDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: 'Maximum' }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
      });

      [
        ['ApiLambdaErrorsAlarm', apiFn],
        ['TrendingRankerLambdaErrorsAlarm', trendingRankerFn],
        ['ExternalSyncLambdaErrorsAlarm', externalSyncFn],
        ['ExternalSyncSchedulerLambdaErrorsAlarm', externalSyncSchedulerFn],
        ['DiscordCommunityDeliveryLambdaErrorsAlarm', discordCommunityDeliveryFn],
        ['VideoPosterLambdaErrorsAlarm', videoPosterIngestFn]
      ].forEach(([alarmId, fn]) => {
        alarm(alarmId as string, {
          ...alarmDefaults,
          alarmDescription: `${(fn as lambda.IFunction).functionName} reported an invocation error.`,
          metric: (fn as lambda.IFunction).metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
        });
      });

      const apiRequests = api.metricCount({ period: Duration.minutes(5), statistic: 'Sum' });
      const apiServerErrors = api.metricServerError({ period: Duration.minutes(5), statistic: 'Sum' });
      const apiErrorRate = new cloudwatch.MathExpression({
        expression: 'IF(requests>=20,100*errors/requests,0)',
        usingMetrics: { requests: apiRequests, errors: apiServerErrors },
        period: Duration.minutes(5),
        label: 'API 5xx error rate (%)'
      });
      alarm('ApiServerErrorRateAlarm', {
        ...alarmDefaults,
        alarmDescription: 'At least 5% of API requests returned 5xx responses over five minutes (minimum 20 requests).',
        metric: apiErrorRate,
        threshold: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
      });

      new cloudwatch.Dashboard(this, 'ProductionOperationsDashboard', {
        dashboardName: `${this.stackName}-${productBrand}-operations`,
        widgets: [
          [new cloudwatch.GraphWidget({ title: 'API requests and 5xx responses', left: [apiRequests, apiServerErrors] })],
          [new cloudwatch.GraphWidget({ title: 'External sync queue', left: [externalSyncQueue.metricApproximateNumberOfMessagesVisible(), externalSyncDlq.metricApproximateNumberOfMessagesVisible()], right: [externalSyncQueue.metricApproximateAgeOfOldestMessage()] })],
          [new cloudwatch.GraphWidget({ title: 'Discord community delivery', left: [discordCommunityDeliveryQueue.metricApproximateNumberOfMessagesVisible(), discordCommunityDeliveryDlq.metricApproximateNumberOfMessagesVisible()], right: [discordCommunityDeliveryQueue.metricApproximateAgeOfOldestMessage()] })],
          [new cloudwatch.GraphWidget({ title: 'Lambda errors', left: [apiFn.metricErrors(), externalSyncFn.metricErrors(), externalSyncSchedulerFn.metricErrors(), discordCommunityDeliveryFn.metricErrors(), trendingRankerFn.metricErrors(), videoPosterIngestFn.metricErrors()] })]
        ]
      });
    }

    new CfnOutput(this, 'ApiUrl', { value: api.url });
    if (apiCustomDomain) new CfnOutput(this, 'CustomApiUrl', { value: `https://${apiCustomDomain.domainName}` });
    if (publicWebDistribution && rootDomain) new CfnOutput(this, 'PublicWebUrl', { value: `https://${rootDomain}` });
    if (publicWebDistribution) new CfnOutput(this, 'PublicWebDistributionDomainName', { value: publicWebDistribution.distributionDomainName });
    if (publicWebDistribution && manageDevWebHosting) new CfnOutput(this, 'DevWebUrl', { value: `https://${publicWebDistribution.distributionDomainName}` });
    new CfnOutput(this, 'MediaBucketName', { value: mediaBucket.bucketName });
    new CfnOutput(this, 'VideoPosterIngestQueueUrl', { value: videoPosterIngestQueue.queueUrl });
    new CfnOutput(this, 'VideoPosterIngestQueueArn', { value: videoPosterIngestQueue.queueArn });
    new CfnOutput(this, 'VideoPosterIngestDlqUrl', { value: videoPosterIngestDlq.queueUrl });
    new CfnOutput(this, 'ExternalSyncQueueUrl', { value: externalSyncQueue.queueUrl });
    new CfnOutput(this, 'ExternalSyncDlqUrl', { value: externalSyncDlq.queueUrl });
    new CfnOutput(this, 'DiscordCommunityDeliveryQueueUrl', { value: discordCommunityDeliveryQueue.queueUrl });
    new CfnOutput(this, 'DiscordCommunityDeliveryDlqUrl', { value: discordCommunityDeliveryDlq.queueUrl });
    new CfnOutput(this, 'DeploymentStage', { value: isProduction ? 'production' : deploymentStage });
    if (productionBackupPlan && productionBackupVault) {
      new CfnOutput(this, 'BackupPlanId', { value: productionBackupPlan.backupPlanId });
      new CfnOutput(this, 'BackupVaultName', { value: productionBackupVault.backupVaultName });
    }
    if (operationsTopic) new CfnOutput(this, 'OperationsAlarmTopicArn', { value: operationsTopic.topicArn });
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
    if (userPoolDomain) new CfnOutput(this, 'UserPoolDomain', { value: userPoolDomain.domainName });
    new CfnOutput(this, 'AdminsGroupName', { value: adminsGroup.groupName || 'Admins' });
    new CfnOutput(this, 'CreatorsGroupName', { value: creatorsGroup.ref });
    new CfnOutput(this, 'UsersGroupName', { value: usersGroup.groupName || 'Users' });
  }
}
