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
