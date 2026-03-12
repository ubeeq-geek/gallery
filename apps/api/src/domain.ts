export type Visibility = 'free' | 'preview' | 'premium';
export type ContentRating = 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
export type AiDisclosure = 'none' | 'ai-assisted' | 'ai-generated';
export type HeavyTopic = 'politics-public-affairs' | 'crime-disasters-tragedy';
export type AiFilterPreference = 'show-all' | 'hide-ai-generated' | 'hide-all-ai';

export interface Artist {
  artistId: string;
  name: string;
  slug: string;
  slugHistory?: string[];
  discoverSquareCropEnabled?: boolean;
  defaultAiDisclosure?: AiDisclosure;
  defaultHeavyTopics?: HeavyTopic[];
  status: 'active' | 'inactive';
  sortOrder: number;
  followerCount?: number;
  imageCount?: number;
  galleryCount?: number;
  createdAt: string;
}

export interface Gallery {
  galleryId: string;
  artistId: string;
  artistSlug?: string;
  title: string;
  slug: string;
  slugHistory?: string[];
  discoverSquareCropEnabled?: boolean;
  defaultAiDisclosure?: AiDisclosure;
  defaultHeavyTopics?: HeavyTopic[];
  visibility: Visibility;
  releaseVisibility?: 'public' | 'hidden' | 'removed';
  pairedPremiumGalleryId?: string;
  purchaseUrl?: string;
  status: 'draft' | 'published';
  publishAt?: string;
  publicReleaseAt?: string;
  premiumPasswordHash?: string;
  coverImageId?: string;
  createdAt: string;
}

export interface Media {
  mediaId: string;
  artistId: string;
  discoverSquareCropEnabled?: boolean;
  contentRating?: ContentRating;
  moderatorContentRating?: ContentRating;
  aiDisclosure?: AiDisclosure;
  moderatorAiDisclosure?: AiDisclosure;
  heavyTopics?: HeavyTopic[];
  moderatorHeavyTopics?: HeavyTopic[];
  assetType?: 'image' | 'video';
  status?: 'draft' | 'scheduled' | 'published' | 'archived';
  releaseVisibility?: 'public' | 'hidden' | 'removed';
  publishAt?: string;
  publicReleaseAt?: string;
  publicPreviewWidth?: number;
  followerPreviewWidth?: number;
  premiumAccessEnabled?: boolean;
  allowOriginalDownloadForPremium?: boolean;
  allowDownloadForFollowers?: boolean;
  allowDownloadForPublic?: boolean;
  title?: string;
  slug?: string;
  slugHistory?: string[];
  originalFilename?: string;
  thumbnailKeys?: {
    w320?: string;
    w640?: string;
    w1280?: string;
    w1920?: string;
    square256?: string;
    square512?: string;
    square1024?: string;
  };
  squareCrop?: {
    x: number;
    y: number;
    size: number;
  };
  previewKey: string;
  premiumKey?: string;
  previewPosterKey?: string;
  premiumPosterKey?: string;
  width: number;
  height: number;
  durationSeconds?: number;
  altText?: string;
  createdAt: string;
}

export interface GalleryMedia {
  galleryMediaId: string;
  galleryId: string;
  mediaId: string;
  position: number;
  createdAt: string;
}

export interface GalleryMediaView extends Media {
  galleryId: string;
  galleryMediaId: string;
  position: number;
}

export interface Comment {
  commentId: string;
  userId: string;
  authorProfileType: 'user' | 'artist';
  authorProfileId: string;
  displayName: string;
  targetType: 'gallery' | 'image';
  targetId: string;
  body: string;
  hidden: boolean;
  createdAt: string;
}

export interface ArtistMember {
  artistId: string;
  userId: string;
  role: 'owner' | 'manager' | 'editor';
  invitedByUserId?: string;
  createdAt: string;
}

export interface Favorite {
  userId: string;
  ownerProfileType?: 'user' | 'artist';
  ownerProfileId?: string;
  targetType: 'gallery' | 'image' | 'collection';
  targetId: string;
  visibility?: 'public' | 'private';
  createdAt: string;
}

export interface Collection {
  collectionId: string;
  ownerUserId: string;
  ownerProfileType?: 'user' | 'artist';
  ownerProfileId?: string;
  title: string;
  description?: string;
  coverImageId?: string;
  visibility: 'public' | 'private';
  insertedDate: string;
  updatedDate: string;
  imageCount: number;
  favoriteCount: number;
}

export interface CollectionImage {
  collectionImageId: string;
  collectionId: string;
  imageId: string;
  sortOrder: number;
  insertedDate: string;
}

export interface Follow {
  followId: string;
  followerUserId: string;
  artistId: string;
  insertedDate: string;
  notificationsEnabled: boolean;
}

export interface BlockedUser {
  userId: string;
  reason?: string;
  blockedAt: string;
}

export interface UserProfile {
  userId: string;
  username: string;
  usernameHistory?: string[];
  displayName?: string;
  bio?: string;
  location?: string;
  website?: string;
  matureContentEnabled?: boolean;
  maxAllowedContentRating?: ContentRating;
  aiFilter?: AiFilterPreference;
  hideHeavyTopics?: boolean;
  hidePoliticsPublicAffairs?: boolean;
  hideCrimeDisastersTragedy?: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsernameChangeAt?: string;
}

export interface SiteSettings {
  settingId: 'SITE';
  siteName: string;
  theme: 'ubeeq' | 'sand' | 'forest' | 'slate';
  logoKey?: string;
  updatedAt: string;
}

export interface IdempotencyRecord {
  scopeKey: string;
  idempotencyKey: string;
  status: number;
  body?: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface AuditEvent {
  auditId: string;
  action: string;
  actorUserId?: string | null;
  actorRole: 'public' | 'user' | 'artist' | 'admin';
  ip?: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

export type TrendingPeriod = 'hourly' | 'daily';

export interface ImageStats {
  imageId: string;
  favoriteCount: number;
  updatedAt: string;
}

export interface TrendingFeedItem {
  period: TrendingPeriod;
  rank: number;
  imageId: string;
  artistId: string;
  artistName: string;
  galleryId: string;
  gallerySlug: string;
  galleryVisibility: 'free' | 'preview';
  discoverSquareCropEnabled: boolean;
  effectiveContentRating: ContentRating;
  effectiveAiDisclosure: AiDisclosure;
  effectiveHeavyTopics: HeavyTopic[];
  title: string;
  previewKey: string;
  favoriteCount: number;
  createdAt: string;
  score: number;
  updatedAt: string;
}
