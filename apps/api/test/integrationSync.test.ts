import { recordExternalPublicationLifecycle, recordRemotePublicationState, schedulePublicationRetry } from '../src/integrationSync';
import type { Publication } from '../src/canonicalDomain';

const publication: Publication = {
  publicationId: 'publication', tenantId: 'tenant', creatorId: 'creator', workId: 'work', destination: 'instagram', status: 'live', visibility: 'public',
  sync: { status: 'in_sync' }, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z'
};

describe('shared integration synchronization contract', () => {
  it('preserves cursors and explicitly distinguishes missing from restricted remote state', () => {
    const missing = recordRemotePublicationState(publication, 'missing', { cursor: 'after-1', reason: 'Removed remotely' });
    expect(missing).toMatchObject({ status: 'missing', sync: { remoteState: 'missing', remoteCursor: 'after-1', errorCode: 'REMOTE_MISSING' } });
    const restricted = recordRemotePublicationState(publication, 'restricted', { reason: 'Audience restricted' });
    expect(restricted).toMatchObject({ status: 'unknown', sync: { remoteState: 'restricted', errorCode: 'REMOTE_RESTRICTED' } });
  });

  it('retains one idempotency key while incrementing retry attempts and recording account cooldown', () => {
    const first = schedulePublicationRetry(publication, { idempotencyKey: 'key-1', accountCooldownUntil: '2026-08-24T02:00:00.000Z' });
    const retry = schedulePublicationRetry(first, { idempotencyKey: 'different-key' });
    expect(retry.sync.retry).toEqual(expect.objectContaining({ idempotencyKey: 'key-1', attempt: 2, accountCooldownUntil: '2026-08-24T02:00:00.000Z' }));
  });

  it('uses the same lifecycle vocabulary for a DeviantArt-style external publication', () => {
    const external = recordExternalPublicationLifecycle({ externalPublicationId: 'external', assetId: 'asset', externalAccountId: 'account', platform: 'deviantart', externalContentId: 'remote', syncStatus: 'active', rawMetadataJson: {}, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z' }, 'restricted', { reason: 'Subscriber-only' });
    expect(external).toMatchObject({ syncStatus: 'restricted', remoteStateReason: 'Subscriber-only' });
  });
});
