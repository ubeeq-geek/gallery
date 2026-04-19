export type Creator = { creatorId: string; name: string; slug: string; creatorThumbnailUrl?: string };

export type ManagedCreator = Creator & { memberRole?: 'owner' | 'manager' | 'editor' | 'admin' };

export type FeedDensity = 'small' | 'medium' | 'large';

export type DensityViewport = 'mobile' | 'tablet' | 'desktop';

export type DiscoveryFilterSection = 'period' | 'density' | 'media' | 'heavy' | 'search';

export type DiscoveryDockSummary = {
  active: boolean;
  viewport: DensityViewport;
  period: 'hourly' | 'daily';
  density: FeedDensity;
  mediaLabel: string;
  showImages: boolean;
  showVideos: boolean;
  showPosts: boolean;
  heavyLabel:
    | 'Heavy Shown'
    | 'Some Heavy'
    | 'Heavy Hidden'
    | 'Heavy Topics Shown'
    | 'Some Heavy Topics'
    | 'Heavy Topics Hidden';
  searchActive: boolean;
};

export const DISCOVERY_FILTER_EVENT_NAME = 'ubeeq:discovery-filters';

export type ContentRating = 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';

export type AiDisclosure = 'none' | 'ai-assisted' | 'ai-generated';

export type AiFilterPreference = 'show-all' | 'hide-ai-generated' | 'hide-all-ai';

export type HeavyTopic = 'politics-public-affairs' | 'crime-disasters-tragedy';

export type CollectionSummary = {
  collectionId: string;
  ownerUserId: string;
  title: string;
  description?: string;
  coverImageId?: string;
  visibility: 'public' | 'private';
  insertedDate: string;
  updatedDate: string;
  imageCount: number;
  favoriteCount: number;
};

export type TrendingImage = {
  imageId: string;
  assetType?: 'image' | 'video';
  creatorId: string;
  creatorName: string;
  groupingId: string;
  groupingSlug: string;
  groupingVisibility?: 'free' | 'preview' | 'premium';
  discoverSquareCropEnabled?: boolean;
  effectiveContentRating?: ContentRating;
  displayedContentRating?: string;
  blurred?: boolean;
  effectiveAiDisclosure?: AiDisclosure;
  displayedAiDisclosure?: string;
  effectiveHeavyTopics?: HeavyTopic[];
  displayedHeavyTopics?: string[];
  title: string;
  previewUrl: string;
  previewPosterUrl?: string;
  width?: number;
  height?: number;
  aspectRatio?: number;
  favoriteCount: number;
  createdAt: string;
};

export type CreatorProfilePayload = {
  creatorId: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive';
  defaultProfileTab?: 'feed' | 'groupings';
  followerCount: number;
  imageCount: number;
  groupingCount: number;
  feedItems?: Array<{
    imageId: string;
    title: string;
    assetType: 'image' | 'video';
    createdAt: string;
    previewUrl?: string;
    previewPosterUrl?: string;
    favoriteCount?: number;
  }>;
  featured?: {
    items: Array<{ imageId: string; title: string; previewUrl?: string; previewPosterUrl?: string }>;
    groupings: Array<{ groupingId: string; title: string; slug: string; visibility: 'free' | 'preview' | 'premium'; groupingThumbnailUrl?: string }>;
  };
  trendingImages: TrendingImage[];
  groupings: Array<{
    groupingId: string;
    title: string;
    slug: string;
    visibility: 'free' | 'preview' | 'premium';
    createdAt: string;
    imageCount: number;
    favoriteCount: number;
    groupingThumbnailUrl?: string;
  }>;
  publicFavoritesByType: {
    images: Array<{ targetId: string; targetType?: 'image'; createdAt?: string; title?: string; previewUrl?: string }>;
    groupings: Array<{ targetId: string; targetType?: 'grouping'; createdAt?: string; title?: string; slug?: string; groupingThumbnailUrl?: string }>;
    collections: Array<{ targetId: string; targetType?: 'collection'; createdAt?: string; title?: string }>;
  };
  publicCollections: Array<{
    collectionId: string;
    title: string;
    description?: string;
    visibility: 'public' | 'private';
    insertedDate: string;
    updatedDate: string;
    imageCount: number;
    favoriteCount: number;
  }>;
};

export type GroupingSummary = {
  groupingId: string;
  title: string;
  slug: string;
  visibility: 'free' | 'preview' | 'premium';
  hasAccess?: boolean;
  purchaseUrl?: string;
  groupingThumbnailUrl?: string;
  stackPreviewUrls?: string[];
};

export type GroupingAsset = {
  imageId: string;
  assetType: 'image' | 'video';
  effectiveContentRating?: ContentRating;
  displayedContentRating?: string;
  blurred?: boolean;
  effectiveAiDisclosure?: AiDisclosure;
  displayedAiDisclosure?: string;
  effectiveHeavyTopics?: HeavyTopic[];
  displayedHeavyTopics?: string[];
  previewUrl: string;
  previewPosterUrl?: string;
  thumbnailUrls?: {
    w320?: string;
    w640?: string;
    w1280?: string;
    w1920?: string;
    square256?: string;
    square512?: string;
    square1024?: string;
  };
  favoriteCount: number;
};

export type Grouping = {
  groupingId: string;
  title: string;
  visibility: 'free' | 'preview' | 'premium';
  hasAccess?: boolean;
  purchaseUrl?: string;
  coverMediaId?: string;
  coverPreviewUrl?: string;
  coverBlur?: boolean;
  premiumTeaserMedia?: Array<{
    imageId: string;
    assetType: 'image' | 'video';
    effectiveContentRating?: ContentRating;
    displayedContentRating?: string;
    blurred?: boolean;
    effectiveAiDisclosure?: AiDisclosure;
    displayedAiDisclosure?: string;
    effectiveHeavyTopics?: HeavyTopic[];
    displayedHeavyTopics?: string[];
    previewUrl: string;
    previewPosterUrl?: string;
  }>;
  favoriteCount: number;
  media: GroupingAsset[];
};

export type Comment = {
  commentId: string;
  authorProfileType?: 'user' | 'creator';
  authorProfileId?: string;
  displayName: string;
  body: string;
  createdAt: string;
};

export type SiteSettings = { siteName: string; theme: 'ubeeq' | 'sand' | 'forest' | 'slate'; logoUrl?: string };

export type UserProfile = {
  userId: string;
  username: string;
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
};

export type ManagedFavorite = {
  targetType: 'grouping' | 'image' | 'collection';
  targetId: string;
  visibility?: 'public' | 'private';
  createdAt: string;
};

export type PostStatus = 'draft' | 'published' | 'archived';
export type PostDiscoveryMode = 'primary' | 'all' | 'selected';
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

export type PostBlock = {
  blockId: string;
  type: PostBlockType;
  text?: string;
  level?: number;
  mediaId?: string;
  caption?: string;
  quote?: string;
  author?: string;
  url?: string;
  mimeType?: string;
  title?: string;
  html?: string;
  payload?: Record<string, unknown>;
};

export type PostMediaRef = {
  mediaId: string;
  discoverable?: boolean;
  sortOrder?: number;
  caption?: string;
};

export type PostDestination = {
  type: 'post' | 'pdf' | 'external' | 'internal';
  url: string;
};

export type ManagedPost = {
  postId: string;
  creatorId: string;
  authorId?: string;
  title: string;
  slug: string;
  slugHistory?: string[];
  summary?: string;
  status: PostStatus;
  blocks: PostBlock[];
  media: PostMediaRef[];
  primaryMediaId?: string;
  discovery: { mode: PostDiscoveryMode };
  destination?: PostDestination | null;
  metadata?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
};

export type ManagedCollection = {
  collectionId: string;
  title: string;
  description?: string;
  visibility: 'public' | 'private';
  imageCount: number;
  favoriteCount: number;
  updatedDate: string;
  imageIds?: string[];
};
