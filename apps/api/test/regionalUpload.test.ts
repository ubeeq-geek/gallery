import { authorizeRegionalUpload } from '../src/regionalUpload';

const request = { creatorId: 'creator', spaceId: 'space', assetId: 'asset', mediaVersionId: 'version', mediaType: 'image', contentType: 'image/jpeg', contentLength: 1024 } as const;
const cell = { product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2', quarantineBucket: 'quarantine' } as const;

describe('regional upload authorization', () => {
  it('persists authorization before signing a cell-local quarantine URL', async () => {
    const authorize = jest.fn(async (value) => value);
    const sign = jest.fn().mockResolvedValue('https://upload.example');
    const result = await authorizeRegionalUpload(request, cell, { authorize }, { sign }, new Date('2026-08-25T00:00:00Z'));
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ quarantineObjectKey: 'images/asset/version/source', state: 'AUTHORIZED', dataHomeRegion: 'us-east-2' }));
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'quarantine', contentLength: 1024, expiresInSeconds: 900 }));
    expect(result.uploadUrl).toBe('https://upload.example');
  });

  it('uses the video quarantine namespace', async () => {
    const authorize = jest.fn(async (value) => value);
    const result = await authorizeRegionalUpload({ ...request, mediaType: 'video', contentType: 'video/mp4' }, cell, { authorize }, { sign: jest.fn().mockResolvedValue('url') });
    expect(result.authorization.quarantineObjectKey).toBe('videos/asset/version/source');
  });

  it('rejects unsupported types, unsafe identifiers, and excessive sizes before persistence', async () => {
    const authorize = jest.fn(); const sign = jest.fn();
    await expect(authorizeRegionalUpload({ ...request, contentType: 'text/html' }, cell, { authorize }, { sign })).rejects.toThrow('not supported');
    await expect(authorizeRegionalUpload({ ...request, assetId: '../asset' }, cell, { authorize }, { sign })).rejects.toThrow('assetId is invalid');
    await expect(authorizeRegionalUpload({ ...request, contentLength: 26 * 1024 * 1024 }, cell, { authorize }, { sign })).rejects.toThrow('length is invalid');
    expect(authorize).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
  });
});
