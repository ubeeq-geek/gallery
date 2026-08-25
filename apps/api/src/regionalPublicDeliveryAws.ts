import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, CopyObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  regionalAssetKey,
  regionalPublicationKey,
  type RegionalPublicDeliveryRepository,
  type RegionalPublicDerivativePublication,
  type RegionalPublicDerivativeStore
} from './regionalPublicDelivery';

const copySource = (bucket: string, key: string): string =>
  `${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;

/** S3 adapter that preserves no source metadata and writes bounded cache headers. */
export const s3RegionalPublicDerivativeStore = (client: Pick<S3Client, 'send'>): RegionalPublicDerivativeStore => ({
  copy: async (input) => {
    await client.send(new CopyObjectCommand({
      Bucket: input.destinationBucket,
      Key: input.destinationObjectKey,
      CopySource: copySource(input.sourceBucket, input.sourceObjectKey),
      ContentType: input.contentType,
      CacheControl: 'public, max-age=300, s-maxage=300, must-revalidate',
      MetadataDirective: 'REPLACE',
      // Do not set an encryption key here: the destination bucket's regional
      // customer-managed KMS default must be used rather than the aws/s3 key.
      Metadata: { sha256: input.contentHash }
    }));
  },
  remove: async ({ bucket, objectKey }) => {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
  }
});

/**
 * Stores the publication, Asset delivery state, and audit records in one cell.
 * All state transitions are conditional, so a stale policy result or replay
 * cannot publish a different Asset version.
 */
export const dynamoRegionalPublicDeliveryRepository = (input: {
  client: DynamoDBDocumentClient;
  metadataTableName: string;
  auditTableName: string;
}): RegionalPublicDeliveryRepository => ({
  begin: async (publication) => {
    await input.client.send(new TransactWriteCommand({ TransactItems: [
      {
        ConditionCheck: {
          TableName: input.metadataTableName,
          Key: { PK: regionalAssetKey(publication.assetId) },
          ConditionExpression: '#product = :product AND #environment = :environment AND dataHomeRegion = :region AND canonicalRegion = :region AND publicDeliveryState = :eligible AND currentScanGroupId = :scanGroupId AND currentMediaVersionId = :mediaVersionId',
          ExpressionAttributeNames: { '#product': 'product', '#environment': 'environment' },
          ExpressionAttributeValues: { ':product': publication.product, ':environment': publication.environment, ':region': publication.dataHomeRegion, ':eligible': 'ELIGIBLE', ':scanGroupId': publication.scanGroupId, ':mediaVersionId': publication.mediaVersionId }
        }
      },
      {
        Put: {
          TableName: input.auditTableName,
          Item: { ...publication, PK: regionalPublicationKey(publication.id) },
          ConditionExpression: 'attribute_not_exists(PK)'
        }
      }
    ] }));
  },
  complete: async (publication) => {
    if (publication.state !== 'PUBLISHED' || !publication.publishedAt) throw new Error('Only a completed publication can be committed');
    await input.client.send(new TransactWriteCommand({ TransactItems: [
      {
        Update: {
          TableName: input.auditTableName,
          Key: { PK: regionalPublicationKey(publication.id) },
          UpdateExpression: 'SET #state = :published, publishedAt = :publishedAt',
          ConditionExpression: '#state = :publishing AND scanGroupId = :scanGroupId AND contentHash = :contentHash',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':published': 'PUBLISHED', ':publishing': 'PUBLISHING', ':publishedAt': publication.publishedAt, ':scanGroupId': publication.scanGroupId, ':contentHash': publication.contentHash }
        }
      },
      {
        Update: {
          TableName: input.metadataTableName,
          Key: { PK: regionalAssetKey(publication.assetId) },
          UpdateExpression: 'SET publicDeliveryState = :published, publicDerivativeKey = :key, publicDeliveryPublishedAt = :publishedAt',
          ConditionExpression: '#product = :product AND #environment = :environment AND dataHomeRegion = :region AND canonicalRegion = :region AND publicDeliveryState = :eligible AND currentScanGroupId = :scanGroupId AND currentMediaVersionId = :mediaVersionId',
          ExpressionAttributeNames: { '#product': 'product', '#environment': 'environment' },
          ExpressionAttributeValues: { ':product': publication.product, ':environment': publication.environment, ':region': publication.dataHomeRegion, ':eligible': 'ELIGIBLE', ':published': 'PUBLISHED', ':key': publication.destinationObjectKey, ':publishedAt': publication.publishedAt, ':scanGroupId': publication.scanGroupId, ':mediaVersionId': publication.mediaVersionId }
        }
      },
      {
        Put: {
          TableName: input.auditTableName,
          Item: {
            PK: `AUDIT#${randomUUID()}`, recordType: 'REGIONAL_PUBLICATION_AUDIT',
            product: publication.product, environment: publication.environment,
            dataHomeRegion: publication.dataHomeRegion, assetId: publication.assetId,
            mediaVersionId: publication.mediaVersionId, scanGroupId: publication.scanGroupId,
            action: 'regional_asset.published', publicationId: publication.id,
            createdAt: publication.publishedAt
          }
        }
      }
    ] }));
  },
  fail: async (publication, reason) => {
    await input.client.send(new UpdateCommand({
      TableName: input.auditTableName,
      Key: { PK: regionalPublicationKey(publication.id) },
      UpdateExpression: 'SET #state = :failed, failureReason = :reason, failedAt = :failedAt',
      ConditionExpression: '#state = :publishing',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':failed': 'FAILED', ':publishing': 'PUBLISHING', ':reason': reason, ':failedAt': new Date().toISOString() }
    }));
  }
});

export const assertPublicationCell = (
  publication: RegionalPublicDerivativePublication,
  cell: Pick<RegionalPublicDerivativePublication, 'product' | 'environment' | 'dataHomeRegion'>
): void => {
  if (publication.product !== cell.product || publication.environment !== cell.environment || publication.dataHomeRegion !== cell.dataHomeRegion) {
    throw new Error('Cross-cell public derivative publication rejected');
  }
};
