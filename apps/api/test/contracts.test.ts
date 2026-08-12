import request from 'supertest';
import { createApp } from '../src/app';
import { InMemoryStore } from '../src/inMemoryStore';
import type { AppConfig } from '../src/config';

const buildConfig = (): AppConfig => ({
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
  externalContentMaxBytes: 50 * 1024 * 1024,
  externalTokenEncryptionKey: 'test-external-encryption-key',
  externalOAuthRedirectUri: 'http://localhost:4000/integrations/deviantart/callback'
});

describe('API contract', () => {
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

  it('lets every signed-in Ubeeqer create a free Space without creator approval', async () => {
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

  it('returns only the connected creator catalogue and never token fields', async () => {
    const store = new InMemoryStore();
    const app = createApp({ config: buildConfig(), store });
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
      externalTitle: 'Imported work',
      externalTags: ['portrait'],
      syncStatus: 'active',
      rawMetadataJson: {},
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
