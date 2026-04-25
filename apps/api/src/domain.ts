export type Visibility = 'free' | 'preview' | 'premium';
export type ContentRating = 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
export type AiDisclosure = 'none' | 'ai-assisted' | 'ai-generated';
export type HeavyTopic = 'politics-public-affairs' | 'crime-disasters-tragedy';
export type AiFilterPreference = 'show-all' | 'hide-ai-generated' | 'hide-all-ai';
export type PostStatus = 'draft' | 'published' | 'archived';
export type PostDiscoveryMode = 'primary' | 'all' | 'selected';
export type CreatorGroupDisplayType = 'series' | 'grouping' | 'set';
export type MediaType = 'image' | 'video' | 'audio';
export type SourceFileKind = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other';
export type PostBlockType =
  | 'heading'
  | 'paragraph'
  | 'image'
  | 'video'
  | 'audio'
  | 'quote'
  | 'divider'
  | 'embed'
  | 'file'
  | 'link'
  | 'grouping'
  | 'carousel'
  | 'pdf_preview'
  | 'html_fragment';

export interface PostBlock {
  blockId: string;
  type: PostBlockType;
  text?: string;
  level?: number;
  mediaId?: string;
  fileId?: string;
  caption?: string;
  quote?: string;
  author?: string;
  url?: string;
  mimeType?: string;
  title?: string;
  html?: string;
  payload?: Record<string, unknown>;
}

export interface PostMediaRef {
  mediaId: string;
  discoverable?: boolean;
  sortOrder?: number;
  caption?: string;
}

export interface PostDestination {
  type: 'post' | 'pdf' | 'external' | 'internal';
  url: string;
}

export interface Post {
  postId: string;
  creatorId: string;
  groupId?: string;
  authorId?: string;
  title: string;
  slug: string;
  slugHistory?: string[];
  summary?: string;
  status: PostStatus;
  blocks: PostBlock[];
  media: PostMediaRef[];
  primaryMediaId?: string;
  discovery: {
    mode: PostDiscoveryMode;
  };
  destination?: PostDestination | null;
  metadata?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

export interface Creator {
  creatorId: string;
  name: string;
  slug: string;
  slugHistory?: string[];
  defaultProfileTab?: 'feed' | 'groupings';
  featuredItemIds?: string[];
  featuredGroupingIds?: string[];
  discoverSquareCropEnabled?: boolean;
  defaultAiDisclosure?: AiDisclosure;
  defaultHeavyTopics?: HeavyTopic[];
  status: 'active' | 'inactive';
  sortOrder: number;
  followerCount?: number;
  imageCount?: number;
  groupingCount?: number;
  branding?: {
    profileImage?: {
      sourceKey: string;
      thumbnailKeys?: {
        square256?: string;
        square512?: string;
        square1024?: string;
      };
      squareCrop?: {
        x: number;
        y: number;
        size: number;
      };
      altText?: string;
      updatedAt: string;
    };
    coverImage?: {
      sourceKey: string;
      renditionKeys?: {
        desktop?: string;
        tablet?: string;
        mobile?: string;
      };
      crops?: {
        desktop?: {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        tablet?: {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        mobile?: {
          x: number;
          y: number;
          width: number;
          height: number;
        };
      };
      focalPoint?: {
        x: number;
        y: number;
      };
      altText?: string;
      updatedAt: string;
    };
  };
  createdAt: string;
}

export interface CreatorGroup {
  groupId: string;
  creatorId: string;
  title: string;
  slug: string;
  description?: string;
  displayType: CreatorGroupDisplayType;
  coverMediaId?: string;
  status: 'draft' | 'published' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface SourceFile {
  fileId: string;
  creatorId: string;
  sourceKind: SourceFileKind;
  mimeType: string;
  storageKey: string;
  originalFilename?: string;
  sizeBytes?: number;
  checksumSha256?: string;
  metadata?: Record<string, string | number | boolean | null>;
  downloadable?: boolean;
  premium?: boolean;
  restricted?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Grouping {
  groupingId: string;
  creatorId: string;
  creatorSlug?: string;
  title: string;
  isDefaultStream?: boolean;
  slug: string;
  slugHistory?: string[];
  discoverSquareCropEnabled?: boolean;
  defaultAiDisclosure?: AiDisclosure;
  defaultHeavyTopics?: HeavyTopic[];
  visibility: Visibility;
  releaseVisibility?: 'public' | 'hidden' | 'removed';
  pairedPremiumGroupingId?: string;
  purchaseUrl?: string;
  defaultPreviewMaxWidth?: number;
  status: 'draft' | 'published';
  publishAt?: string;
  publicReleaseAt?: string;
  premiumPasswordHash?: string;
  coverImageId?: string;
  createdAt: string;
}

export interface Media {
  mediaId: string;
  creatorId: string;
  sourceFileId?: string;
  mediaType?: MediaType;
  appearsInFeed?: boolean;
  discoverSquareCropEnabled?: boolean;
  contentRating?: ContentRating;
  moderatorContentRating?: ContentRating;
  aiDisclosure?: AiDisclosure;
  moderatorAiDisclosure?: AiDisclosure;
  heavyTopics?: HeavyTopic[];
  moderatorHeavyTopics?: HeavyTopic[];
  assetType?: 'image' | 'video' | 'audio';
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

export interface GroupingMedia {
  groupingMediaId: string;
  groupingId: string;
  mediaId: string;
  position: number;
  isPreview?: boolean;
  previewMaxWidth?: number;
  createdAt: string;
}

export interface GroupingMediaView extends Media {
  groupingId: string;
  groupingMediaId: string;
  position: number;
  isPreview?: boolean;
  previewMaxWidth?: number;
}

export interface Comment {
  commentId: string;
  userId: string;
  authorProfileType: 'user' | 'creator';
  authorProfileId: string;
  displayName: string;
  targetType: 'grouping' | 'image';
  targetId: string;
  body: string;
  hidden: boolean;
  createdAt: string;
}

export interface CreatorMember {
  creatorId: string;
  userId: string;
  role: 'owner' | 'manager' | 'editor';
  invitedByUserId?: string;
  createdAt: string;
}

export interface Favorite {
  userId: string;
  ownerProfileType?: 'user' | 'creator';
  ownerProfileId?: string;
  targetType: 'grouping' | 'image' | 'collection';
  targetId: string;
  visibility?: 'public' | 'private';
  createdAt: string;
}

export interface Collection {
  collectionId: string;
  ownerUserId: string;
  ownerProfileType?: 'user' | 'creator';
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
  creatorId: string;
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
  actorRole: 'public' | 'user' | 'creator' | 'admin';
  ip?: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

export type TrendingPeriod = 'hourly' | 'daily';

export type PlatformRole = 'user' | 'contributor' | 'creator' | 'admin';

export interface UserCapabilities {
  canBrowse: boolean;
  canComment: boolean;
  canVote: boolean;
  canSubmitToContexts: boolean;
  canPublishPosts: boolean;
  canManageGroups: boolean;
  canModerate: boolean;
  canAwardPrizes: boolean;
}

export interface UserIdentity {
  userId: string;
  role: PlatformRole;
  isBeeker: boolean;
  capabilities: UserCapabilities;
  createdAt: string;
  updatedAt: string;
}

export interface UserExternalLink {
  linkId: string;
  userId: string;
  type: 'website' | 'deviantart' | 'instagram' | 'x' | 'other';
  label?: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserBadge {
  badgeId: string;
  userId: string;
  code: string;
  label: string;
  description?: string;
  awardedAt: string;
}

export type ContributionContextType = 'challenge' | 'event' | 'prompt' | 'open_call' | 'editorial_call' | 'contest';
export type ContributionContextStatus = 'draft' | 'active' | 'closed' | 'archived';

export interface ContributionContext {
  contextId: string;
  type: ContributionContextType;
  title: string;
  slug: string;
  status: ContributionContextStatus;
  description?: string;
  rules: {
    maxEntriesPerUser: number;
    requiresOtp: boolean;
  };
  submissionWindow?: {
    opensAt?: string;
    closesAt?: string;
  };
  rewardConfig?: {
    manual: boolean;
  };
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export type ContextSubmissionStatus = 'pending' | 'approved' | 'rejected';

export interface ContextSubmission {
  submissionId: string;
  contextId: string;
  userId: string;
  status: ContextSubmissionStatus;
  title: string;
  notes?: string;
  mediaIds: string[];
  fileIds: string[];
  submittedAt: string;
  reviewedAt?: string;
  reviewedByUserId?: string;
  convertedPostId?: string;
}

export interface ContextUnlockThreshold {
  unlockId: string;
  contextId: string;
  metric: 'approved_entries' | 'supports' | 'unique_visitors';
  threshold: number;
  effectDescription: string;
  isActive: boolean;
  activatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChallengePrize {
  prizeId: string;
  contextId: string;
  title: string;
  description: string;
  category: 'platform' | 'digital' | 'physical' | 'draw';
  placement: 'winner' | 'runner_up' | 'top_n' | 'random_supporter';
  quantity: number;
  status: 'draft' | 'active' | 'awarded';
  createdAt: string;
  updatedAt: string;
}

export interface PrizeAward {
  prizeAwardId: string;
  prizeId: string;
  contextId: string;
  recipientUserId: string;
  awardedAt: string;
  fulfillmentStatus: 'pending' | 'in_progress' | 'fulfilled' | 'cancelled';
  fulfillmentNotes?: string;
}

export interface ContentStats {
  imageId: string;
  favoriteCount: number;
  updatedAt: string;
}

export interface TrendingFeedItem {
  period: TrendingPeriod;
  rank: number;
  surfaceType?: 'media_surface' | 'post_surface';
  imageId: string;
  assetType: 'image' | 'video' | 'audio';
  creatorId: string;
  creatorName: string;
  postId?: string;
  groupingId: string;
  groupingSlug: string;
  groupingVisibility: 'free' | 'preview';
  discoverSquareCropEnabled: boolean;
  effectiveContentRating: ContentRating;
  effectiveAiDisclosure: AiDisclosure;
  effectiveHeavyTopics: HeavyTopic[];
  title: string;
  previewKey: string;
  previewPosterKey?: string;
  thumbnailKeys?: Media['thumbnailKeys'];
  width?: number;
  height?: number;
  aspectRatio?: number;
  favoriteCount: number;
  createdAt: string;
  score: number;
  updatedAt: string;
}
