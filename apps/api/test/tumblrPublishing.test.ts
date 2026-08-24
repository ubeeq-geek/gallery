import type { AppConfig } from '../src/config';
import { decryptTumblrOAuthGrant, encryptTumblrOAuthGrant, InMemoryTumblrRepository } from '../src/tumblrRepository';
import { processTumblrPublication } from '../src/tumblrPublishing';

const config: AppConfig = { tenantId: 'test', awsRegion: 'ca-central-1', creators: '', groupingsTable: '', imagesTable: '', commentsTable: '', favoritesTable: '', blockedUsersTable: '', siteSettingsTable: '', contentStatsTable: '', trendingFeedTable: '', contentCoreTable: '', useContentCoreTable: false, mediaBucket: '', unlockJwtSecret: '', unlockTokenTtlSeconds: 1, rememberGroupingAccessTtlSeconds: 1, signedUrlTtlSeconds: 1, trendingFeedMaxItems: 1, trendingCandidateLimit: 1, externalSyncBaseDelaySeconds: 1, deviantArtMinimumRequestIntervalMs: 0, youtubeMinimumRequestIntervalMs: 0, youtubeApiBaseUrl: 'https://www.googleapis.com/youtube/v3', externalScheduledScansEnabled: false, externalAccountScanIntervalSeconds: 1, externalActivityScanIntervalSeconds: 1, deviantArtPublishedDescriptionUpdate: false, externalContentMaxBytes: 1, externalTokenEncryptionKey: 'key', discordApiBaseUrl: '', tumblrClientId: 'client', tumblrClientSecret: 'secret', tumblrOAuthRedirectUri: 'https://app.example/callback', tumblrApiBaseUrl: 'https://api.example', tumblrMediaBlockLimit: 10, tumblrHourlyRequestLimit: 1000, tumblrDailyRequestLimit: 5000, tumblrPublishMaxAttempts: 5, tumblrRetryBaseDelaySeconds: 1 };

describe('Tumblr publishing worker', () => {
  afterEach(() => jest.restoreAllMocks());
  test('delivers a durable NPF snapshot and persists the Tumblr post identity', async () => {
    const repository = new InMemoryTumblrRepository();
    await repository.putConnector({ id: 'connector', tenantId: 'test', userId: 'user', creatorId: 'creator', ownership: 'managed', authProtocol: 'oauth2', status: 'connected', credentialsEncrypted: encryptTumblrOAuthGrant({ accessToken: 'token', scopes: ['write'] }, 'key') });
    await repository.putDestination({ id: 'blog', tenantId: 'test', connectorId: 'connector', creatorId: 'creator', identifier: 'creator-blog', enabled: true });
    await repository.putPublication({ id: 'publication', tenantId: 'test', creatorId: 'creator', workId: 'work', connectorId: 'connector', destinationId: 'blog', mode: 'full', status: 'pending', requestSnapshot: { declarations: {}, npf: { content: [{ type: 'text', text: 'Work' }], layout: [], state: 'published', tags: [] } }, updatedAt: new Date().toISOString() });
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ response: { id_string: '123', post_url: 'https://creator-blog.tumblr.com/post/123' } }), { status: 201, headers: { 'content-type': 'application/json' } }));
    await processTumblrPublication(repository, config, 'publication');
    expect(await repository.getPublication('test', 'publication')).toMatchObject({ status: 'published', tumblrPostId: '123', tumblrPostUrl: 'https://creator-blog.tumblr.com/post/123' });
  });

  test('re-evaluates policy in the worker and blocks a now-ineligible snapshot', async () => {
    const repository = new InMemoryTumblrRepository();
    await repository.putConnector({ id: 'connector', tenantId: 'test', userId: 'user', creatorId: 'creator', ownership: 'creator_owned', authProtocol: 'oauth2', status: 'connected', credentialsEncrypted: {} });
    await repository.putDestination({ id: 'blog', tenantId: 'test', connectorId: 'connector', creatorId: 'creator', identifier: 'creator-blog', enabled: true });
    await repository.putPublication({ id: 'publication', tenantId: 'test', creatorId: 'creator', workId: 'work', connectorId: 'connector', destinationId: 'blog', mode: 'full', status: 'pending', requestSnapshot: { declarations: { nudity: true }, npf: { content: [{ type: 'text', text: 'Work' }], layout: [], state: 'published', tags: [] } }, updatedAt: new Date().toISOString() });
    await processTumblrPublication(repository, { ...config, tumblrPolicyRulesJson: JSON.stringify([{ id: 'api-rule', source: 'tumblr_api', declaration: 'nudity', effect: 'platform_ineligible', message: 'API unavailable' }]) }, 'publication');
    expect(await repository.getPublication('test', 'publication')).toMatchObject({ status: 'failed', responseSnapshot: { errorType: 'policy' } });
  });

  test('schedules transient rate-limit failures with provider retry timing', async () => {
    const repository = new InMemoryTumblrRepository();
    await repository.putConnector({ id: 'connector', tenantId: 'test', userId: 'user', creatorId: 'creator', ownership: 'managed', authProtocol: 'oauth2', status: 'connected', credentialsEncrypted: encryptTumblrOAuthGrant({ accessToken: 'token', scopes: ['write'] }, 'key') });
    await repository.putDestination({ id: 'blog', tenantId: 'test', connectorId: 'connector', creatorId: 'creator', identifier: 'creator-blog', enabled: true });
    await repository.putPublication({ id: 'publication', tenantId: 'test', creatorId: 'creator', workId: 'work', connectorId: 'connector', destinationId: 'blog', mode: 'full', status: 'pending', requestSnapshot: { declarations: {}, npf: { content: [{ type: 'text', text: 'Work' }], layout: [], state: 'published', tags: [] } }, updatedAt: new Date().toISOString() });
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ meta: { msg: 'Slow down' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' } }));
    const retries: Array<{ id: string; delay?: number }> = [];
    await processTumblrPublication(repository, config, 'publication', { async enqueue(id, delay) { retries.push({ id, delay }); } });
    expect(retries).toEqual([{ id: 'publication', delay: 120 }]);
    expect(await repository.getPublication('test', 'publication')).toMatchObject({ status: 'pending', requestSnapshot: { deliveryAttempt: 1 }, responseSnapshot: { errorType: 'rate_limit', retryable: true } });
  });

  test('refreshes an expired OAuth grant before publishing and persists rotated tokens', async () => {
    const repository = new InMemoryTumblrRepository();
    await repository.putConnector({ id: 'connector', tenantId: 'test', userId: 'user', creatorId: 'creator', ownership: 'managed', authProtocol: 'oauth2', status: 'connected', credentialsEncrypted: encryptTumblrOAuthGrant({ accessToken: 'expired', refreshToken: 'refresh', expiresAt: '2000-01-01T00:00:00.000Z', scopes: ['write', 'offline_access'] }, 'key') });
    await repository.putDestination({ id: 'blog', tenantId: 'test', connectorId: 'connector', creatorId: 'creator', identifier: 'creator-blog', enabled: true });
    await repository.putPublication({ id: 'publication', tenantId: 'test', creatorId: 'creator', workId: 'work', connectorId: 'connector', destinationId: 'blog', mode: 'full', status: 'pending', requestSnapshot: { declarations: {}, npf: { content: [{ type: 'text', text: 'Work' }], layout: [], state: 'published', tags: [] } }, updatedAt: new Date().toISOString() });
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'next-access', refresh_token: 'next-refresh', expires_in: 3600, scope: 'write offline_access' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: { id_string: '456' } }), { status: 201, headers: { 'content-type': 'application/json' } }));
    await processTumblrPublication(repository, config, 'publication');
    expect(await repository.getPublication('test', 'publication')).toMatchObject({ status: 'published', tumblrPostId: '456' });
    expect(decryptTumblrOAuthGrant((await repository.getConnector('test', 'connector'))!, 'key')).toMatchObject({ accessToken: 'next-access', refreshToken: 'next-refresh' });
  });
});
