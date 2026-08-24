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
  soundCloudOAuthRedirectUri?: string;
  /** Compliance approval gate; SoundCloud remains unavailable unless explicitly enabled. */
  soundCloudEnabled?: boolean;
  externalTokenEncryptionKey?: string;
  externalSyncQueueUrl?: string;
  externalSyncBaseDelaySeconds: number;
  /** Minimum spacing between DeviantArt API calls. Keep this conservative: DA applies adaptive limits. */
  deviantArtMinimumRequestIntervalMs: number;
  /** Google OAuth application used for the optional YouTube read-only connection. */
  youtubeOAuthClientId?: string;
  youtubeOAuthClientSecret?: string;
  youtubeOAuthRedirectUri?: string;
  /** Keep the import conservative; quota is shared by every channel using this app. */
  youtubeMinimumRequestIntervalMs: number;
  youtubeApiBaseUrl: string;
  /** Enables scheduled catalogue/activity polling. Manual sync remains available when disabled. */
  externalScheduledScansEnabled: boolean;
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
  /** Discord application credentials for the native community integration. */
  discordClientId?: string;
  discordClientSecret?: string;
  /** Bot token is held only by the API/worker and is never returned to Studio. */
  discordBotToken?: string;
  discordOAuthRedirectUri?: string;
  discordCommunityQueueUrl?: string;
  discordApiBaseUrl: string;
  /** Fanvue studio-pilot OAuth and API configuration. Secrets must come from managed application secrets. */
  fanvueClientId?: string;
  fanvueClientSecret?: string;
  fanvueOAuthRedirectUri?: string;
  fanvueWebhookSecret?: string;
  fanvueApiBaseUrl?: string;
  fanvueAuthorizeUrl?: string;
  fanvueApiVersion?: string;
  /** Managed Tumblr OAuth 2 application; creator-owned credentials are encrypted per connector. */
  tumblrClientId?: string;
  tumblrClientSecret?: string;
  tumblrOAuthRedirectUri?: string;
  tumblrApiBaseUrl: string;
  tumblrMediaBlockLimit: number;
  /** Versioned, deployment-owned destination policy rules; never supplied by publish callers. */
  tumblrPolicyRulesJson?: string;
  tumblrPublishQueueUrl?: string;
  tumblrHourlyRequestLimit: number;
  tumblrDailyRequestLimit: number;
  tumblrPublishMaxAttempts: number;
  tumblrRetryBaseDelaySeconds: number;
  localAuthUserId?: string;
  /** Email used for the optional first-admin bootstrap. */
  adminEmail?: string;
  /** Password used only when creating the first Cognito admin. Never log this. */
  adminPassword?: string;
  /** Local-only simulated identity settings when Cognito is not configured. */
  localAuthRole?: 'user' | 'contributor' | 'creator' | 'admin';
  localAuthEmail?: string;
  localAuthDisplayName?: string;
  /** Verified sender used for product-originated email such as integration requests. */
  sesFromAddress?: string;
  /** Brand inbox that receives creator integration requests. */
  integrationRequestToAddress?: string;
  vimeoClientId?: string;
  vimeoClientSecret?: string;
  vimeoOAuthRedirectUri?: string;
  vimeoWebhookSecret?: string;
  vimeoUploadQueueUrl?: string;
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
  // The browser-facing client id is public. Accept its Vite spelling for the
  // paired local web/API launcher, while deployed environments use the normal
  // server-side variable supplied by CDK.
  cognitoClientId: process.env.COGNITO_CLIENT_ID || process.env.VITE_COGNITO_CLIENT_ID,
  cognitoTokenUse: (process.env.COGNITO_TOKEN_USE as 'id' | 'access') || 'id',
  externalOAuthRedirectUri: process.env.EXTERNAL_OAUTH_REDIRECT_URI,
  soundCloudOAuthRedirectUri: process.env.SOUNDCLOUD_OAUTH_REDIRECT_URI,
  soundCloudEnabled: (process.env.SOUNDCLOUD_ENABLED || 'false') === 'true',
  externalTokenEncryptionKey: process.env.EXTERNAL_TOKEN_ENCRYPTION_KEY,
  externalSyncQueueUrl: process.env.EXTERNAL_SYNC_QUEUE_URL,
  externalSyncBaseDelaySeconds: Number(process.env.EXTERNAL_SYNC_BASE_DELAY_SECONDS || 60),
  deviantArtMinimumRequestIntervalMs: Number(process.env.DEVIANTART_MIN_REQUEST_INTERVAL_MS || 2000),
  youtubeOAuthClientId: process.env.YOUTUBE_OAUTH_CLIENT_ID,
  youtubeOAuthClientSecret: process.env.YOUTUBE_OAUTH_CLIENT_SECRET,
  youtubeOAuthRedirectUri: process.env.YOUTUBE_OAUTH_REDIRECT_URI,
  youtubeMinimumRequestIntervalMs: Number(process.env.YOUTUBE_MIN_REQUEST_INTERVAL_MS || 1000),
  youtubeApiBaseUrl: process.env.YOUTUBE_API_BASE_URL || 'https://www.googleapis.com/youtube/v3',
  externalScheduledScansEnabled: process.env.EXTERNAL_SCHEDULED_SCANS_ENABLED === undefined
    ? deploymentStage === 'production' || deploymentStage === 'prod'
    : process.env.EXTERNAL_SCHEDULED_SCANS_ENABLED === 'true',
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
  discordClientId: process.env.DISCORD_CLIENT_ID,
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET,
  discordBotToken: process.env.DISCORD_BOT_TOKEN,
  discordOAuthRedirectUri: process.env.DISCORD_OAUTH_REDIRECT_URI,
  discordCommunityQueueUrl: process.env.DISCORD_COMMUNITY_QUEUE_URL,
  discordApiBaseUrl: process.env.DISCORD_API_BASE_URL || 'https://discord.com/api/v10',
  fanvueClientId: process.env.FANVUE_CLIENT_ID,
  fanvueClientSecret: process.env.FANVUE_CLIENT_SECRET,
  fanvueOAuthRedirectUri: process.env.FANVUE_OAUTH_REDIRECT_URI,
  fanvueWebhookSecret: process.env.FANVUE_WEBHOOK_SECRET,
  fanvueApiBaseUrl: process.env.FANVUE_API_BASE_URL || 'https://api.fanvue.com',
  fanvueAuthorizeUrl: process.env.FANVUE_AUTHORIZE_URL || 'https://auth.fanvue.com/oauth/authorize',
  fanvueApiVersion: process.env.FANVUE_API_VERSION || '2026-08-01',
  tumblrClientId: process.env.TUMBLR_CLIENT_ID,
  tumblrClientSecret: process.env.TUMBLR_CLIENT_SECRET,
  tumblrOAuthRedirectUri: process.env.TUMBLR_OAUTH_REDIRECT_URI,
  tumblrApiBaseUrl: process.env.TUMBLR_API_BASE_URL || 'https://api.tumblr.com',
  tumblrMediaBlockLimit: Number(process.env.TUMBLR_MEDIA_BLOCK_LIMIT || 10),
  tumblrPolicyRulesJson: process.env.TUMBLR_POLICY_RULES_JSON,
  tumblrPublishQueueUrl: process.env.TUMBLR_PUBLISH_QUEUE_URL,
  tumblrHourlyRequestLimit: Number(process.env.TUMBLR_HOURLY_REQUEST_LIMIT || 1000),
  tumblrDailyRequestLimit: Number(process.env.TUMBLR_DAILY_REQUEST_LIMIT || 5000),
  tumblrPublishMaxAttempts: Number(process.env.TUMBLR_PUBLISH_MAX_ATTEMPTS || 5),
  tumblrRetryBaseDelaySeconds: Number(process.env.TUMBLR_RETRY_BASE_DELAY_SECONDS || 60),
  localAuthUserId: process.env.LOCAL_AUTH_USER_ID,
  adminEmail: process.env.ADMIN_EMAIL || (
    process.env.PRODUCT_BRAND === 'eversally' ? 'admin@eversally.com' : 'admin@ubeeq.site'
  ),
  adminPassword: process.env.ADMIN_PASSWORD,
  localAuthRole: (process.env.LOCAL_AUTH_ROLE as AppConfig['localAuthRole']) || undefined,
  localAuthEmail: process.env.LOCAL_AUTH_EMAIL,
  localAuthDisplayName: process.env.LOCAL_AUTH_DISPLAY_NAME,
  sesFromAddress: process.env.SES_FROM_ADDRESS?.trim(),
  integrationRequestToAddress: process.env.INTEGRATION_REQUEST_TO_ADDRESS?.trim()
    || (process.env.PRODUCT_BRAND === 'eversally' ? 'hello@eversally.com' : 'hello@ubeeq.site'),
  vimeoClientId: process.env.VIMEO_CLIENT_ID,
  vimeoClientSecret: process.env.VIMEO_CLIENT_SECRET,
  vimeoOAuthRedirectUri: process.env.VIMEO_OAUTH_REDIRECT_URI,
  vimeoWebhookSecret: process.env.VIMEO_WEBHOOK_SECRET,
  vimeoUploadQueueUrl: process.env.VIMEO_UPLOAD_QUEUE_URL
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
