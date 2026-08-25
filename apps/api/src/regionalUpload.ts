import { randomUUID } from 'node:crypto';
import type { ManagedProduct, ManagedRegion } from './regionalMedia';

export type RegionalUploadMediaType = 'image' | 'video';

export interface RegionalUploadRequest {
  creatorId: string;
  spaceId: string;
  assetId: string;
  mediaVersionId: string;
  mediaType: RegionalUploadMediaType;
  contentType: string;
  contentLength: number;
}

export interface RegionalUploadAuthorization {
  id: string;
  recordType: 'REGIONAL_UPLOAD_AUTHORIZATION';
  product: ManagedProduct;
  environment: string;
  dataHomeRegion: ManagedRegion;
  creatorId: string;
  spaceId: string;
  assetId: string;
  mediaVersionId: string;
  mediaType: RegionalUploadMediaType;
  contentType: string;
  contentLength: number;
  quarantineBucket: string;
  quarantineObjectKey: string;
  state: 'AUTHORIZED';
  createdAt: string;
  expiresAt: string;
  expiresAtEpochSeconds: number;
}

export interface RegionalUploadRepository {
  authorize(input: RegionalUploadAuthorization): Promise<RegionalUploadAuthorization>;
}

export interface RegionalUploadSigner {
  sign(input: { bucket: string; objectKey: string; contentType: string; contentLength: number; expiresInSeconds: number }): Promise<string>;
}

const identifiers = /^[A-Za-z0-9_-]{1,128}$/;
const contentTypes: Record<RegionalUploadMediaType, ReadonlySet<string>> = {
  image: new Set(['image/avif', 'image/jpeg', 'image/png', 'image/webp']),
  video: new Set(['video/mp4', 'video/quicktime', 'video/webm'])
};
const maximumBytes: Record<RegionalUploadMediaType, number> = { image: 25 * 1024 * 1024, video: 5 * 1024 * 1024 * 1024 };

/** Creates a cell-local, single-media-version upload authorization before any bytes are accepted. */
export const authorizeRegionalUpload = async (
  request: RegionalUploadRequest,
  cell: { product: ManagedProduct; environment: string; dataHomeRegion: ManagedRegion; quarantineBucket: string },
  repository: RegionalUploadRepository,
  signer: RegionalUploadSigner,
  now = new Date()
): Promise<{ authorization: RegionalUploadAuthorization; uploadUrl: string }> => {
  for (const [name, value] of Object.entries({ creatorId: request.creatorId, spaceId: request.spaceId, assetId: request.assetId, mediaVersionId: request.mediaVersionId })) {
    if (!identifiers.test(value)) throw new Error(`${name} is invalid`);
  }
  if (!cell.environment.trim()) throw new Error('Upload environment is required');
  if (!contentTypes[request.mediaType]?.has(request.contentType.toLowerCase())) throw new Error('Upload content type is not supported');
  if (!Number.isSafeInteger(request.contentLength) || request.contentLength <= 0 || request.contentLength > maximumBytes[request.mediaType]) throw new Error('Upload content length is invalid');
  const createdAt = now.toISOString();
  const expiresInSeconds = 15 * 60;
  const expiresAtEpochSeconds = Math.floor(now.getTime() / 1000) + expiresInSeconds;
  const quarantineObjectKey = `${request.mediaType === 'image' ? 'images' : 'videos'}/${request.assetId}/${request.mediaVersionId}/source`;
  const proposed: RegionalUploadAuthorization = {
    id: `upload-${request.mediaVersionId}`, recordType: 'REGIONAL_UPLOAD_AUTHORIZATION',
    product: cell.product, environment: cell.environment, dataHomeRegion: cell.dataHomeRegion,
    ...request, contentType: request.contentType.toLowerCase(), quarantineBucket: cell.quarantineBucket,
    quarantineObjectKey, state: 'AUTHORIZED', createdAt,
    expiresAt: new Date(expiresAtEpochSeconds * 1000).toISOString(), expiresAtEpochSeconds
  };
  const authorization = await repository.authorize(proposed);
  const uploadUrl = await signer.sign({ bucket: authorization.quarantineBucket, objectKey: authorization.quarantineObjectKey, contentType: authorization.contentType, contentLength: authorization.contentLength, expiresInSeconds });
  return { authorization, uploadUrl };
};

export const regionalUploadAuditId = (): string => `AUDIT#${randomUUID()}`;
