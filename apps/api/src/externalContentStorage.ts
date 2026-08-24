import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from './config';
import { brandForConfig } from './brand';
import { ExternalProviderError } from './externalPlatformProvider';

export interface HostedExternalContent {
  objectKey: string;
  thumbnailObjectKey?: string;
  contentType: string;
  byteSize: number;
  checksumSha256: string;
  unchanged?: boolean;
  etag?: string;
  lastModified?: string;
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
  input: { tenantId: string; creatorId: string; assetId: string; contentType: string; body: Buffer }
): Promise<HostedUbeeqWorkImage> => {
  if (!input.contentType.startsWith('image/')) throw new Error('Only image uploads are supported for works right now.');
  if (input.body.byteLength > config.externalContentMaxBytes) throw new Error('This image exceeds the configured upload limit.');
  const objectKey = `works/${input.tenantId}/${input.creatorId}/${input.assetId}/source${extensionForContentType(input.contentType)}`;
  const thumbnailObjectKey = `works/${input.tenantId}/${input.creatorId}/${input.assetId}/thumbnail.jpg`;
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

/** Opens canonical storage without materializing large audio/video files. */
export const openStoredUbeeqWorkStream = async (config: AppConfig, objectKey: string): Promise<NodeJS.ReadableStream> => {
  if (config.localMediaDirectory) {
    const base = path.resolve(config.localMediaDirectory);
    const target = path.resolve(base, objectKey);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error('The stored work key is invalid.');
    return createReadStream(target);
  }
  const response = await new S3Client({ region: config.awsRegion }).send(new GetObjectCommand({ Bucket: config.mediaBucket, Key: objectKey }));
  if (!response.Body) throw new Error('The stored work is unavailable.');
  if (response.Body instanceof Readable) return response.Body;
  return Readable.fromWeb(response.Body.transformToWebStream() as never);
};

export const storeExternalContent = async (
  config: AppConfig,
  input: {
    tenantId: string;
    userId: string;
    creatorIdentityId: string;
    assetId: string;
    externalContentId: string;
    sourceUrl: string;
    contentType?: string;
    expectedByteSize?: number;
    existingChecksumSha256?: string;
    existingObjectKey?: string;
    existingThumbnailObjectKey?: string;
  }
): Promise<HostedExternalContent> => {
  if (!isApprovedDeviantArtContentUrl(input.sourceUrl)) {
    throw new ExternalProviderError('DeviantArt did not provide an approved source file URL', 'invalid_response');
  }
  if (input.expectedByteSize && input.expectedByteSize > config.externalContentMaxBytes) {
    throw new ExternalProviderError(`This source file exceeds the configured ${brandForConfig(config).workspaceFullName} backup limit`, 'unsupported');
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
    throw new ExternalProviderError(`This source file exceeds the configured ${brandForConfig(config).workspaceFullName} backup limit`, 'unsupported');
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > config.externalContentMaxBytes) {
    throw new ExternalProviderError(`This source file exceeds the configured ${brandForConfig(config).workspaceFullName} backup limit`, 'unsupported');
  }
  const contentType = input.contentType || response.headers.get('content-type') || 'application/octet-stream';
  const checksumSha256 = createHash('sha256').update(body).digest('hex');
  const etag = response.headers.get('etag') || undefined;
  const lastModified = response.headers.get('last-modified') || undefined;
  if (input.existingChecksumSha256 === checksumSha256 && input.existingObjectKey) {
    return {
      objectKey: input.existingObjectKey,
      thumbnailObjectKey: input.existingThumbnailObjectKey,
      contentType,
      byteSize: body.byteLength,
      checksumSha256,
      unchanged: true,
      etag,
      lastModified
    };
  }

  const versionPrefix = `external-content/${input.tenantId}/${input.userId}/${input.creatorIdentityId}/${input.assetId}/${input.externalContentId}/versions/${checksumSha256}`;
  const objectKey = `${versionPrefix}/source${extensionForContentType(contentType)}`;
  const thumbnailObjectKey = `${versionPrefix}/thumbnail.jpg`;
  await writeStoredObject(config, objectKey, body, contentType, { sha256: checksumSha256, source: 'deviantart' });

  let storedThumbnailObjectKey: string | undefined;
  if (contentType.startsWith('image/')) {
    try {
      const sharp = (await import('sharp')).default;
      const thumbnail = await sharp(body, { limitInputPixels: false })
        .rotate()
        .resize(160, 160, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer();
      await writeStoredObject(config, thumbnailObjectKey, thumbnail, 'image/jpeg', { source: 'deviantart-thumbnail' });
      storedThumbnailObjectKey = thumbnailObjectKey;
    } catch {
      // A source backup remains useful even when it cannot be decoded into a preview.
    }
  }
  return {
    objectKey,
    thumbnailObjectKey: storedThumbnailObjectKey,
    contentType,
    byteSize: body.byteLength,
    checksumSha256,
    unchanged: false,
    etag,
    lastModified
  };
};
