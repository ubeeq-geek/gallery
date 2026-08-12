import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from './config';
import { ExternalProviderError } from './externalPlatformProvider';

export interface HostedExternalContent {
  objectKey: string;
  thumbnailObjectKey?: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string;
}

const isApprovedDeviantArtContentUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && (hostname.endsWith('.deviantart.com') || hostname.endsWith('.deviantart.net') || hostname.endsWith('.wixmp.com'));
  } catch {
    return false;
  }
};

const extensionForContentType = (contentType: string): string => {
  if (contentType.includes('jpeg')) return '.jpg';
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('mp4')) return '.mp4';
  return '';
};

export const storeExternalContent = async (
  config: AppConfig,
  input: { userId: string; creatorIdentityId: string; assetId: string; externalContentId: string; sourceUrl: string; contentType?: string; expectedByteSize?: number }
): Promise<HostedExternalContent> => {
  if (!isApprovedDeviantArtContentUrl(input.sourceUrl)) {
    throw new ExternalProviderError('DeviantArt did not provide an approved source file URL', 'invalid_response');
  }
  if (input.expectedByteSize && input.expectedByteSize > config.externalContentMaxBytes) {
    throw new ExternalProviderError('This source file exceeds the configured Ubeeq Space backup limit', 'unsupported');
  }
  let response: Response;
  try {
    response = await fetch(input.sourceUrl);
  } catch {
    throw new ExternalProviderError('Unable to download the source file from DeviantArt', 'temporarily_unavailable');
  }
  if (!response.ok) {
    throw new ExternalProviderError('DeviantArt did not make the source file available for download', response.status >= 500 ? 'temporarily_unavailable' : 'invalid_response');
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > config.externalContentMaxBytes) {
    throw new ExternalProviderError('This source file exceeds the configured Ubeeq Space backup limit', 'unsupported');
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > config.externalContentMaxBytes) {
    throw new ExternalProviderError('This source file exceeds the configured Ubeeq Space backup limit', 'unsupported');
  }
  const contentType = input.contentType || response.headers.get('content-type') || 'application/octet-stream';
  const objectKey = `external-content/${input.userId}/${input.creatorIdentityId}/${input.assetId}/${input.externalContentId}${extensionForContentType(contentType)}`;
  const thumbnailObjectKey = `external-content/${input.userId}/${input.creatorIdentityId}/${input.assetId}/${input.externalContentId}/thumbnail.jpg`;
  const checksumSha256 = createHash('sha256').update(body).digest('hex');
  if (config.localMediaDirectory) {
    const target = path.join(config.localMediaDirectory, objectKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  } else {
    await new S3Client({ region: config.awsRegion }).send(new PutObjectCommand({
      Bucket: config.mediaBucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
      Metadata: { sha256: checksumSha256, source: 'deviantart' }
    }));
  }

  let storedThumbnailObjectKey: string | undefined;
  if (contentType.startsWith('image/')) {
    try {
      const sharp = (await import('sharp')).default;
      const thumbnail = await sharp(body, { limitInputPixels: false })
        .rotate()
        .resize(160, 160, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer();
      if (config.localMediaDirectory) {
        const target = path.join(config.localMediaDirectory, thumbnailObjectKey);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, thumbnail);
      } else {
        await new S3Client({ region: config.awsRegion }).send(new PutObjectCommand({
          Bucket: config.mediaBucket,
          Key: thumbnailObjectKey,
          Body: thumbnail,
          ContentType: 'image/jpeg',
          CacheControl: 'public, max-age=31536000, immutable',
          Metadata: { source: 'deviantart-thumbnail' }
        }));
      }
      storedThumbnailObjectKey = thumbnailObjectKey;
    } catch {
      // A source backup remains useful even when it cannot be decoded into a preview.
    }
  }
  return { objectKey, thumbnailObjectKey: storedThumbnailObjectKey, contentType, byteSize: body.byteLength, checksumSha256 };
};
