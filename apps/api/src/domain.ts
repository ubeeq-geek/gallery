export type Visibility = 'free' | 'preview' | 'premium';
export type ContentRating = 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
export type AiDisclosure = 'none' | 'ai-assisted' | 'ai-generated';
export type HeavyTopic = 'politics-public-affairs' | 'crime-disasters-tragedy';
export type AiFilterPreference = 'show-all' | 'hide-ai-generated' | 'hide-all-ai';
export type PostStatus = 'draft' | 'published' | 'archived';
export type PostDiscoveryMode = 'primary' | 'all' | 'selected';
export type PostType = 'image' | 'video' | 'story' | 'audio';
export type PostFormat = 'single' | 'multi' | 'short' | 'long';
export type CreatorGroupDisplayType = 'series' | 'grouping' | 'set';
export type MediaType = 'image' | 'video' | 'audio';
export type SourceFileKind = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other';
export type PostBlockType =
  | 'section'
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
  | 'credit'
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
  label?: string;
  html?: string;
  payload?: Record<string, unknown>;
  blocks?: PostBlock[];
}

export interface PostMediaRef {
  mediaId: string;
  discoverable?: boolean;
  sortOrder?: number;
  caption?: string;
  credit?: {
    label: string;
    url?: string;
  };
  comparison?: {
    type?: 'colorization' | 'before-after' | 'retouch' | 'historical' | string;
    role?: 'original' | 'colorized' | 'before' | 'after' | string;
    order?: number;
    comparisonItem?: {
      mediaId: string;
      role?: 'original' | 'colorized' | 'before' | 'after' | string;
      order?: number;
      caption?: string;
      credit?: {
        label: string;
        url?: string;
      };
    };
  };
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
  spaceTier?: 'free' | 'approved';
  approvedCreatorAt?: string;
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
  postType?: PostType;
  postFormat?: PostFormat;
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
  externalPreviewUrl?: string;
  externalPreviewPosterUrl?: string;
  thumbnailKeys?: Media['thumbnailKeys'];
  width?: number;
  height?: number;
  aspectRatio?: number;
  favoriteCount: number;
  createdAt: string;
  score: number;
  updatedAt: string;
}

export type ExternalPlatform = 'deviantart';
export type ExternalAccountConnectionStatus =
  | 'connected'
  | 'authentication_required'
  | 'rate_limited'
  | 'temporarily_unavailable'
  | 'disabled';
export type ExternalAssetType = 'image' | 'literature' | 'video' | 'animation' | 'other';
export type AssetVisibility = 'private' | 'unlisted' | 'public';
export type UbeeqCollectionType = 'collection' | 'gallery' | 'series';
export type MetadataSyncPolicy = 'mirrored' | 'independent' | 'initially_mirrored' | 'manual';
export type SpaceHostingMode = 'linked' | 'hosted';
export type SpaceContentSyncStatus = 'not_requested' | 'queued' | 'syncing' | 'hosted' | 'not_available' | 'failed';
export type ExternalPublicationSyncStatus = 'pending_publish' | 'draft' | 'active' | 'missing' | 'deleted' | 'restricted' | 'unknown' | 'error';
export type ExternalPublicationTargetStatus = 'draft' | 'published';
export type ExternalCollectionSyncMode = 'continuous' | 'initial_only' | 'manual' | 'ignored';
export type ExternalSyncJobType =
  | 'account_import'
  | 'activity_sync'
  | 'content_sync'
  | 'account_scan'
  | 'content_metadata_sync'
  | 'gallery_sync'
  | 'engagement_sync'
  | 'comment_sync'
  | 'full_reconciliation'
  | 'publish'
  | 'remote_update';
export type ExternalSyncJobStatus =
  | 'queued'
  | 'processing'
  | 'successful'
  | 'failed'
  | 'rate_limited'
  | 'authentication_required'
  | 'retry_scheduled'
  | 'cancelled';

export interface ExternalAccount {
  externalAccountId: string;
  userId: string;
  /**
   * Legacy/default owner for imported assets. Account visibility is governed by
   * ExternalAccountCreatorAssignment, so this can be absent until assigned.
   */
  creatorIdentityId?: string;
  primaryCreatorIdentityId?: string;
  externalPlatformCredentialId: string;
  platform: ExternalPlatform;
  externalUserId: string;
  externalUsername: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string;
  tokenExpiresAt?: string;
  connectionStatus: ExternalAccountConnectionStatus;
  lastSuccessfulSyncAt?: string;
  lastSyncAttemptAt?: string;
  /** One-time import preference selected before the account was connected. */
  initialContentSyncRequested?: boolean;
  /** Whether subsequent synchronizations should also copy available source files into Ubeeq Space. */
  includeSourceFilesOnSync?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAccountProfileStats {
  watchers?: number;
  friends?: number;
  deviations?: number;
  favourites?: number;
  comments?: number;
  profilePageviews?: number;
  profileComments?: number;
}

export interface ExternalAccountProfile {
  externalAccountId: string;
  capturedAt: string;
  profileUrl?: string;
  avatarUrl?: string;
  userIsArtist?: boolean;
  artistLevel?: string;
  artistSpecialty?: string;
  realName?: string;
  tagline?: string;
  country?: string;
  website?: string;
  bio?: string;
  coverPhotoUrl?: string;
  joinedAt?: string;
  stats: ExternalAccountProfileStats;
  profileFingerprint: string;
  rawPayload?: Record<string, unknown>;
}

export interface ExternalAccountProfileSnapshot extends ExternalAccountProfile {
  externalAccountProfileSnapshotId: string;
}

export interface ExternalPlatformCredential {
  externalPlatformCredentialId: string;
  userId: string;
  /** Legacy creator-scoped credential retained for backwards compatibility. */
  creatorIdentityId?: string;
  platform: ExternalPlatform;
  applicationLabel?: string;
  clientId: string;
  clientSecretEncrypted: string;
  redirectUri: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A connected external account can be used by more than one Ubeeq creator
 * identity without making the external platform's account model part of ours.
 */
export interface ExternalAccountCreatorAssignment {
  externalAccountId: string;
  creatorIdentityId: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  assetId: string;
  userId: string;
  creatorIdentityId: string;
  assetType: ExternalAssetType;
  canonicalTitle: string;
  canonicalDescription?: string;
  visibility: AssetVisibility;
  titleSyncPolicy: MetadataSyncPolicy;
  descriptionSyncPolicy: MetadataSyncPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalPublication {
  externalPublicationId: string;
  assetId: string;
  externalAccountId: string;
  platform: ExternalPlatform;
  externalContentId: string;
  /** Provider-side draft/source identifier retained when a publish workflow exposes one. */
  externalDraftId?: string;
  /** Desired provider-side state for the next outbound synchronization. */
  targetStatus?: ExternalPublicationTargetStatus;
  externalUrl?: string;
  externalTitle?: string;
  externalDescription?: string;
  externalTags?: string[];
  externalCollectionIds?: string[];
  publishedAt?: string;
  remoteCreatedAt?: string;
  remoteUpdatedAt?: string;
  /** SHA-256 of normalized provider metadata, excluding volatile metrics and signed URL parameters. */
  remoteMetadataFingerprint?: string;
  /** Advisory SHA-256 of the provider's stable file descriptor; the hosted checksum remains authoritative. */
  remoteContentFingerprint?: string;
  lastSyncedAt?: string;
  lastSeenAt?: string;
  syncStatus: ExternalPublicationSyncStatus;
  metadataSyncStatus?: 'in_sync' | 'remote_changed' | 'local_update_pending' | 'conflict';
  remoteChangeDetectedAt?: string;
  lastOutboundSyncAt?: string;
  remoteStateReason?: string;
  rawMetadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SpacePublication {
  assetId: string;
  published: boolean;
  hostingMode: SpaceHostingMode;
  contentSyncStatus?: SpaceContentSyncStatus;
  sourceCopyQuality?: 'original' | 'display_copy';
  originalDownloadStatus?: 'available' | 'not_downloadable' | 'missing';
  hostedObjectKey?: string;
  hostedThumbnailObjectKey?: string;
  hostedContentType?: string;
  hostedByteSize?: number;
  hostedChecksumSha256?: string;
  remoteContentFingerprint?: string;
  remoteContentEtag?: string;
  remoteContentLastModified?: string;
  lastRemoteContentCheckedAt?: string;
  lastContentSyncAt?: string;
  contentSyncError?: string;
  publishedAt?: string;
  ubeeqTitleOverride?: string;
  ubeeqDescriptionOverride?: string;
  visibility: AssetVisibility;
  updatedAt: string;
}

export interface ExternalCollection {
  externalCollectionId: string;
  externalAccountId: string;
  platform: ExternalPlatform;
  externalCollectionExternalId: string;
  name: string;
  description?: string;
  parentExternalCollectionExternalId?: string;
  position?: number;
  remoteSize?: number;
  syncStatus?: 'active' | 'missing';
  lastSeenAt?: string;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UbeeqCollection {
  ubeeqCollectionId: string;
  userId: string;
  creatorIdentityId: string;
  name: string;
  parentUbeeqCollectionId?: string;
  position: number;
  visibility: AssetVisibility;
  collectionType?: UbeeqCollectionType;
  ruleDefinition?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UbeeqCollectionAsset {
  ubeeqCollectionId: string;
  assetId: string;
  userId: string;
  creatorIdentityId: string;
  manuallyAssigned?: boolean;
  externalCollectionMappingIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExternalCollectionMapping {
  externalCollectionMappingId: string;
  externalAccountId: string;
  externalCollectionId: string;
  ubeeqCollectionId: string;
  syncMode: ExternalCollectionSyncMode;
  lastMembershipSyncAt?: string;
  lastMembershipFingerprint?: string;
  lastMembershipCount?: number;
  lastMembershipError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalEngagementSnapshot {
  externalEngagementSnapshotId: string;
  externalPublicationId: string;
  capturedAt: string;
  views?: number;
  favourites?: number;
  comments?: number;
  otherMetricsJson?: Record<string, unknown>;
}

export interface ExternalEngagementCurrent {
  externalPublicationId: string;
  capturedAt: string;
  views?: number;
  favourites?: number;
  comments?: number;
  downloads?: number;
  viewsToday?: number;
  downloadsToday?: number;
  otherMetricsJson?: Record<string, unknown>;
}

export interface ExternalComment {
  externalCommentId: string;
  platform: ExternalPlatform;
  externalCommentExternalId: string;
  externalPublicationId: string;
  externalAuthorId?: string;
  externalAuthorName?: string;
  externalAuthorAvatarUrl?: string;
  body: string;
  createdAtRemote?: string;
  parentExternalCommentExternalId?: string;
  replyCount?: number;
  likeCount?: number;
  isLiked?: boolean;
  isFeatured?: boolean;
  hiddenReason?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  remoteDeletedAt?: string;
  /** Provider payload retained for adapter migrations and diagnostics. */
  rawPayload?: Record<string, unknown>;
  lastSyncedAt: string;
}

export interface ExternalFavourite {
  externalPublicationId: string;
  externalUserId: string;
  externalUsername: string;
  externalUserAvatarUrl?: string;
  favouritedAtRemote?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  active: boolean;
  removalDetectedAt?: string;
  rawPayload?: Record<string, unknown>;
}

export interface ExternalWatcher {
  externalAccountId: string;
  externalUserId: string;
  externalUsername: string;
  externalUserAvatarUrl?: string;
  lastVisitAtRemote?: string;
  watchSettings?: Record<string, boolean>;
  firstSeenAt: string;
  lastSeenAt: string;
  active: boolean;
  removalDetectedAt?: string;
  stateVersion: number;
  lastActivityRemoteId?: string;
  rawPayload?: Record<string, unknown>;
}

export type ExternalActivityType = 'comment' | 'reply' | 'favourite' | 'watch' | 'unwatch' | 'mention' | 'activity';

export interface ExternalActivity {
  externalActivityId: string;
  externalAccountId: string;
  creatorIdentityId?: string;
  assetId?: string;
  externalPublicationId?: string;
  platform: ExternalPlatform;
  type: ExternalActivityType;
  direction: 'inbound' | 'outbound';
  remoteActivityId: string;
  remoteObjectType?: string;
  remoteObjectId?: string;
  remoteMessageId?: string;
  remoteParentId?: string;
  remoteStackId?: string;
  externalActorId?: string;
  externalActorName?: string;
  externalActorAvatarUrl?: string;
  body?: string;
  remoteUrl?: string;
  occurredAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenAt?: string;
  readAt?: string;
  remoteDeletedAt?: string;
  rawPayload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ExternalSyncResourceType = 'feedback.comments' | 'feedback.replies' | 'feedback.activity' | 'messages.feed' | 'messages.mentions' | 'watchers' | 'comments' | 'favourites' | 'engagement' | 'catalogue' | 'gallery.membership' | 'publication.lifecycle';

export interface ExternalSyncCheckpoint {
  externalAccountId: string;
  resourceType: ExternalSyncResourceType;
  resourceId: string;
  highWatermarkAt?: string;
  lastRemoteId?: string;
  recentRemoteIds?: string[];
  lastAttemptAt?: string;
  lastSuccessfulSyncAt?: string;
  nextEligibleAt?: string;
  lastError?: string;
  summary?: Record<string, unknown>;
  updatedAt: string;
}

export interface ExternalSyncJob {
  externalSyncJobId: string;
  externalAccountId: string;
  type: ExternalSyncJobType;
  status: ExternalSyncJobStatus;
  payload?: Record<string, unknown>;
  progress?: {
    discovered: number;
    synchronized: number;
    remaining: number;
  };
  attemptCount: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalSyncLog {
  externalSyncLogId: string;
  externalSyncJobId: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}
