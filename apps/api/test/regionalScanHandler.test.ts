import type { SQSEvent } from 'aws-lambda';
import { createRegionalScanHandler } from '../src/regionalScanHandler';
import type { RegionalScanJob } from '../src/regionalMedia';

const job: RegionalScanJob = {
  id: 'job-1', product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2', assetId: 'asset', mediaVersionId: 'version',
  type: 'IMAGE_MODERATION', scanProfile: 'IMAGE_V1', provider: 'aws-rekognition', contentHash: 'sha256', sourceBucket: 'quarantine', sourceObjectKey: 'uploads/image.jpg',
  scanGroupId: 'group', requiredScanCount: 1, idempotencyKey: 'key', state: 'QUEUED', attemptCount: 0, createdAt: '2026-01-01T00:00:00Z'
};

const event = (body: unknown, receiveCount = '1'): SQSEvent => ({ Records: [{ messageId: 'message-1', receiptHandle: 'receipt', body: JSON.stringify(body), attributes: { ApproximateReceiveCount: receiveCount } }] } as SQSEvent);

describe('regional scan handler', () => {
  beforeEach(() => Object.assign(process.env, { PRODUCT: 'eversally', ENVIRONMENT: 'production', DATA_HOME_REGION: 'us-east-2', QUARANTINE_BUCKET: 'quarantine', SCAN_FRAMES_BUCKET: 'frames' }));

  it('calls the regional provider and persists an immutable result before completing the job', async () => {
    const commitResult = jest.fn().mockResolvedValue(undefined);
    const send = jest.fn().mockResolvedValue({ ModerationModelVersion: '7', ModerationLabels: [{ Name: 'Violence', Confidence: 91 }] });
    const afterCommit = jest.fn().mockResolvedValue(undefined);
    const handler = createRegionalScanHandler({ startAttempt: jest.fn().mockResolvedValue(true), rekognition: { client: { send }, moderation: (input) => input, faces: (input) => input }, commitResult, failJob: jest.fn(), afterCommit, deferRetry: jest.fn() });
    await expect(handler(event(job))).resolves.toEqual({ batchItemFailures: [] });
    expect(send).toHaveBeenCalledWith({ Image: { S3Object: { Bucket: 'quarantine', Name: 'uploads/image.jpg' } } });
    expect(commitResult).toHaveBeenCalledWith(job, expect.objectContaining({ providerRegion: 'us-east-2', contentHash: 'sha256', outcome: 'SIGNALLED', modelOrApiVersion: '7' }));
    expect(commitResult).toHaveBeenCalledTimes(1);
    expect(afterCommit).toHaveBeenCalledWith(job);
  });

  it('returns a partial-batch failure for cross-cell or arbitrary-bucket work', async () => {
    const send = jest.fn();
    const handler = createRegionalScanHandler({ startAttempt: jest.fn().mockResolvedValue(true), rekognition: { client: { send }, moderation: (input) => input, faces: (input) => input }, commitResult: jest.fn(), failJob: jest.fn(), afterCommit: jest.fn(), deferRetry: jest.fn() });
    await expect(handler(event({ ...job, sourceBucket: 'other-region-private' }))).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] });
    expect(send).not.toHaveBeenCalled();
  });

  it('acknowledges an already-terminal duplicate without calling Rekognition again', async () => { const send = jest.fn(); const afterCommit = jest.fn().mockResolvedValue(undefined); const handler = createRegionalScanHandler({ startAttempt: jest.fn().mockResolvedValue(false), rekognition: { client: { send }, moderation: (input) => input, faces: (input) => input }, commitResult: jest.fn(), failJob: jest.fn(), afterCommit, deferRetry: jest.fn() }); await expect(handler(event(job))).resolves.toEqual({ batchItemFailures: [] }); expect(send).not.toHaveBeenCalled(); expect(afterCommit).toHaveBeenCalledWith(job); });

  it('retries transient provider failures and becomes unavailable when retries are exhausted', async () => {
    const failure = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    const send = jest.fn().mockRejectedValue(failure);
    const failJob = jest.fn().mockResolvedValue(undefined);
    const commitResult = jest.fn().mockResolvedValue(undefined);
    const deferRetry = jest.fn().mockResolvedValue(undefined);
    const handler = createRegionalScanHandler({ startAttempt: jest.fn().mockResolvedValue(true), rekognition: { client: { send }, moderation: (input) => input, faces: (input) => input }, commitResult, failJob, afterCommit: jest.fn(), deferRetry });
    await expect(handler(event(job, '2'))).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'message-1' }] });
    expect(failJob).not.toHaveBeenCalled();
    expect(deferRetry).toHaveBeenCalledWith('receipt', 2);
    await expect(handler(event(job, '5'))).resolves.toEqual({ batchItemFailures: [] });
    expect(failJob).toHaveBeenCalledWith(job, 'SCAN_UNAVAILABLE', 'ThrottlingException', expect.objectContaining({ outcome: 'UNAVAILABLE', scanType: 'IMAGE_MODERATION' }));
    expect(commitResult).not.toHaveBeenCalled();
  });

  it('records permanent provider errors without creating a publishable result', async () => {
    const failure = Object.assign(new Error('bad bytes'), { name: 'InvalidImageFormatException' });
    const failJob = jest.fn().mockResolvedValue(undefined);
    const commitResult = jest.fn().mockResolvedValue(undefined);
    const handler = createRegionalScanHandler({ startAttempt: jest.fn().mockResolvedValue(true), rekognition: { client: { send: jest.fn().mockRejectedValue(failure) }, moderation: (input) => input, faces: (input) => input }, commitResult, failJob, afterCommit: jest.fn(), deferRetry: jest.fn() });
    await expect(handler(event(job))).resolves.toEqual({ batchItemFailures: [] });
    expect(failJob).toHaveBeenCalledWith(job, 'SCAN_FAILED', 'InvalidImageFormatException', expect.objectContaining({ outcome: 'ERROR', contentHash: 'sha256' }));
    expect(commitResult).not.toHaveBeenCalled();
  });
});
