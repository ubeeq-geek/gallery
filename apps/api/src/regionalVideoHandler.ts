import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import { assertRegionalJob, finalizeRegionalScanGroup, planRegionalScans, scanGroupManifestRecords, type ManagedProduct, type ManagedRegion, type MediaVersion, type RegionalScanJob } from './regionalMedia';
import { extractValidatedFrames, FfmpegVideoToolAdapter, type ValidatedVideoMetadata, type VideoToolAdapter } from './regionalVideoProcessing';
import { scanDispatchOutbox } from './regionalScanOutboxHandler';
import { dynamoRegionalBillingRepository, processingReservationKey } from './regionalBilling';

export interface RegionalVideoHandlerDependencies {
  tools: VideoToolAdapter;
  authorize(job: RegionalScanJob): Promise<'AUTHORIZED' | 'CONSUMED' | void>;
  download(bucket: string, key: string, path: string): Promise<string>;
  uploadFrame(bucket: string, key: string, path: string): Promise<void>;
  reserve?(job: RegionalScanJob, media: MediaVersion, scanGroupId: string): Promise<void>;
  release?(job: RegionalScanJob, scanGroupId: string, reason: string): Promise<void>;
  ensurePlanJob(job: RegionalScanJob): Promise<boolean>;
  persistPlan(job: RegionalScanJob, metadata: ValidatedVideoMetadata, scanJobs: RegionalScanJob[]): Promise<void>;
  markUnavailable(job: RegionalScanJob, errorCode: string): Promise<void>;
  deferRetry(receiptHandle: string, receiveCount: number): Promise<void>;
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const productionDependencies = (): RegionalVideoHandlerDependencies => {
  const region = required('DATA_HOME_REGION');
  const tableName = required('SCAN_JOBS_TABLE');
  const workQueueUrl = required('VIDEO_PROCESSING_QUEUE_URL');
  const metadataTableName = required('METADATA_TABLE');
  const billingTableName = required('BILLING_LEDGER_TABLE');
  const s3 = new S3Client({ region });
  const sqs = new SQSClient({ region });
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const billing = dynamoRegionalBillingRepository({ client: ddb, tableName: billingTableName });
  const putIdempotently = async (item: Record<string, unknown>): Promise<boolean> => {
    try { await ddb.send(new PutCommand({ TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(id)' })); return true; }
    catch (error) {
      if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error;
      const existing = await ddb.send(new GetCommand({ TableName: tableName, Key: { id: item.id }, ConsistentRead: true }));
      if (!existing.Item || existing.Item.recordType !== item.recordType || (item.contentHash && existing.Item.contentHash !== item.contentHash)) throw error;
      return false;
    }
  };
  return {
    tools: new FfmpegVideoToolAdapter(),
    authorize: async (job) => {
      const [asset, upload] = await Promise.all([
        ddb.send(new GetCommand({ TableName: metadataTableName, Key: { PK: `ASSET#${job.assetId}` }, ConsistentRead: true })),
        ddb.send(new GetCommand({ TableName: metadataTableName, Key: { PK: `UPLOAD#${job.mediaVersionId}` }, ConsistentRead: true }))
      ]);
      if (!asset.Item || asset.Item.product !== job.product || asset.Item.environment !== job.environment || asset.Item.dataHomeRegion !== job.dataHomeRegion || asset.Item.canonicalRegion !== job.dataHomeRegion) throw new Error('Video ingest is not authorized for this regional Asset');
      if (asset.Item.currentMediaVersionId && asset.Item.currentMediaVersionId !== job.mediaVersionId) throw new Error('Video ingest media version does not match the regional Asset');
      if (!upload.Item || !['AUTHORIZED', 'CONSUMED'].includes(upload.Item.state) || upload.Item.mediaType !== 'video' || upload.Item.assetId !== job.assetId || upload.Item.quarantineBucket !== job.sourceBucket || upload.Item.quarantineObjectKey !== job.sourceObjectKey || (upload.Item.state === 'AUTHORIZED' && upload.Item.expiresAtEpochSeconds <= Math.floor(Date.now() / 1000))) throw new Error('Video upload authorization is missing, expired, or mismatched');
      return upload.Item.state as 'AUTHORIZED' | 'CONSUMED';
    },
    download: async (bucket, key, path) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) throw new Error('Quarantined video body is unavailable');
      const hash = createHash('sha256');
      (response.Body as NodeJS.ReadableStream).on('data', (chunk) => hash.update(chunk));
      await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(path));
      return hash.digest('hex');
    },
    uploadFrame: async (bucket, key, path) => { await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(path), ContentType: 'image/jpeg', Metadata: { restricted: 'scan-frame' } })); },
    reserve: async (job, media, scanGroupId) => {
      const upload = await ddb.send(new GetCommand({ TableName: metadataTableName, Key: { PK: `UPLOAD#${job.mediaVersionId}` }, ConsistentRead: true }));
      if (!upload.Item?.creatorId || !upload.Item?.spaceId) throw new Error('Upload billing identity is unavailable');
      await billing.reserve({ product: job.product, environment: job.environment, dataHomeRegion: job.dataHomeRegion, accountId: upload.Item.creatorId, creatorId: upload.Item.creatorId, spaceId: upload.Item.spaceId, assetId: job.assetId, mediaVersionId: job.mediaVersionId, scanGroupId, media });
    },
    release: async (job, scanGroupId, reason) => billing.release({ reservationId: processingReservationKey(job.mediaVersionId, scanGroupId), reason }),
    ensurePlanJob: async (job) => { const inserted = await putIdempotently({ ...job, recordType: 'SCAN_JOB' }); if (inserted) return true; const existing = await ddb.send(new GetCommand({ TableName: tableName, Key: { id: job.id }, ConsistentRead: true })); return existing.Item?.state !== 'COMPLETE'; },
    persistPlan: async (job, metadata, scanJobs) => {
      await putIdempotently({ id: job.mediaVersionId, recordType: 'MEDIA_VERSION', product: job.product, environment: job.environment, dataHomeRegion: job.dataHomeRegion, assetId: job.assetId, sha256: scanJobs[0]?.contentHash || job.contentHash, perceptualFingerprintRefs: [], region: job.dataHomeRegion, ingestSource: 'creator_upload', scanRequiredAt: job.createdAt, mediaType: 'video', durationSeconds: metadata.durationSeconds });
      await putIdempotently({ id: `${job.id}:video-summary`, recordType: 'VIDEO_FRAME_PLAN', jobId: job.id, product: job.product, environment: job.environment, dataHomeRegion: job.dataHomeRegion, assetId: job.assetId, mediaVersionId: job.mediaVersionId, contentHash: job.contentHash, scanProfile: job.scanProfile, ...metadata });
      for (const manifest of scanGroupManifestRecords(scanJobs)) await putIdempotently(manifest);
      for (const scanJob of scanJobs) {
        const outbox = scanDispatchOutbox(scanJob);
        try { await ddb.send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: tableName, Item: { ...scanJob, recordType: 'SCAN_JOB' }, ConditionExpression: 'attribute_not_exists(id)' } },
          { Put: { TableName: tableName, Item: outbox, ConditionExpression: 'attribute_not_exists(id)' } }
        ] })); }
        catch (error) {
          if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') throw error;
          const [storedJob, storedOutbox] = await Promise.all([ddb.send(new GetCommand({ TableName: tableName, Key: { id: scanJob.id }, ConsistentRead: true })), ddb.send(new GetCommand({ TableName: tableName, Key: { id: outbox.id }, ConsistentRead: true }))]);
          if (storedJob.Item?.contentHash !== scanJob.contentHash || storedOutbox.Item?.job?.id !== scanJob.id) throw error;
        }
      }
      await ddb.send(new UpdateCommand({ TableName: metadataTableName, Key: { PK: `ASSET#${job.assetId}` },
        UpdateExpression: 'SET currentMediaVersionId = :mediaVersionId, currentScanGroupId = :scanGroupId, scanState = :queued, activeScanProfile = :profile, quarantineRegion = :region',
        ConditionExpression: '#product = :product AND #environment = :environment AND dataHomeRegion = :region AND canonicalRegion = :region AND (attribute_not_exists(currentMediaVersionId) OR currentMediaVersionId = :mediaVersionId)',
        ExpressionAttributeNames: { '#product': 'product', '#environment': 'environment' },
        ExpressionAttributeValues: { ':product': job.product, ':environment': job.environment, ':region': job.dataHomeRegion, ':mediaVersionId': job.mediaVersionId, ':scanGroupId': scanJobs[0]?.scanGroupId, ':queued': 'QUEUED', ':profile': job.scanProfile } }));
      await ddb.send(new UpdateCommand({ TableName: metadataTableName, Key: { PK: `UPLOAD#${job.mediaVersionId}` }, UpdateExpression: 'SET #state = :consumed, consumedAt = :now', ConditionExpression: '#state = :authorized AND assetId = :assetId', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':consumed': 'CONSUMED', ':authorized': 'AUTHORIZED', ':assetId': job.assetId, ':now': new Date().toISOString() } }));
      await ddb.send(new UpdateCommand({ TableName: tableName, Key: { id: job.id }, UpdateExpression: 'SET #state = :complete, completedAt = :now, authoritativeContentHash = :hash', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':complete': 'COMPLETE', ':now': new Date().toISOString(), ':hash': scanJobs[0]?.contentHash || job.contentHash } }));
    },
    markUnavailable: async (job, errorCode) => { await ddb.send(new UpdateCommand({ TableName: tableName, Key: { id: job.id }, UpdateExpression: 'SET #state = :state, completedAt = :now, errorCode = :error', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':state': 'SCAN_UNAVAILABLE', ':now': new Date().toISOString(), ':error': errorCode } })); },
    deferRetry: async (receiptHandle, receiveCount) => { await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: workQueueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: Math.min(900, 5 * (2 ** Math.max(0, receiveCount - 1))) })); }
  };
};

export const createRegionalVideoHandler = (deps: RegionalVideoHandlerDependencies) => async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const product = required('PRODUCT') as ManagedProduct;
  const environment = required('ENVIRONMENT');
  const region = required('DATA_HOME_REGION') as ManagedRegion;
  const quarantineBucket = required('QUARANTINE_BUCKET');
  const frameBucket = required('SCAN_FRAMES_BUCKET');
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    const workDirectory = `/tmp/regional-video-${record.messageId}`;
    let job: RegionalScanJob | undefined; let cellValidated = false; let reservedScanGroupId: string | undefined;
    try {
      const payload = JSON.parse(record.body) as any;
      const s3Record = payload.Records?.find(({ eventSource }: any) => eventSource === 'aws:s3');
      const eventBridgeObject = payload.source === 'aws.s3' ? payload.detail : undefined;
      if (s3Record || eventBridgeObject) {
        const key = decodeURIComponent(String(s3Record?.s3.object.key || eventBridgeObject.object.key).replace(/\+/g, ' ')); const match = /^videos\/([^/]+)\/([^/]+)\/source$/.exec(key);
        if (!match) throw new Error('Invalid regional video quarantine key');
        const idempotencyKey = createHash('sha256').update([product, environment, region, match[2], key, 'VIDEO_FRAME_PLAN'].join('\u0000')).digest('hex');
        job = { id: `video-plan-${idempotencyKey}`, product, environment, dataHomeRegion: region, assetId: match[1], mediaVersionId: match[2], type: 'VIDEO_FRAME_PLAN', scanProfile: process.env.SCAN_PROFILE || 'REKOGNITION_FRAME_V1', provider: 'ffmpeg', contentHash: 'CALCULATED_BY_VIDEO_WORKER', sourceBucket: s3Record?.s3.bucket.name || eventBridgeObject.bucket.name, sourceObjectKey: key, scanGroupId: `video-plan-${idempotencyKey}`, requiredScanCount: 1, idempotencyKey, state: 'QUEUED', attemptCount: 0, createdAt: new Date().toISOString() };
      } else job = payload as RegionalScanJob;
      assertRegionalJob(job, product, environment, region);
      if (job.type !== 'VIDEO_FRAME_PLAN' || job.sourceBucket !== quarantineBucket) throw new Error('Invalid regional video frame-plan job');
      cellValidated = true;
      if (await deps.authorize(job) === 'CONSUMED') continue;
      if (!await deps.ensurePlanJob(job)) continue;
      await mkdir(workDirectory, { recursive: true });
      const inputPath = `${workDirectory}/input`;
      const contentHash = await deps.download(job.sourceBucket, job.sourceObjectKey, inputPath);
      const metadata = await extractValidatedFrames({ inputPath, outputPath: (timestamp) => `${workDirectory}/${timestamp}.jpg`, tools: deps.tools });
      for (const timestampMs of metadata.frameTimestampsMs) await deps.uploadFrame(frameBucket, `frames/${job.mediaVersionId}/${timestampMs}.jpg`, `${workDirectory}/${timestampMs}.jpg`);
      const media: MediaVersion = { id: job.mediaVersionId, assetId: job.assetId, sha256: contentHash, perceptualFingerprintRefs: [], region, ingestSource: 'creator_upload', scanRequiredAt: job.createdAt, mediaType: 'video', durationSeconds: metadata.durationSeconds };
      const planned = planRegionalScans(product, environment, media, { bucket: quarantineBucket, objectKey: job.sourceObjectKey, frameBucket }, job.scanProfile).filter(({ type }) => type === 'VIDEO_FRAME_MODERATION' || type === 'VIDEO_FRAME_FACE_AGE');
      const scanJobs = finalizeRegionalScanGroup(planned, media, product, environment, job.scanProfile);
      await deps.reserve?.(job, media, scanJobs[0].scanGroupId);
      if (deps.reserve) reservedScanGroupId = scanJobs[0].scanGroupId;
      await deps.persistPlan(job, metadata, scanJobs);
    } catch (error) {
      if (job && cellValidated && Number(record.attributes?.ApproximateReceiveCount || 1) >= 5) { const reason = error instanceof Error ? error.name : 'Error'; if (reservedScanGroupId) await deps.release?.(job, reservedScanGroupId, reason); await deps.markUnavailable(job, reason); }
      else { if (cellValidated) await deps.deferRetry(record.receiptHandle, Number(record.attributes?.ApproximateReceiveCount || 1)); failures.push({ itemIdentifier: record.messageId }); }
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
  return { batchItemFailures: failures };
};

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => createRegionalVideoHandler(productionDependencies())(event);
