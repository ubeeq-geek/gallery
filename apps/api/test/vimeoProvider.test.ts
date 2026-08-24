import { VimeoProvider } from '../src/vimeoProvider';

const response = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(
  body === undefined ? null : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json', ...headers } }
);

describe('VimeoProvider', () => {
  test('exchanges OAuth codes without exposing credentials in the URL', async () => {
    const fetcher = jest.fn(async () => response({ access_token: 'access', refresh_token: 'refresh', expires_in: 60, scope: 'private upload' }));
    const provider = new VimeoProvider(fetcher as typeof fetch);
    const tokens = await provider.exchangeCode({ code: 'code', clientId: 'client', clientSecret: 'secret', redirectUri: 'https://example.test/callback' });
    expect(tokens.accessToken).toBe('access');
    expect(tokens.scopes).toEqual(['private', 'upload']);
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).not.toContain('secret');
    expect(call[1]?.headers).toMatchObject({ authorization: `Basic ${Buffer.from('client:secret').toString('base64')}` });
  });

  test('creates a tus ticket and validates resumed offsets', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(response({ uri: '/videos/42', upload: { upload_link: 'https://upload.test/42' } }))
      .mockResolvedValueOnce(response(undefined, 200, { 'upload-offset': '5' }))
      .mockResolvedValueOnce(response(undefined, 204, { 'upload-offset': '8' }));
    const provider = new VimeoProvider(fetcher as typeof fetch);
    const ticket = await provider.createUpload('token', { sizeBytes: 8, title: 'Video' });
    expect(ticket.videoId).toBe('42');
    expect(await provider.uploadOffset(ticket.uploadUrl)).toBe(5);
    expect(await provider.uploadChunk(ticket.uploadUrl, 5, Buffer.from('abc'))).toBe(8);
    expect(fetcher.mock.calls[2][1]).toMatchObject({ method: 'PATCH', headers: expect.objectContaining({ 'upload-offset': '5', 'tus-resumable': '1.0.0' }) });
  });

  test('classifies policy failures as non-retryable', async () => {
    const provider = new VimeoProvider(jest.fn(async () => response({ error: 'forbidden' }, 403)) as typeof fetch);
    await expect(provider.account('token')).rejects.toMatchObject({ status: 403, retryable: false });
  });

  test('normalizes metadata-only video pages and aggregate metrics', async () => {
    const fetcher = jest.fn(async () => response({
      data: [{
        uri: '/videos/42', name: 'Remote video', link: 'https://vimeo.com/42', duration: 120,
        privacy: { view: 'unlisted' }, embed: { domains: ['eversally.com'] },
        stats: { plays: 9 }, metadata: { connections: { likes: { total: 2 } } }
      }],
      paging: { next: '/me/videos?page=2' }
    }));
    const result = await new VimeoProvider(fetcher as typeof fetch).listVideos('token');
    expect(result).toEqual({
      videos: [expect.objectContaining({ id: '42', title: 'Remote video', durationSeconds: 120, privacy: 'unlisted', embedDomains: ['eversally.com'], stats: { plays: 9, finishes: undefined, likes: 2 } })],
      nextPage: 2
    });
    expect(JSON.stringify(result)).not.toContain('download');
  });

  test('updates privacy and embed domains without replacing source media', async () => {
    const fetcher = jest.fn(async () => response(undefined, 204));
    const provider = new VimeoProvider(fetcher as typeof fetch);
    await provider.configurePrivacy('token', '/videos/42', { privacy: 'unlisted', embedDomains: ['eversally.com'], downloadsAllowed: false });
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].method).toBe('PATCH');
    expect(JSON.parse(String(call[1].body))).toEqual({ privacy: { view: 'unlisted', download: false }, embed: { domains: ['eversally.com'] } });
    expect(String(call[1].body)).not.toContain('upload');
  });
});
