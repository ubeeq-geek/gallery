import { evaluateRegionalPolicy, type RegionalPolicyProfile } from '../src/regionalPolicy';
import type { RegionalScanJob, RegionalScanResult } from '../src/regionalMedia';

const baseJob = { product: 'nightframe', environment: 'production', dataHomeRegion: 'us-east-2', assetId: 'asset', mediaVersionId: 'v', scanProfile: 'REKOGNITION_FRAME_V1', provider: 'aws-rekognition', contentHash: 'hash', sourceBucket: 'frames', sourceObjectKey: 'frame.jpg', scanGroupId: 'group', requiredScanCount: 2, idempotencyKey: 'key', state: 'COMPLETE', attemptCount: 1, createdAt: 'now' } as const;
const jobs: RegionalScanJob[] = [{ ...baseJob, id: 'mod', type: 'VIDEO_FRAME_MODERATION', videoTimestampMs: 0 }, { ...baseJob, id: 'face', type: 'VIDEO_FRAME_FACE_AGE', videoTimestampMs: 0 }];
const result = (job: RegionalScanJob, values: Partial<RegionalScanResult> = {}): RegionalScanResult => ({ id: `${job.id}-result`, scanJobId: job.id, provider: 'aws-rekognition', scanType: job.type, providerRegion: 'us-east-2', modelOrApiVersion: '7', contentHash: 'hash', labels: [], faceAgeRanges: [], videoTimestampMs: job.videoTimestampMs, outcome: 'NO_MATCH', ...values });
const policy: RegionalPolicyProfile = { version: 'regional-policy-v1', highRiskModerationLabels: [{ name: 'Explicit Nudity', minimumConfidence: 0.9 }], ageSensitiveUpperBound: 18 };

describe('regional policy evaluation', () => {
  it('fails closed when either required scan is missing', () => expect(evaluateRegionalPolicy(jobs, [result(jobs[0])], policy)).toMatchObject({ state: 'SCAN_UNAVAILABLE', reasonCode: 'REQUIRED_SCAN_INCOMPLETE' }));
  it('applies a restricted hold for configured high-risk and age-sensitive signals', () => {
    const results = [result(jobs[0], { labels: [{ name: 'Explicit Nudity', confidence: 0.99 }], outcome: 'SIGNALLED' }), result(jobs[1], { faceAgeRanges: [{ low: 15, high: 22 }], outcome: 'SIGNALLED' })];
    expect(evaluateRegionalPolicy(jobs, results, policy)).toEqual({ state: 'HELD', policyVersion: 'regional-policy-v1', reasonCode: 'RESTRICTED_HIGH_RISK_COMBINATION', automatedCompletionOnly: true });
  });
  it('describes no-match only as automated completion', () => expect(evaluateRegionalPolicy(jobs, jobs.map((job) => result(job)), policy)).toMatchObject({ state: 'CLEARED_FOR_POLICY_REVIEW', automatedCompletionOnly: true }));
});

