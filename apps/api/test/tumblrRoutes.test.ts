import request from 'supertest';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { InMemoryStore } from '../src/inMemoryStore';
import { encryptTumblrOAuthGrant, InMemoryTumblrRepository } from '../src/tumblrRepository';

const config = (): AppConfig => ({
  tenantId: 'test', awsRegion: 'ca-central-1', creators: 'creators', groupingsTable: 'groupings', imagesTable: 'images', commentsTable: 'comments', favoritesTable: 'favorites', blockedUsersTable: 'blocked', siteSettingsTable: 'settings', contentStatsTable: 'stats', trendingFeedTable: 'trending', contentCoreTable: 'core', useContentCoreTable: false, mediaBucket: 'media', unlockJwtSecret: 'unlock', unlockTokenTtlSeconds: 3600, rememberGroupingAccessTtlSeconds: 3600, signedUrlTtlSeconds: 300, trendingFeedMaxItems: 100, trendingCandidateLimit: 100, externalSyncBaseDelaySeconds: 60, deviantArtMinimumRequestIntervalMs: 0, externalAccountScanIntervalSeconds: 100, externalActivityScanIntervalSeconds: 100, deviantArtPublishedDescriptionUpdate: false, externalContentMaxBytes: 1_000_000, externalTokenEncryptionKey: 'encryption-key', discordApiBaseUrl: 'https://discord.com/api/v10', tumblrClientId: 'managed-client', tumblrClientSecret: 'managed-secret', tumblrOAuthRedirectUri: 'https://api.example/integrations/tumblr/callback', tumblrApiBaseUrl: 'https://api.tumblr.com', tumblrMediaBlockLimit: 10, tumblrHourlyRequestLimit: 1000, tumblrDailyRequestLimit: 5000, tumblrPublishMaxAttempts: 5, tumblrRetryBaseDelaySeconds: 60
});

describe('Tumblr connector API', () => {
  test('creates, lists, authorizes, and disconnects a managed connector without exposing secrets', async () => {
    const store = new InMemoryStore();
    const repository = new InMemoryTumblrRepository();
    const now = new Date().toISOString();
    store.creators.push({ creatorId: 'creator', name: 'Creator', slug: 'creator', status: 'active', sortOrder: 0, createdAt: now });
    store.creatorMembers.push({ creatorId: 'creator', userId: 'owner', role: 'owner', createdAt: now });
    const app = createApp({ config: config(), store, tumblrRepository: repository });
    const headers = { 'x-user-id': 'owner' };

    const created = await request(app).post('/studio/integrations/tumblr').set(headers).send({ creatorId: 'creator', ownership: 'managed' }).expect(201);
    expect(created.body).toMatchObject({ creatorId: 'creator', ownership: 'managed', hasOAuthGrant: false });
    expect(JSON.stringify(created.body)).not.toContain('credentialsEncrypted');

    const listed = await request(app).get('/studio/integrations/tumblr?creatorId=creator').set(headers).expect(200);
    expect(listed.body).toHaveLength(1);
    const oauth = await request(app).post(`/studio/integrations/tumblr/${created.body.id}/oauth/start`).set(headers).expect(200);
    const authorizationUrl = new URL(oauth.body.authorizationUrl);
    expect(authorizationUrl.searchParams.get('client_id')).toBe('managed-client');
    expect(authorizationUrl.searchParams.get('state')).toBeTruthy();

    await repository.putConnector({ ...repository.connectors[0], status: 'connected', credentialsEncrypted: encryptTumblrOAuthGrant({ accessToken: 'access', refreshToken: 'refresh', scopes: ['basic', 'write', 'offline_access'] }, 'encryption-key'), scopes: ['basic', 'write', 'offline_access'] });
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: { user: { name: 'creator', uuid: 'user-id', blogs: [{ name: 'creator-blog' }] } } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'next-access', refresh_token: 'next-refresh', expires_in: 3600, scope: 'basic write offline_access' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await request(app).post(`/studio/integrations/tumblr/${created.body.id}/test`).set(headers).expect(200).expect(({ body }) => expect(body).toMatchObject({ connected: true, tumblrUserName: 'creator', blogCount: 1 }));
    await request(app).post(`/studio/integrations/tumblr/${created.body.id}/refresh`).set(headers).expect(200).expect(({ body }) => expect(body).toMatchObject({ status: 'connected', hasOAuthGrant: true }));

    await repository.putDestination({ id: 'blog', tenantId: 'test', connectorId: created.body.id, creatorId: 'creator', identifier: 'creator-blog', enabled: false });
    const blog = await request(app).patch(`/studio/integrations/tumblr/${created.body.id}/blogs/blog`).set(headers).send({ enabled: true, defaults: { publicationMode: 'announcement', postState: 'queue', appendDefaultTags: ['art'] } }).expect(200);
    expect(blog.body).toMatchObject({ enabled: true, defaults: { publicationMode: 'announcement', postState: 'queue', appendDefaultTags: ['art'] } });

    await request(app).delete(`/studio/integrations/tumblr/${created.body.id}`).set(headers).expect(204);
    expect(await repository.getConnector('test', created.body.id)).toMatchObject({ status: 'revoked', credentialsEncrypted: {}, scopes: [], disconnectedAt: expect.any(String) });
    expect(await repository.getDestination('test', 'blog')).toMatchObject({ enabled: false });
  });

  test('encrypts BYOI secrets and rejects access from another user', async () => {
    const store = new InMemoryStore();
    const repository = new InMemoryTumblrRepository();
    const now = new Date().toISOString();
    store.creators.push({ creatorId: 'creator', name: 'Creator', slug: 'creator', status: 'active', sortOrder: 0, createdAt: now });
    store.creatorMembers.push({ creatorId: 'creator', userId: 'owner', role: 'owner', createdAt: now });
    const app = createApp({ config: config(), store, tumblrRepository: repository });
    const created = await request(app).post('/studio/integrations/tumblr').set('x-user-id', 'owner').send({ creatorId: 'creator', ownership: 'creator_owned', clientId: 'own-client', clientSecret: 'own-secret', redirectUri: 'https://api.example/integrations/tumblr/callback' }).expect(201);
    expect(JSON.stringify(repository.connectors[0])).not.toContain('own-secret');
    await request(app).post(`/studio/integrations/tumblr/${created.body.id}/oauth/start`).set('x-user-id', 'intruder').expect(404);
  });

  test('previews a canonical Work with destination defaults and server-owned eligibility', async () => {
    const store = new InMemoryStore();
    const repository = new InMemoryTumblrRepository();
    const now = new Date().toISOString();
    store.creators.push({ creatorId: 'creator', name: 'Creator', slug: 'creator', status: 'active', sortOrder: 0, createdAt: now });
    store.creatorMembers.push({ creatorId: 'creator', userId: 'owner', role: 'owner', createdAt: now });
    store.works.push({ workId: 'work', tenantId: 'test', creatorId: 'creator', kind: 'image', title: 'Canonical title', slug: 'work', slugHistory: [], description: 'Canonical description', tags: ['canonical'], contentRating: 'general', aiDisclosure: 'none', heavyTopics: [], status: 'ready', origin: { type: 'local' }, revision: 1, createdAt: now, updatedAt: now });
    store.canonicalAssets.push({ assetId: 'asset', tenantId: 'test', creatorId: 'creator', kind: 'image', status: 'ready', mimeType: 'image/jpeg', storage: { mode: 'external', externalUrl: 'https://cdn.example/work.jpg' }, createdAt: now, updatedAt: now });
    store.canonicalAssets.push({ assetId: 'asset-two', tenantId: 'test', creatorId: 'creator', kind: 'image', status: 'ready', mimeType: 'image/jpeg', storage: { mode: 'external', externalUrl: 'https://cdn.example/work-two.jpg' }, createdAt: now, updatedAt: now });
    store.workAssets.push({ tenantId: 'test', workId: 'work', assetId: 'asset', role: 'primary', position: 0, altText: 'Canonical alt' });
    store.workAssets.push({ tenantId: 'test', workId: 'work', assetId: 'asset-two', role: 'content', position: 1, altText: 'Second alt' });
    await repository.putConnector({ id: 'connector', tenantId: 'test', userId: 'owner', creatorId: 'creator', ownership: 'managed', authProtocol: 'oauth2', status: 'connected', credentialsEncrypted: {}, scopes: [] });
    await repository.putDestination({ id: 'blog', tenantId: 'test', connectorId: 'connector', creatorId: 'creator', identifier: 'creator-blog', enabled: true, defaults: { publicationMode: 'full', postState: 'queue', includeWorkTitle: true, includeDescription: true, includeTags: true } });
    const enqueued: string[] = [];
    const app = createApp({ config: config(), store, tumblrRepository: repository, tumblrPublishQueue: { async enqueue(id) { enqueued.push(id); } } });
    const preview = await request(app).post('/studio/works/work/preview/tumblr').set('x-user-id', 'owner').send({ connectorId: 'connector', destinationId: 'blog' }).expect(200);
    expect(preview.body).toMatchObject({ rendererVersion: 1, eligibility: { allowed: true }, npf: { state: 'queue', tags: ['canonical'] } });
    expect(preview.body.npf.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', alt_text: 'Canonical alt' })]));
    const selectedPreview = await request(app).post('/studio/works/work/preview/tumblr').set('x-user-id', 'owner').send({ connectorId: 'connector', destinationId: 'blog', mode: 'selected_assets', selectedAssetIds: ['asset-two'] }).expect(200);
    expect(selectedPreview.body.npf.content.filter((block: { type: string }) => block.type === 'image')).toEqual([expect.objectContaining({ alt_text: 'Second alt' })]);
    const published = await request(app).post('/studio/works/work/publish/tumblr').set('x-user-id', 'owner').send({ connectorId: 'connector', destinationId: 'blog' }).expect(202);
    expect(published.body).toMatchObject({ workId: 'work', status: 'pending', requestSnapshot: { rendererVersion: 1, workRevision: 1 } });
    expect(enqueued).toEqual([published.body.id]);
    const publications = await request(app).get('/studio/works/work/publications/tumblr').set('x-user-id', 'owner').expect(200);
    expect(publications.body).toHaveLength(1);
  });

  test('requires remote confirmation before updating and deletes only the Tumblr publication', async () => {
    const store = new InMemoryStore();
    const repository = new InMemoryTumblrRepository();
    const now = new Date().toISOString();
    store.creators.push({ creatorId: 'creator', name: 'Creator', slug: 'creator', status: 'active', sortOrder: 0, createdAt: now });
    store.creatorMembers.push({ creatorId: 'creator', userId: 'owner', role: 'owner', createdAt: now });
    store.works.push({ workId: 'work', tenantId: 'test', creatorId: 'creator', kind: 'image', title: 'Canonical title', slug: 'work', slugHistory: [], tags: [], contentRating: 'general', aiDisclosure: 'none', heavyTopics: [], status: 'ready', origin: { type: 'local' }, revision: 1, createdAt: now, updatedAt: now });
    await repository.putConnector({ id: 'connector', tenantId: 'test', userId: 'owner', creatorId: 'creator', ownership: 'managed', authProtocol: 'oauth2', status: 'connected', credentialsEncrypted: encryptTumblrOAuthGrant({ accessToken: 'token', scopes: ['write'] }, 'encryption-key') });
    await repository.putDestination({ id: 'blog', tenantId: 'test', connectorId: 'connector', creatorId: 'creator', identifier: 'creator-blog', enabled: true });
    await repository.putPublication({ id: 'publication', tenantId: 'test', creatorId: 'creator', workId: 'work', connectorId: 'connector', destinationId: 'blog', mode: 'full', status: 'published', tumblrPostId: '123', tumblrPostUrl: 'https://creator-blog.tumblr.com/post/123', requestSnapshot: { npf: { content: [{ type: 'text', text: 'Canonical title' }], layout: [], state: 'published', tags: [] } }, updatedAt: now });
    const remote = { id_string: '123', content: [{ type: 'text', text: 'Edited on Tumblr' }] };
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ response: remote }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const app = createApp({ config: config(), store, tumblrRepository: repository });

    await request(app).patch('/studio/works/work/publications/publication/tumblr').set('x-user-id', 'owner').send({}).expect(409).expect(({ body }) => expect(body).toMatchObject({ code: 'remote_confirmation_required', remote }));
    await request(app).patch('/studio/works/work/publications/publication/tumblr').set('x-user-id', 'owner').send({ confirmRemoteOverwrite: true }).expect(200);
    await request(app).delete('/studio/works/work/publications/publication/tumblr').set('x-user-id', 'owner').expect(200).expect(({ body }) => expect(body).toMatchObject({ status: 'deleted' }));
    expect(store.works.find((work) => work.workId === 'work')).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/posts/123'), expect.objectContaining({ method: 'PUT' }));
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/post/delete'), expect.objectContaining({ method: 'POST' }));
  });
});
