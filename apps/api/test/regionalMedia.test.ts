import { assertRegionalJob, createDataHomeAssignment, deterministicVideoFramePlan, planRegionalScans, scanGroupManifestRecords, scanIdempotencyKey, transitionDataHomeMigration, usageForMedia, videoCoverage, type MediaVersion, type RegionalScanJob } from '../src/regionalMedia';

describe('regional media contracts', () => {
  it('builds a deterministic three-second plan with first and final frames', () => {
    expect(deterministicVideoFramePlan(10)).toEqual([0, 3000, 6000, 9000, 9999]);
    expect(deterministicVideoFramePlan(3)).toEqual([0, 2999]);
  });

  it('creates stable cell-scoped idempotency keys', () => {
    const input = { product: 'eversally' as const, environment: 'production', dataHomeRegion: 'us-east-2' as const, mediaVersionId: 'v1', contentHash: 'abc', scanProfile: 'REKOGNITION_FRAME_V1', provider: 'aws-rekognition', type: 'VIDEO_FRAME_FACE_AGE' as const };
    expect(scanIdempotencyKey(input)).toBe(scanIdempotencyKey(input));
    expect(scanIdempotencyKey({ ...input, dataHomeRegion: 'eu-central-1' })).not.toBe(scanIdempotencyKey(input));
  });

  it('prevents a worker from consuming another cell job', () => {
    const job: RegionalScanJob = { id: 'job', product: 'nightframe', environment: 'production', dataHomeRegion: 'eu-central-1', assetId: 'a', mediaVersionId: 'v', type: 'IMAGE_MODERATION', scanProfile: 'IMAGE_V1', provider: 'aws-rekognition', contentHash: 'hash', sourceBucket: 'private', sourceObjectKey: 'object', scanGroupId: 'group', requiredScanCount: 1, idempotencyKey: 'key', state: 'QUEUED', attemptCount: 0, createdAt: '2026-01-01T00:00:00Z' };
    expect(() => assertRegionalJob(job, 'nightframe', 'production', 'eu-central-1')).not.toThrow();
    expect(() => assertRegionalJob(job, 'eversally', 'production', 'eu-central-1')).toThrow('Cross-cell scan rejected');
  });

  const video: MediaVersion = { id: 'v1', assetId: 'asset', sha256: 'hash', perceptualFingerprintRefs: [], region: 'ap-southeast-2', ingestSource: 'creator_upload', scanRequiredAt: '2026-01-01T00:00:00Z', mediaType: 'video', durationSeconds: 10 };

  it('plans paired moderation and face jobs for every video frame', () => {
    const jobs = planRegionalScans('nightframe', 'production', video, { bucket: 'nightframe-production-ap-southeast-2-quarantine', objectKey: 'uploads/v1', frameBucket: 'nightframe-production-ap-southeast-2-frames' });
    expect(jobs.filter(({ type }) => type === 'VIDEO_FRAME_MODERATION')).toHaveLength(5);
    expect(jobs.filter(({ type }) => type === 'VIDEO_FRAME_FACE_AGE')).toHaveLength(5);
    expect(new Set(jobs.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(jobs.length);
    expect(jobs.every(({ dataHomeRegion, product }) => dataHomeRegion === 'ap-southeast-2' && product === 'nightframe')).toBe(true);
    expect(jobs.filter(({ type }) => type.startsWith('VIDEO_FRAME_') && type !== 'VIDEO_FRAME_PLAN').every(({ sourceBucket }) => sourceBucket.endsWith('-frames'))).toBe(true);
    expect(planRegionalScans('nightframe', 'production', video, { bucket: 'q', objectKey: 'v', frameBucket: 'f' }).map(({ id }) => id)).toEqual(planRegionalScans('nightframe', 'production', video, { bucket: 'q', objectKey: 'v', frameBucket: 'f' }).map(({ id }) => id));
  });

  it('chunks large immutable manifests without copying every job id into queue payloads', () => { const jobs = planRegionalScans('nightframe', 'production', { ...video, durationSeconds: 130 }, { bucket: 'q', objectKey: 'v', frameBucket: 'f' }).filter(({ type }) => type !== 'VIDEO_FRAME_PLAN'); const manifests = scanGroupManifestRecords(jobs); expect(manifests.length).toBeGreaterThan(1); expect(manifests.flatMap(({ jobIds }) => jobIds)).toHaveLength(jobs.length); expect(jobs.every(({ requiredScanCount }) => requiredScanCount > 0)).toBe(true); });

  it('fails video coverage closed when any required result is unavailable', () => {
    const summary = videoCoverage(2, [
      { id: 'r1', scanJobId: 'j1', provider: 'aws-rekognition', scanType: 'VIDEO_FRAME_MODERATION', providerRegion: 'ap-southeast-2', modelOrApiVersion: '1', contentHash: 'hash', labels: [], faceAgeRanges: [], videoTimestampMs: 0, outcome: 'NO_MATCH' },
      { id: 'r1-face', scanJobId: 'j1-face', provider: 'aws-rekognition', scanType: 'VIDEO_FRAME_FACE_AGE', providerRegion: 'ap-southeast-2', modelOrApiVersion: '1', contentHash: 'hash', labels: [], faceAgeRanges: [], videoTimestampMs: 0, outcome: 'NO_MATCH' },
      { id: 'r2', scanJobId: 'j2', provider: 'aws-rekognition', scanType: 'VIDEO_FRAME_MODERATION', providerRegion: 'ap-southeast-2', modelOrApiVersion: '1', contentHash: 'hash', labels: [], faceAgeRanges: [], videoTimestampMs: 3000, outcome: 'UNAVAILABLE' }
    ]);
    expect(summary).toMatchObject({ coverageState: 'UNAVAILABLE', framesPlanned: 2, framesScanned: 1, framesFailed: 1 });
  });

  it('does not report complete coverage when a frame is missing face analysis', () => {
    expect(videoCoverage(1, [{ id: 'r', scanJobId: 'j', provider: 'aws-rekognition', scanType: 'VIDEO_FRAME_MODERATION', providerRegion: 'ap-southeast-2', modelOrApiVersion: '1', contentHash: 'hash', labels: [], faceAgeRanges: [], videoTimestampMs: 0, outcome: 'NO_MATCH' }])).toMatchObject({ coverageState: 'INCOMPLETE', framesScanned: 0 });
  });

  it('meters raw paired calls separately from video credit entitlement', () => {
    expect(usageForMedia({ product: 'eversally', region: 'ap-southeast-2', creatorId: 'creator', spaceId: 'space', period: '2026-08', media: video })).toMatchObject({ sampledFrameCount: 5, moderationCalls: 5, faceAgeCalls: 5, creditUnits: 25 });
  });

  it('changes the authoritative region only after the explicit migration sequence', () => {
    let assignment = createDataHomeAssignment('AMERICAS', 'creator_selection', '2026-01-01T00:00:00Z');
    for (const state of ['REQUESTED', 'PREPARING', 'COPYING', 'RESCANNING', 'VERIFYING'] as const) assignment = transitionDataHomeMigration(assignment, state);
    expect(assignment.dataHomeRegion).toBe('us-east-2');
    expect(() => transitionDataHomeMigration(assignment, 'NONE')).toThrow('Invalid migration transition');
    assignment = transitionDataHomeMigration(assignment, 'COMPLETE', 'EUROPE');
    expect(assignment).toMatchObject({ dataHomeRegion: 'eu-central-1', dataHomeAssignmentSource: 'migration', dataHomeMigrationState: 'COMPLETE' });
  });
});
