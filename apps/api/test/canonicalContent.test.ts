import { InMemoryStore } from '../src/inMemoryStore';
import type { CanonicalAsset, CreatorCollection, Publication, Work } from '../src/canonicalDomain';

const now = '2026-08-14T12:00:00.000Z';

const workFor = (tenantId: string, workId: string, creatorId = 'creator-1'): Work => ({
  workId,
  tenantId,
  creatorId,
  kind: 'image',
  title: `Work ${workId}`,
  slug: `work-${workId}`,
  slugHistory: [`work-${workId}`],
  tags: [],
  contentRating: 'general',
  aiDisclosure: 'none',
  heavyTopics: [],
  status: 'draft',
  revision: 1,
  createdAt: now,
  updatedAt: now
});

describe('canonical content store', () => {
  it('isolates work records by tenant', async () => {
    const store = new InMemoryStore();
    await store.createWork(workFor('eversally', 'same-id'));
    await store.createWork(workFor('ubeeq', 'same-id'));

    await expect(store.listWorksByCreator('eversally', 'creator-1')).resolves.toHaveLength(1);
    await expect(store.listWorksByCreator('ubeeq', 'creator-1')).resolves.toHaveLength(1);
    await expect(store.getWork('another-tenant', 'same-id')).resolves.toBeNull();
  });

  it('keeps assets, publications, discovery, and collections separate from the Work lifecycle', async () => {
    const store = new InMemoryStore();
    const work = workFor('eversally', 'work-1');
    const asset: CanonicalAsset = {
      assetId: 'asset-1',
      tenantId: work.tenantId,
      creatorId: work.creatorId,
      kind: 'image',
      status: 'ready',
      mimeType: 'image/png',
      storage: { mode: 'hosted', objectKey: 'works/eversally/creator-1/asset-1/original.png' },
      createdAt: now,
      updatedAt: now
    };
    const publication: Publication = {
      publicationId: 'publication-1',
      tenantId: work.tenantId,
      creatorId: work.creatorId,
      workId: work.workId,
      destination: 'eversally',
      status: 'live',
      visibility: 'unlisted',
      sync: { status: 'not_applicable', localRevision: work.revision },
      createdAt: now,
      updatedAt: now,
      publishedAt: now
    };
    const collection: CreatorCollection = {
      collectionId: 'collection-1',
      tenantId: work.tenantId,
      creatorId: work.creatorId,
      type: 'collection',
      title: 'Collection',
      slug: 'collection',
      slugHistory: ['collection'],
      status: 'published',
      visibility: 'public',
      createdAt: now,
      updatedAt: now
    };

    await store.createWork(work);
    await store.createCanonicalAsset(asset);
    await store.attachAssetToWork(work.tenantId, { workId: work.workId, assetId: asset.assetId, role: 'primary', position: 0 });
    await store.upsertPublication(publication);
    await store.createCreatorCollection(collection);
    await store.replaceCollectionWorks(work.tenantId, collection.collectionId, [{ collectionId: collection.collectionId, workId: work.workId, position: 0, addedAt: now }]);
    await store.upsertWorkDiscoveryParticipation({ workId: work.workId, tenantId: work.tenantId, creatorId: work.creatorId, state: 'none', updatedAt: now });

    expect((await store.listCanonicalAssetsByWork(work.tenantId, work.workId))[0]).toMatchObject({ assetId: 'asset-1', attachment: { role: 'primary' } });
    expect((await store.listPublicationsByWork(work.tenantId, work.workId))[0]).toMatchObject({ destination: 'eversally', visibility: 'unlisted' });
    expect((await store.listCollectionWorks(work.tenantId, collection.collectionId))[0].workId).toBe(work.workId);
    expect((await store.getWorkDiscoveryParticipation(work.tenantId, work.workId))?.state).toBe('none');
    expect((await store.getWork(work.tenantId, work.workId))?.status).toBe('draft');
  });

  it('replaces collection ordering atomically at the store contract level', async () => {
    const store = new InMemoryStore();
    await store.createCreatorCollection({
      collectionId: 'collection-1',
      tenantId: 'eversally',
      creatorId: 'creator-1',
      type: 'collection',
      title: 'Ordered',
      slug: 'ordered',
      slugHistory: ['ordered'],
      status: 'draft',
      visibility: 'private',
      createdAt: now,
      updatedAt: now
    });
    await store.replaceCollectionWorks('eversally', 'collection-1', [
      { collectionId: 'collection-1', workId: 'work-2', position: 1, addedAt: now },
      { collectionId: 'collection-1', workId: 'work-1', position: 0, addedAt: now }
    ]);
    await expect(store.listCollectionWorks('eversally', 'collection-1')).resolves.toEqual([
      expect.objectContaining({ workId: 'work-1', position: 0 }),
      expect.objectContaining({ workId: 'work-2', position: 1 })
    ]);
  });
});
