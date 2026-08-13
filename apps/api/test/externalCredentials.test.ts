import { decryptExternalCredential, encryptExternalCredential } from '../src/externalCredentials';
import { externalOAuthPkce, issueExternalOAuthState, verifyExternalOAuthState } from '../src/externalOAuth';
import { DeviantArtProvider, parseDeviantArtPublicAiLabels } from '../src/externalPlatformProvider';
import type { AppConfig } from '../src/config';

const oauthConfig = {
  externalTokenEncryptionKey: 'test-oauth-encryption-key',
  unlockJwtSecret: 'test-unlock-secret'
} as AppConfig;

describe('external credentials', () => {
  it('reads AI labels only from the target deviation in DeviantArt public page state', () => {
    const html = String.raw`
      {\"deviationId\":999,\"isAiUseDisallowed\":false,\"isAiGenerated\":false}
      {\"deviationId\":1367834327,\"title\":\"Target\",\"isAiUseDisallowed\":true,\"isAiGenerated\":true}
      {\"deviationId\":1000,\"isAiUseDisallowed\":false,\"isAiGenerated\":false}
    `;

    expect(parseDeviantArtPublicAiLabels(
      html,
      'https://www.deviantart.com/atlas-lp/art/ALP-0003-Fish-Ladder-Flow-Monitor-1367834327'
    )).toEqual({ isAiGenerated: true, noAi: true });
    expect(parseDeviantArtPublicAiLabels(html, 'https://example.com/work-1367834327')).toEqual({});
  });

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
    expect(metadataRequestUrl.searchParams.get('ext_submission')).toBe('true');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it('falls back to target-scoped public page AI labels when OAuth reads omit them', async () => {
    const provider = new DeviantArtProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://fanadmin.top:4000/integrations/deviantart/callback'
    });
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          deviationid: 'deviation-1',
          title: 'Example',
          url: 'https://www.deviantart.com/creator/art/Example-12345'
        }),
        headers: { get: () => null }
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          metadata: [{
            deviationid: 'deviation-1',
            description: '<p>Description</p>',
            tags: [{ tag_name: 'history' }],
            is_mature: false,
            allows_comments: true
          }]
        }),
        headers: { get: () => null }
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => String.raw`
          {\"deviationId\":888,\"isAiUseDisallowed\":false,\"isAiGenerated\":false}
          {\"deviationId\":12345,\"isAiUseDisallowed\":true,\"isAiGenerated\":true}
        `,
        headers: { get: () => null }
      } as unknown as Response);

    const content = await provider.getContent('access-token', 'deviation-1');

    expect(content.rawMetadata).toMatchObject({
      is_ai_generated: true,
      noai: true,
      ubeeq_ai_labels_source: 'deviantart_public_page'
    });
    expect(String(fetchSpy.mock.calls[2][0])).toBe('https://www.deviantart.com/creator/art/Example-12345');
    fetchSpy.mockRestore();
  });

  it('keeps OAuth AI labels authoritative and skips the public page fallback', async () => {
    const provider = new DeviantArtProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://fanadmin.top:4000/integrations/deviantart/callback'
    });
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          deviationid: 'deviation-1',
          title: 'Example',
          url: 'https://www.deviantart.com/creator/art/Example-12345'
        }),
        headers: { get: () => null }
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          metadata: [{
            deviationid: 'deviation-1',
            description: '<p>Description</p>',
            tags: [{ tag_name: 'history' }],
            is_ai_generated: false,
            noai: false
          }]
        }),
        headers: { get: () => null }
      } as unknown as Response);

    const content = await provider.getContent('access-token', 'deviation-1');

    expect(content.rawMetadata).toMatchObject({ is_ai_generated: false, noai: false });
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

  it('submits editable metadata to the DeviantArt edit endpoint', async () => {
    const provider = new DeviantArtProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://fanadmin.top:4000/integrations/deviantart/callback'
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success' }),
      headers: { get: () => null }
    } as unknown as Response);

    await provider.updateContent('access-token', 'deviation-1', {
      title: 'Updated title',
      tags: ['history', 'airship'],
      allowComments: false,
      isMature: true,
      matureLevel: 'moderate',
      matureClassification: ['ideology'],
      isAiGenerated: true,
      noAi: true
    });

    expect(String(fetchSpy.mock.calls[0][0])).toContain('/deviation/edit/deviation-1');
    const request = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(request.method).toBe('POST');
    expect(request.headers).toMatchObject({ Authorization: 'Bearer access-token' });
    const body = new URLSearchParams(String(request.body));
    expect(body.get('title')).toBe('Updated title');
    expect(body.has('description')).toBe(false);
    expect(body.getAll('tags[]')).toEqual(['history', 'airship']);
    expect(body.get('allow_comments')).toBe('false');
    expect(body.get('is_mature')).toBe('true');
    expect(body.get('mature_level')).toBe('moderate');
    expect(body.getAll('mature_classification[]')).toEqual(['ideology']);
    expect(body.get('is_ai_generated')).toBe('true');
    expect(body.get('noai')).toBe('true');
    fetchSpy.mockRestore();
  });

  it('falls back to retained Sta.sh metadata for AI labels when deviation/edit falsely reports not found', async () => {
    const provider = new DeviantArtProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://fanadmin.top:4000/integrations/deviantart/callback'
    });
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_request', error_description: 'Deviation not found.' }),
        headers: { get: () => null }
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', itemid: 123456 }),
        headers: { get: () => null }
      } as unknown as Response);

    await provider.updateContent('access-token', 'deviation-1', {
      isAiGenerated: true,
      noAi: true
    }, { externalDraftId: '123456' });

    expect(String(fetchSpy.mock.calls[0][0])).toContain('/deviation/edit/deviation-1');
    expect(String(fetchSpy.mock.calls[1][0])).toContain('/stash/submit');
    const body = fetchSpy.mock.calls[1][1]?.body as FormData;
    expect(body.get('itemid')).toBe('123456');
    expect(body.get('is_ai_generated')).toBe('true');
    expect(body.get('noai')).toBe('true');
    expect(body.has('file')).toBe(false);
    fetchSpy.mockRestore();
  });

  it('rejects published DeviantArt description updates before making a request', async () => {
    const provider = new DeviantArtProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://fanadmin.top:4000/integrations/deviantart/callback'
    });
    const fetchSpy = jest.spyOn(global, 'fetch');

    await expect(provider.updateContent('access-token', 'deviation-1', {
      description: '<p>Updated description</p>'
    })).rejects.toMatchObject({
      code: 'unsupported'
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('uses a retained Sta.sh item for a published description update', async () => {
    const provider = new DeviantArtProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://fanadmin.top:4000/integrations/deviantart/callback'
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', itemid: 123456 }),
      headers: { get: () => null }
    } as unknown as Response);

    await provider.updateContent('access-token', 'deviation-1', {
      description: '<p>Updated description</p>'
    }, {
      externalDraftId: '123456',
      publishedDescriptionUpdate: true
    });

    expect(String(fetchSpy.mock.calls[0][0])).toContain('/stash/submit');
    const request = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(request.method).toBe('POST');
    expect(request.headers).toMatchObject({ Authorization: 'Bearer access-token' });
    const body = request.body as FormData;
    expect(body.get('itemid')).toBe('123456');
    expect(body.get('artist_comments')).toBe('<p>Updated description</p>');
    expect(body.has('file')).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('retains the Sta.sh item ID returned during initial publishing', async () => {
    const provider = new DeviantArtProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://fanadmin.top:4000/integrations/deviantart/callback'
    });
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', itemid: 123456 }),
        headers: { get: () => null }
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'success', deviationid: 'deviation-1', url: 'https://www.deviantart.com/example/art/test-1' }),
        headers: { get: () => null }
      } as unknown as Response);

    const published = await provider.publishContent('access-token', {
      body: Buffer.from('image'),
      filename: 'test.jpg',
      contentType: 'image/jpeg',
      title: 'Test work',
      description: '<p>Initial description</p>'
    });

    expect(published.externalContentId).toBe('deviation-1');
    expect(published.externalDraftId).toBe('123456');
    expect(published.rawMetadata.stash_itemid).toBe('123456');
    const submitBody = fetchSpy.mock.calls[0][1]?.body as FormData;
    expect(submitBody.get('artist_comments')).toBe('<p>Initial description</p>');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it('can stop after Sta.sh submission for a DeviantArt draft', async () => {
    const provider = new DeviantArtProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://fanadmin.top:4000/integrations/deviantart/callback'
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'success', itemid: 654321 }),
      headers: { get: () => null }
    } as unknown as Response);

    const draft = await provider.submitContent('access-token', {
      body: Buffer.from('image'),
      filename: 'draft.jpg',
      contentType: 'image/jpeg',
      title: 'Draft work',
      description: '<p>Draft description</p>',
      isAiGenerated: true,
      noAi: true
    });

    expect(draft.externalDraftId).toBe('654321');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/stash/submit');
    const body = fetchSpy.mock.calls[0][1]?.body as FormData;
    expect(body.get('file')).toBeInstanceOf(Blob);
    expect(body.get('is_ai_generated')).toBe('true');
    expect(body.get('noai')).toBe('true');
    fetchSpy.mockRestore();
  });
});
