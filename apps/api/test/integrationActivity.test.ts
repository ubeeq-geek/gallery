import { integrationActivitySplit } from '../src/integrationActivity';

describe('integration activity split', () => {
  it('keeps replaceable aggregates apart from immutable historical events', () => {
    const split = integrationActivitySplit(
      [{ externalPublicationId: 'p', capturedAt: '2026-08-24T01:00:00.000Z', views: 4 }],
      [{ externalEngagementSnapshotId: 's', externalPublicationId: 'p', capturedAt: '2026-08-23T01:00:00.000Z', views: 2 }],
      [{ externalActivityId: 'e', externalAccountId: 'a', platform: 'deviantart', type: 'comment', direction: 'inbound', remoteActivityId: 'r', firstSeenAt: '2026-08-24T00:00:00.000Z', lastSeenAt: '2026-08-24T00:00:00.000Z', createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z' }]
    );
    expect(split.current[0]?.views).toBe(4);
    expect(split.history[0]?.views).toBe(2);
    expect(split.events[0]?.remoteActivityId).toBe('r');
  });
});
