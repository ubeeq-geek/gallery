import request from 'supertest';
import { createApp } from '../src/app';
import { InMemoryStore } from '../src/inMemoryStore';
import type { AppConfig } from '../src/config';

const buildConfig = (): AppConfig => ({
  tenantId: 'test',
  awsRegion: 'ca-central-1',
  creators: 'creators',
  groupingsTable: 'groupings',
  imagesTable: 'images',
  commentsTable: 'comments',
  favoritesTable: 'favorites',
  blockedUsersTable: 'blocked-users',
  siteSettingsTable: 'site-settings',
  contentStatsTable: 'content-stats',
  trendingFeedTable: 'trending-feed',
  contentCoreTable: 'content-core',
  useContentCoreTable: false,
  mediaBucket: 'content-media',
  unlockJwtSecret: 'test-secret',
  unlockTokenTtlSeconds: 3600,
  rememberGroupingAccessTtlSeconds: 60 * 60 * 24 * 30,
  signedUrlTtlSeconds: 300,
  trendingFeedMaxItems: 600,
  trendingCandidateLimit: 1500,
  externalSyncBaseDelaySeconds: 60,
  externalAccountScanIntervalSeconds: 21600,
  externalActivityScanIntervalSeconds: 120,
  deviantArtPublishedDescriptionUpdate: false,
  externalContentMaxBytes: 50 * 1024 * 1024,
  externalTokenEncryptionKey: 'test-external-encryption-key',
  externalOAuthRedirectUri: 'http://localhost:4000/integrations/deviantart/callback'
});

describe('API contract', () => {
  it('publishes one canonical Work through Space, discovery, and Collection contracts', async () => {
    const store = new InMemoryStore();
    const app = createApp({ config: buildConfig(), store });
    const now = new Date().toISOString();
    await store.createCreator({
      creatorId: 'canonical-creator',
      name: 'Canonical Creator',
      slug: 'canonical-creator',
      status: 'active',
      sortOrder: 0,
      space: {
        bio: 'A canonical public Space.',
        externalLinks: [{ label: 'Portfolio', url: 'https://example.test/' }],
        theme: 'slate',
        announcement: { enabled: true, message: 'Welcome to the Space.' }
      },
      createdAt: now
    });
    await store.addCreatorMember({ creatorId: 'canonical-creator', userId: 'canonical-owner', role: 'owner', createdAt: now });

    const created = await request(app)
      .post('/studio/works')
      .set('x-user-id', 'canonical-owner')
      .send({ creatorId: 'canonical-creator', title: 'First Work', description: 'Canonical description', tags: ['one', 'two'] });
    expect(created.status).toBe(201);
    const workId = created.body.work.workId as string;
    await store.createCanonicalAsset({
      assetId: 'canonical-asset',
      tenantId: 'test',
      creatorId: 'canonical-creator',
      kind: 'image',
      status: 'ready',
      mimeType: 'image/jpeg',
      storage: { mode: 'external', externalUrl: 'https://example.test/work.jpg' },
      createdAt: now,
      updatedAt: now
    });
    await store.attachAssetToWork('test', { workId, assetId: 'canonical-asset', role: 'primary', position: 0 });

    const published = await request(app)
      .put(`/studio/works/${workId}/publications/eversally`)
      .set('x-user-id', 'canonical-owner')
      .send({ published: true, visibility: 'public' });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ destination: 'eversally', status: 'live', visibility: 'public' });
    expect((await store.getWork('test', workId))?.status).toBe('draft');
    expect(await store.listPublicationIntentsByWork('test', workId)).toEqual([
      expect.objectContaining({ destination: 'eversally', enabled: true, desiredStatus: 'live' })
    ]);
    const catalogue = await request(app)
      .get('/studio/works?creatorId=canonical-creator')
      .set('x-user-id', 'canonical-owner');
    expect(catalogue.body.items[0]).toMatchObject({
      workId,
      status: 'draft',
      contentAvailability: 'external_reference',
      publications: [expect.objectContaining({ destination: 'eversally', status: 'live' })],
      publicationIntents: [expect.objectContaining({ destination: 'eversally', desiredStatus: 'live' })]
    });

    const discovery = await request(app)
      .put(`/studio/works/${workId}/discovery`)
      .set('x-user-id', 'canonical-owner')
      .send({ state: 'opted_in' });
    expect(discovery.status).toBe(200);
    expect(discovery.body.state).toBe('opted_in');

    const collection = await request(app)
      .post('/studio/collections')
      .set('x-user-id', 'canonical-owner')
      .send({ creatorId: 'canonical-creator', title: 'Launch Collection', status: 'published', visibility: 'public' });
    expect(collection.status).toBe(201);
    const membership = await request(app)
      .put(`/studio/collections/${collection.body.collectionId}/works`)
      .set('x-user-id', 'canonical-owner')
      .send({ workIds: [workId] });
    expect(membership.status).toBe(200);

    const publicWorks = await request(app).get('/creators/canonical-creator/works');
    expect(publicWorks.status).toBe(200);
    expect(publicWorks.body.items).toEqual([expect.objectContaining({ workId, title: 'First Work', discovery: 'opted_in' })]);
    expect(publicWorks.body.creator).toMatchObject({ bio: 'A canonical public Space.', theme: 'slate', announcement: { message: 'Welcome to the Space.' } });
    const publicWork = await request(app).get('/creators/canonical-creator/works/first-work');
    expect(publicWork.status).toBe(200);
    expect(publicWork.body.work).toMatchObject({ workId, contentAvailability: 'external_reference', primaryAsset: { hostingMode: 'external' } });
    const publicCollection = await request(app).get('/creators/canonical-creator/collections/launch-collection');
    expect(publicCollection.status).toBe(200);
    expect(publicCollection.body.works).toEqual([expect.objectContaining({ workId })]);
    const rss = await request(app).get('/creators/canonical-creator/rss.xml');
    expect(rss.status).toBe(200);
    expect(rss.headers['content-type']).toContain('application/rss+xml');
    expect(rss.text).toContain('<guid isPermaLink="false">urn:ubeeq:work:');
    expect(rss.text).toContain('First Work');
    const atom = await request(app).get('/creators/canonical-creator/atom.xml');
    expect(atom.status).toBe(200);
    expect(atom.headers['content-type']).toContain('application/atom+xml');
    expect(atom.text).toContain('<id>urn:ubeeq:work:');

    await store.createExternalAccount({
      externalAccountId: 'canonical-da-account',
      userId: 'canonical-owner',
      creatorIdentityId: 'canonical-creator',
      externalPlatformCredentialId: 'canonical-da-credential',
      platform: 'deviantart',
      externalUserId: 'remote-creator',
      externalUsername: 'canonical-remote',
      accessTokenEncrypted: 'secret-token-must-not-export',
      refreshTokenEncrypted: 'secret-refresh-must-not-export',
      connectionStatus: 'connected',
      createdAt: now,
      updatedAt: now
    });
    const exported = await request(app)
      .get('/studio/creators/canonical-creator/export')
      .set('x-user-id', 'canonical-owner');
    expect(exported.status).toBe(200);
    expect(exported.headers['content-disposition']).toContain('canonical-creator-ubeeq-export-');
    expect(exported.body).toMatchObject({
      schemaVersion: 1,
      source: { tenantId: 'test' },
      creator: { creatorId: 'canonical-creator' },
      works: [{
        work: { workId, title: 'First Work' },
        assets: [{ assetId: 'canonical-asset', attachment: { role: 'primary' } }],
        publications: [{ destination: 'eversally' }],
        discovery: { state: 'opted_in' }
      }],
      collections: [{
        collection: { collectionId: collection.body.collectionId },
        works: [{ workId }]
      }],
      integrationAccounts: [{ externalAccountId: 'canonical-da-account', externalUsername: 'canonical-remote' }]
    });
    expect(JSON.stringify(exported.body)).not.toContain('secret-token-must-not-export');
    expect(JSON.stringify(exported.body)).not.toContain('secret-refresh-must-not-export');
  });

  it('returns canonical Eversally identity and domains in hosted mode', async () => {
    const store = new InMemoryStore();
    const app = createApp({ config: { ...buildConfig(), productBrand: 'eversally' }, store });

    const response = await request(app).get('/site-settings');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      siteName: 'Eversally',
      productBrand: 'eversally',
      siteUrl: 'https://eversally.com',
      creatorBaseUrl: 'https://eversally.com/creators/'
    }));
  });

  it('uses normalized offset cursor for /collections random order', async () => {
    const store = new InMemoryStore();
    const app = createApp({ config: buildConfig(), store });
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i += 1) {
      await store.createCollection({
        collectionId: `c-${i}`,
        ownerUserId: 'u-owner',
        ownerProfileType: 'user',
        ownerProfileId: 'u-owner',
        title: `Collection ${i}`,
        visibility: 'public',
        insertedDate: now,
        updatedDate: now,
        imageCount: 0,
        favoriteCount: 0
      });
    }

    const res = await request(app).get('/collections?order=random&seed=abc&limit=2');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(typeof res.body.nextCursor).toBe('string');
    const parsed = JSON.parse(Buffer.from(String(res.body.nextCursor), 'base64url').toString('utf8'));
    expect(parsed.type).toBe('offset');
    expect(parsed.offset).toBe(2);
  });

  it('enforces idempotency for POST /favorites', async () => {
    const store = new InMemoryStore();
    const app = createApp({ config: buildConfig(), store });
    const idempotencyKey = 'idem-1';

    const first = await request(app)
      .post('/favorites')
      .set('x-user-id', 'u-idem')
      .set('x-idempotency-key', idempotencyKey)
      .send({ targetType: 'image', targetId: 'img-1' });
    const second = await request(app)
      .post('/favorites')
      .set('x-user-id', 'u-idem')
      .set('x-idempotency-key', idempotencyKey)
      .send({ targetType: 'image', targetId: 'img-1' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    const favorites = await store.listFavoritesByUser('u-idem');
    expect(favorites).toHaveLength(1);
  });

  it('returns 429 after favorite add rate-limit threshold', async () => {
    const store = new InMemoryStore();
    const app = createApp({ config: buildConfig(), store });

    let lastStatus = 0;
    for (let i = 0; i < 91; i += 1) {
      const res = await request(app)
        .post('/favorites')
        .set('x-user-id', 'u-rate-limit')
        .send({ targetType: 'image', targetId: `img-${i}` });
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('lets every signed-in member create a free creator workspace without creator approval', async () => {
    const store = new InMemoryStore();
    const app = createApp({ config: buildConfig(), store });
    const response = await request(app)
      .post('/studio/creators')
      .set('x-user-id', 'u-ubeeqer')
      .send({ name: 'Open Studio', slug: 'open-studio' });

    expect(response.status).toBe(201);
    expect(response.body.spaceTier).toBe('free');
    const creators = await store.listCreatorsByUserId('u-ubeeqer');
    expect(creators).toHaveLength(1);
    expect(creators[0].slug).toBe('open-studio');
  });

  it('deletes a DeviantArt application only after its connected accounts are removed', async () => {
    const store = new InMemoryStore();
    const app = createApp({ config: buildConfig(), store });
    const saved = await request(app)
      .put('/studio/integrations/deviantart/credentials')
      .set('x-user-id', 'u-da-delete')
      .send({ applicationLabel: 'Disposable DA app', clientId: 'delete-client', clientSecret: 'delete-secret' });
    expect(saved.status).toBe(200);

    const now = new Date().toISOString();
    await store.createExternalAccount({
      externalAccountId: 'account-da-delete',
      userId: 'u-da-delete',
      externalPlatformCredentialId: saved.body.externalPlatformCredentialId,
      platform: 'deviantart',
      externalUserId: 'remote-da-delete',
      externalUsername: 'da-delete-user',
      accessTokenEncrypted: 'encrypted-access-token',
      connectionStatus: 'connected',
      createdAt: now,
      updatedAt: now
    });

    const blocked = await request(app)
      .delete(`/studio/integrations/deviantart/credentials/${saved.body.externalPlatformCredentialId}`)
      .set('x-user-id', 'u-da-delete');
    expect(blocked.status).toBe(409);
    expect(blocked.body.connectedAccountCount).toBe(1);

    const removed = await request(app)
      .delete('/studio/integrations/deviantart/accounts/account-da-delete')
      .set('x-user-id', 'u-da-delete');
    expect(removed.status).toBe(204);

    const deleted = await request(app)
      .delete(`/studio/integrations/deviantart/credentials/${saved.body.externalPlatformCredentialId}`)
      .set('x-user-id', 'u-da-delete');
    expect(deleted.status).toBe(204);
    expect(await store.getExternalPlatformCredential(saved.body.externalPlatformCredentialId)).toBeNull();
  });

  it('returns only the connected creator catalogue and never token fields', async () => {
    const store = new InMemoryStore();
    const app = createApp({ config: buildConfig(), store, externalSyncQueue: { enqueue: jest.fn(async () => undefined) } });
    const now = new Date().toISOString();
    await store.createCreator({ creatorId: 'creator-da', name: 'DA Creator', slug: 'da-creator', status: 'active', sortOrder: 0, createdAt: now });
    await store.addCreatorMember({ creatorId: 'creator-da', userId: 'u-da', role: 'owner', createdAt: now });
    const credentialResponse = await request(app)
      .put('/studio/integrations/deviantart/credentials')
      .set('x-user-id', 'u-da')
      .send({ creatorId: 'creator-da', clientId: 'creator-da-client', clientSecret: 'creator-da-secret' });
    expect(credentialResponse.status).toBe(200);
    expect(credentialResponse.body.clientId).toBe('creator-da-client');
    expect(credentialResponse.body.clientSecretEncrypted).toBeUndefined();
    const storedCredential = (await store.listExternalPlatformCredentialsByCreatorIdentity('creator-da'))[0];
    expect(storedCredential.clientSecretEncrypted).not.toContain('creator-da-secret');
    await store.createExternalAccount({
      externalAccountId: 'account-da',
      userId: 'u-da',
      creatorIdentityId: 'creator-da',
      externalPlatformCredentialId: credentialResponse.body.externalPlatformCredentialId,
      platform: 'deviantart',
      externalUserId: 'remote-da',
      externalUsername: 'da-user',
      accessTokenEncrypted: 'encrypted-access-token',
      refreshTokenEncrypted: 'encrypted-refresh-token',
      connectionStatus: 'connected',
      createdAt: now,
      updatedAt: now
    });
    await store.createAsset({
      assetId: 'asset-da',
      userId: 'u-da',
      creatorIdentityId: 'creator-da',
      assetType: 'image',
      canonicalTitle: 'Imported work',
      visibility: 'private',
      titleSyncPolicy: 'initially_mirrored',
      descriptionSyncPolicy: 'initially_mirrored',
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalPublication({
      externalPublicationId: 'publication-da',
      assetId: 'asset-da',
      externalAccountId: 'account-da',
      platform: 'deviantart',
      externalContentId: 'deviation-uuid',
      externalUrl: 'https://www.deviantart.com/da-user/art/imported-work-123',
      externalTitle: 'Imported work',
      externalDescription: '<p>Original DeviantArt description</p>',
      externalTags: ['portrait'],
      syncStatus: 'active',
      rawMetadataJson: {
        thumbs: [
          { src: 'https://images.example.test/imported-work-small.jpg', width: 150, height: 100 },
          { src: 'https://images.example.test/imported-work-large.jpg', width: 600, height: 400 }
        ],
        submission: {
          allows_comments: false,
          is_mature: true,
          mature_level: 'moderate',
          mature_classification: ['ideology'],
          is_ai_generated: true,
          noai: true
        }
      },
      createdAt: now,
      updatedAt: now
    });
    await store.upsertExternalEngagementCurrent({
      externalPublicationId: 'publication-da',
      capturedAt: now,
      views: 6492,
      favourites: 35,
      comments: 0,
      downloads: 0
    });
    await store.upsertExternalActivity({
      externalActivityId: 'activity-da',
      externalAccountId: 'account-da',
      creatorIdentityId: 'creator-da',
      assetId: 'asset-da',
      externalPublicationId: 'publication-da',
      platform: 'deviantart',
      type: 'favourite',
      direction: 'inbound',
      remoteActivityId: 'remote-activity-da',
      remoteMessageId: 'message-da',
      externalActorName: 'art-fan',
      occurredAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now
    });
    await store.createWork({
      workId: 'asset-da',
      tenantId: 'test',
      creatorId: 'creator-da',
      kind: 'image',
      title: 'Imported work',
      slug: 'imported-work',
      slugHistory: ['imported-work'],
      description: '<p>Original DeviantArt description</p>',
      tags: ['portrait'],
      contentRating: 'general',
      aiDisclosure: 'none',
      heavyTopics: [],
      status: 'draft',
      origin: { type: 'import', platform: 'deviantart', integrationAccountId: 'account-da', remoteId: 'deviation-uuid' },
      revision: 1,
      createdAt: now,
      updatedAt: now
    });
    await store.upsertPublication({
      publicationId: 'publication-da',
      tenantId: 'test',
      creatorId: 'creator-da',
      workId: 'asset-da',
      destination: 'deviantart',
      integrationAccountId: 'account-da',
      status: 'live',
      visibility: 'public',
      remoteId: 'deviation-uuid',
      sync: { status: 'conflict' },
      createdAt: now,
      updatedAt: now
    });

    const accountResponse = await request(app)
      .get('/studio/integrations/deviantart/accounts?creatorId=creator-da')
      .set('x-user-id', 'u-da');
    expect(accountResponse.status).toBe(200);
    expect(accountResponse.body[0].externalUsername).toBe('da-user');
    expect(accountResponse.body[0].accessTokenEncrypted).toBeUndefined();
    expect(accountResponse.body[0].refreshTokenEncrypted).toBeUndefined();

    const catalogueResponse = await request(app)
      .get('/studio/integrations/deviantart/catalogue?creatorId=creator-da&query=portrait')
      .set('x-user-id', 'u-da');
    expect(catalogueResponse.status).toBe(200);
    expect(catalogueResponse.body.total).toBe(1);
    expect(catalogueResponse.body.items[0].publications[0].externalContentId).toBe('deviation-uuid');
    expect(catalogueResponse.body.items[0].publications[0].canUpdatePublishedDescription).toBe(false);
    expect(catalogueResponse.body.items[0].publications[0].publishedDescriptionUpdateMode).toBeUndefined();
    expect(catalogueResponse.body.items[0].engagement).toMatchObject({
      views: 6492,
      favourites: 35,
      comments: 0,
      downloads: 0,
      destinations: 1
    });
    expect(catalogueResponse.body.items[0].publications[0].displayOptions).toMatchObject({
      allowComments: false,
      isMature: true,
      matureLevel: 'moderate',
      matureClassification: ['ideology'],
      isAiGenerated: true,
      noAi: true
    });

    const activityResponse = await request(app)
      .get('/studio/integrations/activity?creatorId=creator-da')
      .set('x-user-id', 'u-da');
    expect(activityResponse.status).toBe(200);
    expect(activityResponse.body.items[0]).toMatchObject({
      externalActivityId: 'activity-da',
      account: {
        externalAccountId: 'account-da',
        platform: 'deviantart',
        externalUserId: 'remote-da',
        externalUsername: 'da-user'
      },
      work: {
        assetId: 'asset-da',
        title: 'Imported work',
        assetType: 'image',
        thumbnailUrl: 'https://images.example.test/imported-work-large.jpg',
        externalUrl: 'https://www.deviantart.com/da-user/art/imported-work-123'
      }
    });
    expect(activityResponse.body.total).toBe(1);
    expect(activityResponse.body.nextCursor).toBeUndefined();

    const bulkReadResponse = await request(app)
      .patch('/studio/integrations/activity/bulk')
      .set('x-user-id', 'u-da')
      .send({ creatorId: 'creator-da', activityIds: ['activity-da'], read: true });
    expect(bulkReadResponse.status).toBe(200);
    expect(bulkReadResponse.body).toEqual({ updated: 1, read: true });
    const readActivityResponse = await request(app)
      .get('/studio/integrations/activity?creatorId=creator-da&status=read&limit=1')
      .set('x-user-id', 'u-da');
    expect(readActivityResponse.body.items).toHaveLength(1);
    expect(readActivityResponse.body.items[0].readAt).toEqual(expect.any(String));

    const workActivityResponse = await request(app)
      .get('/studio/integrations/activity/works/asset-da')
      .set('x-user-id', 'u-da');
    expect(workActivityResponse.status).toBe(200);
    expect(workActivityResponse.body.destinations[0].capabilities).toMatchObject({
      reply: true,
      remoteCommentModeration: false
    });

    const metadataResponse = await request(app)
      .patch('/studio/integrations/assets/asset-da')
      .set('x-user-id', 'u-da')
      .send({
        canonicalDescription: '<p>Independent Ubeeq description</p>',
        descriptionSyncPolicy: 'independent',
        integrationMetadata: {
          externalPublicationId: 'publication-da',
          description: '<p>Unsupported published DeviantArt description</p>'
        }
      });
    expect(metadataResponse.status).toBe(200);
    expect(metadataResponse.body.canonicalDescription).toBe('<p>Independent Ubeeq description</p>');
    expect(metadataResponse.body.remoteUpdateJobs).toEqual([]);
    expect(metadataResponse.body.remoteUpdateWarnings).toEqual([
      'DeviantArt does not permit description changes for already-published deviations through its API. The Ubeeq description was saved, but the DeviantArt description remains unchanged.'
    ]);
    expect((await store.getExternalPublication('account-da', 'deviation-uuid'))?.externalDescription).toBe('<p>Original DeviantArt description</p>');

    const resolvePush = await request(app)
      .post('/studio/works/asset-da/publications/publication-da/resolve')
      .set('x-user-id', 'u-da')
      .send({ strategy: 'push' });
    expect(resolvePush.status).toBe(202);
    expect(resolvePush.body.strategy).toBe('push');
    expect((await store.getPublication('test', 'publication-da'))?.sync.status).toBe('local_newer');
    const remoteUpdate = await store.getExternalSyncJob(resolvePush.body.job.externalSyncJobId);
    expect(remoteUpdate).toMatchObject({ type: 'remote_update', status: 'queued' });

    const resolvePull = await request(app)
      .post('/studio/works/asset-da/publications/publication-da/resolve')
      .set('x-user-id', 'u-da')
      .send({ strategy: 'pull' });
    expect(resolvePull.status).toBe(202);
    expect(resolvePull.body.strategy).toBe('pull');
    expect((await store.getPublication('test', 'publication-da'))?.sync.status).toBe('remote_newer');
    expect(await store.getExternalSyncJob(resolvePull.body.job.externalSyncJobId)).toMatchObject({ type: 'full_reconciliation', status: 'queued' });

    const spaceResponse = await request(app)
      .put('/studio/integrations/assets/asset-da/space-publication')
      .set('x-user-id', 'u-da')
      .send({ published: true, hostingMode: 'linked', visibility: 'private' });
    expect(spaceResponse.status).toBe(200);
    expect(spaceResponse.body.published).toBe(true);
    expect(spaceResponse.body.hostingMode).toBe('linked');

    const selectedCatalogueResponse = await request(app)
      .get('/studio/integrations/deviantart/catalogue?creatorId=creator-da')
      .set('x-user-id', 'u-da');
    expect(selectedCatalogueResponse.body.items[0].spacePublication.published).toBe(true);

    await store.createAsset({
      assetId: 'asset-da-draft',
      userId: 'u-da',
      creatorIdentityId: 'creator-da',
      assetType: 'image',
      canonicalTitle: 'New Ubeeq work',
      visibility: 'private',
      titleSyncPolicy: 'independent',
      descriptionSyncPolicy: 'independent',
      createdAt: now,
      updatedAt: now
    });
    const draftDestination = await request(app)
      .post('/studio/works/asset-da-draft/destinations/deviantart')
      .set('x-user-id', 'u-da')
      .send({ externalAccountId: 'account-da', targetStatus: 'draft' });
    expect(draftDestination.status).toBe(201);
    expect(draftDestination.body.publication).toMatchObject({
      assetId: 'asset-da-draft',
      targetStatus: 'draft',
      syncStatus: 'pending_publish'
    });

    const publishInstead = await request(app)
      .post('/studio/works/asset-da-draft/destinations/deviantart')
      .set('x-user-id', 'u-da')
      .send({ externalAccountId: 'account-da', targetStatus: 'published' });
    expect(publishInstead.status).toBe(200);
    expect(publishInstead.body.publication.targetStatus).toBe('published');
  });

  it('keeps a DeviantArt integration account-owned and uses one sync destination creator', async () => {
    const store = new InMemoryStore();
    const app = createApp({ config: buildConfig(), store });
    const now = new Date().toISOString();
    for (const creator of [
      { creatorId: 'creator-a', name: 'Creator A', slug: 'creator-a' },
      { creatorId: 'creator-b', name: 'Creator B', slug: 'creator-b' }
    ]) {
      await store.createCreator({ ...creator, status: 'active', sortOrder: 0, createdAt: now });
      await store.addCreatorMember({ creatorId: creator.creatorId, userId: 'u-da-owner', role: 'owner', createdAt: now });
    }
    const credential = await request(app)
      .put('/studio/integrations/deviantart/credentials')
      .set('x-user-id', 'u-da-owner')
      .send({ clientId: 'account-owned-client', clientSecret: 'account-owned-secret' });
    expect(credential.status).toBe(200);
    await store.createExternalAccount({
      externalAccountId: 'shared-da-account',
      userId: 'u-da-owner',
      externalPlatformCredentialId: credential.body.externalPlatformCredentialId,
      platform: 'deviantart',
      externalUserId: 'remote-shared',
      externalUsername: 'shared-da',
      accessTokenEncrypted: 'encrypted-access-token',
      connectionStatus: 'connected',
      createdAt: now,
      updatedAt: now
    });

    const assignment = await request(app)
      .put('/studio/integrations/deviantart/accounts/shared-da-account/creators')
      .set('x-user-id', 'u-da-owner')
      .send({ creatorIdentityIds: ['creator-b'], primaryCreatorIdentityId: 'creator-b' });
    expect(assignment.status).toBe(200);
    expect(assignment.body.creatorAssignments).toEqual(['creator-b']);
    expect(assignment.body.primaryCreatorIdentityId).toBe('creator-b');

    const [allAccounts, creatorAAccounts, creatorBAccounts] = await Promise.all([
      request(app).get('/studio/integrations/deviantart/accounts').set('x-user-id', 'u-da-owner'),
      request(app).get('/studio/integrations/deviantart/accounts?creatorId=creator-a').set('x-user-id', 'u-da-owner'),
      request(app).get('/studio/integrations/deviantart/accounts?creatorId=creator-b').set('x-user-id', 'u-da-owner')
    ]);
    expect(allAccounts.status).toBe(200);
    expect(allAccounts.body).toHaveLength(1);
    expect(creatorAAccounts.body).toEqual([]);
    expect(creatorBAccounts.body[0].externalAccountId).toBe('shared-da-account');

    const unsupportedSplit = await request(app)
      .put('/studio/integrations/deviantart/accounts/shared-da-account/creators')
      .set('x-user-id', 'u-da-owner')
      .send({ creatorIdentityIds: ['creator-a', 'creator-b'], primaryCreatorIdentityId: 'creator-b' });
    expect(unsupportedSplit.status).toBe(400);
  });
});
