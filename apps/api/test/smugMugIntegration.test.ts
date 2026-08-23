import { createHash } from 'crypto';
import { SmugMugIntegrationService, type SmugMugGateway, type SmugMugMigrationSink } from '../src/smugMugIntegration';

const image = (id: string, galleryId: string, originalAvailable = true) => ({
  remoteId: id, galleryId, url: `https://example.test/${id}`, filename: `${id}.jpg`, keywords: ['archive'], position: 1,
  mimeType: 'image/jpeg', originalAvailable, sourceUrl: `https://download.test/${id}`, privacy: { visibility: 'private' }, licence: { copyright: 'creator' }
});

describe('SmugMug migration orchestration', () => {
  const gateway: SmugMugGateway = {
    startAuthorization: async (state) => ({ authorizationUrl: `https://smugmug.test/authorize?state=${state}`, credentialRef: 'encrypted:request' }),
    completeAuthorization: async () => ({
      credentialRef: 'encrypted:access', accountId: 'account-1', accountName: 'Photographer',
      capabilities: { inventory: true, originalDownloads: true, exif: true, passwordProtectedGalleries: false }
    }),
    inventory: async () => ({
      collections: [{ remoteId: 'folder-1', kind: 'FOLDER', title: 'Archive', position: 1, privacy: {} }, { remoteId: 'gallery-1', kind: 'GALLERY', parentRemoteId: 'folder-1', title: 'Selected', position: 1, privacy: {} }],
      images: [image('image-1', 'gallery-1'), image('restricted', 'gallery-1', false)]
    }),
    download: async (_credential, remote) => ({ body: Buffer.from(remote.remoteId), mimeType: 'image/jpeg' })
  };

  it('inventories hierarchy and migrates selected sources without publishing', async () => {
    const imported: string[] = [];
    const quarantined: string[] = [];
    const sink: SmugMugMigrationSink = {
      importReference: async ({ image: remote }) => { imported.push(remote.remoteId); },
      findAssetByChecksum: async () => undefined,
      quarantine: async ({ image: remote }) => { quarantined.push(remote.remoteId); return { assetId: `asset-${remote.remoteId}`, scanPassed: true }; }
    };
    const service = new SmugMugIntegrationService(gateway, sink);
    const started = await service.start('user-1', 'creator-1');
    await service.callback(started.connection.oauthState, 'verifier');
    const inventory = await service.inventory(started.connection.id, 'user-1');
    expect(inventory.complete).toBe(true);
    expect(inventory.collectionCount).toBe(2);
    expect(inventory.imageCount).toBe(2);

    const result = await service.confirm(inventory.migration!.id, 'user-1', 'SELECTED_SOURCE_MIGRATION', ['gallery-1']);
    expect(result.migration.status).toBe('COMPLETED');
    expect(imported).toEqual(['image-1', 'restricted']);
    expect(quarantined).toEqual(['image-1']);
    expect(result.items.find((item) => item.remoteId === 'restricted')?.state).toBe('REFERENCE_IMPORTED');
  });

  it('deduplicates only by checksum and preserves inventory after disconnect', async () => {
    const contentChecksum = createHash('sha256').update('image-1').digest('hex');
    const sink: SmugMugMigrationSink = {
      importReference: async () => undefined,
      findAssetByChecksum: async (_creatorId, checksum) => checksum === contentChecksum ? 'existing-asset' : undefined,
      quarantine: async () => ({ assetId: 'new-asset', scanPassed: true })
    };
    const service = new SmugMugIntegrationService(gateway, sink);
    const started = await service.start('user-1', 'creator-1');
    await service.callback(started.connection.oauthState, 'verifier');
    const inventory = await service.inventory(started.connection.id, 'user-1');
    const result = await service.confirm(inventory.migration!.id, 'user-1', 'FULL_CATALOGUE_MIGRATION');
    expect(result.items.find((item) => item.remoteId === 'image-1')).toMatchObject({ state: 'DEDUPLICATED', canonicalAssetId: 'existing-asset' });

    await service.disconnect(started.connection.id, 'user-1');
    expect((await service.repository.getConnection(started.connection.id))?.state).toBe('DISCONNECTED');
    expect(await service.repository.getImages(started.connection.id)).toHaveLength(2);
    expect((await service.repository.getMigration(inventory.migration!.id))?.status).toBe('COMPLETED');
  });

  it('publishes only explicitly selected creator works', async () => {
    const publishingGateway: SmugMugGateway = {
      ...gateway,
      publish: jest.fn(async () => ({ remoteId: 'published-1', remoteUrl: 'https://photos.test/published-1' })),
      updateMetadata: jest.fn(async () => undefined)
    };
    const recorded: string[] = [];
    const service = new SmugMugIntegrationService(publishingGateway, {
      importReference: async () => undefined, findAssetByChecksum: async () => undefined,
      quarantine: async () => ({ assetId: 'asset', scanPassed: true })
    }, undefined, {
      load: async (_creatorId, workId) => ({ body: Buffer.from(workId), filename: `${workId}.jpg`, mimeType: 'image/jpeg', title: workId, keywords: [] }),
      record: async ({ workId }) => { recorded.push(workId); },
      loadMetadata: async (_connectionId, _creatorId, workId) => ({ remoteUri: `/api/v2/image/${workId}`, title: workId, keywords: [] }),
      recordMetadataSync: async () => undefined
    });
    const started = await service.start('user-1', 'creator-1');
    await service.callback(started.connection.oauthState, 'verifier');
    await service.repository.mergeCollections(started.connection.id, [{ remoteId: 'gallery-1', remoteUri: '/api/v2/album/gallery-1', kind: 'GALLERY', title: 'Gallery', position: 0, privacy: {} }]);
    const result = await service.publishSelected(started.connection.id, 'user-1', 'gallery-1', ['work-1', 'work-1', 'work-2']);
    expect(result.results).toHaveLength(2);
    expect(recorded).toEqual(['work-1', 'work-2']);
    expect(publishingGateway.publish).toHaveBeenCalledTimes(2);
    const synced = await service.syncSelectedMetadata(started.connection.id, 'user-1', ['work-1']);
    expect(synced.results).toEqual([{ workId: 'work-1', status: 'updated' }]);
    expect(publishingGateway.updateMetadata).toHaveBeenCalledWith('encrypted:access', expect.objectContaining({ remoteUri: '/api/v2/image/work-1' }));
  });
});
