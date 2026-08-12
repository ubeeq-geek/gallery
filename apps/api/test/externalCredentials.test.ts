import { decryptExternalCredential, encryptExternalCredential } from '../src/externalCredentials';
import { externalOAuthPkce, issueExternalOAuthState, verifyExternalOAuthState } from '../src/externalOAuth';
import { DeviantArtProvider } from '../src/externalPlatformProvider';
import type { AppConfig } from '../src/config';

const oauthConfig = {
  externalTokenEncryptionKey: 'test-oauth-encryption-key',
  unlockJwtSecret: 'test-unlock-secret'
} as AppConfig;

describe('external credentials', () => {
  it('encrypts tokens with authenticated encryption and does not retain plaintext', () => {
    const plaintext = 'deviantart-access-token';
    const encrypted = encryptExternalCredential(plaintext, 'test-encryption-key');
    expect(encrypted).not.toContain(plaintext);
    expect(decryptExternalCredential(encrypted, 'test-encryption-key')).toBe(plaintext);
    expect(() => decryptExternalCredential(encrypted, 'wrong-key')).toThrow();
  });

  it('uses a server-derived PKCE challenge for DeviantArt authorization', () => {
    const issued = issueExternalOAuthState(oauthConfig, {
      userId: 'user-1',
      externalPlatformCredentialId: 'credential-1',
      platform: 'deviantart',
      returnPath: '/studio/workspace?section=integrations'
    });
    const verified = verifyExternalOAuthState(oauthConfig, issued.state);
    const pkce = externalOAuthPkce(oauthConfig, verified.nonce);
    const provider = new DeviantArtProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://fanadmin.top:4000/integrations/deviantart/callback'
    });
    const authorizationUrl = new URL(provider.createAuthorizationUrl(issued.state, pkce));

    expect(pkce.codeVerifier).not.toContain(verified.nonce);
    expect(authorizationUrl.searchParams.get('code_challenge')).toBe(pkce.codeChallenge);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('scope')).toContain('user');
  });

  it('uses DeviantArt gallery page sizes accepted by the API', async () => {
    const provider = new DeviantArtProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://fanadmin.top:4000/integrations/deviantart/callback'
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], has_more: false }),
      headers: { get: () => null }
    } as unknown as Response);

    await provider.listContent('access-token', { username: 'creator', limit: 50 });

    const requestUrl = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(requestUrl.searchParams.get('limit')).toBe('24');
    fetchSpy.mockRestore();
  });

  it('uses extended DeviantArt metadata for imported image descriptions', async () => {
    const provider = new DeviantArtProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://fanadmin.top:4000/integrations/deviantart/callback'
    });
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ deviationid: 'deviation-1', title: 'Example' }),
        headers: { get: () => null }
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          metadata: [{
            deviationid: 'deviation-1',
            description: '<p>The full DeviantArt description</p>',
            tags: [{ tag_name: 'history' }]
          }]
        }),
        headers: { get: () => null }
      } as unknown as Response);

    const content = await provider.getContent('access-token', 'deviation-1');

    expect(content.description).toBe('<p>The full DeviantArt description</p>');
    expect(content.tags).toEqual(['history']);
    const metadataRequestUrl = new URL(String(fetchSpy.mock.calls[1][0]));
    expect(metadataRequestUrl.pathname).toContain('/deviation/metadata');
    expect(metadataRequestUrl.searchParams.get('deviationids[0]')).toBe('deviation-1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it('falls back to browse content for descriptions on legacy connections', async () => {
    const provider = new DeviantArtProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://fanadmin.top:4000/integrations/deviantart/callback'
    });
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ deviationid: 'deviation-legacy', title: 'Legacy work' }),
        headers: { get: () => null }
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ metadata: [{ deviationid: 'deviation-legacy' }] }),
        headers: { get: () => null }
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'unauthorized', error_description: 'Missing user.manage scope' }),
        headers: { get: () => null }
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ html: '<p>Legacy connection description</p>' }),
        headers: { get: () => null }
      } as unknown as Response);

    const content = await provider.getContent('access-token', 'deviation-legacy');

    expect(content.description).toBe('<p>Legacy connection description</p>');
    const fallbackUrl = new URL(String(fetchSpy.mock.calls[3][0]));
    expect(fallbackUrl.pathname).toContain('/deviation/content');
    expect(fallbackUrl.searchParams.get('for_edit')).toBeNull();
    fetchSpy.mockRestore();
  });
});
