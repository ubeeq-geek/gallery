import { evaluateTumblrEligibility, issueTumblrOAuthState, renderTumblrNpfV1, TumblrApiClient, TumblrValidationError, verifyTumblrOAuthState } from '../src/tumblrIntegration';

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
});
