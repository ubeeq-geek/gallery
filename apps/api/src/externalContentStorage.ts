import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from './config';
import { ExternalProviderError } from './externalPlatformProvider';

export interface HostedExternalContent {
  objectKey: string;
  thumbnailObjectKey?: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string;
}

export interface HostedUbeeqWorkImage extends HostedExternalContent {}

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

const writeStoredObject = async (config: AppConfig, key: string, body: Buffer, contentType: string, metadata?: Record<string, string>): Promise<void> => {
  if (config.localMediaDirectory) {
    const target = path.join(config.localMediaDirectory, key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    return;
  }
  await new S3Client({ region: config.awsRegion }).send(new PutObjectCommand({
    Bucket: config.mediaBucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
    Metadata: metadata
  }));
};

const createThumbnail = async (body: Buffer): Promise<Buffer | undefined> => {
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(body, { limitInputPixels: false })
      .rotate()
      .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } catch {
    return undefined;
  }
};

export const storeUbeeqWorkImage = async (
  config: AppConfig,
  input: { userId: string; creatorIdentityId: string; assetId: string; contentType: string; body: Buffer }
): Promise<HostedUbeeqWorkImage> => {
  if (!input.contentType.startsWith('image/')) throw new Error('Only image uploads are supported for works right now.');
  if (input.body.byteLength > config.externalContentMaxBytes) throw new Error('This image exceeds the configured upload limit.');
  const objectKey = `ubeeq-works/${input.userId}/${input.creatorIdentityId}/${input.assetId}/source${extensionForContentType(input.contentType)}`;
  const thumbnailObjectKey = `ubeeq-works/${input.userId}/${input.creatorIdentityId}/${input.assetId}/thumbnail.jpg`;
  const checksumSha256 = createHash('sha256').update(input.body).digest('hex');
  await writeStoredObject(config, objectKey, input.body, input.contentType, { sha256: checksumSha256, source: 'ubeeq-upload' });
  const thumbnail = await createThumbnail(input.body);
  if (thumbnail) await writeStoredObject(config, thumbnailObjectKey, thumbnail, 'image/jpeg', { source: 'ubeeq-thumbnail' });
  return {
    objectKey,
    thumbnailObjectKey: thumbnail ? thumbnailObjectKey : undefined,
    contentType: input.contentType,
    byteSize: input.body.byteLength,
    checksumSha256
  };
};

export const readStoredUbeeqWorkImage = async (config: AppConfig, objectKey: string): Promise<Buffer> => {
  if (config.localMediaDirectory) return readFile(path.join(config.localMediaDirectory, objectKey));
  const response = await new S3Client({ region: config.awsRegion }).send(new GetObjectCommand({ Bucket: config.mediaBucket, Key: objectKey }));
  if (!response.Body) throw new Error('The stored work image is unavailable.');
  return Buffer.from(await response.Body.transformToByteArray());
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
