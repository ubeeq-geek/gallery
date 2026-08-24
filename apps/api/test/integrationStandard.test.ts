import {
  UnsupportedIntegrationOperationError,
  requireIntegrationOperation,
  requireIntegrationPolicy,
  supportsIntegrationOperation,
  type IntegrationPolicyGate
} from '../src/integrationStandard';
import { createStoreIntegrationPolicyGate } from '../src/integrationStandard';
import { InMemoryStore } from '../src/inMemoryStore';
import { processDiscordDelivery } from '../src/discordCommunity';
import type { AppConfig } from '../src/config';

describe('integration standard', () => {
  it('declares provider operations instead of relying on unsupported stubs', () => {
    expect(supportsIntegrationOperation('youtube', 'import')).toBe(true);
    expect(supportsIntegrationOperation('youtube', 'publish')).toBe(false);
    expect(() => requireIntegrationOperation('youtube', 'publish')).toThrow(UnsupportedIntegrationOperationError);
    expect(supportsIntegrationOperation('deviantart', 'publish')).toBe(true);
    expect(supportsIntegrationOperation('discord', 'publish')).toBe(true);
    expect(supportsIntegrationOperation('discord', 'import')).toBe(false);
  });

  it('allows a policy gate to block both queued and just-in-time remote work', async () => {
    const gate: IntegrationPolicyGate = {
      evaluate: async ({ operation, targets }) => ({
        allowed: operation !== 'publish' || !targets.some((target) => target.type === 'publication' && target.id === 'held-publication'),
        reason: 'Publication is under review.',
        activeHoldTypes: ['CONTENT_REVIEW_HOLD']
      })
    };

    await expect(requireIntegrationPolicy(gate, 'publish', [{ type: 'publication', id: 'held-publication' }]))
      .rejects.toThrow('Publication is under review.');
    await expect(requireIntegrationPolicy(gate, 'publish', [{ type: 'publication', id: 'clear-publication' }]))
      .resolves.toBeUndefined();
  });

  it('projects active support holds onto integration targets', async () => {
    const store = new InMemoryStore();
    await store.upsertIntegrationReviewHold({
      integrationReviewHoldId: 'hold-1', targetType: 'publication', targetId: 'publication-1',
      holdType: 'CONTENT_REVIEW_HOLD', reason: 'Awaiting safety review.', active: true, createdAt: '2026-08-23T00:00:00.000Z'
    });
    const decision = await createStoreIntegrationPolicyGate(store).evaluate({
      operation: 'publish', targets: [{ type: 'publication', id: 'publication-1' }]
    });
    expect(decision).toEqual({ allowed: false, reason: 'Integration is blocked by active hold: Awaiting safety review.', activeHoldTypes: ['CONTENT_REVIEW_HOLD'] });
  });

  it('blocks a Discord delivery before contacting Discord when its destination is held', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    await store.upsertCommunityDestination({
      communityDestinationId: 'discord-destination', userId: 'user-1', creatorIdentityId: 'creator-1', provider: 'discord',
      communityInstallationId: 'discord-installation', remoteChannelId: 'channel-1', displayName: 'Announcements', status: 'active',
      eventTypes: ['work_published'], createdAt: now, updatedAt: now
    });
    await store.createCommunityEvent({
      communityEventId: 'discord-event', tenantId: 'test', userId: 'user-1', creatorIdentityId: 'creator-1', workId: 'work-1',
      type: 'work_published', idempotencyKey: 'discord-event-key', payload: { title: 'Held work' }, createdAt: now
    });
    await store.upsertCommunityDelivery({
      communityDeliveryId: 'discord-delivery', tenantId: 'test', userId: 'user-1', creatorIdentityId: 'creator-1',
      communityEventId: 'discord-event', communityDestinationId: 'discord-destination', provider: 'discord', status: 'queued',
      attemptCount: 0, createdAt: now, updatedAt: now
    });
    await store.upsertIntegrationReviewHold({
      integrationReviewHoldId: 'discord-hold', targetType: 'integration_connection', targetId: 'discord-destination',
      holdType: 'MANUAL_REVIEW', reason: 'Announcement awaiting review.', active: true, createdAt: now
    });
    const fetchSpy = jest.spyOn(global, 'fetch');

    await processDiscordDelivery(store, {} as AppConfig, 'discord-delivery', jest.fn(async () => undefined));

    expect(await store.getCommunityDelivery('discord-delivery')).toMatchObject({
      status: 'failed', errorCode: 'SAFETY_HOLD', errorMessage: expect.stringContaining('Announcement awaiting review.')
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});
