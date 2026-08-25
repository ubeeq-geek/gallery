import sharp from 'sharp';
import { planRegionalImageIngest } from '../src/regionalImageIngest';

describe('regional image ingest', () => {
  it('decodes bytes, calculates the authoritative hash, and plans every required scan', async () => {
    const bytes = await sharp({ create: { width: 10, height: 20, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    const plan = await planRegionalImageIngest({ product: 'eversally', environment: 'production', region: 'ap-south-1', assetId: 'asset', mediaVersionId: 'version', quarantineBucket: 'quarantine', quarantineObjectKey: 'uploads/image', bytes, mimeType: 'image/jpeg' });
    expect(plan.mediaVersion).toMatchObject({ width: 10, height: 20, validationProfile: 'IMAGE_INGEST_V1', region: 'ap-south-1' });
    expect(plan.mediaVersion.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.scanJobs.map(({ type }) => type)).toEqual(['IMAGE_MODERATION', 'FACE_AGE']);
    expect(plan.scanJobs.every(({ sourceBucket }) => sourceBucket === 'quarantine')).toBe(true);
  });
  it('rejects MIME types outside the versioned validation profile', async () => {
    await expect(planRegionalImageIngest({ product: 'eversally', environment: 'production', region: 'us-east-2', assetId: 'a', mediaVersionId: 'v', quarantineBucket: 'q', quarantineObjectKey: 'x', bytes: Buffer.from('x'), mimeType: 'image/svg+xml' })).rejects.toThrow('Unsupported image MIME type');
  });
});
