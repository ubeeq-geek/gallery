import { createHash } from 'node:crypto';
import type { ManagedProduct, ManagedRegion } from './regionalMedia';
import { requireRegionalDelivery, type RegionalDeliveryContext } from './regionalDelivery';

const safeSegment = (name: string, value: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} is not safe for a public delivery key`);
  return value;
};

const extensionFor = (contentType: string): string => {
  const extensions: Record<string, string> = {
    'image/avif': 'avif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/webm': 'webm'
  };
  const extension = extensions[contentType.toLowerCase()];
  if (!extension) throw new Error('Public derivative content type is not supported');
  return extension;
};

export interface RegionalPublicDerivativePublication {
  id: string;
  recordType: 'PUBLIC_DERIVATIVE_PUBLICATION';
  product: ManagedProduct;
  environment: string;
  dataHomeRegion: ManagedRegion;
  assetId: string;
  mediaVersionId: string;
  scanGroupId: string;
  sourceBucket: string;
  sourceObjectKey: string;
  destinationBucket: string;
  destinationObjectKey: string;
  contentHash: string;
  contentType: string;
  state: 'PUBLISHING' | 'PUBLISHED' | 'FAILED';
  createdAt: string;
  publishedAt?: string;
}

export interface RegionalPublicDeliveryRepository {
  /** Must conditionally create the publication and reject an existing id. */
  begin(publication: RegionalPublicDerivativePublication): Promise<void>;
  /** Must atomically mark the Asset PUBLISHED and append its regional audit event. */
  complete(publication: RegionalPublicDerivativePublication): Promise<void>;
  /** Records a failed attempt while leaving the Asset non-public. */
  fail(publication: RegionalPublicDerivativePublication, reason: string): Promise<void>;
}

export const regionalPublicationKey = (publicationId: string): string => `PUBLICATION#${publicationId}`;
export const regionalAssetKey = (assetId: string): string => `ASSET#${assetId}`;

export interface RegionalPublicDerivativeStore {
  copy(input: { sourceBucket: string; sourceObjectKey: string; destinationBucket: string; destinationObjectKey: string; contentType: string; contentHash: string }): Promise<void>;
  remove(input: { bucket: string; objectKey: string }): Promise<void>;
}

export interface PublishRegionalPublicDerivativeInput {
  product: ManagedProduct;
  environment: string;
  dataHomeRegion: ManagedRegion;
  assetId: string;
  mediaVersionId: string;
  scanGroupId: string;
  contentHash: string;
  contentType: string;
  sourceBucket: string;
  sourceObjectKey: string;
  expectedPrivateDerivativesBucket: string;
  publicDerivativesBucket: string;
  expectedPublicDerivativesBucket: string;
  delivery: Omit<RegionalDeliveryContext, 'product' | 'dataHomeRegion' | 'purpose' | 'publicDeliveryState'>;
}

/**
 * Promotes only a policy-eligible derivative from this cell's private derivative
 * bucket. Originals and quarantine objects can never be selected as the source.
 */
export const publishRegionalPublicDerivative = async (
  input: PublishRegionalPublicDerivativeInput,
  repository: RegionalPublicDeliveryRepository,
  store: RegionalPublicDerivativeStore,
  now = new Date().toISOString()
): Promise<RegionalPublicDerivativePublication> => {
  if (!input.environment.trim()) throw new Error('Publication environment is required');
  if (input.sourceBucket !== input.expectedPrivateDerivativesBucket) throw new Error('Public delivery source must be this cell\'s private derivatives bucket');
  if (input.publicDerivativesBucket !== input.expectedPublicDerivativesBucket) throw new Error('Public delivery destination must be this cell\'s public derivatives bucket');
  if (!input.sourceObjectKey || input.sourceObjectKey.startsWith('/') || input.sourceObjectKey.includes('..')) throw new Error('Private derivative object key is invalid');
  if (!/^[a-fA-F0-9]{64}$/.test(input.contentHash)) throw new Error('Public derivative requires an authoritative SHA-256');
  requireRegionalDelivery({ ...input.delivery, product: input.product, dataHomeRegion: input.dataHomeRegion, purpose: 'PUBLIC_DERIVATIVE', publicDeliveryState: 'ELIGIBLE' });

  const assetId = safeSegment('Asset identifier', input.assetId);
  const mediaVersionId = safeSegment('Media version identifier', input.mediaVersionId);
  const scanGroupId = safeSegment('Scan group identifier', input.scanGroupId);
  const extension = extensionFor(input.contentType);
  const identity = createHash('sha256').update([
    input.product, input.environment, input.dataHomeRegion, assetId, mediaVersionId,
    scanGroupId, input.contentHash
  ].join('\u0000')).digest('hex');
  const publication: RegionalPublicDerivativePublication = {
    id: `publication-${identity}`, recordType: 'PUBLIC_DERIVATIVE_PUBLICATION',
    product: input.product, environment: input.environment, dataHomeRegion: input.dataHomeRegion,
    assetId, mediaVersionId, scanGroupId, sourceBucket: input.sourceBucket,
    sourceObjectKey: input.sourceObjectKey, destinationBucket: input.publicDerivativesBucket,
    destinationObjectKey: `assets/${assetId}/${mediaVersionId}/${input.contentHash}.${extension}`,
    contentHash: input.contentHash.toLowerCase(), contentType: input.contentType.toLowerCase(),
    state: 'PUBLISHING', createdAt: now
  };

  await repository.begin(publication);
  try {
    await store.copy({
      sourceBucket: publication.sourceBucket, sourceObjectKey: publication.sourceObjectKey,
      destinationBucket: publication.destinationBucket, destinationObjectKey: publication.destinationObjectKey,
      contentType: publication.contentType, contentHash: publication.contentHash
    });
    const completed = { ...publication, state: 'PUBLISHED' as const, publishedAt: now };
    await repository.complete(completed);
    return completed;
  } catch (error) {
    // A copy can succeed before a metadata transaction fails. Always remove the
    // deterministic public object so a failed publication cannot remain served.
    await store.remove({ bucket: publication.destinationBucket, objectKey: publication.destinationObjectKey });
    await repository.fail(publication, error instanceof Error ? error.name : 'PublicationError');
    throw error;
  }
};
