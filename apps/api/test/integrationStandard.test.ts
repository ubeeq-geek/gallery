import {
  UnsupportedIntegrationOperationError,
  requireIntegrationOperation,
  requireIntegrationPolicy,
  supportsIntegrationOperation,
  type IntegrationPolicyGate
} from '../src/integrationStandard';
import { createStoreIntegrationPolicyGate } from '../src/integrationStandard';
import { InMemoryStore } from '../src/inMemoryStore';
import { processDiscordDelivery, queueDiscordWorkPublished } from '../src/discordCommunity';
import type { AppConfig } from '../src/config';
import { createAnnouncementPublication } from '../src/announcementPublication';

describe('integration standard', () => {
  it('declares provider operations instead of relying on unsupported stubs', () => {
    expect(supportsIntegrationOperation('youtube', 'import')).toBe(true);
    expect(supportsIntegrationOperation('youtube', 'publish')).toBe(false);
    expect(() => requireIntegrationOperation('youtube', 'publish')).toThrow(UnsupportedIntegrationOperationError);
    expect(supportsIntegrationOperation('deviantart', 'publish')).toBe(true);
    expect(supportsIntegrationOperation('soundcloud', 'publish')).toBe(true);
    expect(supportsIntegrationOperation('discord', 'publish')).toBe(true);
    expect(supportsIntegrationOperation('discord', 'import')).toBe(false);
    expect(supportsIntegrationOperation('bluesky', 'publish')).toBe(true);
    expect(supportsIntegrationOperation('ghost', 'reconcile')).toBe(true);
    expect(supportsIntegrationOperation('smugmug', 'migrate_source')).toBe(true);
    expect(supportsIntegrationOperation('vimeo', 'publish')).toBe(true);
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

  it('publishes the unified announcement snapshot through the isolated Bluesky broker', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    await store.createExternalAccount({
      externalAccountId: 'bluesky-account', userId: 'user-1', creatorIdentityId: 'creator-1', primaryCreatorIdentityId: 'creator-1',
      externalPlatformCredentialId: 'bluesky-oauth-service', platform: 'bluesky', externalUserId: 'did:plc:test', externalUsername: 'creator.test',
      accessTokenEncrypted: 'broker-held', connectionStatus: 'connected', createdAt: now, updatedAt: now
    });
    await store.createCommunityEvent({ communityEventId: 'event', tenantId: 'test', userId: 'user-1', creatorIdentityId: 'creator-1', workId: 'work-1', type: 'work_published', idempotencyKey: 'release-1', payload: {}, createdAt: now });
    await store.upsertCommunityDelivery({
      communityDeliveryId: 'delivery', tenantId: 'test', userId: 'user-1', creatorIdentityId: 'creator-1', communityEventId: 'event',
      communityDestinationId: 'bluesky-account', provider: 'bluesky', status: 'queued', attemptCount: 0, createdAt: now, updatedAt: now,
      announcementPublication: createAnnouncementPublication({ provider: 'bluesky', connectionId: 'bluesky-account', targetId: 'did:plc:test', workId: 'work-1', idempotencyKey: 'release-1:bluesky-account', content: { version: 1, title: 'New Work', url: 'https://example.test/work', capturedAt: now } })
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ uri: 'at://did:plc:test/app.bsky.feed.post/key', cid: 'cid' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await processDiscordDelivery(store, { tenantId: 'test', blueskyOAuthServiceUrl: 'https://oauth.example.test', blueskyOAuthInternalSecret: 'secret' } as AppConfig, 'delivery', jest.fn(async () => undefined));
    expect(await store.getCommunityDelivery('delivery')).toMatchObject({ status: 'sent', remoteMessageId: 'at://did:plc:test/app.bsky.feed.post/key', announcementPublication: { provider: 'bluesky', status: 'sent' } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('requires an explicit Bluesky announcement target and stores a portable snapshot', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    await store.createExternalAccount({
      externalAccountId: 'bluesky-opt-in', userId: 'user-1', creatorIdentityId: 'creator-1', primaryCreatorIdentityId: 'creator-1',
      externalPlatformCredentialId: 'broker', platform: 'bluesky', externalUserId: 'did:plc:optin', externalUsername: 'optin.test',
      accessTokenEncrypted: 'broker-held', connectionStatus: 'connected', createdAt: now, updatedAt: now
    });
    const config = { tenantId: 'test', blueskyOAuthServiceUrl: 'https://oauth.example.test', blueskyOAuthInternalSecret: 'secret' } as AppConfig;
    const enqueue = jest.fn(async () => undefined);
    const input = { userId: 'user-1', creatorIdentityId: 'creator-1', workId: 'work-1', title: 'Work', url: 'https://example.test/work', creatorName: 'Creator', idempotencyKey: 'announcement-1' };

    await queueDiscordWorkPublished(store, config, input, enqueue);
    expect(enqueue).not.toHaveBeenCalled();

    await queueDiscordWorkPublished(store, config, { ...input, providers: ['bluesky'] }, enqueue);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await store.listCommunityDeliveriesByCreator('creator-1')).toEqual([
      expect.objectContaining({ provider: 'bluesky', announcementPublication: expect.objectContaining({ provider: 'bluesky', content: expect.objectContaining({ title: 'Work' }) }) })
    ]);
  });
});
