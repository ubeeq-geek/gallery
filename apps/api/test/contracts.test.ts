import request from 'supertest';
import { createApp } from '../src/app';
import { InMemoryStore } from '../src/inMemoryStore';
import type { AppConfig } from '../src/config';

const buildConfig = (): AppConfig => ({
  awsRegion: 'ca-central-1',
  artistsTable: 'artists',
  galleriesTable: 'galleries',
  imagesTable: 'images',
  commentsTable: 'comments',
  favoritesTable: 'favorites',
  blockedUsersTable: 'blocked-users',
  siteSettingsTable: 'site-settings',
  imageStatsTable: 'image-stats',
  trendingFeedTable: 'trending-feed',
  galleryCoreTable: 'gallery-core',
  useGalleryCoreTable: false,
  mediaBucket: 'gallery-media',
  unlockJwtSecret: 'test-secret',
  unlockTokenTtlSeconds: 3600,
  rememberGalleryAccessTtlSeconds: 60 * 60 * 24 * 30,
  signedUrlTtlSeconds: 300,
  trendingFeedMaxItems: 600,
  trendingCandidateLimit: 1500
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
});
