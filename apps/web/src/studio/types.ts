import type { PostBlock } from '../domainTypes';

export const studioIntegrationPlatforms = [
  { id: 'deviantart', label: 'DeviantArt' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'fanvue', label: 'Fanvue' },
  { id: 'bluesky', label: 'Bluesky' },
  { id: 'discord', label: 'Discord' },
  { id: 'tumblr', label: 'Tumblr' }
] as const;

export type StudioIntegrationPlatform = typeof studioIntegrationPlatforms[number]['id'];

export type StudioMetrics = {
  totalUsers: number;
  creators: number;
  groupings: number;
  posts: number;
  files: number;
  mediaItems: number;
  pendingEntries: number;
  reviewItems: number;
  contributors: number;
};

export type StudioCreator = {
  creatorId: string;
  name: string;
  slug: string;
  visibleIntegrations?: StudioIntegrationPlatform[];
  status?: 'active' | 'inactive';
  spaceTier?: 'free' | 'approved';
  approvedCreatorAt?: string;
  createdAt?: string;
  space?: {
    bio?: string;
    externalLinks?: Array<{ label: string; url: string }>;
    theme?: 'default' | 'ubeeq' | 'sand' | 'forest' | 'slate';
    coverPreset?: string;
    visibility?: 'public-discoverable' | 'public-link' | 'private';
    shareCode?: string;
    showOnMemberProfile?: boolean;
  };
  branding?: {
    profileImage?: {
      sourceKey: string;
      thumbnailKeys?: {
        square256?: string;
        square512?: string;
        square1024?: string;
      };
      thumbnailUrls?: {
        square256?: string;
        square512?: string;
        square1024?: string;
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
      renditionUrls?: {
        desktop?: string;
        tablet?: string;
        mobile?: string;
      };
      altText?: string;
      updatedAt: string;
    };
  };
};

export type StudioFile = {
  fileId: string;
  creatorId: string;
  sourceKind: string;
  mimeType: string;
  storageKey: string;
  originalFilename?: string;
  sizeBytes?: number;
  premium?: boolean;
  restricted?: boolean;
  updatedAt?: string;
};

export type StudioPost = {
  postId: string;
  title: string;
  status: string;
  creatorId: string;
  metadata?: Record<string, string>;
  postType?: 'image' | 'video' | 'story' | 'audio';
  postFormat?: 'single' | 'multi' | 'short' | 'long';
  summary?: string;
  updatedAt?: string;
  primaryMediaId?: string;
  blocks: PostBlock[];
  media?: Array<{
    mediaId: string;
    caption?: string;
    sortOrder?: number;
    discoverable?: boolean;
  }>;
};

export type StudioGrouping = {
  groupingId: string;
  title: string;
  creatorId: string;
  slug?: string;
  status?: string;
  visibility?: string;
};

export type StudioChallenge = {
  contextId: string;
  title: string;
  slug: string;
  status: string;
  type: string;
  description?: string;
  submissionWindow?: { opensAt?: string; closesAt?: string };
  votingWindow?: { opensAt?: string; closesAt?: string };
  recurrence?: 'none' | 'daily' | 'weekly' | 'monthly';
  specificRules?: string;
  votingConfig?: { mode?: 'none' | 'fan_love' | 'judged' | 'mixed' };
};

export type StudioEntry = {
  submissionId: string;
  contextId: string;
  title: string;
  status: string;
  userId: string;
  convertedPostId?: string;
  promotionOutcome?: string;
  submittedAt?: string;
};

export type StudioUser = {
  userId: string;
  username: string;
  displayName?: string;
  role: string;
  isBeeker?: boolean;
  managedCreatorCount?: number;
};

export type StudioDeviantArtAccount = {
  externalAccountId: string;
  externalPlatformCredentialId: string;
  creatorIdentityId?: string;
  primaryCreatorIdentityId?: string;
  creatorAssignments?: string[];
  platform: 'deviantart';
  externalUserId: string;
  externalUsername: string;
  tokenExpiresAt?: string;
  connectionStatus: 'connected' | 'authentication_required' | 'rate_limited' | 'temporarily_unavailable' | 'disabled';
  rateLimitedUntil?: string;
  lastSuccessfulSyncAt?: string;
  lastSyncAttemptAt?: string;
  health?: {
    state: 'connected' | 'authentication_required' | 'rate_limited' | 'temporarily_unavailable' | 'disabled' | 'attention';
    token: { status: 'valid' | 'expires_soon' | 'expired' | 'unknown'; expiresAt?: string; grantedScopes: string[] };
    sync: { lastAttemptAt?: string; lastSuccessfulAt?: string; rateLimitedUntil?: string; coolingDown: boolean };
    issue?: {
      code: 'authentication_required' | 'rate_limited' | 'temporarily_unavailable' | 'invalid_response' | 'unsupported' | 'sync_failed';
      message: string;
      remediation: string;
      occurredAt: string;
    };
    recommendedAction: 'none' | 'reconnect' | 'wait' | 'retry_sync' | 'review_setup';
  };
  includeSourceFilesOnSync?: boolean;
  deviantArtPublishingPreset?: {
    titleFormat: 'filename_title_case';
    defaultTags: string[];
    galleryExternalCollectionIds: string[];
    targetStatus: 'draft' | 'published';
    displayResolution?: number;
    allowFreeDownload: boolean;
    addWatermark: boolean;
    isMature: boolean;
    matureLevel: 'strict' | 'moderate';
    matureClassification: Array<'nudity' | 'sexual' | 'gore' | 'language' | 'ideology'>;
    isAiGenerated: boolean;
    noAi: boolean;
    sourceFileMode: 'original';
  };
};

export type StudioYouTubeAccount = Omit<StudioDeviantArtAccount, 'platform' | 'includeSourceFilesOnSync' | 'deviantArtPublishingPreset'> & {
  platform: 'youtube';
  channelTitle?: string;
};

export type StudioBlueskyAccount = Omit<StudioDeviantArtAccount, 'platform' | 'includeSourceFilesOnSync' | 'deviantArtPublishingPreset'> & {
  platform: 'bluesky';
};

export type StudioExternalSyncJob = {
  externalSyncJobId: string;
  externalAccountId: string;
  type: string;
  status: string;
  payload?: Record<string, unknown>;
  attemptCount?: number;
  nextAttemptAt?: string;
  errorCode?: string;
  progress?: { discovered: number; synchronized: number; remaining: number };
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type StudioExternalComment = {
  externalCommentId: string;
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
  lastSyncedAt: string;
};

export type StudioExternalEngagement = {
  externalPublicationId: string;
  capturedAt: string;
  views?: number;
  favourites?: number;
  comments?: number;
  downloads?: number;
  viewsToday?: number;
  downloadsToday?: number;
};

export type StudioExternalFavourite = {
  externalPublicationId: string;
  externalUserId: string;
  externalUsername: string;
  externalUserAvatarUrl?: string;
  favouritedAtRemote?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  active: boolean;
};

export type StudioExternalActivity = {
  externalActivityId: string;
  externalAccountId: string;
  externalPublicationId?: string;
  assetId?: string;
  platform: string;
  type: 'comment' | 'reply' | 'favourite' | 'watch' | 'unwatch' | 'mention' | 'publication' | 'activity';
  direction: 'inbound' | 'outbound';
  remoteActivityId: string;
  remoteMessageId?: string;
  remoteStackId?: string;
  externalActorName?: string;
  externalActorAvatarUrl?: string;
  body?: string;
  occurredAt?: string;
  firstSeenAt: string;
  readAt?: string;
  remoteDeletedAt?: string;
  integrationIssue?: {
    code: string;
    remediation: string;
  };
  publicationAction?: 'publish' | 'publish_retrying' | 'publish_failed';
  account?: {
    externalAccountId: string;
    platform: string;
    externalUserId: string;
    externalUsername: string;
  };
  work?: {
    assetId: string;
    title: string;
    assetType: string;
    thumbnailUrl?: string;
    externalUrl?: string;
  };
};

export type StudioWorkActivityDestination = {
  publication: StudioExternalPublication;
  account?: StudioDeviantArtAccount;
  engagement: StudioExternalEngagement | null;
  comments: StudioExternalComment[];
  favourites: StudioExternalFavourite[];
  activities: StudioExternalActivity[];
  capabilities?: {
    reply: boolean;
    remoteCommentModeration: boolean;
    remoteCommentModerationReason?: string;
  };
};

export type StudioExternalPublication = {
  externalPublicationId: string;
  externalAccountId: string;
  platform?: string;
  externalUsername: string;
  externalContentId: string;
  targetStatus?: 'draft' | 'published';
  canUpdatePublishedDescription?: boolean;
  publishedDescriptionUpdateMode?: 'stash';
  externalUrl?: string;
  previewUrl?: string;
  externalTitle?: string;
  externalDescription?: string;
  externalTags: string[];
  displayOptions?: {
    allowComments?: boolean;
    displayResolution?: number;
    allowFreeDownload?: boolean;
    addWatermark?: boolean;
    isMature?: boolean;
    matureLevel?: 'strict' | 'moderate';
    matureClassification?: string[];
    isAiGenerated?: boolean;
    noAi?: boolean;
  };
  externalCollectionIds: string[];
  publishedAt?: string;
  remoteUpdatedAt?: string;
  lastSyncedAt?: string;
  metadataSyncStatus?: 'in_sync' | 'remote_changed' | 'local_update_pending' | 'conflict';
  reconciliation?: StudioPublicationReconciliation;
  remoteChangeDetectedAt?: string;
  lastOutboundSyncAt?: string;
  remoteStateReason?: string;
  syncStatus: 'pending_publish' | 'draft' | 'active' | 'missing' | 'deleted' | 'restricted' | 'unknown' | 'error';
};

export type StudioReconciliationAction = 'accept_remote' | 'keep_local' | 'create_detached_copy';

export type StudioPublicationReconciliation = {
  status: 'in_sync' | 'local_newer' | 'remote_newer' | 'non_conflicting_changes' | 'conflict';
  fields: Array<{
    field: string;
    lastSynced: unknown;
    local: unknown;
    remote: unknown;
    localChanged: boolean;
    remoteChanged: boolean;
    conflict: boolean;
  }>;
  updatedAt: string;
};

export type StudioExternalAsset = {
  assetId: string;
  creatorIdentityId: string;
  assetType: 'image' | 'literature' | 'video' | 'animation' | 'other';
  canonicalTitle?: string;
  canonicalDescription?: string;
  /** Canonical provenance disclosure, used to preflight platform-specific AI labels. */
  aiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
  /** Structured block content for literature/article Works. */
  body?: PostBlock[];
  canonicalSlug?: string;
  discoveryState?: 'none' | 'eligible' | 'opted_in' | 'removed';
  visibility: 'private' | 'unlisted' | 'public';
  titleSyncPolicy: 'mirrored' | 'independent' | 'initially_mirrored' | 'manual';
  descriptionSyncPolicy: 'mirrored' | 'independent' | 'initially_mirrored' | 'manual';
  updatedAt: string;
  workStatus: 'draft' | 'ready' | 'archived' | 'deleted';
  contentAvailability: 'metadata_only' | 'external_reference' | 'display_copy' | 'original_hosted';
  origin: {
    type: 'local' | 'import';
    platform?: string;
    integrationAccountId?: string;
    remoteId?: string;
    remoteUrl?: string;
    importedAt?: string;
  };
  destinationPublications: StudioDestinationPublication[];
  publicationIntents: StudioPublicationIntent[];
  /** A preview from the configured creator-workspace backup, when one is available. */
  thumbnailUrl?: string;
  spacePublication?: StudioSpacePublication | null;
  engagement?: {
    views: number;
    favourites: number;
    comments: number;
    downloads: number;
    capturedAt?: string;
    destinations: number;
  };
  publications: StudioExternalPublication[];
};

export type StudioDestinationPublication = {
  publicationId: string;
  destination: string;
  integrationAccountId?: string;
  accountLabel?: string;
  status: 'draft' | 'scheduled' | 'queued' | 'publishing' | 'live' | 'updating' | 'failed' | 'missing' | 'removed' | 'unknown';
  visibility: 'private' | 'unlisted' | 'public';
  syncStatus: 'not_applicable' | 'in_sync' | 'local_newer' | 'remote_newer' | 'non_conflicting_changes' | 'conflict' | 'error' | 'unknown';
  remoteUrl?: string;
  publishedAt?: string;
};

export type StudioPublicationIntent = {
  publicationIntentId: string;
  destination: string;
  integrationAccountId?: string;
  enabled: boolean;
  desiredStatus: 'draft' | 'live' | 'scheduled';
  scheduledAt?: string;
};

export type StudioSpacePublication = {
  assetId: string;
  published: boolean;
  hostingMode: 'linked' | 'hosted';
  contentSyncStatus?: 'not_requested' | 'queued' | 'syncing' | 'hosted' | 'not_available' | 'failed';
  sourceCopyQuality?: 'original' | 'display_copy';
  originalDownloadStatus?: 'available' | 'not_downloadable' | 'missing';
  hostedByteSize?: number;
  lastContentSyncAt?: string;
  contentSyncError?: string;
  publishedAt?: string;
  visibility: 'private' | 'unlisted' | 'public';
};

export type StudioUbeeqCollection = {
  ubeeqCollectionId: string;
  creatorIdentityId: string;
  name: string;
  parentUbeeqCollectionId?: string;
  visibility: 'private' | 'unlisted' | 'public';
  collectionType?: 'collection' | 'gallery' | 'series';
};

export type StudioExternalCollection = {
  externalCollectionId: string;
  externalAccountId: string;
  externalCollectionExternalId: string;
  externalUsername: string;
  name: string;
  description?: string;
  parentExternalCollectionExternalId?: string;
  position?: number;
  remoteSize?: number;
  syncStatus?: 'active' | 'missing';
  lastSeenAt?: string;
  lastSyncedAt?: string;
};

export type StudioExternalCollectionMapping = {
  externalCollectionMappingId: string;
  externalAccountId: string;
  externalCollectionId: string;
  ubeeqCollectionId: string;
  syncMode: 'continuous' | 'initial_only' | 'manual' | 'ignored';
  lastMembershipSyncAt?: string;
  lastMembershipCount?: number;
  lastMembershipError?: string;
};
