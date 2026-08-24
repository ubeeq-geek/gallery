import { InstagramProvider, InstagramProviderError } from '../src/instagramProvider';

const config = { appId: 'app', appSecret: 'secret', redirectUri: 'https://api.example.test/oauth', apiVersion: 'v24.0', graphBaseUrl: 'https://graph.example.test', approvedCapabilities: { imagePublish: true, carouselPublish: true } };
const response = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }));

describe('Instagram provider adapter', () => {
  it('requires an explicitly pinned API version', () => expect(() => new InstagramProvider({ ...config, apiVersion: 'latest' })).toThrow('pinned'));
  it('keeps credentials server-side in the OAuth code exchange body', async () => {
    const request = jest.fn(() => response({ access_token: 'token', expires_in: 3600 }));
    await new InstagramProvider(config, request as typeof fetch).exchangeAuthorizationCode('code');
    const [url, init] = request.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).not.toContain('secret');
    expect(String(init.body)).toContain('client_secret=secret');
  });
  it('uses the provider limit endpoint rather than a hard-coded quota', async () => {
    const request = jest.fn(() => response({ data: [{ quota_usage: 4 }] }));
    await new InstagramProvider(config, request as typeof fetch).getPublishingLimit('token', 'ig-1');
    const calls = request.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    expect(String(calls[0][0])).toContain('/v24.0/ig-1/content_publishing_limit');
  });
  it('creates, checks, then publishes a container explicitly', async () => {
    const request = jest.fn()
      .mockImplementationOnce(() => response({ id: 'container-1' }))
      .mockImplementationOnce(() => response({ status_code: 'FINISHED' }))
      .mockImplementationOnce(() => response({ id: 'media-1' }));
    const provider = new InstagramProvider(config, request as typeof fetch);
    const id = await provider.createContainer('token', 'ig-1', { placement: 'IMAGE', mediaUrl: 'https://delivery.test/opaque' });
    expect(await provider.getContainerStatus('token', id)).toBe('FINISHED');
    expect(await provider.publishContainer('token', 'ig-1', id)).toBe('media-1');
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('classifies ambiguous provider failures for reconciliation', async () => {
    const provider = new InstagramProvider(config, (() => response({ error: { message: 'timeout' } }, 503)) as typeof fetch);
    await expect(provider.publishContainer('token', 'ig-1', 'container')).rejects.toMatchObject<Partial<InstagramProviderError>>({ code: 'UNKNOWN' });
  });
  it('revokes the server-held authorization on disconnect', async () => {
    const request = jest.fn(() => response({ success: true }));
    await new InstagramProvider(config, request as typeof fetch).revokeAuthorization('token');
    const calls = request.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(calls[0][1]).toMatchObject({ method: 'DELETE', headers: expect.objectContaining({ authorization: 'Bearer token' }) });
  });
  it('preserves provider cooldown information for limit-aware scheduling', async () => {
    const limited = new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'retry-after': '90', 'content-type': 'application/json' } });
    const provider = new InstagramProvider(config, (async () => limited) as typeof fetch);
    await expect(provider.getPublishingLimit('token', 'ig-1')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 90 });
  });
  it('reads only publication metadata needed for reconciliation', async () => {
    const request = jest.fn(() => response({ id: 'media-1', permalink: 'https://instagram.test/p/1', caption: 'Changed', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: '2026-08-23T00:00:00Z' }));
    await expect(new InstagramProvider(config, request as typeof fetch).getMedia('token', 'media-1')).resolves.toMatchObject({ id: 'media-1', caption: 'Changed', placement: 'FEED' });
    const calls = request.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    expect(String(calls[0][0])).toContain('fields=id%2Cpermalink%2Ccaption%2Cmedia_type%2Cmedia_product_type%2Ctimestamp');
  });
  it('classifies a missing remote post independently from the canonical Work', async () => {
    const provider = new InstagramProvider(config, (() => response({ error: { message: 'missing' } }, 404)) as typeof fetch);
    await expect(provider.getMedia('token', 'gone')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('imports only authorized metadata with a bounded page size', async () => {
    const request = jest.fn(() => response({ data: [{ id: 'media-1', permalink: 'https://instagram.test/p/1', caption: 'Reference', media_type: 'IMAGE' }], paging: { cursors: { after: 'next' } } }));
    await expect(new InstagramProvider(config, request as typeof fetch).listMedia('token', 'ig-1', undefined, 500)).resolves.toMatchObject({ items: [{ id: 'media-1', caption: 'Reference' }], nextCursor: 'next' });
    const calls = request.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    expect(String(calls[0][0])).toContain('limit=50');
    expect(String(calls[0][0])).not.toContain('media_url');
  });
  it('normalizes aggregate insights without audience records', async () => {
    const request = jest.fn(() => response({ data: [{ name: 'reach', period: 'day', values: [{ value: 42 }] }, { name: 'views', total_value: { value: 90 } }] }));
    await expect(new InstagramProvider(config, request as typeof fetch).getInsights('token', 'media-1', ['reach', 'views'])).resolves.toEqual([
      expect.objectContaining({ metric: 'reach', value: 42 }), expect.objectContaining({ metric: 'views', value: 90 })
    ]);
    const calls = request.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    expect(String(calls[0][0])).toContain('/media-1/insights?metric=reach%2Cviews');
  });
  it('uses video delivery for a video Story container', async () => {
    const request = jest.fn(() => response({ id: 'story-container' }));
    await new InstagramProvider(config, request as typeof fetch).createContainer('token', 'ig-1', { placement: 'STORY', mediaUrl: 'https://delivery.test/video', video: true });
    const calls = request.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(String(calls[0][1].body)).toContain('media_type=STORIES');
    expect(String(calls[0][1].body)).toContain('video_url=https%3A%2F%2Fdelivery.test%2Fvideo');
    expect(String(calls[0][1].body)).not.toContain('image_url');
  });
  it('sets AI self-disclosure on a top-level container', async () => {
    const request = jest.fn(() => response({ id: 'container' }));
    await new InstagramProvider(config, request as typeof fetch).createContainer('token', 'ig-1', { placement: 'IMAGE', mediaUrl: 'https://delivery.test/image', isAiGenerated: true });
    const calls = request.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(String(calls[0][1].body)).toContain('is_ai_generated=true');
  });
  it('keeps carousel AI disclosure on the parent and rejects it on children', async () => {
    const request = jest.fn(() => response({ id: 'parent' }));
    const provider = new InstagramProvider(config, request as typeof fetch);
    await expect(provider.createContainer('token', 'ig-1', { placement: 'IMAGE', mediaUrl: 'https://delivery.test/child', carouselItem: true, isAiGenerated: true })).rejects.toThrow('carousel child');
    await provider.createContainer('token', 'ig-1', { placement: 'CAROUSEL', mediaUrl: 'https://delivery.test/first', children: ['child-1', 'child-2'], isAiGenerated: true });
    const calls = request.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(String(calls[0][1].body)).toContain('media_type=CAROUSEL');
    expect(String(calls[0][1].body)).toContain('is_ai_generated=true');
  });
  it('imports the provider AI label while preserving an unavailable value', async () => {
    const request = jest.fn()
      .mockImplementationOnce(() => response({ data: [{ id: 'ai', is_ai_generated: true }, { id: 'unknown' }] }))
      .mockImplementationOnce(() => response({ id: 'ai', is_ai_generated: true }));
    const provider = new InstagramProvider(config, request as typeof fetch);
    await expect(provider.listMedia('token', 'ig-1')).resolves.toMatchObject({ items: [{ id: 'ai', isAiGenerated: true }, { id: 'unknown', isAiGenerated: undefined }] });
    await expect(provider.getMedia('token', 'ai')).resolves.toMatchObject({ id: 'ai', isAiGenerated: true });
  });
});
