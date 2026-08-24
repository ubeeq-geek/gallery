import { evaluateTumblrEligibility, issueTumblrOAuthState, renderCanonicalWorkToTumblrV1, renderTumblrNpfV1, TumblrApiClient, TumblrValidationError, verifyTumblrOAuthState } from '../src/tumblrIntegration';

describe('Tumblr integration foundation', () => {
  test('platform policy cannot be bypassed with creator-owned credentials', () => {
    const rules = [{ id: 'sensitive-api', source: 'tumblr_api' as const, declaration: 'sexuallyExplicit' as const, effect: 'platform_ineligible' as const, message: 'Not available through the API.' }];
    expect(evaluateTumblrEligibility({ sexuallyExplicit: true }, 'creator_owned', rules)).toMatchObject({ eligibility: 'platform_ineligible', allowed: false });
  });

  test('managed risk policy permits a creator-owned connector', () => {
    const rules = [{ id: 'managed-sensitive', source: 'managed_connector' as const, declaration: 'sensitiveTopic' as const, effect: 'creator_owned_required' as const, message: 'Use an isolated application.' }];
    expect(evaluateTumblrEligibility({ sensitiveTopic: true }, 'managed', rules).allowed).toBe(false);
    expect(evaluateTumblrEligibility({ sensitiveTopic: true }, 'creator_owned', rules)).toMatchObject({ eligibility: 'creator_owned_required', allowed: true });
  });

  test('renders selected image assets as versioned NPF without silently dropping media', () => {
    const post = renderTumblrNpfV1({ title: 'A Work', description: 'Description', canonicalUrl: 'https://example.com/work', mode: 'selected_assets', state: 'queue', selectedAssetIds: ['two'], includeSourceLink: true, tags: ['art', ' art ', ''], assets: [
      { id: 'one', kind: 'image', url: 'https://cdn.example/one.jpg' },
      { id: 'two', kind: 'image', url: 'https://cdn.example/two.jpg', altText: 'Alt' }
    ] });
    expect(post).toMatchObject({ state: 'queue', tags: ['art'], source_url: 'https://example.com/work' });
    expect(post.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', alt_text: 'Alt' }), expect.objectContaining({ type: 'link' })]));
    expect(post.content.filter((block) => block.type === 'image')).toHaveLength(1);
  });

  test('honors creator-selected ordering and permits announcement preview images', () => {
    const assets = [{ id: 'one', kind: 'image' as const, url: 'https://cdn.example/one.jpg' }, { id: 'two', kind: 'image' as const, url: 'https://cdn.example/two.jpg' }];
    const selected = renderTumblrNpfV1({ mode: 'selected_assets', state: 'draft', selectedAssetIds: ['two', 'one'], assets });
    expect(selected.content.filter((block) => block.type === 'image').map((block) => block.type === 'image' && block.media[0].url)).toEqual(['https://cdn.example/two.jpg', 'https://cdn.example/one.jpg']);
    const announcement = renderTumblrNpfV1({ mode: 'announcement', state: 'published', selectedAssetIds: ['one'], canonicalUrl: 'https://example.com/work', assets });
    expect(announcement.content.map((block) => block.type)).toEqual(['image', 'link']);
  });

  test('adapts only ready, supported canonical assets in attachment order', () => {
    const post = renderCanonicalWorkToTumblrV1({ work: { title: 'Work', tags: [] }, mode: 'full', state: 'draft', maxMediaBlocks: 10, assets: [
      { assetId: 'later', kind: 'image', status: 'ready', mimeType: 'image/jpeg', url: 'https://cdn.example/later.jpg', attachment: { position: 2 } },
      { assetId: 'ignored', kind: 'document', status: 'ready', mimeType: 'application/pdf', url: 'https://cdn.example/file.pdf', attachment: { position: 0 } },
      { assetId: 'first', kind: 'image', status: 'ready', mimeType: 'image/jpeg', url: 'https://cdn.example/first.jpg', attachment: { position: 1 } }
    ] });
    expect(post.content.filter((block) => block.type === 'image').map((block) => block.type === 'image' && block.media[0].url)).toEqual(['https://cdn.example/first.jpg', 'https://cdn.example/later.jpg']);
  });

  test('rejects posts over the runtime media limit', () => {
    expect(() => renderTumblrNpfV1({ mode: 'full', state: 'published', maxMediaBlocks: 1, assets: [
      { id: '1', kind: 'image', url: 'https://cdn.example/1.jpg' }, { id: '2', kind: 'image', url: 'https://cdn.example/2.jpg' }
    ] })).toThrow(TumblrValidationError);
  });

  test('binds signed OAuth state to connector context and expiry', () => {
    const state = issueTumblrOAuthState({ userId: 'user', creatorId: 'creator', connectorId: 'connector', ownership: 'creator_owned' }, 'secret', 60, 1_000);
    expect(verifyTumblrOAuthState(state, 'secret', 2_000)).toMatchObject({ creatorId: 'creator', ownership: 'creator_owned' });
    expect(() => verifyTumblrOAuthState(state, 'secret', 62_000)).toThrow('expired');
    expect(() => verifyTumblrOAuthState(`${state}x`, 'secret', 2_000)).toThrow('invalid');
  });

  test('builds an OAuth 2 authorization request with write and offline scopes', () => {
    const url = new URL(new TumblrApiClient({ clientId: 'client', clientSecret: 'secret', redirectUri: 'https://app.example/callback' }).authorizationUrl('state'));
    expect(url.origin).toBe('https://www.tumblr.com');
    expect(url.searchParams.get('scope')).toBe('basic write offline_access');
    expect(url.searchParams.get('state')).toBe('state');
  });

  test('exchanges a refresh token without exposing it in the request URL', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'next-access', refresh_token: 'next-refresh', expires_in: 3600, scope: 'basic write offline_access' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new TumblrApiClient({ clientId: 'client', clientSecret: 'secret', redirectUri: 'https://app.example/callback' });
    await expect(client.refreshAccessToken('old-refresh')).resolves.toMatchObject({ accessToken: 'next-access', refreshToken: 'next-refresh', expiresIn: 3600 });
    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain('old-refresh');
    expect(String(request?.body)).toContain('grant_type=refresh_token');
    fetchMock.mockRestore();
  });
});
