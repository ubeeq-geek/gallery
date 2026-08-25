import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { planRegionalScans, type ManagedProduct, type ManagedRegion, type MediaVersion, type RegionalScanJob } from './regionalMedia';

export interface ImageValidationProfile {
  profile: string;
  maximumBytes: number;
  maximumPixels: number;
  allowedMimeTypes: string[];
}

export const DEFAULT_IMAGE_VALIDATION_PROFILE: ImageValidationProfile = Object.freeze({ profile: 'IMAGE_INGEST_V1', maximumBytes: 50 * 1024 * 1024, maximumPixels: 100_000_000, allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'] });

export interface RegionalImageIngestPlan {
  mediaVersion: MediaVersion & { mimeType: string; width: number; height: number; validationProfile: string };
  scanJobs: RegionalScanJob[];
}

/** Decodes quarantined bytes before planning scans; caller-provided hashes or dimensions are never trusted. */
export const planRegionalImageIngest = async (input: { product: ManagedProduct; environment: string; region: ManagedRegion; assetId: string; mediaVersionId: string; quarantineBucket: string; quarantineObjectKey: string; bytes: Uint8Array; mimeType: string; ingestSource?: MediaVersion['ingestSource']; specialistHashProvider?: string; profile?: ImageValidationProfile }): Promise<RegionalImageIngestPlan> => {
  const profile = input.profile || DEFAULT_IMAGE_VALIDATION_PROFILE;
  if (!profile.allowedMimeTypes.includes(input.mimeType)) throw new Error('Unsupported image MIME type');
  if (!input.bytes.byteLength || input.bytes.byteLength > profile.maximumBytes) throw new Error('Image size exceeds the active validation profile');
  const metadata = await sharp(input.bytes, { failOn: 'error', limitInputPixels: profile.maximumPixels }).metadata();
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error('Image decoder did not produce valid dimensions');
  const mediaVersion: RegionalImageIngestPlan['mediaVersion'] = {
    id: input.mediaVersionId, assetId: input.assetId, sha256: createHash('sha256').update(input.bytes).digest('hex'), perceptualFingerprintRefs: [],
    region: input.region, ingestSource: input.ingestSource || 'creator_upload', scanRequiredAt: new Date().toISOString(), mediaType: 'image',
    mimeType: input.mimeType, width: metadata.width, height: metadata.height, validationProfile: profile.profile
  };
  return { mediaVersion, scanJobs: planRegionalScans(input.product, input.environment, mediaVersion, { bucket: input.quarantineBucket, objectKey: input.quarantineObjectKey, specialistHashProvider: input.specialistHashProvider }, 'REKOGNITION_IMAGE_V1') };
};
