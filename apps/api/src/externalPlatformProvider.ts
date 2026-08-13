import type { ExternalAssetType, ExternalPlatform } from './domain';

export class ExternalProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'authentication_required' | 'rate_limited' | 'temporarily_unavailable' | 'invalid_response' | 'unsupported',
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
}

export interface ExternalOAuthPkce {
  codeChallenge: string;
  codeVerifier: string;
}

export interface ExternalRemoteAccount {
  externalUserId: string;
  externalUsername: string;
}

export interface ExternalRemoteCollection {
  externalCollectionId: string;
  name: string;
  parentExternalCollectionId?: string;
  position?: number;
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
  content?: {
    sourceUrl: string;
    contentType?: string;
    byteSize?: number;
  };
  metrics?: {
    views?: number;
    favourites?: number;
    comments?: number;
    other?: Record<string, unknown>;
  };
  rawMetadata: Record<string, unknown>;
}

export interface ExternalContentUpdate {
  title?: string;
  description?: string;
  tags?: string[];
  allowComments?: boolean;
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
  isMature?: boolean;
  matureLevel?: 'strict' | 'moderate';
  matureClassification?: Array<'nudity' | 'sexual' | 'gore' | 'language' | 'ideology'>;
  allowComments?: boolean;
  isAiGenerated?: boolean;
  noAi?: boolean;
}

export interface ExternalPublishedContent {
  externalContentId: string;
  externalDraftId?: string;
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
  body: string;
  createdAt?: string;
  parentExternalCommentId?: string;
  rawPayload?: Record<string, unknown>;
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
  listContent(accessToken: string, options: { username: string; cursor?: string; limit?: number }): Promise<ExternalContentPage>;
  getContent(accessToken: string, externalContentId: string): Promise<ExternalRemoteContent>;
  listCollections(accessToken: string, username: string): Promise<ExternalRemoteCollection[]>;
  listComments(accessToken: string, externalContentId: string, cursor?: string): Promise<{ items: ExternalRemoteComment[]; nextCursor?: string }>;
  postComment(accessToken: string, externalContentId: string, body: string, parentExternalCommentId?: string): Promise<ExternalRemoteComment>;
  updateContent(accessToken: string, externalContentId: string, update: ExternalContentUpdate, options?: ExternalContentUpdateOptions): Promise<void>;
  submitContent(accessToken: string, content: ExternalContentPublish, existingDraftId?: string): Promise<ExternalDraftContent>;
  publishDraft(accessToken: string, externalDraftId: string, content: ExternalContentPublish): Promise<ExternalPublishedContent>;
  publishContent(accessToken: string, content: ExternalContentPublish): Promise<ExternalPublishedContent>;
  moveContent(): Promise<never>;
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
  const raw = asString(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};

const rawItems = (payload: Record<string, unknown>): unknown[] => {
  const values = payload.results || payload.metadata || payload.deviations || payload.items || payload.comments;
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
    ...(sourceUrl ? {
      content: {
        sourceUrl,
        contentType: asString(content.content_type) || asString(item.mime_type),
        byteSize: asNumber(content.filesize) || asNumber(item.filesize)
      }
    } : {}),
    metrics: {
      views: asNumber(stats.views) || asNumber(item.views),
      favourites: asNumber(stats.favourites) || asNumber(stats.favorites) || asNumber(item.favourites),
      comments: asNumber(stats.comments) || asNumber(item.comments),
      other: Object.keys(stats).length > 0 ? stats : undefined
    },
    rawMetadata: item
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
  private static readonly scopes = ['user', 'user.manage', 'browse', 'gallery', 'collection', 'stash', 'publish', 'comment.post'];

  constructor(private readonly credentials?: ExternalPlatformApplicationCredentials) {}

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
    const metadataPayload = await this.request('/deviation/metadata', accessToken, {
      'deviationids[0]': externalContentId,
      ext_submission: 'true',
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

  async listCollections(accessToken: string, username: string): Promise<ExternalRemoteCollection[]> {
    const collections: ExternalRemoteCollection[] = [];
    let offset = 0;
    let hasMore = true;
    while (hasMore) {
      const payload = await this.request('/gallery/folders', accessToken, {
        username,
        offset: String(offset),
        limit: '24'
      });
      rawItems(payload).forEach((value, index) => {
        const item = asRecord(value);
        const externalCollectionId = asString(item.folderid) || asString(item.uuid) || asString(item.id);
        if (!externalCollectionId) return;
        const parentExternalCollectionId = asString(item.parent_folderid) || asString(item.parent_id);
        collections.push({
          externalCollectionId,
          name: asString(item.name) || 'Untitled DeviantArt folder',
          ...(parentExternalCollectionId ? { parentExternalCollectionId } : {}),
          position: asNumber(item.position) || offset + index,
          rawMetadata: item
        });
      });
      const nextOffset = asNumber(payload.next_offset);
      hasMore = Boolean(payload.has_more) && nextOffset !== undefined && nextOffset > offset;
      offset = nextOffset === undefined ? offset : nextOffset;
    }
    return collections;
  }

  async listComments(accessToken: string, externalContentId: string, cursor?: string): Promise<{ items: ExternalRemoteComment[]; nextCursor?: string }> {
    const payload = await this.request(`/comments/deviation/${encodeURIComponent(externalContentId)}`, accessToken, {
      offset: cursor || '0',
      limit: '50',
      // The list response otherwise may contain abbreviated comment bodies.
      expand: 'comment.fulltext'
    });
    const items: ExternalRemoteComment[] = [];
    rawItems(payload).forEach((value) => {
      const item = asRecord(value);
      const externalCommentId = asString(item.commentid) || asString(item.id);
      if (!externalCommentId) return;
      const user = asRecord(item.user);
      const authorId = asString(item.userid) || asString(user.userid);
      const authorName = asString(item.username) || asString(user.username);
      const createdAt = asIsoDate(item.posted_on) || asIsoDate(item.created_at);
      const parentExternalCommentId = asString(item.parentid);
      items.push({
        externalCommentId,
        ...(authorId ? { authorId } : {}),
        ...(authorName ? { authorName } : {}),
        body: asString(item.body) || '',
        ...(createdAt ? { createdAt } : {}),
        ...(parentExternalCommentId ? { parentExternalCommentId } : {}),
        rawPayload: item
      });
    });
    const nextOffset = asNumber(payload.next_offset);
    return { items, nextCursor: Boolean(payload.has_more) && nextOffset !== undefined ? String(nextOffset) : undefined };
  }

  async postComment(accessToken: string, externalContentId: string, body: string, parentExternalCommentId?: string): Promise<ExternalRemoteComment> {
    const form = new URLSearchParams({ body });
    if (parentExternalCommentId) form.set('commentid', parentExternalCommentId);
    const payload = await this.requestForm(`/comments/post/deviation/${encodeURIComponent(externalContentId)}`, accessToken, form);
    const comment = asRecord(payload.comment);
    const source = Object.keys(comment).length ? comment : payload;
    const externalCommentId = asString(source.commentid) || asString(source.id);
    if (!externalCommentId) throw new ExternalProviderError('DeviantArt did not return a comment ID', 'invalid_response');
    const user = asRecord(source.user);
    const authorId = asString(source.userid) || asString(user.userid);
    const authorName = asString(source.username) || asString(user.username);
    const createdAt = asIsoDate(source.posted_on) || asIsoDate(source.created_at);
    return {
      externalCommentId,
      ...(authorId ? { authorId } : {}),
      ...(authorName ? { authorName } : {}),
      body: asString(source.body) || body,
      ...(createdAt ? { createdAt } : {}),
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
    if (update.allowComments !== undefined) form.set('allow_comments', String(update.allowComments));
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
    if (!itemId) throw new ExternalProviderError('DeviantArt did not return a Sta.sh item ID', 'invalid_response');
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
    if (content.tags) content.tags.forEach((tag) => publish.append('tags[]', tag));
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
  async moveContent(): Promise<never> { throw new ExternalProviderError('Remote writes are not enabled for DeviantArt', 'unsupported'); }

  private async request(path: string, accessToken: string, query?: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`${DeviantArtProvider.apiBaseUrl}${path}`);
    Object.entries(query || {}).forEach(([key, value]) => url.searchParams.set(key, value));
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
    const response = await fetch(`${DeviantArtProvider.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      body: form
    });
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) {
      const error = this.errorFromResponse(response.status, payload, response.headers.get('retry-after'));
      throw new ExternalProviderError(`DeviantArt ${path}: ${error.message}`, error.code, error.retryAfterSeconds);
    }
    return payload;
  }

  private errorFromResponse(status: number, payload: Record<string, unknown>, retryAfter?: string | null): ExternalProviderError {
    const message = asString(payload.error_description) || asString(payload.error) || `DeviantArt request failed (${status})`;
    if (status === 401 || status === 403) return new ExternalProviderError(message, 'authentication_required');
    if (status === 429) return new ExternalProviderError(message, 'rate_limited', asNumber(retryAfter));
    if (status >= 500) return new ExternalProviderError(message, 'temporarily_unavailable');
    return new ExternalProviderError(message, 'invalid_response');
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
  throw new Error(`Unsupported external platform: ${platform}`);
};
