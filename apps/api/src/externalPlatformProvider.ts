import type { ExternalActivityType, ExternalAssetType, ExternalPlatform } from './domain';

/** DeviantArt rejects /deviation/metadata requests containing more than ten IDs. */
export const DEVIANTART_METADATA_BATCH_SIZE = 10;

// The DeviantArt UI describes these options as pixel widths, while the
// /stash/publish API expects the option's enum index. `0` means original; we
// represent that choice by omitting displayResolution from the request model.
const deviantArtDisplayResolutionCode = new Map<number, number>([
  [400, 1],
  [600, 2],
  [800, 3],
  [900, 4],
  [1024, 5],
  [1280, 6],
  [1600, 7],
  [1920, 8]
]);

export class ExternalProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'authentication_required' | 'rate_limited' | 'temporarily_unavailable' | 'ambiguous_submission' | 'invalid_response' | 'unsupported',
    readonly retryAfterSeconds?: number,
    readonly operation?: 'token_exchange' | 'account_lookup'
  ) {
    super(message);
    this.name = 'ExternalProviderError';
  }
}

export interface ExternalAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface ExternalPlatformApplicationCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Provider API pacing. OAuth token exchange is intentionally excluded. */
  minimumRequestIntervalMs?: number;
  /** Override for tests; production uses the public platform API base URL. */
  apiBaseUrl?: string;
  /** Space-separated OAuth scopes requested for this provider. */
  oauthScopes?: string;
}

export interface ExternalOAuthPkce {
  codeChallenge: string;
  codeVerifier: string;
}

export interface ExternalRemoteAccount {
  externalUserId: string;
  externalUsername: string;
}

export interface ExternalRemoteProfile {
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
  stats: {
    watchers?: number;
    friends?: number;
    deviations?: number;
    favourites?: number;
    comments?: number;
    profilePageviews?: number;
    profileComments?: number;
  };
  rawPayload: Record<string, unknown>;
}

export interface ExternalRemoteDownload {
  status: 'available' | 'not_downloadable' | 'missing';
  sourceUrl?: string;
  filename?: string;
  byteSize?: number;
  width?: number;
  height?: number;
  rawPayload: Record<string, unknown>;
}

export interface ExternalRemoteCollection {
  externalCollectionId: string;
  name: string;
  description?: string;
  parentExternalCollectionId?: string;
  position?: number;
  size?: number;
  rawMetadata: Record<string, unknown>;
}

export interface ExternalRemoteContent {
  externalContentId: string;
  externalUrl?: string;
  title: string;
  description?: string;
  tags: string[];
  assetType: ExternalAssetType;
  publishedAt?: string;
  remoteCreatedAt?: string;
  remoteUpdatedAt?: string;
  collectionExternalIds: string[];
  remoteState?: 'active' | 'deleted' | 'restricted';
  remoteStateReason?: string;
  content?: {
    sourceUrl: string;
    contentType?: string;
    byteSize?: number;
    filename?: string;
    width?: number;
    height?: number;
  };
  metrics?: {
    views?: number;
    favourites?: number;
    comments?: number;
    downloads?: number;
    viewsToday?: number;
    downloadsToday?: number;
    other?: Record<string, unknown>;
  };
  rawMetadata: Record<string, unknown>;
}

export interface ExternalContentUpdate {
  title?: string;
  description?: string;
  tags?: string[];
  collectionExternalIds?: string[];
  allowComments?: boolean;
  /** A width selects a rendition; null explicitly restores DeviantArt's Original option. */
  displayResolution?: number | null;
  allowFreeDownload?: boolean;
  addWatermark?: boolean;
  isMature?: boolean;
  matureLevel?: 'strict' | 'moderate';
  matureClassification?: Array<'nudity' | 'sexual' | 'gore' | 'language' | 'ideology'>;
  isAiGenerated?: boolean;
  noAi?: boolean;
}

export interface ExternalContentUpdateOptions {
  externalDraftId?: string;
  publishedDescriptionUpdate?: boolean;
}

export interface ExternalContentPublish {
  body: Buffer;
  filename: string;
  contentType: string;
  title: string;
  description?: string;
  tags?: string[];
  collectionExternalIds?: string[];
  isMature?: boolean;
  matureLevel?: 'strict' | 'moderate';
  matureClassification?: Array<'nudity' | 'sexual' | 'gore' | 'language' | 'ideology'>;
  allowComments?: boolean;
  displayResolution?: number;
  allowFreeDownload?: boolean;
  addWatermark?: boolean;
  isAiGenerated?: boolean;
  noAi?: boolean;
}

/** Native text publication payloads. These bypass Sta.sh because DeviantArt
 * exposes dedicated endpoints for literature and journals. */
export interface ExternalLiteraturePublish {
  title: string;
  body: string;
  description?: string;
  tags?: string[];
  collectionExternalIds?: string[];
  isMature?: boolean;
  matureLevel?: 'strict' | 'moderate';
  matureClassification?: Array<'nudity' | 'sexual' | 'gore' | 'language' | 'ideology'>;
  allowComments?: boolean;
  license?: string;
}

export interface ExternalJournalPublish {
  title: string;
  body: string;
  tags?: string[];
  coverUrl?: string;
  embeddedImageUrl?: string;
  isMature?: boolean;
  matureLevel?: 'strict' | 'moderate';
  matureClassification?: Array<'nudity' | 'sexual' | 'gore' | 'language' | 'ideology'>;
  allowComments?: boolean;
}

export interface ExternalStatusPublish {
  body: string;
  parentExternalId?: string;
  stashExternalId?: string;
}

export interface ExternalPublishedContent {
  externalContentId: string;
  externalDraftId?: string;
  externalUrl?: string;
  rawMetadata: Record<string, unknown>;
}

export interface ExternalPublishedPost {
  externalPostId: string;
  externalUrl?: string;
  rawMetadata: Record<string, unknown>;
}

export interface ExternalDraftContent {
  externalDraftId: string;
  externalUrl?: string;
  rawMetadata: Record<string, unknown>;
}

export interface ExternalRemoteComment {
  externalCommentId: string;
  authorId?: string;
  authorName?: string;
  authorAvatarUrl?: string;
  body: string;
  createdAt?: string;
  parentExternalCommentId?: string;
  replyCount?: number;
  likeCount?: number;
  isLiked?: boolean;
  isFeatured?: boolean;
  hiddenReason?: string;
  rawPayload?: Record<string, unknown>;
}

export interface ExternalRemoteFavourite {
  externalUserId: string;
  username: string;
  avatarUrl?: string;
  favouritedAt?: string;
  rawPayload: Record<string, unknown>;
}

export interface ExternalRemoteActivity {
  remoteActivityId: string;
  sourceMessageId: string;
  remoteMessageId?: string;
  type: ExternalActivityType;
  occurredAt?: string;
  stackId?: string;
  stackCount?: number;
  isNew?: boolean;
  actorId?: string;
  actorName?: string;
  actorAvatarUrl?: string;
  externalContentId?: string;
  externalCommentId?: string;
  parentExternalCommentId?: string;
  body?: string;
  rawPayload: Record<string, unknown>;
}

export interface ExternalRemoteWatcher {
  externalUserId: string;
  username: string;
  avatarUrl?: string;
  lastVisitAt?: string;
  watchSettings?: Record<string, boolean>;
  rawPayload: Record<string, unknown>;
}

export interface ExternalRemoteEngagement {
  externalContentId: string;
  metrics: NonNullable<ExternalRemoteContent['metrics']>;
  rawPayload: Record<string, unknown>;
}

export interface ExternalContentPage {
  items: ExternalRemoteContent[];
  nextCursor?: string;
}

export interface ExternalPlatformProvider {
  readonly platform: ExternalPlatform;
  isConfigured(): boolean;
  createAuthorizationUrl(state: string, pkce?: ExternalOAuthPkce): string;
  exchangeAuthorizationCode(code: string, pkce?: ExternalOAuthPkce): Promise<ExternalAuthTokens>;
  refreshAuthentication(refreshToken: string): Promise<ExternalAuthTokens>;
  getAccount(accessToken: string): Promise<ExternalRemoteAccount>;
  getProfile(accessToken: string, username: string): Promise<ExternalRemoteProfile>;
  listContent(accessToken: string, options: { username: string; cursor?: string; limit?: number }): Promise<ExternalContentPage>;
  getContent(accessToken: string, externalContentId: string): Promise<ExternalRemoteContent>;
  getOriginalDownload(accessToken: string, externalContentId: string): Promise<ExternalRemoteDownload>;
  getEngagement(accessToken: string, externalContentIds: string[]): Promise<ExternalRemoteEngagement[]>;
  listCollections(accessToken: string, username: string): Promise<ExternalRemoteCollection[]>;
  createGalleryFolder(accessToken: string, name: string): Promise<ExternalRemoteCollection>;
  listCollectionContent(accessToken: string, externalCollectionId: string, username: string, cursor?: string): Promise<ExternalContentPage>;
  listComments(accessToken: string, externalContentId: string, cursor?: string): Promise<{ items: ExternalRemoteComment[]; nextCursor?: string }>;
  listFeedback(accessToken: string, type: 'comments' | 'replies' | 'activity', cursor?: string): Promise<{ items: ExternalRemoteActivity[]; nextCursor?: string }>;
  listMessages(accessToken: string, source: 'feed' | 'mentions', cursor?: string): Promise<{ items: ExternalRemoteActivity[]; nextCursor?: string }>;
  listMessageStack(accessToken: string, source: 'feedback' | 'mentions', stackId: string, cursor?: string): Promise<{ items: ExternalRemoteActivity[]; nextCursor?: string }>;
  listWatchers(accessToken: string, username: string, cursor?: string): Promise<{ items: ExternalRemoteWatcher[]; nextCursor?: string; truncated?: boolean }>;
  deleteMessage(accessToken: string, message: { messageId?: string; stackId?: string; folderId?: string }): Promise<void>;
  listFavourites(accessToken: string, externalContentId: string, cursor?: string): Promise<{ items: ExternalRemoteFavourite[]; nextCursor?: string }>;
  postComment(accessToken: string, externalContentId: string, body: string, parentExternalCommentId?: string): Promise<ExternalRemoteComment>;
  updateContent(accessToken: string, externalContentId: string, update: ExternalContentUpdate, options?: ExternalContentUpdateOptions): Promise<void>;
  submitContent(accessToken: string, content: ExternalContentPublish, existingDraftId?: string): Promise<ExternalDraftContent>;
  publishDraft(accessToken: string, externalDraftId: string, content: ExternalContentPublish): Promise<ExternalPublishedContent>;
  publishContent(accessToken: string, content: ExternalContentPublish): Promise<ExternalPublishedContent>;
  createLiterature(accessToken: string, content: ExternalLiteraturePublish): Promise<ExternalPublishedContent>;
  updateLiterature(accessToken: string, externalContentId: string, content: ExternalLiteraturePublish): Promise<ExternalPublishedContent>;
  createJournal(accessToken: string, content: ExternalJournalPublish): Promise<ExternalPublishedContent>;
  postStatus(accessToken: string, content: ExternalStatusPublish): Promise<ExternalPublishedPost>;
  moveContent(): Promise<never>;
}

/** YouTube's management API is intentionally optional: the canonical provider
 * contract remains platform-neutral while YouTube exposes its richer v3
 * resources through this capability interface. */
export interface YouTubePlaylist {
  id: string;
  title: string;
  description?: string;
  privacyStatus?: string;
  itemCount?: number;
  publishedAt?: string;
  rawPayload: Record<string, unknown>;
}

export interface YouTubePlaylistItem {
  id: string;
  playlistId: string;
  videoId: string;
  position?: number;
  title?: string;
  rawPayload: Record<string, unknown>;
}

export interface YouTubeComment {
  id: string;
  videoId?: string;
  parentId?: string;
  authorName?: string;
  authorAvatarUrl?: string;
  text: string;
  publishedAt?: string;
  updatedAt?: string;
  likeCount?: number;
  canReply?: boolean;
  replyCount?: number;
  replies?: YouTubeComment[];
  rawPayload: Record<string, unknown>;
}

export interface YouTubeCaption {
  id: string;
  videoId?: string;
  name?: string;
  language?: string;
  trackKind?: string;
  isDraft?: boolean;
  rawPayload: Record<string, unknown>;
}

export interface YouTubeActivity {
  id: string;
  publishedAt?: string;
  type?: string;
  videoId?: string;
  channelId?: string;
  title?: string;
  description?: string;
  rawPayload: Record<string, unknown>;
}

export interface YouTubeManagementProvider {
  listPlaylists(accessToken: string): Promise<YouTubePlaylist[]>;
  createPlaylist(accessToken: string, input: { title: string; description?: string; privacyStatus?: string }): Promise<YouTubePlaylist>;
  updatePlaylist(accessToken: string, playlistId: string, input: { title?: string; description?: string; privacyStatus?: string }): Promise<YouTubePlaylist>;
  deletePlaylist(accessToken: string, playlistId: string): Promise<void>;
  addPlaylistItem(accessToken: string, playlistId: string, videoId: string): Promise<YouTubePlaylistItem>;
  removePlaylistItem(accessToken: string, playlistItemId: string): Promise<void>;
  updateVideo(accessToken: string, videoId: string, input: { title?: string; description?: string; tags?: string[]; categoryId?: string; privacyStatus?: string; license?: string; embeddable?: boolean }): Promise<ExternalRemoteContent>;
  deleteVideo(accessToken: string, videoId: string): Promise<void>;
  listVideoComments(accessToken: string, videoId: string, cursor?: string): Promise<{ items: YouTubeComment[]; nextCursor?: string }>;
  postVideoComment(accessToken: string, videoId: string, text: string): Promise<YouTubeComment>;
  replyToComment(accessToken: string, parentCommentId: string, text: string): Promise<YouTubeComment>;
  updateComment(accessToken: string, commentId: string, text: string): Promise<YouTubeComment>;
  deleteComment(accessToken: string, commentId: string): Promise<void>;
  moderateComment(accessToken: string, commentId: string, moderationStatus: 'heldForReview' | 'published' | 'rejected' | 'likelySpam', banAuthor?: boolean): Promise<void>;
  listCaptions(accessToken: string, videoId: string): Promise<YouTubeCaption[]>;
  deleteCaption(accessToken: string, captionId: string): Promise<void>;
  getRating(accessToken: string, videoId: string): Promise<'like' | 'dislike' | 'none' | 'unknown'>;
  rateVideo(accessToken: string, videoId: string, rating: 'like' | 'dislike' | 'none'): Promise<void>;
  listChannelActivity(accessToken: string, cursor?: string): Promise<{ items: YouTubeActivity[]; nextCursor?: string }>;
  getAnalytics(): Promise<never>;
}

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const asString = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const asIdentifier = (value: unknown): string | undefined => {
  const stringValue = asString(value);
  if (stringValue) return stringValue;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
};
const descriptionFrom = (item: Record<string, unknown>): string | undefined => {
  const direct = [item.description, item.description_html, item.html, item.excerpt, item.artist_comments]
    .map(asString)
    .find((value): value is string => Boolean(value));
  if (direct) return direct;
  const textContent = asRecord(item.text_content);
  const body = asRecord(textContent.body);
  return [body.html, body.text, textContent.html, textContent.text].map(asString).find((value): value is string => Boolean(value));
};
const asNumber = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

export const parseRetryAfterSeconds = (value: string | null | undefined, now = Date.now()): number | undefined => {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
};

const asBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
};

const metadataBoolean = (metadata: Record<string, unknown>, ...keys: string[]): boolean | undefined => {
  const submission = asRecord(metadata.submission);
  for (const key of keys) {
    const value = asBoolean(metadata[key] ?? submission[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const asIsoDate = (value: unknown): string | undefined => {
  const numeric = asNumber(value);
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    if (!numeric) return undefined;
    const parsedNumeric = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return Number.isFinite(parsedNumeric) ? new Date(parsedNumeric).toISOString() : undefined;
  }
  const raw = asString(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};

const rawItems = (payload: Record<string, unknown>): unknown[] => {
  const values = payload.results || payload.metadata || payload.deviations || payload.items || payload.comments || payload.thread;
  return Array.isArray(values) ? values : [];
};

const normalizeAssetType = (item: Record<string, unknown>): ExternalAssetType => {
  const category = `${asString(item.category_path) || ''} ${asString(item.category) || ''}`.toLowerCase();
  if (Boolean(item.is_film) || category.includes('animation')) return 'animation';
  if (Boolean(item.is_literature) || category.includes('literature') || category.includes('poetry') || category.includes('prose')) return 'literature';
  if (category.includes('film') || category.includes('video')) return 'video';
  if (category.includes('digital') || category.includes('traditional') || category.includes('photography') || category.includes('artisan') || category.includes('design')) return 'image';
  return 'other';
};

const normalizeContent = (value: unknown): ExternalRemoteContent | null => {
  const item = asRecord(value);
  const externalContentId = asString(item.deviationid) || asString(item.uuid) || asString(item.id);
  if (!externalContentId) return null;
  const stats = asRecord(item.stats);
  const tags = (Array.isArray(item.tags) ? item.tags : [])
    .map((tag) => typeof tag === 'string' ? tag : asString(asRecord(tag).name) || asString(asRecord(tag).tag_name))
    .filter((tag): tag is string => Boolean(tag));
  const galleryIds = [
    asString(item.gallery_folder_id),
    asString(item.folderid),
    ...((Array.isArray(item.gallery_folders) ? item.gallery_folders : []).map((folder) => asString(folder)).filter((folder): folder is string => Boolean(folder)))
  ].filter((item, index, values): item is string => Boolean(item) && values.indexOf(item) === index);
  const content = asRecord(item.content);
  const sourceUrl = asString(content.src);
  const isDeleted = asBoolean(item.is_deleted) === true;
  const isBlocked = asBoolean(item.is_blocked) === true;
  const tierAccess = asString(item.tier_access);
  const remoteState = isDeleted ? 'deleted' : (isBlocked || tierAccess === 'locked' || tierAccess === 'locked-subscribed') ? 'restricted' : 'active';
  return {
    externalContentId,
    externalUrl: asString(item.url),
    title: asString(item.title) || 'Untitled DeviantArt work',
    description: descriptionFrom(item),
    tags,
    assetType: normalizeAssetType(item),
    publishedAt: asIsoDate(item.published_time) || asIsoDate(item.published_at),
    remoteCreatedAt: asIsoDate(item.published_time) || asIsoDate(item.created_time),
    remoteUpdatedAt: asIsoDate(item.updated_time) || asIsoDate(item.updated_at),
    collectionExternalIds: galleryIds,
    remoteState,
    ...(remoteState === 'deleted' ? { remoteStateReason: 'Deleted on DeviantArt' } : {}),
    ...(remoteState === 'restricted' ? { remoteStateReason: isBlocked ? 'Blocked or unavailable to this DeviantArt account' : 'Restricted to a DeviantArt tier' } : {}),
    ...(sourceUrl ? {
      content: {
        sourceUrl,
        contentType: asString(content.content_type) || asString(item.mime_type),
        byteSize: asNumber(content.filesize) ?? asNumber(item.filesize),
        filename: asString(content.filename) || asString(item.filename),
        width: asNumber(content.width) || asNumber(item.width),
        height: asNumber(content.height) || asNumber(item.height)
      }
    } : {}),
    metrics: {
      views: asNumber(stats.views) ?? asNumber(item.views),
      favourites: asNumber(stats.favourites) ?? asNumber(stats.favorites) ?? asNumber(item.favourites),
      comments: asNumber(stats.comments) ?? asNumber(item.comments),
      downloads: asNumber(stats.downloads),
      viewsToday: asNumber(stats.views_today),
      downloadsToday: asNumber(stats.downloads_today),
      other: Object.keys(stats).length > 0 ? stats : undefined
    },
    rawMetadata: item
  };
};

const normalizeRemoteComment = (value: unknown): ExternalRemoteComment | null => {
  const item = asRecord(value);
  const externalCommentId = asString(item.commentid) || asString(item.id);
  if (!externalCommentId) return null;
  const user = asRecord(item.user);
  const authorId = asString(item.userid) || asString(user.userid);
  const authorName = asString(item.username) || asString(user.username);
  const authorAvatarUrl = asString(item.usericon) || asString(user.usericon);
  const createdAt = asIsoDate(item.posted) || asIsoDate(item.posted_on) || asIsoDate(item.created_at);
  const parentExternalCommentId = asString(item.parentid);
  const hiddenReason = asString(item.hidden);
  return {
    externalCommentId,
    ...(authorId ? { authorId } : {}),
    ...(authorName ? { authorName } : {}),
    ...(authorAvatarUrl ? { authorAvatarUrl } : {}),
    body: asString(item.body) || descriptionFrom(item) || '',
    ...(createdAt ? { createdAt } : {}),
    ...(parentExternalCommentId ? { parentExternalCommentId } : {}),
    replyCount: asNumber(item.replies),
    likeCount: asNumber(item.likes),
    isLiked: asBoolean(item.is_liked),
    isFeatured: asBoolean(item.is_featured),
    ...(hiddenReason ? { hiddenReason } : {}),
    rawPayload: item
  };
};

const feedbackActivityType = (
  requestedType: 'comments' | 'replies' | 'activity',
  providerType: string,
  comment?: ExternalRemoteComment
): ExternalActivityType => {
  const normalized = providerType.toLowerCase();
  if (requestedType === 'replies' || comment?.parentExternalCommentId) return 'reply';
  if (requestedType === 'comments' || normalized.includes('comment')) return 'comment';
  if (normalized.includes('favourite') || normalized.includes('favorite') || normalized.includes('fave')) return 'favourite';
  if (normalized.includes('watch')) return 'watch';
  if (normalized.includes('mention')) return 'mention';
  return 'activity';
};

const normalizeRemoteActivity = (
  value: unknown,
  requestedType: 'comments' | 'replies' | 'activity',
  forceType?: ExternalActivityType
): ExternalRemoteActivity | null => {
  const item = asRecord(value);
  const remoteMessageId = asString(item.messageid);
  const sourceMessageId = remoteMessageId || asString(item.id);
  if (!sourceMessageId) return null;
  const subject = asRecord(item.subject);
  const deviation = Object.keys(asRecord(item.deviation)).length ? asRecord(item.deviation) : asRecord(subject.deviation);
  const status = Object.keys(asRecord(item.status)).length ? asRecord(item.status) : asRecord(subject.status);
  const sharedDeviation = (Array.isArray(status.items) ? status.items : [])
    .map(asRecord)
    .map((statusItem) => asRecord(statusItem.deviation))
    .find((statusItem) => Object.keys(statusItem).length > 0);
  const commentValue = Object.keys(asRecord(item.comment)).length ? item.comment : subject.comment;
  const comment = normalizeRemoteComment(commentValue);
  const originator = Object.keys(asRecord(item.originator)).length
    ? asRecord(item.originator)
    : asRecord(comment?.rawPayload?.user);
  const providerType = asString(item.type) || requestedType;
  const externalContentId = asString(deviation.deviationid)
    || asString(deviation.id)
    || asString(sharedDeviation?.deviationid)
    || asString(sharedDeviation?.id);
  const remoteActivityId = comment ? `comment:${comment.externalCommentId}` : `message:${sourceMessageId}`;
  const body = comment?.body || asString(item.html) || descriptionFrom(status) || descriptionFrom(item);
  return {
    remoteActivityId,
    sourceMessageId,
    ...(remoteMessageId ? { remoteMessageId } : {}),
    type: forceType || feedbackActivityType(requestedType, providerType, comment || undefined),
    occurredAt: asIsoDate(item.ts) || comment?.createdAt || asIsoDate(status.ts),
    stackId: asString(item.stackid),
    stackCount: asNumber(item.stack_count),
    isNew: asBoolean(item.is_new),
    actorId: asString(originator.userid) || comment?.authorId,
    actorName: asString(originator.username) || comment?.authorName,
    actorAvatarUrl: asString(originator.usericon) || comment?.authorAvatarUrl,
    ...(externalContentId ? { externalContentId } : {}),
    ...(comment ? {
      externalCommentId: comment.externalCommentId,
      parentExternalCommentId: comment.parentExternalCommentId
    } : {}),
    ...(body ? { body } : {}),
    rawPayload: item
  };
};

export interface DeviantArtPublicAiLabels {
  isAiGenerated?: boolean;
  noAi?: boolean;
}

/**
 * DeviantArt's documented OAuth read responses can omit the AI label values
 * accepted by its write endpoints. The public deviation page currently embeds
 * them in its initial state. Scope the lookup to the page's primary numeric
 * deviation ID because the same state also contains recommended deviations.
 */
export const parseDeviantArtPublicAiLabels = (
  html: string,
  externalUrl: string
): DeviantArtPublicAiLabels => {
  let url: URL;
  try {
    url = new URL(externalUrl);
  } catch {
    return {};
  }
  if (url.protocol !== 'https:' || (url.hostname !== 'deviantart.com' && !url.hostname.endsWith('.deviantart.com'))) {
    return {};
  }
  const numericId = url.pathname.match(/-(\d+)\/?$/)?.[1];
  if (!numericId) return {};

  const escapedMarker = `\\"deviationId\\":${numericId}`;
  const plainMarker = `"deviationId":${numericId}`;
  const markerIndex = html.indexOf(escapedMarker) >= 0
    ? html.indexOf(escapedMarker)
    : html.indexOf(plainMarker);
  if (markerIndex < 0) return {};

  // Both properties occur near the beginning of the target deviation object.
  // A bounded slice prevents values in related content from being considered.
  const targetRecord = html.slice(markerIndex, markerIndex + 5_000).replace(/\\"/g, '"');
  const readFlag = (key: string): boolean | undefined => {
    const match = targetRecord.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`));
    return match ? match[1] === 'true' : undefined;
  };
  const isAiGenerated = readFlag('isAiGenerated');
  const noAi = readFlag('isAiUseDisallowed');
  return {
    ...(isAiGenerated !== undefined ? { isAiGenerated } : {}),
    ...(noAi !== undefined ? { noAi } : {})
  };
};

export class DeviantArtProvider implements ExternalPlatformProvider {
  readonly platform = 'deviantart' as const;
  private static readonly oauthBaseUrl = 'https://www.deviantart.com/oauth2';
  private static readonly apiBaseUrl = 'https://www.deviantart.com/api/v1/oauth2';
  // user.manage is required for owner-only editing data, including the original
  // text returned by deviation/content?for_edit=true.
  // DeviantArt uses granular comment scopes. `comment` is not a valid OAuth
  // scope; posting a deviation comment specifically requires `comment.post`.
  private static readonly scopes = ['user', 'user.manage', 'browse', 'gallery', 'collection', 'stash', 'publish', 'comment.post', 'message'];
  private static nextApiRequestAt = 0;
  private static pacingTail: Promise<void> = Promise.resolve();

  constructor(private readonly credentials?: ExternalPlatformApplicationCredentials) {}

  /**
   * Serialize and space DeviantArt API calls across every provider instance in
   * this process. Production also limits the worker Lambda to one concurrent
   * execution, so this protects both calls within a job and adjacent jobs.
   */
  private async waitForApiRequestSlot(): Promise<void> {
    const configuredInterval = this.credentials?.minimumRequestIntervalMs;
    const intervalMs = Number.isFinite(configuredInterval) ? Math.max(0, Math.floor(configuredInterval!)) : 0;
    if (!intervalMs) return;
    const scheduled = DeviantArtProvider.pacingTail.then(async () => {
      const waitMs = Math.max(0, DeviantArtProvider.nextApiRequestAt - Date.now());
      if (waitMs) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      DeviantArtProvider.nextApiRequestAt = Date.now() + intervalMs;
    });
    DeviantArtProvider.pacingTail = scheduled.catch(() => undefined);
    await scheduled;
  }

  isConfigured(): boolean {
    return Boolean(
      this.credentials?.clientId
      && this.credentials.clientSecret
      && this.credentials.redirectUri
    );
  }

  createAuthorizationUrl(state: string, pkce?: ExternalOAuthPkce): string {
    if (!this.isConfigured()) {
      throw new ExternalProviderError('DeviantArt OAuth is not configured', 'unsupported');
    }
    const url = new URL(`${DeviantArtProvider.oauthBaseUrl}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.credentials!.clientId);
    url.searchParams.set('redirect_uri', this.credentials!.redirectUri);
    url.searchParams.set('scope', DeviantArtProvider.scopes.join(' '));
    url.searchParams.set('state', state);
    if (pkce) {
      url.searchParams.set('code_challenge', pkce.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string, pkce?: ExternalOAuthPkce): Promise<ExternalAuthTokens> {
    try {
      return await this.exchangeToken({
        grant_type: 'authorization_code',
        code,
        client_id: this.credentials?.clientId || '',
        client_secret: this.credentials?.clientSecret || '',
        redirect_uri: this.credentials?.redirectUri || '',
        ...(pkce ? { code_verifier: pkce.codeVerifier } : {})
      });
    } catch (error) {
      throw withProviderOperation(error, 'token_exchange');
    }
  }

  async refreshAuthentication(refreshToken: string): Promise<ExternalAuthTokens> {
    return this.exchangeToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.credentials?.clientId || '',
      client_secret: this.credentials?.clientSecret || ''
    });
  }

  private async exchangeToken(params: Record<string, string>): Promise<ExternalAuthTokens> {
    if (!this.isConfigured()) throw new ExternalProviderError('DeviantArt OAuth is not configured', 'unsupported');
    const response = await fetch(`${DeviantArtProvider.oauthBaseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) throw this.errorFromResponse(response.status, payload);
    const accessToken = asString(payload.access_token);
    if (!accessToken) throw new ExternalProviderError('DeviantArt did not return an access token', 'invalid_response');
    const expiresIn = asNumber(payload.expires_in);
    return {
      accessToken,
      refreshToken: asString(payload.refresh_token),
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined
    };
  }

  async getAccount(accessToken: string): Promise<ExternalRemoteAccount> {
    let payload: Record<string, unknown>;
    try {
      payload = await this.request('/user/whoami', accessToken);
    } catch (error) {
      throw withProviderOperation(error, 'account_lookup');
    }
    const externalUserId = asString(payload.userid) || asString(payload.user_id) || asString(payload.uuid);
    const externalUsername = asString(payload.username);
    if (!externalUserId || !externalUsername) {
      throw new ExternalProviderError('DeviantArt account identity response was incomplete', 'invalid_response');
    }
    return { externalUserId, externalUsername };
  }

  async getProfile(accessToken: string, username: string): Promise<ExternalRemoteProfile> {
    const payload = await this.request(`/user/profile/${encodeURIComponent(username)}`, accessToken, {
      with_session: 'true',
      expand: 'user.details,user.stats'
    });
    const user = asRecord(payload.user);
    const details = asRecord(user.details);
    const userStats = asRecord(user.stats);
    const profileStats = asRecord(payload.stats);
    return {
      profileUrl: asString(payload.profile_url),
      avatarUrl: asString(user.usericon),
      userIsArtist: asBoolean(payload.user_is_artist),
      artistLevel: asString(payload.artist_level),
      artistSpecialty: asString(payload.artist_specialty) || asString(payload.artist_speciality),
      realName: asString(payload.real_name),
      tagline: asString(payload.tagline),
      country: asString(payload.country),
      website: asString(payload.website),
      bio: asString(payload.bio),
      coverPhotoUrl: asString(payload.cover_photo),
      joinedAt: asIsoDate(details.joindate),
      stats: {
        watchers: asNumber(userStats.watchers),
        friends: asNumber(userStats.friends),
        deviations: asNumber(profileStats.user_deviations),
        favourites: asNumber(profileStats.user_favourites),
        comments: asNumber(profileStats.user_comments),
        profilePageviews: asNumber(profileStats.profile_pageviews),
        profileComments: asNumber(profileStats.profile_comments)
      },
      rawPayload: payload
    };
  }

  async listContent(accessToken: string, options: { username: string; cursor?: string; limit?: number }): Promise<ExternalContentPage> {
    const cursor = options.cursor ? Number(options.cursor) : 0;
    const payload = await this.request('/gallery/all', accessToken, {
      username: options.username,
      offset: Number.isFinite(cursor) ? String(cursor) : '0',
      limit: String(Math.max(1, Math.min(24, options.limit || 24)))
    });
    const items = rawItems(payload).map(normalizeContent).filter((item): item is ExternalRemoteContent => Boolean(item));
    const nextOffset = asNumber(payload.next_offset);
    return {
      items,
      nextCursor: Boolean(payload.has_more) && nextOffset !== undefined ? String(nextOffset) : undefined
    };
  }

  async getContent(accessToken: string, externalContentId: string): Promise<ExternalRemoteContent> {
    const summary = await this.request(`/deviation/${encodeURIComponent(externalContentId)}`, accessToken, { with_session: 'true' });
    // Deleted and access-restricted deviations frequently reject the extended
    // metadata request even though the summary endpoint still identifies the
    // lifecycle state. Preserve that state instead of turning it into a generic
    // provider failure during reconciliation.
    if (
      asBoolean(summary.is_deleted) === true
      || asBoolean(summary.is_blocked) === true
      || ['locked', 'locked-subscribed'].includes(asString(summary.tier_access) || '')
    ) {
      const unavailableContent = normalizeContent({ ...summary, deviationid: externalContentId });
      if (!unavailableContent) throw new ExternalProviderError('DeviantArt deviation response was incomplete', 'invalid_response');
      return unavailableContent;
    }
    const metadataPayload = await this.request('/deviation/metadata', accessToken, {
      'deviationids[0]': externalContentId,
      ext_submission: 'true',
      ext_stats: 'true',
      with_session: 'true'
    });
    const metadata = rawItems(metadataPayload)
      .map(asRecord)
      .find((item) => (asString(item.deviationid) || asString(item.id)) === externalContentId) || {};
    let fullContent: Record<string, unknown> = {};
    if (!descriptionFrom(metadata) && !descriptionFrom(summary)) {
      try {
        fullContent = await this.request('/deviation/content', accessToken, { deviationid: externalContentId, for_edit: 'true', with_session: 'true' });
      } catch (contentError) {
        if (!(contentError instanceof ExternalProviderError)) throw contentError;
        if (contentError.code !== 'authentication_required' && contentError.code !== 'invalid_response') throw contentError;
        try {
          // Existing connections may predate user.manage. The ordinary content
          // endpoint uses browse access and can still return literature or journal
          // bodies without forcing the creator to reconnect.
          fullContent = await this.request('/deviation/content', accessToken, { deviationid: externalContentId, with_session: 'true' });
        } catch (fallbackError) {
          if (!(fallbackError instanceof ExternalProviderError)) throw fallbackError;
          if (fallbackError.code !== 'authentication_required' && fallbackError.code !== 'invalid_response') throw fallbackError;
          // DeviantArt does not expose /deviation/content for every media type.
          // Image descriptions live in /deviation/metadata, so an unsupported
          // content response must not discard the extended metadata we already have.
          fullContent = {};
        }
      }
    }
    // Gallery listings intentionally omit editable metadata. Extended metadata is
    // authoritative for image descriptions and tags; content adds bodies for
    // media types such as literature and journals when DeviantArt supports it.
    const description = descriptionFrom(metadata) || descriptionFrom(summary) || descriptionFrom(fullContent);
    const payload: Record<string, unknown> = {
      ...summary,
      ...metadata,
      ...fullContent,
      ...(description ? { description } : {}),
      deviationid: externalContentId
    };
    const needsAiGenerated = metadataBoolean(payload, 'is_ai_generated', 'isAiGenerated', 'ai_generated', 'created_with_ai') === undefined;
    const needsNoAi = metadataBoolean(payload, 'noai', 'noAI', 'noAi', 'no_ai') === undefined;
    const externalUrl = asString(payload.url);
    if ((needsAiGenerated || needsNoAi) && externalUrl) {
      try {
        const pageUrl = new URL(externalUrl);
        if (
          pageUrl.protocol === 'https:'
          && (pageUrl.hostname === 'deviantart.com' || pageUrl.hostname.endsWith('.deviantart.com'))
        ) {
          const pageResponse = await fetch(pageUrl, {
            headers: { Accept: 'text/html', 'User-Agent': 'Ubeeq/1.0' },
            redirect: 'manual',
            signal: AbortSignal.timeout(8_000)
          });
          if (pageResponse.ok) {
            const publicLabels = parseDeviantArtPublicAiLabels(await pageResponse.text(), pageUrl.toString());
            if (needsAiGenerated && publicLabels.isAiGenerated !== undefined) payload.is_ai_generated = publicLabels.isAiGenerated;
            if (needsNoAi && publicLabels.noAi !== undefined) payload.noai = publicLabels.noAi;
            if (publicLabels.isAiGenerated !== undefined || publicLabels.noAi !== undefined) {
              payload.ubeeq_ai_labels_source = 'deviantart_public_page';
            }
          }
        }
      } catch {
        // This is a best-effort fallback. OAuth metadata remains authoritative,
        // and a public-page format or network failure must not fail the sync.
      }
    }
    const content = normalizeContent(payload);
    if (!content) throw new ExternalProviderError('DeviantArt deviation response was incomplete', 'invalid_response');
    return content;
  }

  async getOriginalDownload(accessToken: string, externalContentId: string): Promise<ExternalRemoteDownload> {
    const path = `/deviation/download/${encodeURIComponent(externalContentId)}`;
    await this.waitForApiRequestSlot();
    const response = await fetch(`${DeviantArtProvider.apiBaseUrl}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) {
      const providerErrorCode = asNumber(payload.error_code);
      if (providerErrorCode === 2) return { status: 'not_downloadable', rawPayload: payload };
      if (providerErrorCode === 1 || providerErrorCode === 3) return { status: 'missing', rawPayload: payload };
      const error = this.errorFromResponse(response.status, payload, response.headers.get('retry-after'));
      throw new ExternalProviderError(`DeviantArt ${path}: ${error.message}`, error.code, error.retryAfterSeconds);
    }
    const sourceUrl = asString(payload.src);
    if (!sourceUrl) throw new ExternalProviderError('DeviantArt original download response did not include a source URL', 'invalid_response');
    return {
      status: 'available',
      sourceUrl,
      filename: asString(payload.filename),
      byteSize: asNumber(payload.filesize),
      width: asNumber(payload.width),
      height: asNumber(payload.height),
      rawPayload: payload
    };
  }

  async getEngagement(accessToken: string, externalContentIds: string[]): Promise<ExternalRemoteEngagement[]> {
    const ids = externalContentIds.filter(Boolean).slice(0, DEVIANTART_METADATA_BATCH_SIZE);
    if (!ids.length) return [];
    const query: Record<string, string> = { ext_stats: 'true', with_session: 'true' };
    ids.forEach((externalContentId, index) => { query[`deviationids[${index}]`] = externalContentId; });
    const payload = await this.request('/deviation/metadata', accessToken, query);
    return rawItems(payload).map(asRecord).map((item): ExternalRemoteEngagement | null => {
      const stats = asRecord(item.stats);
      const externalContentId = asString(item.deviationid) || asString(item.id);
      if (!externalContentId) return null;
      return {
        externalContentId,
        metrics: {
          views: asNumber(stats.views),
          favourites: asNumber(stats.favourites) ?? asNumber(stats.favorites),
          comments: asNumber(stats.comments),
          downloads: asNumber(stats.downloads),
          viewsToday: asNumber(stats.views_today),
          downloadsToday: asNumber(stats.downloads_today),
          other: stats
        },
        rawPayload: item
      };
    }).filter((item): item is ExternalRemoteEngagement => Boolean(item));
  }

  async listCollections(accessToken: string, username: string): Promise<ExternalRemoteCollection[]> {
    const collections: ExternalRemoteCollection[] = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const payload = await this.request('/gallery/folders', accessToken, {
        username,
        calculate_size: 'true',
        offset: String(offset),
        limit: '50'
      });
      rawItems(payload).forEach((value, index) => {
        const item = asRecord(value);
        const externalCollectionId = asString(item.folderid) || asString(item.uuid) || asString(item.id);
        if (!externalCollectionId) return;
        const parentExternalCollectionId = asString(item.parent) || asString(item.parent_folderid) || asString(item.parent_id);
        collections.push({
          externalCollectionId,
          name: asString(item.name) || 'Untitled DeviantArt folder',
          description: asString(item.description),
          ...(parentExternalCollectionId ? { parentExternalCollectionId } : {}),
          position: asNumber(item.position) || offset + index,
          size: asNumber(item.size),
          rawMetadata: item
        });
      });
      const nextOffset = asNumber(payload.next_offset);
      hasMore = Boolean(payload.has_more) && nextOffset !== undefined && nextOffset > offset;
      offset = nextOffset === undefined ? offset : nextOffset;
    }
    return collections;
  }

  async createGalleryFolder(accessToken: string, name: string): Promise<ExternalRemoteCollection> {
    const folder = name.trim().slice(0, 50);
    if (!folder) throw new ExternalProviderError('A DeviantArt gallery name is required', 'invalid_response');
    const payload = await this.requestForm('/gallery/folders/create', accessToken, new URLSearchParams({ folder }));
    const externalCollectionId = asString(payload.folderid) || asString(payload.uuid) || asString(payload.id);
    if (!externalCollectionId) throw new ExternalProviderError('DeviantArt did not return a gallery folder ID', 'invalid_response');
    return {
      externalCollectionId,
      name: asString(payload.name) || folder,
      position: 0,
      rawMetadata: payload
    };
  }

  async listCollectionContent(accessToken: string, externalCollectionId: string, username: string, cursor?: string): Promise<ExternalContentPage> {
    const offset = Number(cursor || '0');
    const payload = await this.request(`/gallery/${encodeURIComponent(externalCollectionId)}`, accessToken, {
      username,
      offset: Number.isFinite(offset) ? String(offset) : '0',
      limit: '24',
      with_session: 'true'
    });
    const items = rawItems(payload).map(normalizeContent).filter((item): item is ExternalRemoteContent => Boolean(item));
    const nextOffset = asNumber(payload.next_offset);
    return {
      items,
      nextCursor: Boolean(payload.has_more) && nextOffset !== undefined && nextOffset > offset ? String(nextOffset) : undefined
    };
  }

  async listComments(accessToken: string, externalContentId: string, cursor?: string): Promise<{ items: ExternalRemoteComment[]; nextCursor?: string }> {
    const payload = await this.request(`/comments/deviation/${encodeURIComponent(externalContentId)}`, accessToken, {
      offset: cursor || '0',
      limit: '50',
      maxdepth: '5',
      // The list response otherwise may contain abbreviated comment bodies.
      expand: 'comment.fulltext'
    });
    const items = rawItems(payload).map(normalizeRemoteComment).filter((item): item is ExternalRemoteComment => Boolean(item));
    const nextOffset = asNumber(payload.next_offset);
    return { items, nextCursor: Boolean(payload.has_more) && nextOffset !== undefined ? String(nextOffset) : undefined };
  }

  async listFeedback(accessToken: string, type: 'comments' | 'replies' | 'activity', cursor?: string): Promise<{ items: ExternalRemoteActivity[]; nextCursor?: string }> {
    const payload = await this.request('/messages/feedback', accessToken, {
      type,
      stack: 'false',
      offset: cursor || '0',
      limit: '50',
      with_session: 'true'
    });
    const items = rawItems(payload)
      .map((value) => normalizeRemoteActivity(value, type))
      .filter((item): item is ExternalRemoteActivity => Boolean(item));
    const nextOffset = asNumber(payload.next_offset);
    return { items, nextCursor: Boolean(payload.has_more) && nextOffset !== undefined ? String(nextOffset) : undefined };
  }

  async listMessages(accessToken: string, source: 'feed' | 'mentions', cursor?: string): Promise<{ items: ExternalRemoteActivity[]; nextCursor?: string }> {
    const payload = await this.request(`/messages/${source}`, accessToken, source === 'feed' ? {
      stack: 'false',
      ...(cursor ? { cursor } : {}),
      with_session: 'true'
    } : {
      stack: 'true',
      offset: cursor || '0',
      limit: '50',
      with_session: 'true'
    });
    const items = rawItems(payload)
      .map((value) => normalizeRemoteActivity(value, 'activity', source === 'mentions' ? 'mention' : undefined))
      .filter((item): item is ExternalRemoteActivity => Boolean(item));
    if (source === 'feed') {
      const nextCursor = asString(payload.cursor);
      return { items, nextCursor: Boolean(payload.has_more) && nextCursor && nextCursor !== cursor ? nextCursor : undefined };
    }
    const nextOffset = asNumber(payload.next_offset);
    return { items, nextCursor: Boolean(payload.has_more) && nextOffset !== undefined ? String(nextOffset) : undefined };
  }

  async listMessageStack(accessToken: string, source: 'feedback' | 'mentions', stackId: string, cursor?: string): Promise<{ items: ExternalRemoteActivity[]; nextCursor?: string }> {
    const payload = await this.request(`/messages/${source}/${encodeURIComponent(stackId)}`, accessToken, {
      offset: cursor || '0',
      limit: '50',
      with_session: 'true'
    });
    const items = rawItems(payload)
      .map((value) => normalizeRemoteActivity(value, 'activity', source === 'mentions' ? 'mention' : undefined))
      .filter((item): item is ExternalRemoteActivity => Boolean(item));
    const nextOffset = asNumber(payload.next_offset);
    return { items, nextCursor: Boolean(payload.has_more) && nextOffset !== undefined ? String(nextOffset) : undefined };
  }

  async listWatchers(accessToken: string, username: string, cursor?: string): Promise<{ items: ExternalRemoteWatcher[]; nextCursor?: string; truncated?: boolean }> {
    const offset = Number(cursor || '0');
    const payload = await this.request(`/user/watchers/${encodeURIComponent(username)}`, accessToken, {
      offset: Number.isFinite(offset) ? String(offset) : '0',
      limit: '50'
    });
    const items = rawItems(payload).map((value): ExternalRemoteWatcher | null => {
      const item = asRecord(value);
      const user = asRecord(item.user);
      const externalUserId = asString(user.userid);
      const watcherUsername = asString(user.username);
      if (!externalUserId || !watcherUsername) return null;
      const watch = asRecord(item.watch);
      const watchSettings = Object.fromEntries(Object.entries(watch)
        .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
      return {
        externalUserId,
        username: watcherUsername,
        avatarUrl: asString(user.usericon),
        lastVisitAt: asIsoDate(item.lastvisit),
        watchSettings: Object.keys(watchSettings).length ? watchSettings : undefined,
        rawPayload: item
      };
    }).filter((item): item is ExternalRemoteWatcher => Boolean(item));
    const nextOffset = asNumber(payload.next_offset);
    const hasMore = Boolean(payload.has_more);
    const canContinue = hasMore && nextOffset !== undefined && nextOffset > offset && nextOffset <= 50000;
    return {
      items,
      nextCursor: canContinue ? String(nextOffset) : undefined,
      truncated: hasMore && !canContinue
    };
  }

  async deleteMessage(accessToken: string, message: { messageId?: string; stackId?: string; folderId?: string }): Promise<void> {
    if (!message.messageId && !message.stackId) {
      throw new ExternalProviderError('A DeviantArt message or stack ID is required', 'invalid_response');
    }
    const form = new URLSearchParams();
    if (message.folderId) form.set('folderid', message.folderId);
    if (message.messageId) form.set('messageid', message.messageId);
    if (message.stackId) form.set('stackid', message.stackId);
    const payload = await this.requestForm('/messages/delete', accessToken, form);
    if (payload.success === false) {
      throw new ExternalProviderError(asString(payload.error_description) || 'DeviantArt did not dismiss the notification', 'invalid_response');
    }
  }

  async listFavourites(accessToken: string, externalContentId: string, cursor?: string): Promise<{ items: ExternalRemoteFavourite[]; nextCursor?: string }> {
    const payload = await this.request('/deviation/whofaved', accessToken, {
      deviationid: externalContentId,
      offset: cursor || '0',
      limit: '50'
    });
    const items = rawItems(payload).map((value): ExternalRemoteFavourite | null => {
      const item = asRecord(value);
      const user = asRecord(item.user);
      const externalUserId = asString(user.userid) || asString(item.userid);
      const username = asString(user.username) || asString(item.username);
      if (!externalUserId || !username) return null;
      return {
        externalUserId,
        username,
        avatarUrl: asString(user.usericon) || asString(item.usericon),
        favouritedAt: asIsoDate(item.time),
        rawPayload: item
      };
    }).filter((item): item is ExternalRemoteFavourite => Boolean(item));
    const nextOffset = asNumber(payload.next_offset);
    return { items, nextCursor: Boolean(payload.has_more) && nextOffset !== undefined ? String(nextOffset) : undefined };
  }

  async postComment(accessToken: string, externalContentId: string, body: string, parentExternalCommentId?: string): Promise<ExternalRemoteComment> {
    const form = new URLSearchParams({ body });
    if (parentExternalCommentId) form.set('commentid', parentExternalCommentId);
    const payload = await this.requestForm(`/comments/post/deviation/${encodeURIComponent(externalContentId)}`, accessToken, form);
    const source = Object.keys(asRecord(payload.comment)).length ? asRecord(payload.comment) : payload;
    const comment = normalizeRemoteComment(source);
    if (!comment) throw new ExternalProviderError('DeviantArt did not return a comment ID', 'invalid_response');
    return {
      ...comment,
      body: comment.body || body,
      ...(parentExternalCommentId ? { parentExternalCommentId } : {}),
      rawPayload: source
    };
  }

  async updateContent(accessToken: string, externalContentId: string, update: ExternalContentUpdate, options?: ExternalContentUpdateOptions): Promise<void> {
    const form = new URLSearchParams();
    if (update.title !== undefined) form.set('title', update.title);
    // The published-deviation edit endpoint does not expose description or
    // artist_comments. A retained Sta.sh item lets us update artist_comments
    // without replacing the media; the worker verifies the published result.
    if (update.description !== undefined) {
      if (!options?.publishedDescriptionUpdate) {
        throw new ExternalProviderError(
          'DeviantArt published-description updates are disabled',
          'unsupported'
        );
      }
      if (!options.externalDraftId || !/^\d+$/.test(options.externalDraftId)) {
        throw new ExternalProviderError(
          'This DeviantArt publication does not have a retained Sta.sh item ID',
          'unsupported'
        );
      }
      const stashMetadata = new FormData();
      stashMetadata.set('itemid', options.externalDraftId);
      stashMetadata.set('artist_comments', update.description);
      // Intentionally omit `file`: including it would replace the media.
      await this.requestMultipart('/stash/submit', accessToken, stashMetadata);
    }
    if (update.tags !== undefined) update.tags.forEach((tag) => form.append('tags[]', tag));
    if (update.collectionExternalIds !== undefined) update.collectionExternalIds.forEach((collectionId) => form.append('galleryids[]', collectionId));
    if (update.allowComments !== undefined) form.set('allow_comments', String(update.allowComments));
    if (update.displayResolution !== undefined) {
      const displayResolutionCode = update.displayResolution === null
        ? 0
        : deviantArtDisplayResolutionCode.get(update.displayResolution);
      if (displayResolutionCode === undefined) {
        throw new ExternalProviderError(
          `Unsupported DeviantArt display width: ${update.displayResolution}px`,
          'invalid_response'
        );
      }
      form.set('display_resolution', String(displayResolutionCode));
    }
    if (update.allowFreeDownload !== undefined) form.set('allow_free_download', String(update.allowFreeDownload));
    if (update.addWatermark !== undefined) form.set('add_watermark', String(update.addWatermark));
    if (update.isMature !== undefined) form.set('is_mature', String(update.isMature));
    if (update.isMature && update.matureLevel) form.set('mature_level', update.matureLevel);
    if (update.matureClassification !== undefined) update.matureClassification.forEach((classification) => form.append('mature_classification[]', classification));
    const hasNonAiEditFields = [...form.keys()].length > 0;
    if (update.isAiGenerated !== undefined) form.set('is_ai_generated', String(update.isAiGenerated));
    if (update.noAi !== undefined) form.set('noai', String(update.noAi));
    if (![...form.keys()].length) return;
    try {
      await this.requestForm(`/deviation/edit/${encodeURIComponent(externalContentId)}`, accessToken, form);
    } catch (error) {
      // DeviantArt documents both AI fields on deviation/edit, but freshly
      // API-published deviations can incorrectly return "Deviation not found"
      // from that endpoint while remaining readable. A retained Sta.sh item is
      // an equivalent documented metadata surface and does not replace media
      // when `file` is omitted.
      if (
        !(error instanceof ExternalProviderError)
        || !/deviation not found/i.test(error.message)
        || hasNonAiEditFields
        || !options?.externalDraftId
        || !/^\d+$/.test(options.externalDraftId)
      ) throw error;
      const stashMetadata = new FormData();
      stashMetadata.set('itemid', options.externalDraftId);
      if (update.isAiGenerated !== undefined) stashMetadata.set('is_ai_generated', String(update.isAiGenerated));
      if (update.noAi !== undefined) stashMetadata.set('noai', String(update.noAi));
      await this.requestMultipart('/stash/submit', accessToken, stashMetadata);
    }
  }
  async submitContent(accessToken: string, content: ExternalContentPublish, existingDraftId?: string): Promise<ExternalDraftContent> {
    const submit = new FormData();
    if (existingDraftId) submit.set('itemid', existingDraftId);
    submit.set('title', content.title);
    if (content.description) submit.set('artist_comments', content.description);
    if (content.tags) content.tags.forEach((tag) => submit.append('tags[]', tag));
    if (content.isAiGenerated !== undefined) submit.set('is_ai_generated', String(content.isAiGenerated));
    if (content.noAi !== undefined) submit.set('noai', String(content.noAi));
    if (!existingDraftId) {
      const uploadBytes = new Uint8Array(content.body.byteLength);
      uploadBytes.set(content.body);
      submit.set('file', new Blob([uploadBytes], { type: content.contentType }), content.filename);
    }
    const submitted = await this.requestMultipart('/stash/submit', accessToken, submit);
    const itemId = asIdentifier(submitted.itemid) || asIdentifier(submitted.id);
    if (!itemId) throw new ExternalProviderError('DeviantArt did not return a Sta.sh item ID', 'ambiguous_submission');
    return {
      externalDraftId: itemId,
      externalUrl: asString(submitted.url),
      rawMetadata: { ...submitted, stash_itemid: itemId }
    };
  }

  async publishDraft(accessToken: string, externalDraftId: string, content: ExternalContentPublish): Promise<ExternalPublishedContent> {
    const publish = new URLSearchParams({ itemid: externalDraftId, is_mature: String(content.isMature === true) });
    if (content.isMature && content.matureLevel) publish.set('mature_level', content.matureLevel);
    if (content.matureClassification) content.matureClassification.forEach((classification) => publish.append('mature_classification[]', classification));
    if (content.allowComments !== undefined) publish.set('allow_comments', String(content.allowComments));
    if (content.displayResolution !== undefined) {
      const displayResolutionCode = deviantArtDisplayResolutionCode.get(content.displayResolution);
      if (displayResolutionCode === undefined) {
        throw new ExternalProviderError(
          `Unsupported DeviantArt display width: ${content.displayResolution}px`,
          'invalid_response'
        );
      }
      publish.set('display_resolution', String(displayResolutionCode));
    }
    if (content.allowFreeDownload !== undefined) publish.set('allow_free_download', String(content.allowFreeDownload));
    if (content.addWatermark && content.displayResolution !== undefined) publish.set('add_watermark', 'true');
    if (content.tags) content.tags.forEach((tag) => publish.append('tags[]', tag));
    if (content.collectionExternalIds) content.collectionExternalIds.forEach((collectionId) => publish.append('galleryids[]', collectionId));
    if (content.isAiGenerated !== undefined) publish.set('is_ai_generated', String(content.isAiGenerated));
    if (content.noAi !== undefined) publish.set('noai', String(content.noAi));
    const published = await this.requestForm('/stash/publish', accessToken, publish);
    const nestedDeviation = asRecord(published.deviation);
    const externalContentId = asString(published.deviationid) || asString(published.id) || asString(nestedDeviation.deviationid) || asString(nestedDeviation.id);
    if (!externalContentId) throw new ExternalProviderError('DeviantArt did not return a published deviation ID', 'invalid_response');
    return {
      externalContentId,
      externalDraftId,
      externalUrl: asString(published.url) || asString(nestedDeviation.url),
      rawMetadata: { ...published, stash_itemid: externalDraftId }
    };
  }

  async publishContent(accessToken: string, content: ExternalContentPublish): Promise<ExternalPublishedContent> {
    const draft = await this.submitContent(accessToken, content);
    const published = await this.publishDraft(accessToken, draft.externalDraftId, content);
    return { ...published, rawMetadata: { ...draft.rawMetadata, ...published.rawMetadata } };
  }

  async createLiterature(accessToken: string, content: ExternalLiteraturePublish): Promise<ExternalPublishedContent> {
    const title = content.title.trim();
    const body = content.body.trim();
    if (!title || !body) throw new ExternalProviderError('DeviantArt literature requires a title and body', 'invalid_response');
    const form = this.literatureForm(content);
    const payload = await this.requestForm('/deviation/literature/create', accessToken, form);
    const deviation = asRecord(payload.deviation);
    const externalContentId = asIdentifier(payload.deviationid)
      || asIdentifier(payload.id)
      || asIdentifier(deviation.deviationid)
      || asIdentifier(deviation.id);
    if (!externalContentId) throw new ExternalProviderError('DeviantArt did not return a literature deviation ID', 'invalid_response');
    return {
      externalContentId,
      externalUrl: asString(payload.url) || asString(deviation.url),
      rawMetadata: { ...payload, content_type: 'literature' }
    };
  }

  async updateLiterature(accessToken: string, externalContentId: string, content: ExternalLiteraturePublish): Promise<ExternalPublishedContent> {
    const title = content.title.trim();
    const body = content.body.trim();
    if (!title || !body) throw new ExternalProviderError('DeviantArt literature requires a title and body', 'invalid_response');
    const payload = await this.requestForm(`/deviation/literature/update/${encodeURIComponent(externalContentId)}`, accessToken, this.literatureForm(content));
    const deviation = asRecord(payload.deviation);
    const returnedId = asIdentifier(payload.deviationid) || asIdentifier(payload.id) || asIdentifier(deviation.deviationid) || asIdentifier(deviation.id) || externalContentId;
    return {
      externalContentId: returnedId,
      externalUrl: asString(payload.url) || asString(deviation.url),
      rawMetadata: { ...payload, content_type: 'literature' }
    };
  }

  async createJournal(accessToken: string, content: ExternalJournalPublish): Promise<ExternalPublishedContent> {
    const title = content.title.trim();
    const body = content.body.trim();
    if (!title || !body) throw new ExternalProviderError('DeviantArt journals require a title and body', 'invalid_response');
    const form = new URLSearchParams({ title, body, is_mature: String(content.isMature === true) });
    if (content.tags) content.tags.forEach((tag) => form.append('tags[]', tag));
    if (content.coverUrl) form.set('cover', content.coverUrl);
    if (content.embeddedImageUrl) form.set('embedded_image', content.embeddedImageUrl);
    if (content.isMature && content.matureLevel) form.set('mature_level', content.matureLevel);
    if (content.matureClassification) content.matureClassification.forEach((classification) => form.append('mature_classification[]', classification));
    if (content.allowComments !== undefined) form.set('allow_comments', String(content.allowComments));
    const payload = await this.requestForm('/deviation/journal/create', accessToken, form);
    const deviation = asRecord(payload.deviation);
    const externalContentId = asIdentifier(payload.deviationid) || asIdentifier(payload.id) || asIdentifier(deviation.deviationid) || asIdentifier(deviation.id);
    if (!externalContentId) throw new ExternalProviderError('DeviantArt did not return a journal deviation ID', 'invalid_response');
    return {
      externalContentId,
      externalUrl: asString(payload.url) || asString(deviation.url),
      rawMetadata: { ...payload, content_type: 'journal' }
    };
  }

  async postStatus(accessToken: string, content: ExternalStatusPublish): Promise<ExternalPublishedPost> {
    const body = content.body.trim();
    if (!body) throw new ExternalProviderError('DeviantArt status updates require a body', 'invalid_response');
    const form = new URLSearchParams({ body });
    if (content.parentExternalId) form.set('parentid', content.parentExternalId);
    if (content.stashExternalId) form.set('stashid', content.stashExternalId);
    const payload = await this.requestForm('/user/statuses/post', accessToken, form);
    const status = asRecord(payload.status);
    const externalPostId = asIdentifier(payload.statusid) || asIdentifier(payload.id) || asIdentifier(status.statusid) || asIdentifier(status.id);
    if (!externalPostId) throw new ExternalProviderError('DeviantArt did not return a status update ID', 'invalid_response');
    return {
      externalPostId,
      externalUrl: asString(payload.url) || asString(status.url),
      rawMetadata: { ...payload, content_type: 'status' }
    };
  }

  private literatureForm(content: ExternalLiteraturePublish): URLSearchParams {
    const form = new URLSearchParams({
      title: content.title.trim(),
      body: content.body.trim(),
      is_mature: String(content.isMature === true)
    });
    if (content.description) form.set('description', content.description);
    if (content.tags) content.tags.forEach((tag) => form.append('tags[]', tag));
    if (content.collectionExternalIds) content.collectionExternalIds.forEach((id) => form.append('galleryids[]', id));
    if (content.isMature && content.matureLevel) form.set('mature_level', content.matureLevel);
    if (content.matureClassification) content.matureClassification.forEach((classification) => form.append('mature_classification[]', classification));
    if (content.allowComments !== undefined) form.set('allow_comments', String(content.allowComments));
    if (content.license) form.set('license', content.license);
    return form;
  }

  async moveContent(): Promise<never> { throw new ExternalProviderError('Remote writes are not enabled for DeviantArt', 'unsupported'); }

  private async request(path: string, accessToken: string, query?: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`${DeviantArtProvider.apiBaseUrl}${path}`);
    Object.entries(query || {}).forEach(([key, value]) => url.searchParams.set(key, value));
    await this.waitForApiRequestSlot();
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) {
      const error = this.errorFromResponse(response.status, payload, response.headers.get('retry-after'));
      throw new ExternalProviderError(`DeviantArt ${path}: ${error.message}`, error.code, error.retryAfterSeconds);
    }
    return payload;
  }

  private async requestForm(path: string, accessToken: string, form: URLSearchParams): Promise<Record<string, unknown>> {
    await this.waitForApiRequestSlot();
    const response = await fetch(`${DeviantArtProvider.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) {
      const error = this.errorFromResponse(response.status, payload, response.headers.get('retry-after'));
      throw new ExternalProviderError(`DeviantArt ${path}: ${error.message}`, error.code, error.retryAfterSeconds);
    }
    return payload;
  }

  private async requestMultipart(path: string, accessToken: string, form: FormData): Promise<Record<string, unknown>> {
    await this.waitForApiRequestSlot();
    const response = await fetch(`${DeviantArtProvider.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      body: form
    });
    // Sta.sh item IDs can exceed JavaScript's safe integer range. Preserve an
    // unquoted numeric `itemid` from the raw JSON before JSON.parse rounds it.
    const responseWithText = response as Response & { text?: () => Promise<string> };
    const responseText = typeof responseWithText.text === 'function' ? await responseWithText.text() : undefined;
    const payload = responseText === undefined
      ? asRecord(await response.json().catch(() => ({})))
      : asRecord((() => {
        try { return JSON.parse(responseText) as unknown; } catch { return {}; }
      })());
    const rawItemId = responseText?.match(/"(?:itemid|stash_itemid)"\s*:\s*(?:"([^"]+)"|(\d+))/)?.slice(1).find(Boolean);
    if (rawItemId) payload.itemid = rawItemId;
    if (!response.ok) {
      const error = this.errorFromResponse(response.status, payload, response.headers.get('retry-after'));
      throw new ExternalProviderError(`DeviantArt ${path}: ${error.message}`, error.code, error.retryAfterSeconds);
    }
    return payload;
  }

  private errorFromResponse(status: number, payload: Record<string, unknown>, retryAfter?: string | null): ExternalProviderError {
    const baseMessage = asString(payload.error_description) || asString(payload.error) || `DeviantArt request failed (${status})`;
    const details = Object.entries(asRecord(payload.error_details))
      .map(([field, value]) => `${field}: ${asString(value) || JSON.stringify(value)}`)
      .filter((detail) => !detail.endsWith(': undefined'));
    const providerCode = asNumber(payload.error_code);
    const codeDetail = providerCode === 5
      ? 'display_resolution: DeviantArt rejected the selected display size.'
      : undefined;
    const detailText = details.length > 0 ? details.join('; ') : codeDetail;
    const message = detailText ? `${baseMessage} (${detailText})` : baseMessage;
    if (status === 401 || status === 403) return new ExternalProviderError(message, 'authentication_required');
    if (status === 429) return new ExternalProviderError(message, 'rate_limited', parseRetryAfterSeconds(retryAfter));
    if (status >= 500) return new ExternalProviderError(message, 'temporarily_unavailable');
    return new ExternalProviderError(message, 'invalid_response');
  }
}

/**
 * Read-only YouTube adapter. A YouTube video remains an external, embed-only
 * asset: Ubeeq/Eversally owns the canonical Work and only imports metadata,
 * thumbnails, playlists, and current engagement. Uploading or mutating videos
 * is deliberately not enabled by this first integration slice.
 */
export class YouTubeProvider implements ExternalPlatformProvider, YouTubeManagementProvider {
  readonly platform = 'youtube' as const;
  private nextRequestAt = 0;

  constructor(private readonly credentials?: ExternalPlatformApplicationCredentials) {}

  isConfigured(): boolean {
    return Boolean(this.credentials?.clientId && this.credentials?.clientSecret && this.credentials?.redirectUri);
  }

  createAuthorizationUrl(state: string, pkce?: ExternalOAuthPkce): string {
    if (!this.isConfigured()) throw new ExternalProviderError('YouTube OAuth is not configured', 'authentication_required');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.credentials!.clientId);
    url.searchParams.set('redirect_uri', this.credentials!.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.credentials?.oauthScopes?.trim() || 'https://www.googleapis.com/auth/youtube.readonly');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'true');
    // Explicit consent makes refresh-token behaviour predictable for a new connection.
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    if (pkce) {
      url.searchParams.set('code_challenge', pkce.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string, pkce?: ExternalOAuthPkce): Promise<ExternalAuthTokens> {
    return this.exchangeToken({
      grant_type: 'authorization_code', code, redirect_uri: this.credentials?.redirectUri || '',
      ...(pkce ? { code_verifier: pkce.codeVerifier } : {})
    });
  }

  async refreshAuthentication(refreshToken: string): Promise<ExternalAuthTokens> {
    return this.exchangeToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async getAccount(accessToken: string): Promise<ExternalRemoteAccount> {
    const item = await this.firstChannel(accessToken);
    return { externalUserId: asString(item.id) || '', externalUsername: asString(asRecord(item.snippet).title) || asString(item.id) || 'YouTube channel' };
  }

  async getProfile(accessToken: string, _username: string): Promise<ExternalRemoteProfile> {
    const item = await this.firstChannel(accessToken);
    const snippet = asRecord(item.snippet);
    const statistics = asRecord(item.statistics);
    const thumbnails = asRecord(snippet.thumbnails);
    const high = asRecord(thumbnails.high);
    const medium = asRecord(thumbnails.medium);
    const channelId = asString(item.id);
    return {
      profileUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : undefined,
      avatarUrl: asString(high.url) || asString(medium.url),
      tagline: asString(snippet.description),
      joinedAt: asString(snippet.publishedAt),
      stats: { deviations: asNumber(statistics.videoCount), profilePageviews: asNumber(statistics.viewCount) },
      rawPayload: item
    };
  }

  async listContent(accessToken: string, options: { username: string; cursor?: string; limit?: number }): Promise<ExternalContentPage> {
    // Search costs 100 quota units per call. The uploads playlist plus a
    // batched Videos lookup is both incremental and dramatically cheaper.
    const channel = await this.firstChannel(accessToken);
    const uploadsPlaylistId = asString(asRecord(asRecord(channel.contentDetails).relatedPlaylists).uploads);
    if (!uploadsPlaylistId) throw new ExternalProviderError('The YouTube channel has no uploads playlist', 'invalid_response', undefined, 'account_lookup');
    const page = await this.api(accessToken, '/playlistItems', {
      part: 'contentDetails', playlistId: uploadsPlaylistId, maxResults: String(Math.min(options.limit || 50, 50)),
      ...(options.cursor && options.cursor !== '0' ? { pageToken: options.cursor } : {})
    });
    const ids = this.videoIdsFromPlaylistItems(page);
    const detailById = await this.videoDetailsById(accessToken, ids);
    return { items: ids.map((id) => this.toContent(detailById.get(id) || {})).filter((item): item is ExternalRemoteContent => Boolean(item)), nextCursor: asString(page.nextPageToken) };
  }

  async getContent(accessToken: string, externalContentId: string): Promise<ExternalRemoteContent> {
    const response = await this.api(accessToken, '/videos', { part: 'snippet,contentDetails,statistics,status', id: externalContentId });
    const item = asRecord(Array.isArray(response.items) ? response.items[0] : undefined);
    const mapped = this.toContent(item);
    if (!mapped) throw new ExternalProviderError('YouTube video was not found or is no longer accessible', 'invalid_response');
    return mapped;
  }

  async getOriginalDownload(_accessToken: string, externalContentId: string): Promise<ExternalRemoteDownload> {
    return { status: 'not_downloadable', rawPayload: { externalContentId, reason: 'YouTube originals are not copied by this integration.' } };
  }

  async getEngagement(accessToken: string, externalContentIds: string[]): Promise<ExternalRemoteEngagement[]> {
    if (!externalContentIds.length) return [];
    const response = await this.api(accessToken, '/videos', { part: 'statistics', id: externalContentIds.join(',') });
    return (Array.isArray(response.items) ? response.items : []).map(asRecord).map((item) => {
      const statistics = asRecord(item.statistics);
      return { externalContentId: asString(item.id) || '', metrics: { views: asNumber(statistics.viewCount), comments: asNumber(statistics.commentCount), other: { likes: asNumber(statistics.likeCount) } }, rawPayload: item };
    }).filter((item) => Boolean(item.externalContentId));
  }

  async listCollections(accessToken: string, _username: string): Promise<ExternalRemoteCollection[]> {
    const response = await this.api(accessToken, '/playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: '50' });
    return (Array.isArray(response.items) ? response.items : []).map(asRecord).map((item) => ({
      externalCollectionId: asString(item.id) || '', name: asString(asRecord(item.snippet).title) || 'Untitled playlist', description: asString(asRecord(item.snippet).description),
      size: asNumber(asRecord(item.contentDetails).itemCount), rawMetadata: item
    })).filter((item) => Boolean(item.externalCollectionId));
  }

  async listCollectionContent(accessToken: string, externalCollectionId: string, _username: string, cursor?: string): Promise<ExternalContentPage> {
    const page = await this.api(accessToken, '/playlistItems', { part: 'contentDetails', playlistId: externalCollectionId, maxResults: '50', ...(cursor ? { pageToken: cursor } : {}) });
    const ids = this.videoIdsFromPlaylistItems(page);
    if (!ids.length) return { items: [], nextCursor: asString(page.nextPageToken) };
    const details = await this.videoDetailsById(accessToken, ids);
    return {
      items: ids.map((id) => this.toContent(details.get(id) || {}))
        .filter((item): item is ExternalRemoteContent => Boolean(item))
        .map((item) => ({ ...item, collectionExternalIds: [externalCollectionId] })),
      nextCursor: asString(page.nextPageToken)
    };
  }

  async listComments(accessToken: string, externalContentId: string, cursor?: string): Promise<{ items: ExternalRemoteComment[]; nextCursor?: string }> {
    const page = await this.api(accessToken, '/commentThreads', { part: 'snippet', videoId: externalContentId, maxResults: '50', ...(cursor ? { pageToken: cursor } : {}) });
    const items = (Array.isArray(page.items) ? page.items : []).map(asRecord).map((item) => {
      const threadSnippet = asRecord(item.snippet);
      const topLevelComment = asRecord(threadSnippet.topLevelComment);
      const commentSnippet = asRecord(topLevelComment.snippet);
      return { externalCommentId: asString(topLevelComment.id) || asString(item.id) || '', authorName: asString(commentSnippet.authorDisplayName), authorAvatarUrl: asString(commentSnippet.authorProfileImageUrl), body: asString(commentSnippet.textDisplay) || '', createdAt: asString(commentSnippet.publishedAt), replyCount: asNumber(threadSnippet.totalReplyCount), rawPayload: item };
    }).filter((item) => Boolean(item.externalCommentId));
    return { items, nextCursor: asString(page.nextPageToken) };
  }

  async listPlaylists(accessToken: string): Promise<YouTubePlaylist[]> {
    const response = await this.api(accessToken, '/playlists', { part: 'snippet,contentDetails,status', mine: 'true', maxResults: '50' });
    return (Array.isArray(response.items) ? response.items : []).map(asRecord).map((item) => {
      const snippet = asRecord(item.snippet); const status = asRecord(item.status); const details = asRecord(item.contentDetails);
      return { id: asString(item.id) || '', title: asString(snippet.title) || 'Untitled playlist', description: asString(snippet.description), privacyStatus: asString(status.privacyStatus), itemCount: asNumber(details.itemCount), publishedAt: asString(snippet.publishedAt), rawPayload: item };
    }).filter((item) => Boolean(item.id));
  }

  async createPlaylist(accessToken: string, input: { title: string; description?: string; privacyStatus?: string }): Promise<YouTubePlaylist> {
    this.requireScope();
    const response = await this.api(accessToken, '/playlists', { part: 'snippet,status' }, { method: 'POST', body: { snippet: { title: input.title, description: input.description || '' }, status: { privacyStatus: input.privacyStatus || 'private' } } });
    return this.playlistFromPayload(response);
  }

  async updatePlaylist(accessToken: string, playlistId: string, input: { title?: string; description?: string; privacyStatus?: string }): Promise<YouTubePlaylist> {
    this.requireScope();
    const current = await this.api(accessToken, '/playlists', { part: 'snippet,status', id: playlistId });
    const item = asRecord(Array.isArray(current.items) ? current.items[0] : undefined);
    if (!asString(item.id)) throw new ExternalProviderError('YouTube playlist was not found', 'invalid_response');
    const snippet = asRecord(item.snippet); const status = asRecord(item.status);
    const response = await this.api(accessToken, '/playlists', { part: 'snippet,status' }, { method: 'PUT', body: { id: playlistId, snippet: { title: input.title ?? asString(snippet.title) ?? '', description: input.description ?? asString(snippet.description) ?? '', ...(asString(snippet.defaultLanguage) ? { defaultLanguage: snippet.defaultLanguage } : {}) }, status: { privacyStatus: input.privacyStatus ?? asString(status.privacyStatus) ?? 'private' } } });
    return this.playlistFromPayload(response);
  }

  async deletePlaylist(accessToken: string, playlistId: string): Promise<void> { this.requireScope(); await this.api(accessToken, '/playlists', { id: playlistId }, { method: 'DELETE' }); }

  async addPlaylistItem(accessToken: string, playlistId: string, videoId: string): Promise<YouTubePlaylistItem> {
    this.requireScope();
    const response = await this.api(accessToken, '/playlistItems', { part: 'snippet,contentDetails' }, { method: 'POST', body: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } } });
    return this.playlistItemFromPayload(response);
  }

  async removePlaylistItem(accessToken: string, playlistItemId: string): Promise<void> { this.requireScope(); await this.api(accessToken, '/playlistItems', { id: playlistItemId }, { method: 'DELETE' }); }

  async updateVideo(accessToken: string, videoId: string, input: { title?: string; description?: string; tags?: string[]; categoryId?: string; privacyStatus?: string; license?: string; embeddable?: boolean }): Promise<ExternalRemoteContent> {
    this.requireScope();
    const current = await this.api(accessToken, '/videos', { part: 'snippet,status', id: videoId });
    const item = asRecord(Array.isArray(current.items) ? current.items[0] : undefined);
    if (!asString(item.id)) throw new ExternalProviderError('YouTube video was not found', 'invalid_response');
    const snippet = asRecord(item.snippet); const status = asRecord(item.status);
    const body = { id: videoId, snippet: { title: input.title ?? asString(snippet.title) ?? '', description: input.description ?? asString(snippet.description) ?? '', tags: input.tags ?? (Array.isArray(snippet.tags) ? snippet.tags : undefined), categoryId: input.categoryId ?? asString(snippet.categoryId) ?? undefined }, status: { privacyStatus: input.privacyStatus ?? asString(status.privacyStatus) ?? 'private', license: input.license ?? asString(status.license) ?? undefined, embeddable: input.embeddable ?? asBoolean(status.embeddable) ?? true } };
    const response = await this.api(accessToken, '/videos', { part: 'snippet,status' }, { method: 'PUT', body });
    const mapped = this.toContent(asRecord(response));
    if (mapped) return mapped;
    return this.getContent(accessToken, videoId);
  }

  async deleteVideo(accessToken: string, videoId: string): Promise<void> { this.requireScope(); await this.api(accessToken, '/videos', { id: videoId }, { method: 'DELETE' }); }

  async listVideoComments(accessToken: string, videoId: string, cursor?: string): Promise<{ items: YouTubeComment[]; nextCursor?: string }> {
    const page = await this.api(accessToken, '/commentThreads', { part: 'snippet,replies', videoId, maxResults: '50', ...(cursor ? { pageToken: cursor } : {}) });
    const items = (Array.isArray(page.items) ? page.items : []).map(asRecord).map((item) => this.commentFromThread(item, videoId)).filter((item): item is YouTubeComment => Boolean(item));
    return { items, nextCursor: asString(page.nextPageToken) };
  }

  async postVideoComment(accessToken: string, videoId: string, text: string): Promise<YouTubeComment> {
    this.requireScope();
    const response = await this.api(accessToken, '/commentThreads', { part: 'snippet' }, { method: 'POST', body: { snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } } });
    return this.commentFromThread(asRecord(response), videoId) || { id: '', text, videoId, rawPayload: response };
  }

  async replyToComment(accessToken: string, parentCommentId: string, text: string): Promise<YouTubeComment> {
    this.requireScope();
    const response = await this.api(accessToken, '/comments', { part: 'snippet' }, { method: 'POST', body: { snippet: { parentId: parentCommentId, textOriginal: text } } });
    return this.commentFromPayload(asRecord(response)) || { id: '', text, parentId: parentCommentId, rawPayload: response };
  }

  async updateComment(accessToken: string, commentId: string, text: string): Promise<YouTubeComment> {
    this.requireScope();
    const response = await this.api(accessToken, '/comments', { part: 'snippet' }, { method: 'PUT', body: { id: commentId, snippet: { textOriginal: text } } });
    return this.commentFromPayload(asRecord(response)) || { id: commentId, text, rawPayload: response };
  }

  async deleteComment(accessToken: string, commentId: string): Promise<void> { this.requireScope(); await this.api(accessToken, '/comments', { id: commentId }, { method: 'DELETE' }); }

  async moderateComment(accessToken: string, commentId: string, moderationStatus: 'heldForReview' | 'published' | 'rejected' | 'likelySpam', banAuthor = false): Promise<void> {
    this.requireScope(); await this.api(accessToken, '/comments/setModerationStatus', { id: commentId, moderationStatus, banAuthor: String(banAuthor) }, { method: 'POST' });
  }

  async listCaptions(accessToken: string, videoId: string): Promise<YouTubeCaption[]> {
    const response = await this.api(accessToken, '/captions', { part: 'snippet', videoId, maxResults: '50' });
    return (Array.isArray(response.items) ? response.items : []).map(asRecord).map((item) => { const snippet = asRecord(item.snippet); return { id: asString(item.id) || '', videoId, name: asString(snippet.name), language: asString(snippet.language), trackKind: asString(snippet.trackKind), isDraft: asBoolean(snippet.isDraft), rawPayload: item }; }).filter((item) => Boolean(item.id));
  }

  async deleteCaption(accessToken: string, captionId: string): Promise<void> { this.requireScope(); await this.api(accessToken, '/captions', { id: captionId }, { method: 'DELETE' }); }

  async getRating(accessToken: string, videoId: string): Promise<'like' | 'dislike' | 'none' | 'unknown'> {
    const response = await this.api(accessToken, '/videos/getRating', { id: videoId }); const item = asRecord(Array.isArray(response.items) ? response.items[0] : undefined); const rating = asString(item.rating); return rating === 'like' || rating === 'dislike' || rating === 'none' ? rating : 'unknown';
  }

  async rateVideo(accessToken: string, videoId: string, rating: 'like' | 'dislike' | 'none'): Promise<void> { this.requireScope(); await this.api(accessToken, '/videos/rate', { id: videoId, rating }, { method: 'POST' }); }

  async listChannelActivity(accessToken: string, cursor?: string): Promise<{ items: YouTubeActivity[]; nextCursor?: string }> {
    const channel = await this.firstChannel(accessToken); const channelId = asString(channel.id) || ''; const response = await this.api(accessToken, '/activities', { part: 'snippet,contentDetails', channelId, maxResults: '50', ...(cursor ? { pageToken: cursor } : {}) });
    const items = (Array.isArray(response.items) ? response.items : []).map(asRecord).map((item) => { const snippet = asRecord(item.snippet); const details = asRecord(item.contentDetails); const upload = asRecord(details.upload); return { id: asString(item.id) || '', publishedAt: asString(snippet.publishedAt), type: asString(snippet.type), channelId, videoId: asString(upload.videoId), title: asString(snippet.title), description: asString(snippet.description), rawPayload: item }; }).filter((item) => Boolean(item.id));
    return { items, nextCursor: asString(response.nextPageToken) };
  }

  async getAnalytics(): Promise<never> { throw this.unsupported('YouTube Analytics requires a separate analytics API base URL and OAuth scope.'); }

  async listFeedback(): Promise<{ items: ExternalRemoteActivity[]; nextCursor?: string }> { return { items: [] }; }
  async listMessages(): Promise<{ items: ExternalRemoteActivity[]; nextCursor?: string }> { return { items: [] }; }
  async listMessageStack(): Promise<{ items: ExternalRemoteActivity[]; nextCursor?: string }> { return { items: [] }; }
  async listWatchers(): Promise<{ items: ExternalRemoteWatcher[]; nextCursor?: string; truncated?: boolean }> { return { items: [], truncated: true }; }
  async deleteMessage(): Promise<void> { throw this.unsupported('Deleting YouTube messages is not supported.'); }
  async listFavourites(): Promise<{ items: ExternalRemoteFavourite[]; nextCursor?: string }> { return { items: [] }; }
  async postComment(): Promise<ExternalRemoteComment> { throw this.unsupported('Posting YouTube comments is not supported.'); }
  async createGalleryFolder(): Promise<ExternalRemoteCollection> { throw this.unsupported('Creating YouTube playlists is not supported.'); }
  async updateContent(): Promise<void> { throw this.unsupported('Updating YouTube videos is not supported.'); }
  async submitContent(): Promise<ExternalDraftContent> { throw this.unsupported('Uploading YouTube videos is not supported.'); }
  async publishDraft(): Promise<ExternalPublishedContent> { throw this.unsupported('Publishing YouTube videos is not supported.'); }
  async publishContent(): Promise<ExternalPublishedContent> { throw this.unsupported('Publishing YouTube videos is not supported.'); }
  async createLiterature(): Promise<ExternalPublishedContent> { throw this.unsupported('YouTube does not support this publication type.'); }
  async updateLiterature(): Promise<ExternalPublishedContent> { throw this.unsupported('YouTube does not support this publication type.'); }
  async createJournal(): Promise<ExternalPublishedContent> { throw this.unsupported('YouTube does not support this publication type.'); }
  async postStatus(): Promise<ExternalPublishedPost> { throw this.unsupported('YouTube does not support status updates.'); }
  async moveContent(): Promise<never> { throw this.unsupported('Moving YouTube content is not supported.'); }

  private hasScope(scope = 'https://www.googleapis.com/auth/youtube'): boolean {
    const configured = this.credentials?.oauthScopes?.trim() || 'https://www.googleapis.com/auth/youtube.readonly';
    return configured.split(/\s+/).includes(scope);
  }
  private requireScope(scope = 'https://www.googleapis.com/auth/youtube'): void {
    if (!this.hasScope(scope)) {
      throw this.unsupported('This YouTube action requires the full YouTube OAuth scope. Reconnect the channel with write access enabled.');
    }
  }
  private playlistFromPayload(payload: Record<string, unknown>): YouTubePlaylist {
    const item = asRecord(Array.isArray(payload.items) ? payload.items[0] : payload);
    if (!asString(item.id)) throw new ExternalProviderError('YouTube returned an invalid playlist response', 'invalid_response');
    const snippet = asRecord(item.snippet); const status = asRecord(item.status); const details = asRecord(item.contentDetails);
    return { id: asString(item.id)!, title: asString(snippet.title) || 'Untitled playlist', description: asString(snippet.description), privacyStatus: asString(status.privacyStatus), itemCount: asNumber(details.itemCount), publishedAt: asString(snippet.publishedAt), rawPayload: item };
  }
  private playlistItemFromPayload(payload: Record<string, unknown>): YouTubePlaylistItem {
    const item = asRecord(Array.isArray(payload.items) ? payload.items[0] : payload); const snippet = asRecord(item.snippet); const resource = asRecord(snippet.resourceId);
    const id = asString(item.id); const playlistId = asString(snippet.playlistId); const videoId = asString(resource.videoId);
    if (!id || !playlistId || !videoId) throw new ExternalProviderError('YouTube returned an invalid playlist item response', 'invalid_response');
    return { id, playlistId, videoId, position: asNumber(snippet.position), title: asString(snippet.title), rawPayload: item };
  }
  private commentFromThread(item: Record<string, unknown>, videoId?: string): YouTubeComment | undefined {
    const threadSnippet = asRecord(item.snippet); const top = asRecord(threadSnippet.topLevelComment); const mapped = this.commentFromPayload(top);
    if (!mapped) return undefined;
    const replies = asRecord(item.replies); const replyItems = Array.isArray(replies.comments) ? replies.comments.map(asRecord).map((reply) => this.commentFromPayload(reply)).filter((reply): reply is YouTubeComment => Boolean(reply)) : [];
    return { ...mapped, videoId: videoId || mapped.videoId, replyCount: asNumber(threadSnippet.totalReplyCount) ?? replyItems.length, replies: replyItems, rawPayload: item };
  }
  private commentFromPayload(item: Record<string, unknown>): YouTubeComment | undefined {
    const id = asString(item.id); if (!id) return undefined; const snippet = asRecord(item.snippet);
    return { id, parentId: asString(snippet.parentId), videoId: asString(snippet.videoId), text: asString(snippet.textDisplay) || asString(snippet.textOriginal) || '', authorName: asString(snippet.authorDisplayName), authorAvatarUrl: asString(snippet.authorProfileImageUrl), publishedAt: asString(snippet.publishedAt), updatedAt: asString(snippet.updatedAt), likeCount: asNumber(snippet.likeCount), rawPayload: item };
  }
  private unsupported(message: string): ExternalProviderError { return new ExternalProviderError(message, 'unsupported'); }
  private async exchangeToken(input: Record<string, string>): Promise<ExternalAuthTokens> {
    if (!this.isConfigured()) throw this.unsupported('YouTube OAuth is not configured.');
    const body = new URLSearchParams({ ...input, client_id: this.credentials!.clientId, client_secret: this.credentials!.clientSecret });
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) throw new ExternalProviderError(asString(payload.error_description) || 'Google OAuth token exchange failed', response.status === 401 ? 'authentication_required' : 'invalid_response', undefined, 'token_exchange');
    const accessToken = asString(payload.access_token); if (!accessToken) throw new ExternalProviderError('Google OAuth returned no access token', 'invalid_response', undefined, 'token_exchange');
    const expiresIn = asNumber(payload.expires_in);
    return { accessToken, refreshToken: asString(payload.refresh_token), ...(expiresIn ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}) };
  }
  private async firstChannel(accessToken: string): Promise<Record<string, unknown>> {
    const response = await this.api(accessToken, '/channels', { part: 'snippet,statistics,contentDetails', mine: 'true', maxResults: '1' });
    const item = asRecord(Array.isArray(response.items) ? response.items[0] : undefined);
    if (!asString(item.id)) throw new ExternalProviderError('No YouTube channel is available for this Google account', 'invalid_response', undefined, 'account_lookup');
    return item;
  }
  private videoIdsFromPlaylistItems(page: Record<string, unknown>): string[] {
    return (Array.isArray(page.items) ? page.items : []).map(asRecord)
      .map((item) => asString(asRecord(item.contentDetails).videoId))
      .filter((id): id is string => Boolean(id));
  }
  private async videoDetailsById(accessToken: string, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
    const detailsById = new Map<string, Record<string, unknown>>();
    if (!ids.length) return detailsById;
    const details = await this.api(accessToken, '/videos', { part: 'snippet,contentDetails,statistics,status', id: ids.join(',') });
    for (const raw of (Array.isArray(details.items) ? details.items : [])) {
      const item = asRecord(raw); const id = asString(item.id); if (id) detailsById.set(id, item);
    }
    return detailsById;
  }
  private toContent(item: Record<string, unknown>): ExternalRemoteContent | undefined {
    const id = asString(item.id); if (!id) return undefined;
    const snippet = asRecord(item.snippet); const statistics = asRecord(item.statistics); const status = asRecord(item.status); const thumbnails = asRecord(snippet.thumbnails); const high = asRecord(thumbnails.high); const medium = asRecord(thumbnails.medium);
    const privacy = asString(status.privacyStatus);
    return { externalContentId: id, externalUrl: `https://www.youtube.com/watch?v=${id}`, title: asString(snippet.title) || `YouTube video ${id}`, description: asString(snippet.description), tags: Array.isArray(snippet.tags) ? snippet.tags.filter((tag): tag is string => typeof tag === 'string') : [], assetType: 'video', publishedAt: asString(snippet.publishedAt), remoteCreatedAt: asString(snippet.publishedAt), remoteUpdatedAt: asString(snippet.publishedAt), collectionExternalIds: [], remoteState: privacy === 'private' ? 'restricted' : 'active', content: { sourceUrl: `https://www.youtube.com/watch?v=${id}`, contentType: 'video/youtube', filename: `${id}.youtube` }, metrics: { views: asNumber(statistics.viewCount), comments: asNumber(statistics.commentCount), other: { likes: asNumber(statistics.likeCount), duration: asString(asRecord(item.contentDetails).duration), thumbnailUrl: asString(high.url) || asString(medium.url) } }, rawMetadata: item };
  }
  private async api(accessToken: string, path: string, params: Record<string, string>, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Record<string, unknown>> {
    const delay = Math.max(0, this.nextRequestAt - Date.now()); if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    this.nextRequestAt = Date.now() + Math.max(0, this.credentials?.minimumRequestIntervalMs || 0);
    const baseUrl = (this.credentials?.apiBaseUrl || 'https://www.googleapis.com/youtube/v3').replace(/\/$/, '');
    const url = new URL(`${baseUrl}${path}`); Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url, { method: init?.method || 'GET', headers: { authorization: `Bearer ${accessToken}`, ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers || {}) }, ...(init?.body ? { body: JSON.stringify(init.body) } : {}) });
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) { const details = asRecord(payload.error); const reason = asString(Array.isArray(details.errors) ? asRecord(details.errors[0]).reason : undefined); const code = response.status === 401 ? 'authentication_required' : response.status === 429 || reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' ? 'rate_limited' : response.status >= 500 ? 'temporarily_unavailable' : 'invalid_response'; throw new ExternalProviderError(asString(details.message) || `YouTube request failed (${response.status})`, code, code === 'rate_limited' ? parseRetryAfterSeconds(response.headers.get('retry-after')) || 300 : undefined); }
    return payload;
  }
}

const withProviderOperation = (
  error: unknown,
  operation: 'token_exchange' | 'account_lookup'
): ExternalProviderError | unknown => {
  if (!(error instanceof ExternalProviderError)) return error;
  return new ExternalProviderError(error.message, error.code, error.retryAfterSeconds, operation);
};

export const createExternalPlatformProvider = (platform: ExternalPlatform, credentials?: ExternalPlatformApplicationCredentials): ExternalPlatformProvider => {
  if (platform === 'deviantart') return new DeviantArtProvider(credentials);
  if (platform === 'youtube') return new YouTubeProvider(credentials);
  throw new Error(`Unsupported external platform: ${platform}`);
};
