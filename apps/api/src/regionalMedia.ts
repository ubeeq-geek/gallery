import { createHash } from 'node:crypto';

export const MANAGED_DATA_HOMES = {
  AMERICAS: 'us-east-2',
  EUROPE: 'eu-central-1',
  SOUTH_ASIA: 'ap-south-1',
  SOUTHEAST_ASIA: 'ap-southeast-1',
  AU_NZ: 'ap-southeast-2'
} as const;

export type DataHomeLabel = keyof typeof MANAGED_DATA_HOMES;
export type ManagedRegion = typeof MANAGED_DATA_HOMES[DataHomeLabel];
export type ManagedProduct = 'eversally' | 'nightframe';
export type DataHomeAssignmentSource = 'creator_selection' | 'support_assignment' | 'migration';
export type DataHomeMigrationState = 'NONE' | 'REQUESTED' | 'PREPARING' | 'COPYING' | 'RESCANNING' | 'VERIFYING' | 'COMPLETE' | 'FAILED';
export type RegionalScanType = 'HASH' | 'IMAGE_MODERATION' | 'FACE_AGE' | 'VIDEO_FRAME_PLAN' | 'VIDEO_FRAME_MODERATION' | 'VIDEO_FRAME_FACE_AGE';
export type RegionalScanState = 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'SCAN_FAILED' | 'SCAN_UNAVAILABLE';
export type ScanOutcome = 'NO_MATCH' | 'SIGNALLED' | 'ERROR' | 'UNAVAILABLE';

export const DEFAULT_VIDEO_SCAN_PROFILE = Object.freeze({
  scanProfile: 'REKOGNITION_FRAME_V1',
  videoFrameIntervalSeconds: 3,
  videoFramesPerMinute: 20
});

export interface DataHomeAssignment {
  dataHomeRegion: ManagedRegion;
  dataHomeLabel: DataHomeLabel;
  dataHomeAssignedAt: string;
  dataHomeAssignmentSource: DataHomeAssignmentSource;
  dataHomeMigrationState: DataHomeMigrationState;
}

export interface GlobalRoutingEntry {
  opaqueSpaceId: string;
  publicHandle?: string;
  product: ManagedProduct;
  homeRegion: ManagedRegion;
  status: 'ACTIVE' | 'MIGRATING' | 'SUSPENDED' | 'RETIRED';
}

export const createDataHomeAssignment = (label: DataHomeLabel, source: DataHomeAssignmentSource, assignedAt = new Date().toISOString()): DataHomeAssignment => ({
  dataHomeLabel: label,
  dataHomeRegion: MANAGED_DATA_HOMES[label],
  dataHomeAssignedAt: assignedAt,
  dataHomeAssignmentSource: source,
  dataHomeMigrationState: 'NONE'
});

const migrationTransitions: Record<DataHomeMigrationState, DataHomeMigrationState[]> = {
  NONE: ['REQUESTED'], REQUESTED: ['PREPARING', 'FAILED'], PREPARING: ['COPYING', 'FAILED'], COPYING: ['RESCANNING', 'FAILED'],
  RESCANNING: ['VERIFYING', 'FAILED'], VERIFYING: ['COMPLETE', 'FAILED'], COMPLETE: [], FAILED: ['REQUESTED']
};

/** Enforces an explicit, resumable path; only COMPLETE may make a destination authoritative. */
export const transitionDataHomeMigration = (assignment: DataHomeAssignment, next: DataHomeMigrationState, destination?: DataHomeLabel): DataHomeAssignment => {
  if (!migrationTransitions[assignment.dataHomeMigrationState].includes(next)) throw new Error(`Invalid migration transition ${assignment.dataHomeMigrationState} -> ${next}`);
  if (next === 'COMPLETE' && !destination) throw new Error('Completed migration requires a verified destination');
  return next === 'COMPLETE'
    ? { ...assignment, dataHomeLabel: destination!, dataHomeRegion: MANAGED_DATA_HOMES[destination!], dataHomeAssignedAt: new Date().toISOString(), dataHomeAssignmentSource: 'migration', dataHomeMigrationState: next }
    : { ...assignment, dataHomeMigrationState: next };
};

export interface RegionalScanJob {
  id: string;
  product: ManagedProduct;
  environment: string;
  dataHomeRegion: ManagedRegion;
  assetId: string;
  mediaVersionId: string;
  type: RegionalScanType;
  scanProfile: string;
  provider: string;
  contentHash: string;
  sourceBucket: string;
  sourceObjectKey: string;
  videoTimestampMs?: number;
  scanGroupId: string;
  requiredScanCount: number;
  idempotencyKey: string;
  state: RegionalScanState;
  attemptCount: number;
  createdAt: string;
  completedAt?: string;
}

export interface RegionalScanResult {
  id: string;
  scanJobId: string;
  scanGroupId?: string;
  assetId?: string;
  mediaVersionId?: string;
  scanProfile?: string;
  provider: string;
  scanType: RegionalScanType;
  providerRegion: ManagedRegion;
  modelOrApiVersion: string;
  contentHash: string;
  labels: Array<{ name: string; confidence: number }>;
  faceAgeRanges: Array<{ low: number; high: number; confidence?: number }>;
  videoTimestampMs?: number;
  frameEvidenceRef?: string;
  outcome: ScanOutcome;
  createdAt?: string;
}

export interface MediaVersion {
  id: string;
  assetId: string;
  sha256: string;
  perceptualFingerprintRefs: string[];
  region: ManagedRegion;
  ingestSource: 'creator_upload' | 'approved_import' | 'product_transfer' | 'migration';
  scanRequiredAt: string;
  mediaType: 'image' | 'video';
  durationSeconds?: number;
}

export interface VideoScanSummary {
  frameIntervalSeconds: number;
  framesPlanned: number;
  framesScanned: number;
  framesFailed: number;
  aggregateLabels: Array<{ name: string; maxConfidence: number }>;
  aggregateAgeSignals: Array<{ low: number; high: number }>;
  coverageState: 'COMPLETE' | 'INCOMPLETE' | 'UNAVAILABLE';
}

export interface MediaProcessingLedgerEntry {
  product: ManagedProduct;
  dataHomeRegion: ManagedRegion;
  creatorId: string;
  spaceId: string;
  period: string;
  mediaType: 'image' | 'video';
  sourceImageCount: number;
  videoDurationSeconds: number;
  sampledFrameCount: number;
  moderationCalls: number;
  faceAgeCalls: number;
  estimatedProviderCost: number;
  creditUnits: number;
}

/** Stable identity used for deduplication inside one product and regional cell. */
export const scanIdempotencyKey = (input: Pick<RegionalScanJob, 'product' | 'environment' | 'dataHomeRegion' | 'mediaVersionId' | 'scanProfile' | 'provider' | 'type'> & { contentHash: string }): string =>
  createHash('sha256').update([
    input.product, input.environment, input.dataHomeRegion, input.mediaVersionId, input.contentHash,
    input.scanProfile, input.provider, input.type
  ].join('\u0000')).digest('hex');

/** Includes t=0 and appends the final decodable instant when cadence misses it. */
export const deterministicVideoFramePlan = (durationSeconds: number, intervalSeconds: number = DEFAULT_VIDEO_SCAN_PROFILE.videoFrameIntervalSeconds): number[] => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Video duration must be positive');
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) throw new Error('Frame interval must be positive');
  const durationMs = Math.round(durationSeconds * 1000);
  const intervalMs = Math.round(intervalSeconds * 1000);
  const finalMs = Math.max(0, durationMs - 1);
  const frames: number[] = [];
  for (let timestamp = 0; timestamp < durationMs; timestamp += intervalMs) frames.push(timestamp);
  if (frames.at(-1) !== finalMs) frames.push(finalMs);
  return [...new Set(frames)];
};

export const assertRegionalJob = (job: RegionalScanJob, workerProduct: ManagedProduct, workerEnvironment: string, workerRegion: ManagedRegion): void => {
  if (job.product !== workerProduct || job.environment !== workerEnvironment || job.dataHomeRegion !== workerRegion) {
    throw new Error(`Cross-cell scan rejected: job=${job.product}/${job.environment}/${job.dataHomeRegion} worker=${workerProduct}/${workerEnvironment}/${workerRegion}`);
  }
};

type PlannedJobInput = Omit<RegionalScanJob, 'id' | 'idempotencyKey' | 'state' | 'attemptCount' | 'createdAt' | 'scanGroupId' | 'requiredScanCount'> & { contentHash: string };
const job = (input: PlannedJobInput): RegionalScanJob => {
  const idempotencyKey = scanIdempotencyKey(input);
  return { ...input, id: `scan-${idempotencyKey}`, idempotencyKey, scanGroupId: '', requiredScanCount: 0, state: 'QUEUED', attemptCount: 0, createdAt: new Date().toISOString() };
};

export const finalizeRegionalScanGroup = (jobs: RegionalScanJob[], media: MediaVersion, product: ManagedProduct, environment: string, scanProfile: string): RegionalScanJob[] => {
  const scanGroupId = createHash('sha256').update([product, environment, media.region, media.id, media.sha256, scanProfile].join('\u0000')).digest('hex');
  return jobs.map((planned) => ({ ...planned, scanGroupId, requiredScanCount: jobs.length }));
};

/** Creates all required work up-front, so partial scans can never look publishable. */
export const planRegionalScans = (product: ManagedProduct, environment: string, media: MediaVersion, source: { bucket: string; objectKey: string; frameBucket?: string; specialistHashProvider?: string }, scanProfile: string = DEFAULT_VIDEO_SCAN_PROFILE.scanProfile): RegionalScanJob[] => {
  if (!environment.trim()) throw new Error('Scan environment is required');
  const common = { product, environment, dataHomeRegion: media.region, assetId: media.assetId, mediaVersionId: media.id, scanProfile, provider: 'aws-rekognition', contentHash: media.sha256, sourceBucket: source.bucket, sourceObjectKey: source.objectKey };
  const specialistJobs = source.specialistHashProvider ? [job({ ...common, type: 'HASH' as const, provider: source.specialistHashProvider })] : [];
  if (media.mediaType === 'image') return finalizeRegionalScanGroup([
    ...specialistJobs,
    job({ ...common, type: 'IMAGE_MODERATION' }),
    job({ ...common, type: 'FACE_AGE' })
  ], media, product, environment, scanProfile);
  if (!media.durationSeconds) throw new Error('Accepted video requires a validated duration');
  const frames = deterministicVideoFramePlan(media.durationSeconds);
  return finalizeRegionalScanGroup([
    ...specialistJobs,
    job({ ...common, type: 'VIDEO_FRAME_PLAN' }),
    ...frames.flatMap((timestampMs) => [
      job({ ...common, mediaVersionId: `${media.id}@${timestampMs}`, sourceBucket: source.frameBucket || source.bucket, sourceObjectKey: `frames/${media.id}/${timestampMs}.jpg`, type: 'VIDEO_FRAME_MODERATION', videoTimestampMs: timestampMs }),
      job({ ...common, mediaVersionId: `${media.id}@${timestampMs}`, sourceBucket: source.frameBucket || source.bucket, sourceObjectKey: `frames/${media.id}/${timestampMs}.jpg`, type: 'VIDEO_FRAME_FACE_AGE', videoTimestampMs: timestampMs })
    ])
  ], media, product, environment, scanProfile);
};

export const videoCoverage = (plannedFrames: number, results: RegionalScanResult[]): VideoScanSummary => {
  const frameResults = results.filter(({ videoTimestampMs }) => videoTimestampMs !== undefined);
  const failedTimestamps = new Set(frameResults.filter(({ outcome }) => outcome === 'ERROR' || outcome === 'UNAVAILABLE').map(({ videoTimestampMs }) => videoTimestampMs));
  const successfulTypes = new Map<number, Set<RegionalScanType>>();
  frameResults.filter(({ outcome }) => outcome !== 'ERROR' && outcome !== 'UNAVAILABLE').forEach(({ videoTimestampMs, scanType }) => {
    const timestamp = videoTimestampMs!;
    const types = successfulTypes.get(timestamp) || new Set<RegionalScanType>();
    types.add(scanType);
    successfulTypes.set(timestamp, types);
  });
  const completeTimestamps = [...successfulTypes].filter(([, types]) => types.has('VIDEO_FRAME_MODERATION') && types.has('VIDEO_FRAME_FACE_AGE')).map(([timestamp]) => timestamp);
  const labels = new Map<string, number>();
  results.flatMap(({ labels }) => labels).forEach(({ name, confidence }) => labels.set(name, Math.max(labels.get(name) || 0, confidence)));
  const complete = completeTimestamps.length === plannedFrames && failedTimestamps.size === 0;
  return {
    frameIntervalSeconds: DEFAULT_VIDEO_SCAN_PROFILE.videoFrameIntervalSeconds,
    framesPlanned: plannedFrames,
    framesScanned: completeTimestamps.length,
    framesFailed: failedTimestamps.size,
    aggregateLabels: [...labels].map(([name, maxConfidence]) => ({ name, maxConfidence })),
    aggregateAgeSignals: results.flatMap(({ faceAgeRanges }) => faceAgeRanges.map(({ low, high }) => ({ low, high }))),
    coverageState: complete ? 'COMPLETE' : failedTimestamps.size ? 'UNAVAILABLE' : 'INCOMPLETE'
  };
};

export const usageForMedia = (input: { product: ManagedProduct; region: ManagedRegion; creatorId: string; spaceId: string; period: string; media: MediaVersion; estimatedProviderCost?: number }): MediaProcessingLedgerEntry => {
  const sampledFrameCount = input.media.mediaType === 'video' ? deterministicVideoFramePlan(input.media.durationSeconds || 0).length : 0;
  return {
    product: input.product, dataHomeRegion: input.region, creatorId: input.creatorId, spaceId: input.spaceId, period: input.period,
    mediaType: input.media.mediaType, sourceImageCount: input.media.mediaType === 'image' ? 1 : 0,
    videoDurationSeconds: input.media.mediaType === 'video' ? input.media.durationSeconds || 0 : 0,
    sampledFrameCount, moderationCalls: input.media.mediaType === 'image' ? 1 : sampledFrameCount,
    faceAgeCalls: input.media.mediaType === 'image' ? 1 : sampledFrameCount,
    estimatedProviderCost: input.estimatedProviderCost || 0,
    creditUnits: input.media.mediaType === 'image' ? 1 : Math.ceil((input.media.durationSeconds || 0) / 60) * 25
  };
};

export const scanGroupManifestRecords = (jobs: RegionalScanJob[], chunkSize = 40): Array<{ id: string; recordType: 'SCAN_GROUP_MANIFEST'; scanGroupId: string; chunk: number; jobIds: string[] }> => {
  if (!jobs.length || !jobs[0].scanGroupId || jobs.some(({ scanGroupId }) => scanGroupId !== jobs[0].scanGroupId)) throw new Error('Manifest jobs must belong to one scan group');
  const records = [];
  for (let offset = 0; offset < jobs.length; offset += chunkSize) records.push({ id: `manifest-${jobs[0].scanGroupId}-${records.length}`, recordType: 'SCAN_GROUP_MANIFEST' as const, scanGroupId: jobs[0].scanGroupId, chunk: records.length, jobIds: jobs.slice(offset, offset + chunkSize).map(({ id }) => id) });
  return records;
};
