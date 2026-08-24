import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from './config';

export interface QuarantinedFlickrSource {
  objectKey: string;
  checksumSha256: string;
  mimeType: string;
  sizeBytes: number;
  /** `pending` until the deployment's standard safety scanner promotes it. */
  scanOutcome: 'pending' | 'clean' | 'blocked';
}

const approvedUrl = (value: string) => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'live.staticflickr.com' || host.endsWith('.staticflickr.com'));
  } catch { return false; }
};

const detectedMime = (body: Buffer): string | undefined => {
  if (body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (body.subarray(0, 6).toString('ascii') === 'GIF87a' || body.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
};

/** Downloads creator-authorized originals into private quarantine and validates bytes before returning. */
export const quarantineFlickrSource = async (config: AppConfig, input: {
  creatorId: string; migrationId: string; remoteId: string; sourceUrl: string;
}, fetcher: typeof fetch = fetch): Promise<QuarantinedFlickrSource> => {
  if (!approvedUrl(input.sourceUrl)) throw new Error('FLICKR_SOURCE_URL_REJECTED');
  const response = await fetcher(input.sourceUrl, { redirect: 'error' });
  if (!response.ok) throw new Error(response.status >= 500 ? 'FLICKR_SOURCE_TEMPORARILY_UNAVAILABLE' : 'FLICKR_SOURCE_UNAVAILABLE');
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > config.externalContentMaxBytes) throw new Error('FLICKR_SOURCE_TOO_LARGE');
  const body = Buffer.from(await response.arrayBuffer());
  if (!body.length || body.length > config.externalContentMaxBytes) throw new Error('FLICKR_SOURCE_TOO_LARGE');
  const mimeType = detectedMime(body);
  if (!mimeType) throw new Error('FLICKR_SOURCE_MIME_INVALID');
  const checksumSha256 = createHash('sha256').update(body).digest('hex');
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1];
  const objectKey = `quarantine/flickr/${config.tenantId}/${input.creatorId}/${input.migrationId}/${input.remoteId}/${checksumSha256}.${extension}`;
  if (config.localMediaDirectory) {
    const target = path.join(config.localMediaDirectory, objectKey); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, body);
  } else {
    await new S3Client({ region: config.awsRegion }).send(new PutObjectCommand({ Bucket: config.mediaBucket, Key: objectKey, Body: body,
      ContentType: mimeType, Metadata: { sha256: checksumSha256, source: 'flickr', quarantine: 'validated' } }));
  }
  return { objectKey, checksumSha256, mimeType, sizeBytes: body.length, scanOutcome: 'pending' };
};
