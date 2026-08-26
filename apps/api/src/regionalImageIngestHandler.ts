import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import { planRegionalImageIngest, type RegionalImageIngestPlan } from './regionalImageIngest';
import { scanGroupManifestRecords, type ManagedProduct, type ManagedRegion } from './regionalMedia';
import { scanDispatchOutbox } from './regionalScanOutboxHandler';
import { dynamoRegionalBillingRepository, processingReservationKey } from './regionalBilling';

export interface RegionalImageIngestMessage { product: ManagedProduct; environment: string; dataHomeRegion: ManagedRegion; assetId: string; mediaVersionId: string; quarantineBucket: string; quarantineObjectKey: string; mimeType?: string; }
export interface RegionalImageIngestDependencies {
  authorize(message: RegionalImageIngestMessage): Promise<'AUTHORIZED' | 'CONSUMED' | void>;
  read(bucket: string, key: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  reserve?(message: RegionalImageIngestMessage, plan: RegionalImageIngestPlan): Promise<void>;
  release?(message: RegionalImageIngestMessage, scanGroupId: string, reason: string): Promise<void>;
  persistAndEnqueue(message: RegionalImageIngestMessage, plan: RegionalImageIngestPlan, source: { bytes: Uint8Array; mimeType: string }): Promise<void>;
  markUnavailable(message: RegionalImageIngestMessage, errorCode: string): Promise<void>;
  deferRetry(receiptHandle: string, receiveCount: number): Promise<void>;
}
const required = (name: string): string => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; };

const dependencies = (): RegionalImageIngestDependencies => {
  const region = required('DATA_HOME_REGION'); const tableName = required('SCAN_JOBS_TABLE'); const metadataTableName = required('METADATA_TABLE'); const billingTableName = required('BILLING_LEDGER_TABLE');
  const workQueueUrl = required('IMAGE_INGEST_QUEUE_URL'); const originalsBucket = required('ORIGINALS_BUCKET'); const privateDerivativesBucket = required('PRIVATE_DERIVATIVES_BUCKET');
  const s3 = new S3Client({ region }); const sqs = new SQSClient({ region }); const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region })); const billing = dynamoRegionalBillingRepository({ client: ddb, tableName: billingTableName });
  const putIdempotently = async (item: Record<string, unknown>): Promise<void> => {
    try { await ddb.send(new PutCommand({ TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(id)' })); }
    catch (error) {
      if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error;
      const existing = await ddb.send(new GetCommand({ TableName: tableName, Key: { id: item.id }, ConsistentRead: true }));
      if (!existing.Item || existing.Item.recordType !== item.recordType || (item.contentHash && existing.Item.contentHash !== item.contentHash)) throw error;
    }
  };
  return {
    authorize: async (message) => {
      const [asset, upload] = await Promise.all([
        ddb.send(new GetCommand({ TableName: metadataTableName, Key: { PK: `ASSET#${message.assetId}` }, ConsistentRead: true })),
        ddb.send(new GetCommand({ TableName: metadataTableName, Key: { PK: `UPLOAD#${message.mediaVersionId}` }, ConsistentRead: true }))
      ]);
      if (!asset.Item || asset.Item.product !== message.product || asset.Item.environment !== message.environment || asset.Item.dataHomeRegion !== message.dataHomeRegion || asset.Item.canonicalRegion !== message.dataHomeRegion) throw new Error('Image ingest is not authorized for this regional Asset');
      if (asset.Item.currentMediaVersionId && asset.Item.currentMediaVersionId !== message.mediaVersionId) throw new Error('Image ingest media version does not match the regional Asset');
      if (!upload.Item || !['AUTHORIZED', 'CONSUMED'].includes(upload.Item.state) || upload.Item.mediaType !== 'image' || upload.Item.assetId !== message.assetId || upload.Item.quarantineBucket !== message.quarantineBucket || upload.Item.quarantineObjectKey !== message.quarantineObjectKey || (upload.Item.state === 'AUTHORIZED' && upload.Item.expiresAtEpochSeconds <= Math.floor(Date.now() / 1000))) throw new Error('Image upload authorization is missing, expired, or mismatched');
      return upload.Item.state as 'AUTHORIZED' | 'CONSUMED';
    },
    read: async (bucket, key) => { const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })); if (!response.Body || !response.ContentType) throw new Error('Quarantined image body or MIME type is unavailable'); return { bytes: await response.Body.transformToByteArray(), mimeType: response.ContentType }; },
    reserve: async (message, plan) => {
      const upload = await ddb.send(new GetCommand({ TableName: metadataTableName, Key: { PK: `UPLOAD#${message.mediaVersionId}` }, ConsistentRead: true }));
      if (!upload.Item?.creatorId || !upload.Item?.spaceId) throw new Error('Upload billing identity is unavailable');
      await billing.reserve({ product: message.product, environment: message.environment, dataHomeRegion: message.dataHomeRegion, accountId: upload.Item.creatorId, creatorId: upload.Item.creatorId, spaceId: upload.Item.spaceId, assetId: message.assetId, mediaVersionId: message.mediaVersionId, scanGroupId: plan.scanJobs[0].scanGroupId, media: plan.mediaVersion });
    },
    release: async (message, scanGroupId, reason) => billing.release({ reservationId: processingReservationKey(message.mediaVersionId, scanGroupId), reason }),
    persistAndEnqueue: async (message, plan, source) => {
      const privateDerivativeObjectKey = `assets/${message.assetId}/${message.mediaVersionId}/image`;
      await Promise.all([
        s3.send(new PutObjectCommand({ Bucket: originalsBucket, Key: `assets/${message.assetId}/${message.mediaVersionId}/source`, Body: source.bytes, ContentType: source.mimeType, Metadata: { sha256: plan.mediaVersion.sha256 } })),
        s3.send(new PutObjectCommand({ Bucket: privateDerivativesBucket, Key: privateDerivativeObjectKey, Body: source.bytes, ContentType: source.mimeType, Metadata: { sha256: plan.mediaVersion.sha256 } }))
      ]);
      await putIdempotently({ recordType: 'MEDIA_VERSION', product: message.product, environment: message.environment, dataHomeRegion: message.dataHomeRegion, ...plan.mediaVersion });
      for (const manifest of scanGroupManifestRecords(plan.scanJobs)) await putIdempotently(manifest);
      for (const job of plan.scanJobs) {
        const outbox = scanDispatchOutbox(job);
        try { await ddb.send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: tableName, Item: { ...job, recordType: 'SCAN_JOB' }, ConditionExpression: 'attribute_not_exists(id)' } },
          { Put: { TableName: tableName, Item: outbox, ConditionExpression: 'attribute_not_exists(id)' } }
        ] })); }
        catch (error) {
          if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') throw error;
          const [storedJob, storedOutbox] = await Promise.all([ddb.send(new GetCommand({ TableName: tableName, Key: { id: job.id }, ConsistentRead: true })), ddb.send(new GetCommand({ TableName: tableName, Key: { id: outbox.id }, ConsistentRead: true }))]);
          if (storedJob.Item?.contentHash !== job.contentHash || storedOutbox.Item?.job?.id !== job.id) throw error;
        }
      }
      await ddb.send(new UpdateCommand({ TableName: metadataTableName, Key: { PK: `ASSET#${message.assetId}` },
        UpdateExpression: 'SET currentMediaVersionId = :mediaVersionId, currentScanGroupId = :scanGroupId, scanState = :queued, activeScanProfile = :profile, quarantineRegion = :region, privateDerivativeObjectKey = :derivative, mediaContentHash = :hash, mediaContentType = :contentType',
        ConditionExpression: '#product = :product AND #environment = :environment AND dataHomeRegion = :region AND canonicalRegion = :region AND (attribute_not_exists(currentMediaVersionId) OR currentMediaVersionId = :mediaVersionId)',
        ExpressionAttributeNames: { '#product': 'product', '#environment': 'environment' },
        ExpressionAttributeValues: { ':product': message.product, ':environment': message.environment, ':region': message.dataHomeRegion, ':mediaVersionId': message.mediaVersionId, ':scanGroupId': plan.scanJobs[0].scanGroupId, ':queued': 'QUEUED', ':profile': plan.scanJobs[0].scanProfile, ':derivative': privateDerivativeObjectKey, ':hash': plan.mediaVersion.sha256, ':contentType': source.mimeType } }));
      await ddb.send(new UpdateCommand({ TableName: metadataTableName, Key: { PK: `UPLOAD#${message.mediaVersionId}` }, UpdateExpression: 'SET #state = :consumed, consumedAt = :now', ConditionExpression: '#state = :authorized AND assetId = :assetId', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':consumed': 'CONSUMED', ':authorized': 'AUTHORIZED', ':assetId': message.assetId, ':now': new Date().toISOString() } }));
    },
    markUnavailable: async (message, errorCode) => { await putIdempotently({ id: `ingest-${message.mediaVersionId}`, recordType: 'IMAGE_INGEST_UNAVAILABLE', product: message.product, environment: message.environment, dataHomeRegion: message.dataHomeRegion, assetId: message.assetId, mediaVersionId: message.mediaVersionId, state: 'SCAN_UNAVAILABLE', errorCode, createdAt: new Date().toISOString() }); },
    deferRetry: async (receiptHandle, receiveCount) => { await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: workQueueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: Math.min(900, 5 * (2 ** Math.max(0, receiveCount - 1))) })); }
  };
};

export const createRegionalImageIngestHandler = (deps: RegionalImageIngestDependencies) => async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const product = required('PRODUCT') as ManagedProduct; const environment = required('ENVIRONMENT'); const region = required('DATA_HOME_REGION') as ManagedRegion; const quarantineBucket = required('QUARANTINE_BUCKET');
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    let message: RegionalImageIngestMessage | undefined; let cellValidated = false; let reservedScanGroupId: string | undefined;
    try {
      const payload = JSON.parse(record.body) as any;
      const s3Record = payload.Records?.find(({ eventSource }: any) => eventSource === 'aws:s3');
      const eventBridgeObject = payload.source === 'aws.s3' ? payload.detail : undefined;
      if (s3Record || eventBridgeObject) {
        const key = decodeURIComponent(String(s3Record?.s3.object.key || eventBridgeObject.object.key).replace(/\+/g, ' ')); const match = /^images\/([^/]+)\/([^/]+)\/source$/.exec(key);
        if (!match) throw new Error('Invalid regional image quarantine key');
        message = { product, environment, dataHomeRegion: region, assetId: match[1], mediaVersionId: match[2], quarantineBucket: s3Record?.s3.bucket.name || eventBridgeObject.bucket.name, quarantineObjectKey: key };
      } else message = payload as RegionalImageIngestMessage;
      if (message.product !== product || message.environment !== environment || message.dataHomeRegion !== region || message.quarantineBucket !== quarantineBucket) throw new Error('Cross-cell image ingest rejected');
      cellValidated = true;
      if (await deps.authorize(message) === 'CONSUMED') continue;
      const source = await deps.read(message.quarantineBucket, message.quarantineObjectKey);
      const plan = await planRegionalImageIngest({ product, environment, region, assetId: message.assetId, mediaVersionId: message.mediaVersionId, quarantineBucket, quarantineObjectKey: message.quarantineObjectKey, bytes: source.bytes, mimeType: message.mimeType || source.mimeType, specialistHashProvider: process.env.SPECIALIST_HASH_PROVIDER?.trim() });
      await deps.reserve?.(message, plan);
      if (deps.reserve) reservedScanGroupId = plan.scanJobs[0].scanGroupId;
      await deps.persistAndEnqueue(message, plan, source);
    } catch (error) {
      if (message && cellValidated && Number(record.attributes?.ApproximateReceiveCount || 1) >= 5) { const reason = error instanceof Error ? error.name : 'Error'; if (reservedScanGroupId) await deps.release?.(message, reservedScanGroupId, reason); await deps.markUnavailable(message, reason); }
      else { if (cellValidated) await deps.deferRetry(record.receiptHandle, Number(record.attributes?.ApproximateReceiveCount || 1)); failures.push({ itemIdentifier: record.messageId }); }
    }
  }
  return { batchItemFailures: failures };
};
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => createRegionalImageIngestHandler(dependencies())(event);
