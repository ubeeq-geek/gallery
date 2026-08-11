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
  status?: 'active' | 'inactive';
  spaceTier?: 'free' | 'approved';
  approvedCreatorAt?: string;
  createdAt?: string;
  branding?: {
    profileImage?: {
      sourceKey: string;
      thumbnailKeys?: {
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
  media?: Array<{ mediaId: string }>;
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
  creatorIdentityId?: string;
  primaryCreatorIdentityId?: string;
  creatorAssignments?: string[];
  platform: 'deviantart';
  externalUserId: string;
  externalUsername: string;
  tokenExpiresAt?: string;
  connectionStatus: 'connected' | 'authentication_required' | 'rate_limited' | 'temporarily_unavailable' | 'disabled';
  lastSuccessfulSyncAt?: string;
  lastSyncAttemptAt?: string;
};

export type StudioExternalSyncJob = {
  externalSyncJobId: string;
  externalAccountId: string;
  type: string;
  status: string;
  progress?: { discovered: number; synchronized: number; remaining: number };
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type StudioExternalPublication = {
  externalPublicationId: string;
  externalAccountId: string;
  externalUsername: string;
  externalContentId: string;
  externalUrl?: string;
  externalTitle?: string;
  externalTags: string[];
  externalCollectionIds: string[];
  publishedAt?: string;
  remoteUpdatedAt?: string;
  syncStatus: string;
};

export type StudioExternalAsset = {
  assetId: string;
  creatorIdentityId: string;
  assetType: 'image' | 'literature' | 'video' | 'animation' | 'other';
  canonicalTitle?: string;
  canonicalDescription?: string;
  visibility: 'private' | 'unlisted' | 'public';
  titleSyncPolicy: 'mirrored' | 'independent' | 'initially_mirrored' | 'manual';
  descriptionSyncPolicy: 'mirrored' | 'independent' | 'initially_mirrored' | 'manual';
  updatedAt: string;
  spacePublication?: StudioSpacePublication | null;
  publications: StudioExternalPublication[];
};

export type StudioSpacePublication = {
  assetId: string;
  published: boolean;
  hostingMode: 'linked' | 'hosted';
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
  parentExternalCollectionExternalId?: string;
  position?: number;
};

export type StudioExternalCollectionMapping = {
  externalCollectionMappingId: string;
  externalAccountId: string;
  externalCollectionId: string;
  ubeeqCollectionId: string;
  syncMode: 'continuous' | 'initial_only' | 'manual' | 'ignored';
};
