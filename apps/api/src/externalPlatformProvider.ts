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
  metrics?: {
    views?: number;
    favourites?: number;
    comments?: number;
    other?: Record<string, unknown>;
  };
  rawMetadata: Record<string, unknown>;
}

export interface ExternalRemoteComment {
  externalCommentId: string;
  authorId?: string;
  authorName?: string;
  body: string;
  createdAt?: string;
  parentExternalCommentId?: string;
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
  updateContent(): Promise<never>;
  publishContent(): Promise<never>;
  moveContent(): Promise<never>;
}

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const asString = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const asNumber = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const asIsoDate = (value: unknown): string | undefined => {
  const raw = asString(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};

const rawItems = (payload: Record<string, unknown>): unknown[] => {
  const values = payload.results || payload.deviations || payload.items || payload.comments;
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
    .map((tag) => typeof tag === 'string' ? tag : asString(asRecord(tag).name))
    .filter((tag): tag is string => Boolean(tag));
  const galleryIds = [
    asString(item.gallery_folder_id),
    asString(item.folderid),
    ...((Array.isArray(item.gallery_folders) ? item.gallery_folders : []).map((folder) => asString(folder)).filter((folder): folder is string => Boolean(folder)))
  ].filter((item, index, values): item is string => Boolean(item) && values.indexOf(item) === index);
  return {
    externalContentId,
    externalUrl: asString(item.url),
    title: asString(item.title) || 'Untitled DeviantArt work',
    description: asString(item.description) || asString(item.description_html),
    tags,
    assetType: normalizeAssetType(item),
    publishedAt: asIsoDate(item.published_time) || asIsoDate(item.published_at),
    remoteCreatedAt: asIsoDate(item.published_time) || asIsoDate(item.created_time),
    remoteUpdatedAt: asIsoDate(item.updated_time) || asIsoDate(item.updated_at),
    collectionExternalIds: galleryIds,
    metrics: {
      views: asNumber(stats.views) || asNumber(item.views),
      favourites: asNumber(stats.favourites) || asNumber(stats.favorites) || asNumber(item.favourites),
      comments: asNumber(stats.comments) || asNumber(item.comments),
      other: Object.keys(stats).length > 0 ? stats : undefined
    },
    rawMetadata: item
  };
};

export class DeviantArtProvider implements ExternalPlatformProvider {
  readonly platform = 'deviantart' as const;
  private static readonly oauthBaseUrl = 'https://www.deviantart.com/oauth2';
  private static readonly apiBaseUrl = 'https://www.deviantart.com/api/v1/oauth2';
  private static readonly scopes = ['user', 'browse', 'gallery', 'collection'];

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
    const payload = await this.request(`/deviation/${encodeURIComponent(externalContentId)}`, accessToken);
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
      limit: '50'
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
        ...(parentExternalCommentId ? { parentExternalCommentId } : {})
      });
    });
    const nextOffset = asNumber(payload.next_offset);
    return { items, nextCursor: Boolean(payload.has_more) && nextOffset !== undefined ? String(nextOffset) : undefined };
  }

  async updateContent(): Promise<never> { throw new ExternalProviderError('Remote writes are not enabled for DeviantArt', 'unsupported'); }
  async publishContent(): Promise<never> { throw new ExternalProviderError('Remote writes are not enabled for DeviantArt', 'unsupported'); }
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
