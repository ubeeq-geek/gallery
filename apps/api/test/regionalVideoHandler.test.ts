import type { SQSEvent } from 'aws-lambda';
import { createRegionalVideoHandler } from '../src/regionalVideoHandler';
import type { RegionalScanJob } from '../src/regionalMedia';

const job: RegionalScanJob = { id: 'plan', product: 'nightframe', environment: 'production', dataHomeRegion: 'eu-central-1', assetId: 'asset', mediaVersionId: 'version', type: 'VIDEO_FRAME_PLAN', scanProfile: 'REKOGNITION_FRAME_V1', provider: 'aws-rekognition', contentHash: 'hash', sourceBucket: 'quarantine', sourceObjectKey: 'uploads/video.mp4', scanGroupId: 'group', requiredScanCount: 1, idempotencyKey: 'key', state: 'QUEUED', attemptCount: 0, createdAt: '2026-01-01T00:00:00Z' };
const event = (value: unknown, receiveCount = '1'): SQSEvent => ({ Records: [{ messageId: 'message', body: JSON.stringify(value), attributes: { ApproximateReceiveCount: receiveCount } }] } as SQSEvent);
const probe = { format: { duration: '4', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }] };

describe('regional video handler', () => {
  beforeEach(() => Object.assign(process.env, { PRODUCT: 'nightframe', ENVIRONMENT: 'production', DATA_HOME_REGION: 'eu-central-1', QUARANTINE_BUCKET: 'quarantine', SCAN_FRAMES_BUCKET: 'frames' }));

  it('validates, extracts, uploads, and persists paired frame jobs', async () => {
    const extractFrame = jest.fn().mockResolvedValue(undefined);
    const uploadFrame = jest.fn().mockResolvedValue(undefined);
    const persistPlan = jest.fn().mockResolvedValue(undefined);
    const handler = createRegionalVideoHandler({ authorize: jest.fn(), ensurePlanJob: jest.fn().mockResolvedValue(true), tools: { probe: jest.fn().mockResolvedValue(probe), extractFrame }, download: jest.fn().mockResolvedValue('authoritative-hash'), uploadFrame, persistPlan, markUnavailable: jest.fn(), deferRetry: jest.fn() });
    await expect(handler(event(job))).resolves.toEqual({ batchItemFailures: [] });
    expect(extractFrame).toHaveBeenCalledTimes(3);
    expect(uploadFrame).toHaveBeenCalledTimes(3);
    const scanJobs: RegionalScanJob[] = persistPlan.mock.calls[0][2];
    expect(scanJobs).toHaveLength(6);
    expect(scanJobs.filter(({ type }) => type === 'VIDEO_FRAME_MODERATION')).toHaveLength(3);
    expect(scanJobs.filter(({ type }) => type === 'VIDEO_FRAME_FACE_AGE')).toHaveLength(3);
    expect(scanJobs.every(({ sourceBucket }) => sourceBucket === 'frames')).toBe(true);
    expect(scanJobs.every(({ contentHash }) => contentHash === 'authoritative-hash')).toBe(true);
  });

  it('rejects another cell before downloading private media', async () => {
    const download = jest.fn();
    const handler = createRegionalVideoHandler({ authorize: jest.fn(), ensurePlanJob: jest.fn().mockResolvedValue(true), tools: { probe: jest.fn(), extractFrame: jest.fn() }, download, uploadFrame: jest.fn(), persistPlan: jest.fn(), markUnavailable: jest.fn(), deferRetry: jest.fn() });
    await expect(handler(event({ ...job, dataHomeRegion: 'us-east-2' }))).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'message' }] });
    expect(download).not.toHaveBeenCalled();
  });
  it('rejects a video not authorized by the regional Asset before downloading it', async () => {
    const download = jest.fn();
    const authorize = jest.fn().mockRejectedValue(new Error('not authorized'));
    const handler = createRegionalVideoHandler({ authorize, ensurePlanJob: jest.fn(), tools: { probe: jest.fn(), extractFrame: jest.fn() }, download, uploadFrame: jest.fn(), persistPlan: jest.fn(), markUnavailable: jest.fn(), deferRetry: jest.fn() });
    await expect(handler(event(job))).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'message' }] });
    expect(authorize).toHaveBeenCalledWith(job);
    expect(download).not.toHaveBeenCalled();
  });
  it('acknowledges a duplicate event for an already consumed video upload', async () => {
    const download = jest.fn();
    const handler = createRegionalVideoHandler({ authorize: jest.fn().mockResolvedValue('CONSUMED'), ensurePlanJob: jest.fn(), tools: { probe: jest.fn(), extractFrame: jest.fn() }, download, uploadFrame: jest.fn(), persistPlan: jest.fn(), markUnavailable: jest.fn(), deferRetry: jest.fn() });
    await expect(handler(event(job))).resolves.toEqual({ batchItemFailures: [] });
    expect(download).not.toHaveBeenCalled();
  });
  it('accepts only the regional video quarantine key convention from S3', async () => { const ensurePlanJob = jest.fn().mockResolvedValue(true); const handler = createRegionalVideoHandler({ authorize: jest.fn(), ensurePlanJob, tools: { probe: jest.fn().mockResolvedValue(probe), extractFrame: jest.fn().mockResolvedValue(undefined) }, download: jest.fn().mockResolvedValue('hash'), uploadFrame: jest.fn().mockResolvedValue(undefined), persistPlan: jest.fn().mockResolvedValue(undefined), markUnavailable: jest.fn(), deferRetry: jest.fn() }); const notification = { Records: [{ eventSource: 'aws:s3', s3: { bucket: { name: 'quarantine' }, object: { key: 'videos%2Fasset%2Fversion%2Fsource' } } }] }; await expect(handler(event(notification))).resolves.toEqual({ batchItemFailures: [] }); expect(ensurePlanJob).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'asset', mediaVersionId: 'version', type: 'VIDEO_FRAME_PLAN' })); });
  it('marks exhausted extraction work unavailable without creating frame scans', async () => { const markUnavailable = jest.fn().mockResolvedValue(undefined); const handler = createRegionalVideoHandler({ authorize: jest.fn(), ensurePlanJob: jest.fn().mockResolvedValue(true), tools: { probe: jest.fn(), extractFrame: jest.fn() }, download: jest.fn().mockRejectedValue(Object.assign(new Error('decoder'), { name: 'InvalidVideo' })), uploadFrame: jest.fn(), persistPlan: jest.fn(), markUnavailable, deferRetry: jest.fn() }); await expect(handler(event(job, '5'))).resolves.toEqual({ batchItemFailures: [] }); expect(markUnavailable).toHaveBeenCalledWith(job, 'InvalidVideo'); });
  it('acknowledges a duplicate completed frame plan without decoding twice', async () => { const download = jest.fn(); const handler = createRegionalVideoHandler({ authorize: jest.fn(), ensurePlanJob: jest.fn().mockResolvedValue(false), tools: { probe: jest.fn(), extractFrame: jest.fn() }, download, uploadFrame: jest.fn(), persistPlan: jest.fn(), markUnavailable: jest.fn(), deferRetry: jest.fn() }); await expect(handler(event(job))).resolves.toEqual({ batchItemFailures: [] }); expect(download).not.toHaveBeenCalled(); });
});
