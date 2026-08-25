import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { dynamoScanCompletionRepository, evaluateCompletedScanGroup } from '../src/regionalScanCompletion';
import type { RegionalScanJob, RegionalScanResult } from '../src/regionalMedia';

const common = { product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2', assetId: 'asset', mediaVersionId: 'version', scanProfile: 'REKOGNITION_IMAGE_V1', provider: 'aws-rekognition', contentHash: 'hash', sourceBucket: 'quarantine', sourceObjectKey: 'image.jpg', scanGroupId: 'group', requiredScanCount: 2, idempotencyKey: 'key', state: 'COMPLETE', attemptCount: 1, createdAt: 'now' } as const;
const jobs: RegionalScanJob[] = [{ ...common, id: 'mod', type: 'IMAGE_MODERATION' }, { ...common, id: 'face', type: 'FACE_AGE' }];
const result = (job: RegionalScanJob): RegionalScanResult => ({ id: `${job.id}:result`, scanJobId: job.id, provider: 'aws-rekognition', scanType: job.type, providerRegion: 'us-east-2', modelOrApiVersion: '7', contentHash: 'hash', labels: [], faceAgeRanges: [], outcome: 'NO_MATCH' });
const policy = { version: 'v1', highRiskModerationLabels: [{ name: 'Explicit Nudity', minimumConfidence: 0.9 }], ageSensitiveUpperBound: 18 };

describe('regional scan completion', () => {
  it('waits until every immutable result in the manifest is present', async () => {
    const applyDecision = jest.fn();
    await expect(evaluateCompletedScanGroup(jobs[0], policy, { loadJobsAndResults: jest.fn().mockResolvedValue({ jobs, results: [result(jobs[0])] }), applyDecision })).resolves.toBeNull();
    expect(applyDecision).not.toHaveBeenCalled();
  });
  it('evaluates and atomically routes the final completed scan group', async () => {
    const applyDecision = jest.fn().mockResolvedValue(undefined);
    await expect(evaluateCompletedScanGroup(jobs[1], policy, { loadJobsAndResults: jest.fn().mockResolvedValue({ jobs, results: jobs.map(result) }), applyDecision })).resolves.toMatchObject({ state: 'CLEARED_FOR_POLICY_REVIEW', automatedCompletionOnly: true });
    expect(applyDecision).toHaveBeenCalledWith(jobs[1], expect.objectContaining({ policyVersion: 'v1' }));
  });
  it('atomically updates the authoritative regional Asset with the policy decision', async () => {
    const send = jest.fn().mockResolvedValue({});
    const repository = dynamoScanCompletionRepository({ client: { send } as any, scanTableName: 'scans', auditTableName: 'audit', metadataTableName: 'metadata' });
    await repository.applyDecision(jobs[0], { state: 'CLEARED_FOR_POLICY_REVIEW', policyVersion: 'v1', reasonCode: 'AUTOMATED_NO_RELEVANT_RESULT', automatedCompletionOnly: true });
    const command = send.mock.calls[0][0] as TransactWriteCommand;
    const assetUpdate = command.input.TransactItems?.find(({ Update }) => Update?.TableName === 'metadata')?.Update;
    expect(assetUpdate?.ConditionExpression).toContain('currentScanGroupId = :scanGroupId');
    expect(assetUpdate?.ExpressionAttributeValues).toMatchObject({ ':deliveryState': 'ELIGIBLE', ':scanState': 'CLEARED_FOR_POLICY_REVIEW', ':mediaVersionId': 'version' });
  });
});
