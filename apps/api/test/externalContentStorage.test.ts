import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { AppConfig } from '../src/config';
import { storeExternalContent } from '../src/externalContentStorage';

describe('external content storage', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ubeeq-external-content-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('retains the existing version when downloaded bytes have the same checksum', async () => {
    const body = Buffer.from('same provider bytes');
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: async () => body,
      headers: new Headers({ 'content-type': 'image/jpeg', etag: 'provider-etag' })
    } as unknown as Response);
    const config = {
      localMediaDirectory: directory,
      externalContentMaxBytes: 1024,
      awsRegion: 'ca-central-1',
      mediaBucket: 'test'
    } as AppConfig;
    const input = {
      tenantId: 'test',
      userId: 'user-1',
      creatorIdentityId: 'creator-1',
      assetId: 'asset-1',
      externalContentId: 'deviation-1',
      sourceUrl: 'https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/source.jpg'
    };

    const first = await storeExternalContent(config, input);
    const second = await storeExternalContent(config, {
      ...input,
      existingChecksumSha256: first.checksumSha256,
      existingObjectKey: first.objectKey,
      existingThumbnailObjectKey: first.thumbnailObjectKey
    });

    expect(first.objectKey).toContain(`/versions/${first.checksumSha256}/`);
    expect(second).toMatchObject({
      objectKey: first.objectKey,
      checksumSha256: first.checksumSha256,
      unchanged: true,
      etag: 'provider-etag'
    });
  });
});
