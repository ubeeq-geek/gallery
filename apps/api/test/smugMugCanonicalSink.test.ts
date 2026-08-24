import { mkdtemp, rm } from 'fs/promises';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import type { AppConfig } from '../src/config';
import { InMemoryStore } from '../src/inMemoryStore';
import { SmugMugCanonicalSink } from '../src/smugMugCanonicalSink';

describe('SmugMug canonical migration sink', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'smugmug-sink-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('stages private canonical references and upgrades a scanned source without Discovery', async () => {
    const store = new InMemoryStore();
    const config = { tenantId: 'tenant-1', localMediaDirectory: directory, externalContentMaxBytes: 1024, awsRegion: 'ca-central-1', mediaBucket: 'test' } as AppConfig;
    const scanner = { scan: jest.fn(async () => ({ safe: true })) };
    const sink = new SmugMugCanonicalSink(store, config, scanner);
    const remote = {
      remoteId: 'image-1', galleryId: 'gallery-1', url: 'https://photos.test/image-1', filename: 'original.jpg', title: 'Portrait', caption: 'Caption',
      keywords: ['portrait'], position: 3, byteSize: 4, width: 10, height: 20, mimeType: 'image/jpeg', originalAvailable: true,
      sourceUrl: 'https://photos.test/original.jpg', privacy: { visibility: 'Private' }, licence: { copyright: 'Creator' }, exif: { Camera: 'Test' }
    };
    await sink.importReference({ connectionId: 'connection-1', creatorId: 'creator-1', image: remote, collections: [
      { remoteId: 'gallery-1', kind: 'GALLERY', title: 'Clients', position: 2, privacy: {} }
    ] });
    const works = await store.listWorksByCreator('tenant-1', 'creator-1');
    expect(works).toHaveLength(1);
    expect(works[0]).toMatchObject({ status: 'draft', origin: { platform: 'smugmug', remoteId: 'image-1' } });
    expect(await store.getWorkDiscoveryParticipation('tenant-1', works[0].workId)).toBeNull();
    expect((await store.listPublicationsByWork('tenant-1', works[0].workId))[0]).toMatchObject({ destination: 'smugmug', visibility: 'private', remoteId: 'image-1' });

    const body = Buffer.from('safe');
    const migrated = await sink.quarantine({ connectionId: 'connection-1', creatorId: 'creator-1', image: remote, body, mimeType: 'image/jpeg', checksum: createHash('sha256').update(body).digest('hex') });
    expect(migrated.scanPassed).toBe(true);
    expect(scanner.scan).toHaveBeenCalledTimes(1);
    const upgraded = await store.getWork('tenant-1', works[0].workId);
    expect(upgraded).toMatchObject({ status: 'ready', primaryAssetId: migrated.assetId });
  });

  it('does not persist quarantined bytes when scanning fails', async () => {
    const store = new InMemoryStore();
    const config = { tenantId: 'tenant-1', localMediaDirectory: directory, externalContentMaxBytes: 1024, awsRegion: 'ca-central-1', mediaBucket: 'test' } as AppConfig;
    const sink = new SmugMugCanonicalSink(store, config, { scan: async () => ({ safe: false, reason: 'blocked' }) });
    const result = await sink.quarantine({ connectionId: 'connection-1', creatorId: 'creator-1', body: Buffer.from('unsafe'), mimeType: 'image/jpeg', checksum: 'checksum', image: {
      remoteId: 'image-2', galleryId: 'gallery-1', url: 'https://photos.test/image-2', keywords: [], position: 0, originalAvailable: true, privacy: {}, licence: {}
    } });
    expect(result.scanPassed).toBe(false);
    expect(await store.getCanonicalAsset('tenant-1', result.assetId)).toBeNull();
  });
});
