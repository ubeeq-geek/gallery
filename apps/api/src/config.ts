export interface AppConfig {
  awsRegion: string;
  creators: string;
  groupingsTable: string;
  imagesTable: string;
  commentsTable: string;
  favoritesTable: string;
  blockedUsersTable: string;
  siteSettingsTable: string;
  imageStatsTable: string;
  trendingFeedTable: string;
  groupingCoreTable: string;
  useGroupingCoreTable: boolean;
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
}

export const loadConfig = (): AppConfig => ({
  awsRegion: process.env.AWS_REGION || 'ca-central-1',
  creators: process.env.CREATORS || 'creators',
  groupingsTable: process.env.GROUPINGS_TABLE || 'groupings',
  imagesTable: process.env.IMAGES_TABLE || 'images',
  commentsTable: process.env.COMMENTS_TABLE || 'comments',
  favoritesTable: process.env.FAVORITES_TABLE || 'favorites',
  blockedUsersTable: process.env.BLOCKED_USERS_TABLE || 'blocked-users',
  siteSettingsTable: process.env.SITE_SETTINGS_TABLE || 'site-settings',
  imageStatsTable: process.env.IMAGE_STATS_TABLE || 'image-stats',
  trendingFeedTable: process.env.TRENDING_FEED_TABLE || 'trending-feed',
  groupingCoreTable: process.env.GROUPING_CORE_TABLE || 'grouping-core',
  useGroupingCoreTable: (process.env.USE_GROUPING_CORE_TABLE || 'false') === 'true',
  mediaBucket: process.env.MEDIA_BUCKET || 'grouping-media',
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
  cognitoTokenUse: (process.env.COGNITO_TOKEN_USE as 'id' | 'access') || 'id'
});
