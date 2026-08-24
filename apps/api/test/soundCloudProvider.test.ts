import { createExternalPlatformProvider, ExternalProviderError } from '../src/externalPlatformProvider';
import { issueExternalOAuthState, verifyExternalOAuthState } from '../src/externalOAuth';
import type { AppConfig } from '../src/config';
import { Readable } from 'node:stream';

const credentials = {
  clientId: 'soundcloud-client', clientSecret: 'soundcloud-secret',
  redirectUri: 'https://studio.example/integrations/soundcloud/callback'
};

describe('SoundCloud provider', () => {
  afterEach(() => jest.restoreAllMocks());

  test('uses OAuth 2.1 PKCE and accepts SoundCloud in generic signed state', () => {
    const config = { externalTokenEncryptionKey: 'test-secret' } as AppConfig;
    const issued = issueExternalOAuthState(config, {
      userId: 'user-1', externalPlatformCredentialId: 'credential-1', platform: 'soundcloud', returnPath: '/studio/integrations'
    });
    expect(verifyExternalOAuthState(config, issued.state).platform).toBe('soundcloud');

    const provider = createExternalPlatformProvider('soundcloud', credentials);
    const url = new URL(provider.createAuthorizationUrl(issued.state, { codeChallenge: 'challenge', codeVerifier: 'verifier' }));
    expect(url.origin).toBe('https://secure.soundcloud.com');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(() => provider.createAuthorizationUrl('state')).toThrow('requires PKCE');
  });

  test('normalizes numeric account IDs and metadata-only audio tracks with linked pagination', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 42, username: 'artist' }), headers: { get: () => null } } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        collection: [{ id: 7, title: 'Track', permalink_url: 'https://soundcloud.com/artist/track', tag_list: 'ambient "field recording"', playback_count: 12, likes_count: 3 }],
        next_href: 'https://api.soundcloud.com/me/tracks?cursor=next'
      }), headers: { get: () => null } } as unknown as Response);
    const provider = createExternalPlatformProvider('soundcloud', credentials);

    await expect(provider.getAccount('token')).resolves.toEqual({ externalUserId: '42', externalUsername: 'artist' });
    const page = await provider.listContent('token', { username: 'artist' });
    expect(page.nextCursor).toBe('https://api.soundcloud.com/me/tracks?cursor=next');
    expect(page.items[0]).toMatchObject({ externalContentId: '7', assetType: 'audio', title: 'Track', tags: ['ambient', 'field recording'] });
    expect(page.items[0].content).toBeUndefined();
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(['https://api.soundcloud.com/me', 'https://api.soundcloud.com/me/tracks?linked_partitioning=true&limit=50']);
  });

  test('rotates refresh tokens and honors the provider kill switch', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }), headers: { get: () => null } } as unknown as Response);
    await expect(createExternalPlatformProvider('soundcloud', credentials).refreshAuthentication('old-refresh')).resolves.toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' });

    const disabled = createExternalPlatformProvider('soundcloud', { ...credentials, enabled: false });
    expect(() => disabled.createAuthorizationUrl('state', { codeChallenge: 'challenge', codeVerifier: 'verifier' })).toThrow(ExternalProviderError);
  });

  test('never exposes an imported SoundCloud audio download', async () => {
    await expect(createExternalPlatformProvider('soundcloud', credentials).getOriginalDownload('token', 'track')).resolves.toMatchObject({ status: 'not_downloadable' });
  });

  test('normalizes playlists, timed comments, favoriters, and engagement without invoking DeviantArt', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ collection: [{ urn: 'soundcloud:playlists:1', title: 'Set', track_count: 1 }] }), headers: { get: () => null } } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ collection: [{ urn: 'soundcloud:comments:2', body: 'Drop!', timestamp: 1234, user: { id: 9, username: 'listener' } }] }), headers: { get: () => null } } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ collection: [{ urn: 'soundcloud:users:9', username: 'listener' }] }), headers: { get: () => null } } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ urn: 'soundcloud:tracks:3', title: 'Track', playback_count: 20, reposts_count: 2 }), headers: { get: () => null } } as unknown as Response);
    const provider = createExternalPlatformProvider('soundcloud', credentials);

    await expect(provider.listCollections('token', 'artist')).resolves.toMatchObject([{ externalCollectionId: 'soundcloud:playlists:1', name: 'Set', size: 1 }]);
    await expect(provider.listComments('token', 'soundcloud:tracks:3')).resolves.toMatchObject({ items: [{ positionMilliseconds: 1234, authorName: 'listener' }] });
    await expect(provider.listFavourites('token', 'soundcloud:tracks:3')).resolves.toMatchObject({ items: [{ externalUserId: 'soundcloud:users:9' }] });
    await expect(provider.getEngagement('token', ['soundcloud:tracks:3'])).resolves.toMatchObject([{ metrics: { views: 20, other: { reposts: 2 } } }]);
    expect(fetchSpy.mock.calls.every(([url]) => String(url).startsWith('https://api.soundcloud.com/'))).toBe(true);
  });

  test('fails closed for capabilities that are not implemented yet', async () => {
    const provider = createExternalPlatformProvider('soundcloud', credentials);
    await expect(provider.createJournal('token', { title: 'Journal', body: 'Body' }))
      .rejects.toMatchObject({ code: 'unsupported' });
  });

  test('streams multipart audio uploads and stores the returned stable track identity', async () => {
    let multipart = '';
    jest.spyOn(global, 'fetch').mockImplementationOnce(async (_url, init) => {
      for await (const chunk of init!.body as unknown as AsyncIterable<Buffer>) multipart += Buffer.from(chunk).toString('utf8');
      return { ok: true, json: async () => ({ urn: 'soundcloud:tracks:44', permalink_url: 'https://soundcloud.com/artist/track' }), headers: { get: () => null } } as unknown as Response;
    });
    const published = await createExternalPlatformProvider('soundcloud', credentials).publishContent('token', {
      body: Buffer.alloc(0), filename: 'track.flac', contentType: 'audio/flac', title: 'Track', artist: 'Artist', visibility: 'public',
      uploadSource: { assetId: 'asset-1', filename: 'track.flac', contentType: 'audio/flac', byteSize: 5, openReadStream: async () => Readable.from([Buffer.from('audio')]) }
    });
    expect(published).toMatchObject({ externalContentId: 'soundcloud:tracks:44', externalUrl: 'https://soundcloud.com/artist/track' });
    expect(multipart).toContain('name="track[title]"\r\n\r\nTrack');
    expect(multipart).toContain('filename="track.flac"');
    expect(multipart).toContain('audio');
  });

  test('classifies a timed-out upload as ambiguous instead of retry-safe', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('socket closed'));
    await expect(createExternalPlatformProvider('soundcloud', credentials).publishContent('token', {
      body: Buffer.alloc(0), filename: 'track.flac', contentType: 'audio/flac', title: 'Track',
      uploadSource: { assetId: 'asset-1', filename: 'track.flac', contentType: 'audio/flac', openReadStream: async () => Readable.from([Buffer.from('audio')]) }
    })).rejects.toMatchObject({ code: 'ambiguous_submission' });
  });

  test('updates metadata without audio fields and deletes only through explicit adapter calls', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({}), headers: { get: () => null } } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('no body'); }, headers: { get: () => null } } as unknown as Response);
    const provider = createExternalPlatformProvider('soundcloud', credentials);
    await provider.updateContent('token', 'soundcloud:tracks:44', { title: 'Updated', tags: ['ambient'], allowComments: false });
    await provider.deleteContent!('token', 'soundcloud:tracks:44');
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: 'PUT' });
    expect(String(fetchSpy.mock.calls[0][1]?.body)).toContain('track%5Btitle%5D=Updated');
    expect(String(fetchSpy.mock.calls[0][1]?.body)).not.toContain('asset_data');
    expect(fetchSpy.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
  });

  test('implements deliberate comments, likes, reposts, and follows with provider-native state calls', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ urn: 'soundcloud:comments:1', body: 'Great', timestamp: 500 }), headers: { get: () => null } } as unknown as Response)
      .mockResolvedValue({ ok: true, json: async () => ({}), headers: { get: () => null } } as unknown as Response);
    const provider = createExternalPlatformProvider('soundcloud', credentials);
    await expect(provider.postTimedComment!('token', 'soundcloud:tracks:1', 'Great', 500)).resolves.toMatchObject({ externalCommentId: 'soundcloud:comments:1', positionMilliseconds: 500 });
    await provider.likeContent!('token', 'soundcloud:tracks:1');
    await provider.unlikeContent!('token', 'soundcloud:tracks:1');
    await provider.repostContent!('token', 'soundcloud:tracks:1');
    await provider.unrepostContent!('token', 'soundcloud:tracks:1');
    await provider.followUser!('token', 'soundcloud:users:2');
    await provider.unfollowUser!('token', 'soundcloud:users:2');
    expect(fetchSpy.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'PUT', 'DELETE', 'PUT', 'DELETE', 'PUT', 'DELETE']);
  });

  test('normalizes the available account feed without claiming notification completeness', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, json: async () => ({
      collection: [{ type: 'track-like', created_at: '2026-08-20T12:00:00Z', user: { urn: 'soundcloud:users:2', username: 'fan' }, track: { urn: 'soundcloud:tracks:3', title: 'Track' } }]
    }), headers: { get: () => null } } as unknown as Response);
    const result = await createExternalPlatformProvider('soundcloud', credentials).listMessages('token', 'feed');
    expect(result.items[0]).toMatchObject({ type: 'favourite', actorName: 'fan', externalContentId: 'soundcloud:tracks:3' });
  });
});
