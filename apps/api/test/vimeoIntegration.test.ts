import { createHmac } from 'crypto';
import { createVimeoPublication, MemoryVimeoRepository, publicVimeoConnection, verifyVimeoWebhook, vimeoEligibility, vimeoPreflight, VIMEO_REFERENCE_NOTICE, type VimeoConnection } from '../src/vimeoIntegration';
import type { CanonicalAsset, Work } from '../src/canonicalDomain';

describe('Vimeo integration safety invariants', () => {
  test('publication creation is idempotent for work/account/intent', async () => {
    const repository = new MemoryVimeoRepository();
    const input = {
      ownerId: 'creator-1', connectionId: 'connection-1', workId: 'work-1',
      sourceAssetId: 'asset-1', sourceHash: 'sha256', intentVersion: 'revision-3',
      privacy: 'nobody' as const, embedDomains: ['eversally.com'], downloadsAllowed: false
    };
    const first = await createVimeoPublication(repository, input);
    const replay = await createVimeoPublication(repository, input);
    expect(replay.id).toBe(first.id);
    expect(first.state).toBe('DRAFT');
  });

  test('managed policy rejects adult output and honors safety holds', () => {
    expect(vimeoEligibility('adult').result).toBe('DESTINATION_POLICY_DENIED');
    expect(vimeoEligibility('general', true).result).toBe('SAFETY_HOLD');
    expect(VIMEO_REFERENCE_NOTICE).toContain('does not hold the original video');
  });

  test('preflight requires a ready, hosted, checksummed canonical video', () => {
    const work = { status: 'ready', contentRating: 'general' } as Work;
    const asset = { kind: 'video', status: 'ready', mimeType: 'video/mp4', sizeBytes: 10, checksumSha256: 'hash', storage: { mode: 'hosted', objectKey: 'canonical/video.mp4' } } as CanonicalAsset;
    const connection = { state: 'CONNECTED', mode: 'EVERSALLY_MANAGED', capabilities: ['video_publish'] } as VimeoConnection;
    expect(vimeoPreflight(work, asset, connection)).toMatchObject({ allowed: true, errors: [] });
    expect(vimeoPreflight(work, { ...asset, storage: { mode: 'external', externalUrl: 'https://vimeo.test/video' } }, connection)).toMatchObject({ allowed: false, errors: ['CANONICAL_SOURCE_REQUIRED'] });
  });

  test('webhooks require a current valid signature', () => {
    const body = Buffer.from('{"event_id":"evt-1"}');
    const timestamp = '1700000000';
    const signature = createHmac('sha256', 'secret').update(`${timestamp}.${body.toString()}`).digest('hex');
    expect(verifyVimeoWebhook(body, `sha256=${signature}`, 'secret', timestamp, 1_700_000_000_000)).toBe(true);
    expect(verifyVimeoWebhook(body, `sha256=${signature}`, 'secret', timestamp, 1_700_001_000_000)).toBe(false);
    expect(verifyVimeoWebhook(Buffer.from('tampered'), `sha256=${signature}`, 'secret', timestamp, 1_700_000_000_000)).toBe(false);
  });

  test('creator-owned application and account credentials are redacted', () => {
    const connection = {
      id: 'connection', ownerId: 'creator', mode: 'CREATOR_OWNED', applicationClientId: 'public-client-id',
      applicationCredentialRef: 'encrypted-app-secret', credentialRef: 'encrypted-oauth-token', capabilities: [],
      state: 'CONNECTED', createdAt: 'now', updatedAt: 'now'
    } as VimeoConnection;
    expect(publicVimeoConnection(connection)).toEqual(expect.objectContaining({ applicationClientId: 'public-client-id', mode: 'CREATOR_OWNED' }));
    expect(JSON.stringify(publicVimeoConnection(connection))).not.toContain('encrypted');
  });

  test('OAuth attempts are single-use and expire', async () => {
    const repository = new MemoryVimeoRepository();
    await repository.rememberOAuth('valid', { ownerId: 'creator', connectionId: 'connection', expiresAt: Date.now() + 1000 });
    expect(await repository.consumeOAuth('valid')).toMatchObject({ connectionId: 'connection' });
    expect(await repository.consumeOAuth('valid')).toBeUndefined();
    await repository.rememberOAuth('expired', { ownerId: 'creator', connectionId: 'connection', expiresAt: Date.now() - 1 });
    expect(await repository.consumeOAuth('expired')).toBeUndefined();
  });
});
