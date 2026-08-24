import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export type TumblrIntegrationOwnership = 'managed' | 'creator_owned';
export type TumblrAuthProtocol = 'oauth2' | 'oauth1';
export type TumblrPostState = 'published' | 'draft' | 'queue' | 'private';
export type TumblrPublicationMode = 'full' | 'selected_assets' | 'announcement';
export type TumblrDestinationEligibility = 'allowed_managed' | 'creator_owned_required' | 'platform_ineligible';

export interface TumblrConnector {
  id: string;
  tenantId: string;
  userId: string;
  creatorId: string;
  ownership: TumblrIntegrationOwnership;
  authProtocol: TumblrAuthProtocol;
  status: 'pending' | 'connected' | 'expired' | 'revoked' | 'error' | 'disabled';
  tumblrUserId?: string;
  tumblrUserName?: string;
  managedApplicationId?: string;
  creatorApplicationEncrypted?: { clientId?: string; clientSecret?: string; redirectUri?: string; consumerKey?: string; consumerSecret?: string };
  credentialsEncrypted: Record<string, unknown>;
  scopes?: string[];
  connectedAt?: string;
  lastValidatedAt?: string;
  disconnectedAt?: string;
}

export interface TumblrBlogDestination {
  id: string;
  tenantId: string;
  connectorId: string;
  creatorId: string;
  tumblrBlogId?: string;
  identifier: string;
  name?: string;
  title?: string;
  url?: string;
  avatarUrl?: string;
  enabled: boolean;
  defaults?: {
    publicationMode?: TumblrPublicationMode;
    postState?: TumblrPostState;
    includeSourceLink?: boolean;
    includeWorkTitle?: boolean;
    includeDescription?: boolean;
    includeTags?: boolean;
    appendDefaultTags?: string[];
  };
}

export interface TumblrPublication {
  id: string;
  tenantId: string;
  creatorId: string;
  workId: string;
  connectorId: string;
  destinationId: string;
  mode: TumblrPublicationMode;
  selectedAssetIds?: string[];
  status: 'pending' | 'publishing' | 'published' | 'queued' | 'draft' | 'private' | 'failed' | 'deleted' | 'remote_missing';
  tumblrPostId?: string;
  tumblrPostUrl?: string;
  requestSnapshot?: Record<string, unknown>;
  responseSnapshot?: Record<string, unknown>;
  publishedAt?: string;
  updatedAt?: string;
  deletedAt?: string;
}

export interface TumblrContentDeclarations {
  matureThemes?: boolean;
  nudity?: boolean;
  sexuallyExplicit?: boolean;
  graphicViolence?: boolean;
  disturbingImagery?: boolean;
  politicalContent?: boolean;
  aiGenerated?: boolean;
  aiAssisted?: boolean;
  sensitiveTopic?: boolean;
}

export interface TumblrPolicyRule {
  id: string;
  source: 'tumblr_api' | 'managed_connector';
  declaration: keyof TumblrContentDeclarations;
  effect: Exclude<TumblrDestinationEligibility, 'allowed_managed'>;
  message: string;
}

export interface TumblrEligibilityDecision {
  eligibility: TumblrDestinationEligibility;
  allowed: boolean;
  reasons: Array<{ ruleId: string; source: TumblrPolicyRule['source']; message: string }>;
}

/** Policy is supplied by deployment configuration instead of freezing Tumblr rules in code. */
export const evaluateTumblrEligibility = (
  declarations: TumblrContentDeclarations,
  ownership: TumblrIntegrationOwnership,
  rules: TumblrPolicyRule[]
): TumblrEligibilityDecision => {
  const matching = rules.filter((rule) => declarations[rule.declaration] === true);
  const platformRules = matching.filter((rule) => rule.effect === 'platform_ineligible');
  const managedRules = matching.filter((rule) => rule.effect === 'creator_owned_required');
  const eligibility: TumblrDestinationEligibility = platformRules.length
    ? 'platform_ineligible'
    : managedRules.length
      ? 'creator_owned_required'
      : 'allowed_managed';
  return {
    eligibility,
    allowed: eligibility === 'allowed_managed' || (eligibility === 'creator_owned_required' && ownership === 'creator_owned'),
    reasons: (platformRules.length ? platformRules : managedRules).map(({ id, source, message }) => ({ ruleId: id, source, message }))
  };
};

export interface TumblrRenderableAsset {
  id: string;
  kind: 'image' | 'video' | 'audio';
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
  altText?: string;
  caption?: string;
}

export type TumblrNpfBlock =
  | { type: 'text'; text: string; subtype?: 'heading1' | 'heading2' | 'quirky' }
  | { type: 'image'; media: Array<{ url: string; type?: string; width?: number; height?: number }>; alt_text?: string; caption?: string }
  | { type: 'video'; media: { url: string; type?: string } }
  | { type: 'audio'; media: { url: string; type?: string } }
  | { type: 'link'; url: string; title?: string; description?: string };

export interface TumblrRenderRequest {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  assets: TumblrRenderableAsset[];
  selectedAssetIds?: string[];
  mode: TumblrPublicationMode;
  state: TumblrPostState;
  tags?: string[];
  includeTitle?: boolean;
  includeDescription?: boolean;
  includeSourceLink?: boolean;
  maxMediaBlocks?: number;
}

export interface TumblrCanonicalWorkInput {
  work: { title: string; description?: string; tags: string[] };
  assets: Array<{ assetId: string; kind: string; status: string; mimeType: string; width?: number; height?: number; url?: string; attachment: { position: number; altText?: string; caption?: string } }>;
  mode: TumblrPublicationMode;
  state: TumblrPostState;
  selectedAssetIds?: string[];
  canonicalUrl?: string;
  includeTitle?: boolean;
  includeDescription?: boolean;
  includeSourceLink?: boolean;
  tags?: string[];
  maxMediaBlocks: number;
}

/** Adapts canonical Work + Asset records into the versioned NPF renderer. */
export const renderCanonicalWorkToTumblrV1 = (input: TumblrCanonicalWorkInput): TumblrNpfPost => {
  const supported = new Set(['image', 'video', 'audio']);
  const assets = input.assets
    .filter((asset) => asset.status === 'ready' && supported.has(asset.kind) && asset.url)
    .sort((a, b) => a.attachment.position - b.attachment.position)
    .map((asset) => ({ id: asset.assetId, kind: asset.kind as TumblrRenderableAsset['kind'], url: asset.url!, mimeType: asset.mimeType, width: asset.width, height: asset.height, altText: asset.attachment.altText, caption: asset.attachment.caption }));
  return renderTumblrNpfV1({ title: input.work.title, description: input.work.description, assets, mode: input.mode, state: input.state, selectedAssetIds: input.selectedAssetIds, canonicalUrl: input.canonicalUrl, includeTitle: input.includeTitle, includeDescription: input.includeDescription, includeSourceLink: input.includeSourceLink, tags: input.tags || input.work.tags, maxMediaBlocks: input.maxMediaBlocks });
};

export interface TumblrNpfPost {
  content: TumblrNpfBlock[];
  layout: unknown[];
  state: TumblrPostState;
  tags: string[];
  source_url?: string;
}

export class TumblrValidationError extends Error {
  constructor(message: string, readonly code: 'media_limit' | 'invalid_assets' | 'empty_post') {
    super(message);
  }
}

/** Version 1 of the canonical Work-to-NPF transformation contract. */
export const renderTumblrNpfV1 = (request: TumblrRenderRequest): TumblrNpfPost => {
  const assetsById = new Map(request.assets.map((asset) => [asset.id, asset]));
  const selected = request.mode === 'announcement'
    ? (request.selectedAssetIds || []).map((id) => assetsById.get(id)).filter((asset): asset is TumblrRenderableAsset => Boolean(asset))
    : request.selectedAssetIds
      ? request.selectedAssetIds.map((id) => assetsById.get(id)).filter((asset): asset is TumblrRenderableAsset => Boolean(asset))
      : request.assets;
  if (request.mode === 'selected_assets' && !request.selectedAssetIds?.length) {
    throw new TumblrValidationError('Select at least one asset for a selected-assets post.', 'invalid_assets');
  }
  const limit = request.maxMediaBlocks ?? 10;
  if (selected.length > limit) {
    throw new TumblrValidationError(`This Work has ${selected.length} media blocks; Tumblr currently permits ${limit} for this destination.`, 'media_limit');
  }
  const content: TumblrNpfBlock[] = [];
  if (request.includeTitle !== false && request.title?.trim()) content.push({ type: 'text', subtype: 'heading1', text: request.title.trim() });
  if (request.includeDescription !== false && request.description?.trim()) content.push({ type: 'text', text: request.description.trim() });
  for (const asset of selected) {
    if (!/^https:\/\//i.test(asset.url)) throw new TumblrValidationError('Tumblr media must use an HTTPS URL.', 'invalid_assets');
    if (asset.kind === 'image') content.push({
      type: 'image',
      media: [{ url: asset.url, ...(asset.mimeType ? { type: asset.mimeType } : {}), ...(asset.width ? { width: asset.width } : {}), ...(asset.height ? { height: asset.height } : {}) }],
      ...(asset.altText ? { alt_text: asset.altText } : {}),
      ...(asset.caption ? { caption: asset.caption } : {})
    });
    else content.push({ type: asset.kind, media: { url: asset.url, ...(asset.mimeType ? { type: asset.mimeType } : {}) } });
  }
  if ((request.mode === 'announcement' || request.includeSourceLink) && request.canonicalUrl) {
    content.push({ type: 'link', url: request.canonicalUrl, ...(request.title ? { title: request.title } : {}), ...(request.description ? { description: request.description } : {}) });
  }
  if (!content.length) throw new TumblrValidationError('The Tumblr post has no publishable content.', 'empty_post');
  return {
    content,
    layout: [],
    state: request.state,
    tags: [...new Set((request.tags || []).map((tag) => tag.trim()).filter(Boolean))],
    ...(request.includeSourceLink && request.canonicalUrl ? { source_url: request.canonicalUrl } : {})
  };
};

export interface TumblrOAuthState {
  userId: string;
  creatorId: string;
  connectorId: string;
  ownership: TumblrIntegrationOwnership;
  expiresAt: number;
  nonce: string;
}

const stateSignature = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('base64url');

export const issueTumblrOAuthState = (
  value: Omit<TumblrOAuthState, 'expiresAt' | 'nonce'>,
  secret: string,
  ttlSeconds = 600,
  now = Date.now()
): string => {
  if (!secret) throw new Error('Tumblr OAuth state signing is not configured.');
  const payload = Buffer.from(JSON.stringify({ ...value, expiresAt: now + ttlSeconds * 1000, nonce: randomBytes(24).toString('base64url') })).toString('base64url');
  return `${payload}.${stateSignature(payload, secret)}`;
};

export const verifyTumblrOAuthState = (value: string, secret: string, now = Date.now()): TumblrOAuthState => {
  const [payload, signature] = value.split('.');
  if (!payload || !signature) throw new Error('Tumblr OAuth state is invalid.');
  const expected = stateSignature(payload, secret);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('Tumblr OAuth state is invalid.');
  let state: Partial<TumblrOAuthState>;
  try {
    state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<TumblrOAuthState>;
  } catch {
    throw new Error('Tumblr OAuth state is invalid.');
  }
  if (!state.userId || !state.creatorId || !state.connectorId || !state.nonce || !['managed', 'creator_owned'].includes(state.ownership || '') || !state.expiresAt) {
    throw new Error('Tumblr OAuth state is invalid.');
  }
  if (state.expiresAt < now) throw new Error('Tumblr OAuth state has expired.');
  return state as TumblrOAuthState;
};

export interface TumblrApplicationCredentials { clientId: string; clientSecret: string; redirectUri: string }

export class TumblrApiClient {
  constructor(
    private readonly credentials: TumblrApplicationCredentials,
    private readonly apiBaseUrl = 'https://api.tumblr.com'
  ) {}

  authorizationUrl(state: string): string {
    const url = new URL('https://www.tumblr.com/oauth2/authorize');
    url.search = new URLSearchParams({ client_id: this.credentials.clientId, response_type: 'code', scope: 'basic write offline_access', redirect_uri: this.credentials.redirectUri, state }).toString();
    return url.toString();
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scopes: string[] }> {
    const response = await fetch(`${this.apiBaseUrl}/v2/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: this.credentials.clientId, client_secret: this.credentials.clientSecret, redirect_uri: this.credentials.redirectUri })
    });
    const body = await this.response(response) as Record<string, unknown>;
    if (typeof body.access_token !== 'string') throw new Error('Tumblr did not return an access token.');
    return { accessToken: body.access_token, ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}), ...(typeof body.expires_in === 'number' ? { expiresIn: body.expires_in } : {}), scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/) : [] };
  }

  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; scopes: string[] }> {
    const response = await fetch(`${this.apiBaseUrl}/v2/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.credentials.clientId, client_secret: this.credentials.clientSecret })
    });
    const body = await this.response(response) as Record<string, unknown>;
    if (typeof body.access_token !== 'string') throw new Error('Tumblr did not return a refreshed access token.');
    return { accessToken: body.access_token, ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}), ...(typeof body.expires_in === 'number' ? { expiresIn: body.expires_in } : {}), scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/) : [] };
  }

  async userInfo(accessToken: string): Promise<Record<string, unknown>> { return this.get('/v2/user/info', accessToken); }

  async createPost(blogIdentifier: string, post: TumblrNpfPost, accessToken: string): Promise<Record<string, unknown>> {
    return this.request(`/v2/blog/${encodeURIComponent(blogIdentifier)}/posts`, accessToken, 'POST', post);
  }

  async getPost(blogIdentifier: string, postId: string, accessToken: string): Promise<Record<string, unknown>> {
    return this.get(`/v2/blog/${encodeURIComponent(blogIdentifier)}/posts/${encodeURIComponent(postId)}`, accessToken);
  }

  async updatePost(blogIdentifier: string, postId: string, post: TumblrNpfPost, accessToken: string): Promise<Record<string, unknown>> {
    return this.request(`/v2/blog/${encodeURIComponent(blogIdentifier)}/posts/${encodeURIComponent(postId)}`, accessToken, 'PUT', post);
  }

  async deletePost(blogIdentifier: string, postId: string, accessToken: string): Promise<void> {
    await this.request(`/v2/blog/${encodeURIComponent(blogIdentifier)}/post/delete`, accessToken, 'POST', { id: postId });
  }

  private get(path: string, token: string) { return this.request(path, token, 'GET'); }
  private async request(path: string, token: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return this.response(response) as Promise<Record<string, unknown>>;
  }
  private async response(response: Response): Promise<unknown> {
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta as Record<string, unknown> : {};
      const message = typeof meta.msg === 'string' ? meta.msg : typeof payload.error_description === 'string' ? payload.error_description : `Tumblr API request failed (${response.status}).`;
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new TumblrApiError(message, response.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    }
    return payload.response ?? payload;
  }
}

export type TumblrPublishErrorType = 'auth' | 'permission' | 'rate_limit' | 'validation' | 'policy' | 'media' | 'platform' | 'network' | 'unknown';

export class TumblrApiError extends Error {
  readonly errorType: TumblrPublishErrorType;
  readonly retryable: boolean;
  constructor(message: string, readonly status: number, readonly retryAfterSeconds?: number) {
    super(message);
    this.errorType = status === 401 ? 'auth' : status === 403 ? 'permission' : status === 429 ? 'rate_limit' : status >= 400 && status < 500 ? 'validation' : 'platform';
    this.retryable = status === 429 || status >= 500;
  }
}
