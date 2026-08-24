import { FlickrMigrationService, InMemoryFlickrRepository, normalizeFlickrPhoto, type FlickrConnection } from '../src/flickrIntegration';
import { InMemoryStore } from '../src/inMemoryStore';
import { loadConfig } from '../src/config';

const connection: FlickrConnection = {
  connectionId: 'connection-1', userId: 'user-1', creatorId: 'creator-1', accountId: 'flickr-user', username: 'creator',
  encryptedTokenRef: 'encrypted', scopes: ['read'], state: 'CONNECTED',
  capabilities: { inventory: true, originals: true, exif: true }, ownershipValidatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z'
};

const photo = normalizeFlickrPhoto({
  remoteId: 'photo-1', remoteUrl: 'https://www.flickr.com/photos/user/photo-1', title: 'A title', description: 'Description',
  tags: ['landscape', 'landscape', '  archive '], albumIds: ['album-1', 'album-1'], licence: 'cc-by', visibility: 'private',
  originalFilename: 'source.tif', originalSizeBytes: 42, originalAvailable: true
});

describe('Flickr migration service', () => {
  it('builds deterministic metadata and a resumable reference inventory', async () => {
    const repository = new InMemoryFlickrRepository();
    const service = new FlickrMigrationService(repository);
    const migration = await service.inventory(connection, [photo], 'next-page');
    expect(photo.tags).toEqual(['landscape', 'archive']);
    expect(photo.albumIds).toEqual(['album-1']);
    expect(migration).toMatchObject({ status: 'INVENTORY_READY', cursor: 'next-page', estimatedBytes: 42, discoveryEnabled: false });
    expect(migration.publications[0]).toMatchObject({ remotePhotoId: 'photo-1', state: 'ACTIVE', workId: 'flickr-flickr-user-photo-1' });
    expect(migration.provenance[0]).toMatchObject({ remotePhotoId: 'photo-1', accountId: 'flickr-user', creatorAttestedOwnership: true });
    const confirmed = await service.confirm(migration, 'REFERENCE_IMPORT', [], false);
    expect(confirmed.items).toEqual([expect.objectContaining({ remoteId: 'photo-1', transferStatus: 'NOT_REQUESTED' })]);
  });

  it('reuses the manifest and Work identity while reconciling changed and missing photos', async () => {
    const repository = new InMemoryFlickrRepository();
    const service = new FlickrMigrationService(repository);
    const first = await service.inventory(connection, [photo]);
    const changed = normalizeFlickrPhoto({ ...photo, title: 'Changed remotely', remoteUrl: photo.remoteUrl });
    const second = await service.inventory(connection, [changed]);
    expect(second.migrationId).toBe(first.migrationId);
    expect(second.publications[0]).toMatchObject({ state: 'REMOTE_CHANGED', workId: first.publications[0].workId });
    const missing = await service.inventory(connection, []);
    expect(missing.publications).toContainEqual(expect.objectContaining({ remotePhotoId: 'photo-1', state: 'MISSING' }));
  });

  it('requires explicit storage confirmation and keeps unavailable originals as references', async () => {
    const repository = new InMemoryFlickrRepository();
    const service = new FlickrMigrationService(repository);
    const unavailable = normalizeFlickrPhoto({ ...photo, remoteId: 'photo-2', originalAvailable: false, remoteUrl: photo.remoteUrl });
    const migration = await service.inventory(connection, [unavailable]);
    await expect(service.confirm(migration, 'FULL_CATALOGUE_MIGRATION', [], false)).rejects.toThrow('Storage and cost confirmation');
    const confirmed = await service.confirm(migration, 'FULL_CATALOGUE_MIGRATION', [], true);
    expect(confirmed.items[0]).toMatchObject({ transferStatus: 'UNAVAILABLE', errorCode: 'ORIGINAL_UNAVAILABLE' });
  });

  it('does not offer source migration until the owned account demonstrates original retrieval capability', async () => {
    const repository = new InMemoryFlickrRepository();
    const service = new FlickrMigrationService(repository);
    const referenceOnly = { ...connection, capabilities: { ...connection.capabilities, originals: false } };
    const migration = await service.inventory(referenceOnly, [photo]);
    await expect(service.confirm(migration, 'FULL_CATALOGUE_MIGRATION', [], true)).rejects.toThrow('use reference import instead');
    await expect(service.confirm(migration, 'REFERENCE_IMPORT', [], false)).resolves.toMatchObject({
      auditEvents: expect.arrayContaining([expect.objectContaining({ action: 'INVENTORY_CAPTURED' }), expect.objectContaining({ action: 'MIGRATION_CONFIRMED' })])
    });
  });

  it('does not allow an empty selected-source migration', async () => {
    const service = new FlickrMigrationService(new InMemoryFlickrRepository());
    const migration = await service.inventory(connection, [photo]);
    await expect(service.confirm(migration, 'SELECTED_SOURCE_MIGRATION', [], true)).rejects.toThrow('Select at least one');
  });

  it('materializes private staged Works, Flickr publications, Discovery-off state, and ordered album mappings idempotently', async () => {
    const repository = new InMemoryFlickrRepository();
    const canonical = new InMemoryStore();
    const service = new FlickrMigrationService(repository, canonical, 'tenant-1');
    const migration = await service.inventory(connection, [photo], undefined, [{
      remoteAlbumId: 'album-1', title: 'Flickr album', orderedRemotePhotoIds: ['photo-1']
    }]);
    const first = await service.confirm(migration, 'REFERENCE_IMPORT', [], false);
    const works = await canonical.listWorksByCreator('tenant-1', 'creator-1');
    expect(works).toHaveLength(1);
    expect(works[0]).toMatchObject({ status: 'draft', origin: { platform: 'flickr', remoteId: 'photo-1' } });
    expect(works[0].origin.remoteUrl).toBeUndefined();
    await expect(canonical.listPublicationsByWork('tenant-1', works[0].workId)).resolves.toEqual([
      expect.objectContaining({ destination: 'flickr', visibility: 'private', remoteId: 'photo-1' })
    ]);
    await expect(canonical.getWorkDiscoveryParticipation('tenant-1', works[0].workId)).resolves.toMatchObject({ state: 'none' });
    const collectionId = first.albums[0].mappedCollectionId!;
    await expect(canonical.getCreatorCollection('tenant-1', collectionId)).resolves.toMatchObject({ status: 'draft', visibility: 'private' });
    await expect(canonical.listCollectionWorks('tenant-1', collectionId)).resolves.toEqual([
      expect.objectContaining({ workId: works[0].workId, position: 0 })
    ]);
    const review = { ...first, status: 'REVIEW' as const };
    await service.confirm(review, 'REFERENCE_IMPORT', [], false);
    await expect(canonical.listWorksByCreator('tenant-1', 'creator-1')).resolves.toHaveLength(1);
  });

  it('validates confirmed sources in quarantine and deduplicates canonical Assets by checksum', async () => {
    const repository = new InMemoryFlickrRepository();
    const canonical = new InMemoryStore();
    const transfer = jest.fn(async () => ({ objectKey: 'quarantine/flickr/source.jpg', checksumSha256: 'same-checksum',
      mimeType: 'image/jpeg', sizeBytes: 3, scanOutcome: 'clean' as const }));
    const service = new FlickrMigrationService(repository, canonical, 'tenant-1', { ...loadConfig(), tenantId: 'tenant-1' }, transfer);
    const second = normalizeFlickrPhoto({ ...photo, remoteId: 'photo-2', remoteUrl: `${photo.remoteUrl}-2`, originalSourceUrl: 'https://live.staticflickr.com/source-2.jpg' });
    const first = normalizeFlickrPhoto({ ...photo, originalSourceUrl: 'https://live.staticflickr.com/source-1.jpg' });
    const migration = await service.inventory(connection, [first, second]);
    const confirmed = await service.confirm(migration, 'SELECTED_SOURCE_MIGRATION', ['photo-1', 'photo-2'], true);
    const completed = await service.migrateConfirmedSources(confirmed);
    expect(completed.status).toBe('COMPLETE');
    expect(completed.items.map((item) => item.dedupeStatus)).toEqual(['UNIQUE', 'CHECKSUM_MATCH']);
    expect(completed.auditEvents.filter((event) => event.action === 'SOURCE_TRANSFERRED')).toHaveLength(2);
    expect(transfer).toHaveBeenCalledTimes(2);
    const works = await canonical.listWorksByCreator('tenant-1', 'creator-1');
    const assets = await Promise.all(works.map((work) => canonical.listCanonicalAssetsByWork('tenant-1', work.workId)));
    expect(new Set(assets.flat().map((asset) => asset.assetId)).size).toBe(1);
    expect(assets.flat()[0]).toMatchObject({ status: 'ready', checksumSha256: 'same-checksum', metadata: { scanOutcome: 'clean', source: 'flickr' } });
  });

  it('checkpoints quarantined files and promotes them only after a clean scan without downloading twice', async () => {
    const repository = new InMemoryFlickrRepository();
    const canonical = new InMemoryStore();
    const transfer = jest.fn(async () => ({ objectKey: 'quarantine/flickr/pending.jpg', checksumSha256: 'pending-checksum',
      mimeType: 'image/jpeg', sizeBytes: 3, scanOutcome: 'pending' as const }));
    const scan = jest.fn<Promise<'pending' | 'clean'>, [string]>().mockResolvedValueOnce('pending').mockResolvedValueOnce('clean');
    const service = new FlickrMigrationService(repository, canonical, 'tenant-1', { ...loadConfig(), tenantId: 'tenant-1' }, transfer, scan);
    const source = normalizeFlickrPhoto({ ...photo, originalSourceUrl: 'https://live.staticflickr.com/source.jpg' });
    const migration = await service.inventory(connection, [source]);
    const confirmed = await service.confirm(migration, 'SELECTED_SOURCE_MIGRATION', ['photo-1'], true);
    const quarantined = await service.migrateConfirmedSources(confirmed);
    expect(quarantined).toMatchObject({ status: 'REVIEW', items: [{ transferStatus: 'QUARANTINED',
      quarantineObjectKey: 'quarantine/flickr/pending.jpg', scanOutcome: 'pending' }] });
    const completed = await service.migrateConfirmedSources(quarantined);
    expect(completed).toMatchObject({ status: 'COMPLETE', items: [{ transferStatus: 'VALIDATED', scanOutcome: 'clean' }] });
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('schedules bounded retries only for transient source failures', async () => {
    const repository = new InMemoryFlickrRepository();
    const canonical = new InMemoryStore();
    const transfer = jest.fn(async () => { throw new Error('FLICKR_SOURCE_TEMPORARILY_UNAVAILABLE'); });
    const service = new FlickrMigrationService(repository, canonical, 'tenant-1', { ...loadConfig(), tenantId: 'tenant-1' }, transfer);
    const source = normalizeFlickrPhoto({ ...photo, originalSourceUrl: 'https://live.staticflickr.com/source.jpg' });
    const migration = await service.inventory(connection, [source]);
    const confirmed = await service.confirm(migration, 'SELECTED_SOURCE_MIGRATION', ['photo-1'], true);
    const failed = await service.migrateConfirmedSources(confirmed);
    expect(failed.items[0]).toMatchObject({ transferStatus: 'FAILED', retryCount: 1, errorCode: 'FLICKR_SOURCE_TEMPORARILY_UNAVAILABLE' });
    expect(failed.items[0].nextRetryAt).toBeDefined();
    await service.migrateConfirmedSources(failed);
    expect(transfer).toHaveBeenCalledTimes(1);
  });
});
