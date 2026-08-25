import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import { assertRegionalJob, type ManagedProduct, type ManagedRegion, type RegionalScanJob, type RegionalScanResult } from './regionalMedia';
import { dynamoScanCompletionRepository, evaluateCompletedScanGroup } from './regionalScanCompletion';
import type { RegionalPolicyProfile } from './regionalPolicy';

interface RekognitionCommands {
  client: { send(command: unknown): Promise<any> };
  moderation(input: unknown): unknown;
  faces(input: unknown): unknown;
}

export interface RegionalScanHandlerDependencies {
  rekognition: RekognitionCommands;
  startAttempt(job: RegionalScanJob): Promise<boolean>;
  commitResult(job: RegionalScanJob, result: RegionalScanResult): Promise<void>;
  failJob(job: RegionalScanJob, state: 'SCAN_FAILED' | 'SCAN_UNAVAILABLE', errorCode: string, result: RegionalScanResult): Promise<void>;
  afterCommit(job: RegionalScanJob): Promise<void>;
  deferRetry(receiptHandle: string, receiveCount: number): Promise<void>;
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const dependencies = (): RegionalScanHandlerDependencies => {
  // Lambda Node.js runtimes include AWS SDK v3. CDK marks this package external
  // so the deployed worker uses the runtime's region-aware Rekognition client.
  const sdk = require('@aws-sdk/client-rekognition') as any;
  const region = required('DATA_HOME_REGION');
  const tableName = required('SCAN_JOBS_TABLE');
  const auditTableName = required('AUDIT_USAGE_TABLE');
  const metadataTableName = required('METADATA_TABLE');
  const queueUrl = required('SCAN_QUEUE_URL');
  const policy = JSON.parse(required('REGIONAL_POLICY_PROFILE')) as RegionalPolicyProfile;
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const sqs = new SQSClient({ region });
  const completion = dynamoScanCompletionRepository({ client: ddb, scanTableName: tableName, auditTableName, metadataTableName });
  const transactIdempotently = async (job: RegionalScanJob, result: RegionalScanResult, command: TransactWriteCommand): Promise<void> => {
    try { await ddb.send(command); }
    catch (error) {
      if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') throw error;
      const [storedJob, storedResult] = await Promise.all([ddb.send(new GetCommand({ TableName: tableName, Key: { id: job.id }, ConsistentRead: true })), ddb.send(new GetCommand({ TableName: tableName, Key: { id: result.id }, ConsistentRead: true }))]);
      if (!storedResult.Item || storedResult.Item.contentHash !== result.contentHash || !['COMPLETE', 'SCAN_FAILED', 'SCAN_UNAVAILABLE'].includes(storedJob.Item?.state)) throw error;
    }
  };
  return {
    rekognition: {
      client: new sdk.RekognitionClient({ region }),
      moderation: (input) => new sdk.DetectModerationLabelsCommand(input),
      faces: (input) => new sdk.DetectFacesCommand(input)
    },
    startAttempt: async (job) => {
      try { await ddb.send(new UpdateCommand({ TableName: tableName, Key: { id: job.id }, UpdateExpression: 'SET #state = :running ADD attemptCount :one', ConditionExpression: '#state IN (:queued, :running)', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':running': 'RUNNING', ':queued': 'QUEUED', ':one': 1 } })); return true; }
      catch (error) { if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error; const current = await ddb.send(new GetCommand({ TableName: tableName, Key: { id: job.id }, ConsistentRead: true })); if (['COMPLETE', 'SCAN_FAILED', 'SCAN_UNAVAILABLE'].includes(current.Item?.state)) return false; throw error; }
    },
    commitResult: async (job, result) => { await transactIdempotently(job, result, new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: tableName, Item: { ...result, recordType: 'SCAN_RESULT' }, ConditionExpression: 'attribute_not_exists(id)' } },
      { Update: { TableName: tableName, Key: { id: job.id }, UpdateExpression: 'SET #state = :complete, completedAt = :now, resultId = :resultId', ConditionExpression: '#state IN (:queued, :running)', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':complete': 'COMPLETE', ':now': new Date().toISOString(), ':resultId': result.id, ':queued': 'QUEUED', ':running': 'RUNNING' } } }
    ] })); },
    failJob: async (job, state, errorCode, result) => { await transactIdempotently(job, result, new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: tableName, Item: { ...result, recordType: 'SCAN_RESULT' }, ConditionExpression: 'attribute_not_exists(id)' } },
      { Update: { TableName: tableName, Key: { id: job.id }, UpdateExpression: 'SET #state = :state, completedAt = :now, errorCode = :errorCode, resultId = :resultId', ConditionExpression: '#state IN (:queued, :running)', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':state': state, ':now': new Date().toISOString(), ':errorCode': errorCode, ':resultId': result.id, ':queued': 'QUEUED', ':running': 'RUNNING' } } }
    ] })); },
    afterCommit: async (job) => { await evaluateCompletedScanGroup(job, policy, completion); },
    deferRetry: async (receiptHandle, receiveCount) => { await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: Math.min(900, 5 * (2 ** Math.max(0, receiveCount - 1))) })); }
  };
};

const transientProviderErrors = new Set(['ThrottlingException', 'ProvisionedThroughputExceededException', 'InternalServerError', 'ServiceUnavailableException', 'TimeoutError']);

export const createRegionalScanHandler = (deps: RegionalScanHandlerDependencies) => async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const product = required('PRODUCT') as ManagedProduct;
  const environment = required('ENVIRONMENT');
  const region = required('DATA_HOME_REGION') as ManagedRegion;
  const allowedBuckets = new Set([required('QUARANTINE_BUCKET'), required('SCAN_FRAMES_BUCKET')]);
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    let job: RegionalScanJob | undefined;
    let providerAttempted = false;
    let resultCommitted = false;
    try {
      job = JSON.parse(record.body) as RegionalScanJob;
      assertRegionalJob(job, product, environment, region);
      if (!allowedBuckets.has(job.sourceBucket)) throw new Error('Scan source bucket is outside this cell');
      if (!await deps.startAttempt(job)) { await deps.afterCommit(job); continue; }
      const image = { S3Object: { Bucket: job.sourceBucket, Name: job.sourceObjectKey } };
      let response: any;
      let result: RegionalScanResult;
      if (job.type === 'IMAGE_MODERATION' || job.type === 'VIDEO_FRAME_MODERATION') {
        providerAttempted = true;
        response = await deps.rekognition.client.send(deps.rekognition.moderation({ Image: image }));
        result = { id: `${job.id}:result`, scanJobId: job.id, scanGroupId: job.scanGroupId, assetId: job.assetId, mediaVersionId: job.mediaVersionId, scanProfile: job.scanProfile, provider: 'aws-rekognition', scanType: job.type, providerRegion: region, modelOrApiVersion: response.ModerationModelVersion || 'unspecified', contentHash: job.contentHash, labels: (response.ModerationLabels || []).flatMap((label: any) => typeof label.Name === 'string' && typeof label.Confidence === 'number' ? [{ name: label.Name, confidence: label.Confidence / 100 }] : []), faceAgeRanges: [], videoTimestampMs: job.videoTimestampMs, outcome: response.ModerationLabels?.length ? 'SIGNALLED' : 'NO_MATCH', createdAt: new Date().toISOString() } as RegionalScanResult;
      } else if (job.type === 'FACE_AGE' || job.type === 'VIDEO_FRAME_FACE_AGE') {
        providerAttempted = true;
        response = await deps.rekognition.client.send(deps.rekognition.faces({ Image: image, Attributes: ['DEFAULT'] }));
        const ages = (response.FaceDetails || []).flatMap((face: any) => typeof face.AgeRange?.Low === 'number' && typeof face.AgeRange?.High === 'number' ? [{ low: face.AgeRange.Low, high: face.AgeRange.High, confidence: typeof face.Confidence === 'number' ? face.Confidence / 100 : undefined }] : []);
        result = { id: `${job.id}:result`, scanJobId: job.id, scanGroupId: job.scanGroupId, assetId: job.assetId, mediaVersionId: job.mediaVersionId, scanProfile: job.scanProfile, provider: 'aws-rekognition', scanType: job.type, providerRegion: region, modelOrApiVersion: response.FaceModelVersion || 'unspecified', contentHash: job.contentHash, labels: [], faceAgeRanges: ages, videoTimestampMs: job.videoTimestampMs, outcome: ages.length ? 'SIGNALLED' : 'NO_MATCH', createdAt: new Date().toISOString() } as RegionalScanResult;
      } else {
        throw new Error(`Unsupported Rekognition job type: ${job.type}`);
      }
      await deps.commitResult(job, result);
      resultCommitted = true;
      await deps.afterCommit(job);
    } catch (error) {
      if (resultCommitted) { failures.push({ itemIdentifier: record.messageId }); continue; }
      const errorCode = error instanceof Error ? error.name || 'Error' : 'Error';
      const receiveCount = Number(record.attributes?.ApproximateReceiveCount || 1);
      if (job && providerAttempted && (!transientProviderErrors.has(errorCode) || receiveCount >= 5)) {
        const unavailable = transientProviderErrors.has(errorCode);
        const errorResult: RegionalScanResult = { id: `${job.id}:result`, scanJobId: job.id, scanGroupId: job.scanGroupId, assetId: job.assetId, mediaVersionId: job.mediaVersionId, scanProfile: job.scanProfile, provider: 'aws-rekognition', scanType: job.type, providerRegion: region, modelOrApiVersion: 'unavailable', contentHash: job.contentHash, labels: [], faceAgeRanges: [], videoTimestampMs: job.videoTimestampMs, outcome: unavailable ? 'UNAVAILABLE' : 'ERROR', createdAt: new Date().toISOString() } as RegionalScanResult;
        await deps.failJob(job, unavailable ? 'SCAN_UNAVAILABLE' : 'SCAN_FAILED', errorCode, errorResult);
        await deps.afterCommit(job);
      } else {
        if (job && providerAttempted && transientProviderErrors.has(errorCode)) await deps.deferRetry(record.receiptHandle, receiveCount);
        failures.push({ itemIdentifier: record.messageId });
      }
    }
  }
  return { batchItemFailures: failures };
};

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => createRegionalScanHandler(dependencies())(event);
