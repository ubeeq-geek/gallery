import { mkdtemp, readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadConfig } from '../src/config';
import { quarantineFlickrSource } from '../src/flickrSourceMigration';

describe('Flickr source quarantine', () => {
  it('checks the provider host, byte signature, checksum, and private quarantine key', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'flickr-source-'));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]);
    const fetcher = jest.fn(async () => new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })) as unknown as typeof fetch;
    const stored = await quarantineFlickrSource({ ...loadConfig(), tenantId: 'tenant', localMediaDirectory: directory }, {
      creatorId: 'creator', migrationId: 'migration', remoteId: 'photo', sourceUrl: 'https://live.staticflickr.com/server/source.jpg'
    }, fetcher);
    expect(stored).toMatchObject({ mimeType: 'image/jpeg', sizeBytes: jpeg.length, scanOutcome: 'pending' });
    expect(stored.objectKey).toMatch(/^quarantine\/flickr\/tenant\/creator\/migration\/photo\//);
    await expect(readFile(path.join(directory, stored.objectKey))).resolves.toEqual(jpeg);
  });

  it('rejects unapproved hosts and content whose bytes are not a supported image', async () => {
    const config = { ...loadConfig(), localMediaDirectory: os.tmpdir() };
    await expect(quarantineFlickrSource(config, { creatorId: 'c', migrationId: 'm', remoteId: 'p', sourceUrl: 'https://example.com/source.jpg' })).rejects.toThrow('FLICKR_SOURCE_URL_REJECTED');
    const fetcher = jest.fn(async () => new Response('not an image', { status: 200 })) as unknown as typeof fetch;
    await expect(quarantineFlickrSource(config, { creatorId: 'c', migrationId: 'm', remoteId: 'p', sourceUrl: 'https://live.staticflickr.com/source.jpg' }, fetcher)).rejects.toThrow('FLICKR_SOURCE_MIME_INVALID');
  });
});
