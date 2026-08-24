export interface VimeoTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes: string[];
}

export interface VimeoAccount {
  id: string;
  name: string;
  uri: string;
  accountType?: string;
  uploadQuota?: { freeBytes?: number; resetsAt?: string };
}

export interface VimeoUploadTicket {
  videoId: string;
  uploadUrl: string;
  videoUri: string;
}

export interface VimeoRemoteVideo {
  id: string;
  uri: string;
  link?: string;
  title: string;
  description?: string;
  durationSeconds?: number;
  privacy?: string;
  embedDomains: string[];
  stats: { plays?: number; finishes?: number; likes?: number };
  modifiedAt?: string;
}

export class VimeoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'VimeoApiError';
  }
}

type Fetch = typeof fetch;

const responseError = async (response: Response): Promise<VimeoApiError> => {
  const retryAfter = Number(response.headers.get('retry-after') || '') || undefined;
  const payload = await response.text();
  let providerMessage = '';
  try {
    const parsed = JSON.parse(payload) as { error?: string; developer_message?: string };
    providerMessage = parsed.developer_message || parsed.error || '';
  } catch {
    // Provider HTML and proxy errors are deliberately not included in logs.
  }
  return new VimeoApiError(
    providerMessage || `Vimeo request failed (${response.status})`,
    response.status,
    response.status === 408 || response.status === 429 || response.status >= 500,
    retryAfter
  );
};

export class VimeoProvider {
  constructor(
    private readonly fetcher: Fetch = fetch,
    private readonly apiBase = 'https://api.vimeo.com'
  ) {}

  async exchangeCode(input: { code: string; clientId: string; clientSecret: string; redirectUri: string }): Promise<VimeoTokens> {
    const response = await this.fetcher(`${this.apiBase}/oauth/access_token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/vnd.vimeo.*+json;version=3.4'
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri })
    });
    if (!response.ok) throw await responseError(response);
    const value = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!value.access_token) throw new VimeoApiError('Vimeo returned no access token', 502, false);
    return {
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      expiresAt: value.expires_in ? new Date(Date.now() + value.expires_in * 1000).toISOString() : undefined,
      scopes: (value.scope || '').split(/\s+/).filter(Boolean)
    };
  }

  async account(accessToken: string): Promise<VimeoAccount> {
    const response = await this.api('/me', accessToken);
    const value = await response.json() as Record<string, any>;
    return {
      id: String(value.uri || '').split('/').pop() || '',
      uri: String(value.uri || ''),
      name: String(value.name || ''),
      accountType: value.account,
      uploadQuota: {
        freeBytes: value.upload_quota?.space?.free,
        resetsAt: value.upload_quota?.periodic?.reset_date
      }
    };
  }

  async revokeAccessToken(accessToken: string): Promise<void> {
    await this.api('/tokens', accessToken, { method: 'DELETE' });
  }

  async deleteVideo(accessToken: string, videoUri: string): Promise<void> {
    await this.api(videoUri, accessToken, { method: 'DELETE' });
  }

  async listVideos(accessToken: string, page = 1, perPage = 50): Promise<{ videos: VimeoRemoteVideo[]; nextPage?: number }> {
    const query = new URLSearchParams({ page: String(page), per_page: String(Math.min(100, Math.max(1, perPage))) });
    const response = await this.api(`/me/videos?${query}`, accessToken);
    const value = await response.json() as Record<string, any>;
    const videos = (Array.isArray(value.data) ? value.data : []).map((video: Record<string, any>): VimeoRemoteVideo => ({
      id: String(video.uri || '').split('/').pop() || '',
      uri: String(video.uri || ''),
      link: typeof video.link === 'string' ? video.link : undefined,
      title: String(video.name || 'Untitled Vimeo video'),
      description: typeof video.description === 'string' ? video.description : undefined,
      durationSeconds: typeof video.duration === 'number' ? video.duration : undefined,
      privacy: typeof video.privacy?.view === 'string' ? video.privacy.view : undefined,
      embedDomains: Array.isArray(video.embed?.domains) ? video.embed.domains.filter((domain: unknown): domain is string => typeof domain === 'string') : [],
      stats: {
        plays: typeof video.stats?.plays === 'number' ? video.stats.plays : undefined,
        finishes: typeof video.stats?.finishes === 'number' ? video.stats.finishes : undefined,
        likes: typeof video.metadata?.connections?.likes?.total === 'number' ? video.metadata.connections.likes.total : undefined
      },
      modifiedAt: typeof video.modified_time === 'string' ? video.modified_time : undefined
    }));
    return { videos, nextPage: value.paging?.next ? page + 1 : undefined };
  }

  async createUpload(accessToken: string, input: { sizeBytes: number; title: string; description?: string }): Promise<VimeoUploadTicket> {
    const response = await this.api('/me/videos', accessToken, {
      method: 'POST',
      body: JSON.stringify({
        upload: { approach: 'tus', size: input.sizeBytes },
        name: input.title,
        description: input.description
      })
    });
    const value = await response.json() as Record<string, any>;
    const videoUri = String(value.uri || '');
    const uploadUrl = String(value.upload?.upload_link || '');
    if (!videoUri || !uploadUrl) throw new VimeoApiError('Vimeo returned an invalid upload ticket', 502, false);
    return { videoUri, videoId: videoUri.split('/').pop()!, uploadUrl };
  }

  async uploadOffset(uploadUrl: string): Promise<number> {
    const response = await this.fetcher(uploadUrl, { method: 'HEAD', headers: { 'tus-resumable': '1.0.0' } });
    if (!response.ok) throw await responseError(response);
    const offset = Number(response.headers.get('upload-offset'));
    if (!Number.isSafeInteger(offset) || offset < 0) throw new VimeoApiError('Vimeo returned an invalid upload offset', 502, false);
    return offset;
  }

  async uploadChunk(uploadUrl: string, offset: number, body: Buffer): Promise<number> {
    const response = await this.fetcher(uploadUrl, {
      method: 'PATCH',
      headers: { 'tus-resumable': '1.0.0', 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' },
      body: body as unknown as BodyInit
    });
    if (!response.ok) throw await responseError(response);
    const next = Number(response.headers.get('upload-offset'));
    if (!Number.isSafeInteger(next) || next !== offset + body.length) throw new VimeoApiError('Vimeo upload offset did not advance as expected', 502, false);
    return next;
  }

  async configureVideo(accessToken: string, videoUri: string, input: { title: string; description?: string; privacy: string; embedDomains: string[]; downloadsAllowed: boolean }): Promise<void> {
    await this.api(videoUri, accessToken, {
      method: 'PATCH',
      body: JSON.stringify({ name: input.title, description: input.description, privacy: { view: input.privacy, download: input.downloadsAllowed }, embed: { domains: input.embedDomains } })
    });
  }

  async configurePrivacy(accessToken: string, videoUri: string, input: { privacy: string; embedDomains: string[]; downloadsAllowed: boolean }): Promise<void> {
    await this.api(videoUri, accessToken, {
      method: 'PATCH',
      body: JSON.stringify({ privacy: { view: input.privacy, download: input.downloadsAllowed }, embed: { domains: input.embedDomains } })
    });
  }

  async video(accessToken: string, videoUri: string): Promise<Record<string, unknown>> {
    const response = await this.api(videoUri, accessToken);
    return response.json() as Promise<Record<string, unknown>>;
  }

  private async api(path: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(`${this.apiBase}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.vimeo.*+json;version=3.4', 'content-type': 'application/json', ...init.headers }
    });
    if (!response.ok) throw await responseError(response);
    return response;
  }
}
