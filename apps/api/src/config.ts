export interface AppConfig {
  deploymentStage?: string;
  productBrand?: 'eversally' | 'ubeeq';
  tenantId: string;
  awsRegion: string;
  creators: string;
  groupingsTable: string;
  imagesTable: string;
  commentsTable: string;
  favoritesTable: string;
  blockedUsersTable: string;
  siteSettingsTable: string;
  contentStatsTable: string;
  trendingFeedTable: string;
  contentCoreTable: string;
  useContentCoreTable: boolean;
  mediaBucket: string;
  unlockJwtSecret: string;
  unlockTokenTtlSeconds: number;
  rememberGroupingAccessTtlSeconds: number;
  signedUrlTtlSeconds: number;
  mediaCdnDomain?: string;
  premiumMediaCdnDomain?: string;
  cloudFrontKeyPairId?: string;
  cloudFrontPrivateKey?: string;
  trendingFeedMaxItems: number;
  trendingCandidateLimit: number;
  cognitoUserPoolId?: string;
  cognitoClientId?: string;
  cognitoTokenUse?: 'id' | 'access';
  externalOAuthRedirectUri?: string;
  externalTokenEncryptionKey?: string;
  externalSyncQueueUrl?: string;
  externalSyncBaseDelaySeconds: number;
  externalAccountScanIntervalSeconds: number;
  externalActivityScanIntervalSeconds: number;
  deviantArtPublishedDescriptionUpdate: boolean;
  externalContentMaxBytes: number;
  localMediaDirectory?: string;
  appOrigin?: string;
  /** Public HTTPS URL hosting the atproto OAuth client metadata document. */
  blueskyOAuthClientMetadataUrl?: string;
  /** Public HTTPS callback handled by this API. */
  blueskyOAuthCallbackUrl?: string;
  /** Public JWKS JSON for the confidential atproto OAuth client. */
  blueskyOAuthJwksJson?: string;
  /** Confidential signing key material; load from Secrets Manager in production. */
  blueskyOAuthPrivateJwk?: string;
  /** Dedicated DPoP OAuth broker used to hold Bluesky sessions outside the product API. */
  blueskyOAuthServiceUrl?: string;
  /** Public JWKS used to verify one-time connection proofs issued by the OAuth broker. */
  blueskyOAuthServiceJwksUrl?: string;
  localAuthUserId?: string;
}

export const loadConfig = (): AppConfig => {
  const deploymentStage = (process.env.DEPLOYMENT_STAGE || 'development').trim().toLowerCase();
  const config: AppConfig = {
  deploymentStage,
  productBrand: process.env.PRODUCT_BRAND === 'eversally' ? 'eversally' : 'ubeeq',
  tenantId: process.env.TENANT_ID || 'default',
  awsRegion: process.env.AWS_REGION || 'ca-central-1',
  creators: process.env.CREATORS || 'creators',
  groupingsTable: process.env.GROUPINGS_TABLE || 'groupings',
  imagesTable: process.env.IMAGES_TABLE || 'images',
  commentsTable: process.env.COMMENTS_TABLE || 'comments',
  favoritesTable: process.env.FAVORITES_TABLE || 'favorites',
  blockedUsersTable: process.env.BLOCKED_USERS_TABLE || 'blocked-users',
  siteSettingsTable: process.env.SITE_SETTINGS_TABLE || 'site-settings',
  contentStatsTable: process.env.CONTENT_STATS_TABLE || 'content-stats',
  trendingFeedTable: process.env.TRENDING_FEED_TABLE || 'trending-feed',
  contentCoreTable: process.env.CONTENT_CORE_TABLE || 'content-core',
  useContentCoreTable: (process.env.USE_CONTENT_CORE_TABLE || 'false') === 'true',
  mediaBucket: process.env.MEDIA_BUCKET || 'content-media',
  unlockJwtSecret: process.env.UNLOCK_JWT_SECRET || 'dev-secret',
  unlockTokenTtlSeconds: Number(process.env.UNLOCK_TOKEN_TTL_SECONDS || 3600),
  rememberGroupingAccessTtlSeconds: Number(process.env.REMEMBER_GROUPING_ACCESS_TTL_SECONDS || 60 * 60 * 24 * 30),
  signedUrlTtlSeconds: Number(process.env.SIGNED_URL_TTL_SECONDS || 300),
  mediaCdnDomain: process.env.MEDIA_CDN_DOMAIN,
  premiumMediaCdnDomain: process.env.PREMIUM_MEDIA_CDN_DOMAIN,
  cloudFrontKeyPairId: process.env.CLOUDFRONT_KEY_PAIR_ID,
  cloudFrontPrivateKey: process.env.CLOUDFRONT_PRIVATE_KEY,
  trendingFeedMaxItems: Number(process.env.TRENDING_FEED_MAX_ITEMS || 600),
  trendingCandidateLimit: Number(process.env.TRENDING_CANDIDATE_LIMIT || 1500),
  cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID,
  cognitoClientId: process.env.COGNITO_CLIENT_ID,
  cognitoTokenUse: (process.env.COGNITO_TOKEN_USE as 'id' | 'access') || 'id',
  externalOAuthRedirectUri: process.env.EXTERNAL_OAUTH_REDIRECT_URI,
  externalTokenEncryptionKey: process.env.EXTERNAL_TOKEN_ENCRYPTION_KEY,
  externalSyncQueueUrl: process.env.EXTERNAL_SYNC_QUEUE_URL,
  externalSyncBaseDelaySeconds: Number(process.env.EXTERNAL_SYNC_BASE_DELAY_SECONDS || 60),
  externalAccountScanIntervalSeconds: Number(process.env.EXTERNAL_ACCOUNT_SCAN_INTERVAL_SECONDS || 21600),
  externalActivityScanIntervalSeconds: Number(process.env.EXTERNAL_ACTIVITY_SCAN_INTERVAL_SECONDS || 120),
  deviantArtPublishedDescriptionUpdate: (
    process.env.DEVIANTART_PUBLISHED_DESCRIPTION_UPDATE
    || process.env.DEVIANTART_EXPERIMENTAL_PUBLISHED_DESCRIPTION_UPDATE
    || 'true'
  ) === 'true',
  externalContentMaxBytes: Number(process.env.EXTERNAL_CONTENT_MAX_BYTES || 50 * 1024 * 1024),
  localMediaDirectory: process.env.LOCAL_MEDIA_DIRECTORY || (process.env.LOCAL_AUTH_USER_ID ? '/tmp/ubeeq-media' : undefined),
  appOrigin: process.env.APP_ORIGIN,
  blueskyOAuthClientMetadataUrl: process.env.BLUESKY_OAUTH_CLIENT_METADATA_URL,
  blueskyOAuthCallbackUrl: process.env.BLUESKY_OAUTH_CALLBACK_URL,
  blueskyOAuthJwksJson: process.env.BLUESKY_OAUTH_JWKS_JSON,
  blueskyOAuthPrivateJwk: process.env.BLUESKY_OAUTH_PRIVATE_JWK,
  blueskyOAuthServiceUrl: process.env.BLUESKY_OAUTH_SERVICE_URL,
  blueskyOAuthServiceJwksUrl: process.env.BLUESKY_OAUTH_SERVICE_JWKS_URL,
  localAuthUserId: process.env.LOCAL_AUTH_USER_ID
  };
  if (deploymentStage === 'production' || deploymentStage === 'prod') {
    const missing = [
      !config.cognitoUserPoolId ? 'COGNITO_USER_POOL_ID' : '',
      !config.cognitoClientId ? 'COGNITO_CLIENT_ID' : '',
      !process.env.CONTENT_CORE_TABLE ? 'CONTENT_CORE_TABLE' : '',
      !config.useContentCoreTable ? 'USE_CONTENT_CORE_TABLE=true' : '',
      !process.env.MEDIA_BUCKET ? 'MEDIA_BUCKET' : '',
      !config.appOrigin ? 'APP_ORIGIN' : '',
      !config.externalTokenEncryptionKey ? 'EXTERNAL_TOKEN_ENCRYPTION_KEY' : '',
      !config.unlockJwtSecret || config.unlockJwtSecret === 'dev-secret' ? 'UNLOCK_JWT_SECRET' : ''
    ].filter(Boolean);
    if (missing.length) throw new Error(`Production API configuration is incomplete: ${missing.join(', ')}`);
    if (config.localAuthUserId) throw new Error('LOCAL_AUTH_USER_ID must not be set in production.');
    if (!config.appOrigin!.startsWith('https://')) throw new Error('APP_ORIGIN must use HTTPS in production.');
  }
  return config;
};
