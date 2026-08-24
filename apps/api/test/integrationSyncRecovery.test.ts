import { advanceIntegrationCheckpoint, integrationRecoveryDecision } from '../src/integrationSyncRecovery';

describe('shared integration sync and recovery contracts', () => {
  it('requires reconciliation before retrying an ambiguous publication', () => {
    expect(integrationRecoveryDecision({ operation: 'publish', code: 'ambiguous_submission' })).toEqual({
      disposition: 'reconcile_before_retry', requiresRemoteLookup: true
    });
  });

  it('advances a reusable checkpoint only when a page walk is complete', () => {
    const checkpoint = { platform: 'deviantart' as const, connectionId: 'connection-1', resourceType: 'catalogue', resourceId: 'account-1', recentRemoteIds: ['old'] };
    const partial = advanceIntegrationCheckpoint(checkpoint, { items: [{ remoteId: 'new', occurredAt: '2026-08-24T10:00:00Z' }], nextCursor: 'cursor-2', complete: false }, '2026-08-24T11:00:00Z');
    expect(partial).toMatchObject({ cursor: 'cursor-2', highWatermarkAt: '2026-08-24T10:00:00Z', recentRemoteIds: ['new', 'old'] });
    expect(partial.lastSuccessfulAt).toBeUndefined();
    expect(advanceIntegrationCheckpoint(partial, { items: [], complete: true }, '2026-08-24T12:00:00Z').lastSuccessfulAt).toBe('2026-08-24T12:00:00Z');
  });

  it('rejects a partial page without a recovery cursor', () => {
    const checkpoint = { platform: 'instagram' as const, connectionId: 'connection-1', resourceType: 'media', resourceId: 'account-1', recentRemoteIds: [] };
    expect(() => advanceIntegrationCheckpoint(checkpoint, { items: [], complete: false })).toThrow('continuation cursor');
  });
});
