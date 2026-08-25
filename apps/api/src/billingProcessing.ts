import { BillingLedger, BillingScope, CreditReservation, processingCharge } from './billing';

export type ProcessingTrigger = 'CREATOR_UPLOAD' | 'CREATOR_REPLACEMENT' | 'SERVICE_RETRY' | 'REVIEW_RESCAN' | 'MIGRATION_RECHECK' | 'POLICY_BACKFILL';
export type ProcessingMedia = { type: 'IMAGE' } | { type: 'VIDEO'; durationSeconds: number };

export interface ProcessingJobRecord extends BillingScope {
  jobId: string;
  assetId: string;
  trigger: ProcessingTrigger;
  mediaType: ProcessingMedia['type'];
  durationSeconds?: number;
  scanProfileVersion: string;
  plannedFrames: number;
  completedFrames: number;
  missingFrames: number;
  moderationCalls: number;
  faceAgeCalls: number;
  chargedCredits: number;
  reservationId?: string;
  reservationEventId?: string;
  finalizationEventId?: string;
  state: 'ACTION_REQUIRED' | 'RESERVED' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  actionRequiredReason?: 'INSUFFICIENT_PROCESSING_CREDITS';
  createdAt: string;
  completedAt?: string;
}

const scopeKey = (scope: BillingScope) => `${scope.product}|${scope.environment}|${scope.dataHomeRegion}|${scope.spaceId}`;
const clone = <T>(value: T): T => structuredClone(value);
const creatorCharged = (trigger: ProcessingTrigger) => trigger === 'CREATOR_UPLOAD' || trigger === 'CREATOR_REPLACEMENT';

/** Coordinates creator credit reservations while retaining non-sensitive scan cost facts. */
export class ProcessingMeter {
  private readonly jobs = new Map<string, ProcessingJobRecord>();

  constructor(private readonly ledger: BillingLedger) {}

  accept(scope: BillingScope, input: { jobId: string; assetId: string; trigger: ProcessingTrigger; media: ProcessingMedia; scanProfileVersion: string; observedAt: string }): ProcessingJobRecord {
    const key = `${scopeKey(scope)}|${input.jobId}`;
    const existing = this.jobs.get(key);
    if (existing) return clone(existing);
    if (!input.scanProfileVersion.trim()) throw new Error('Scan profile version is required');
    const plannedFrames = input.media.type === 'VIDEO' ? Math.ceil(input.media.durationSeconds / 3) : 1;
    const chargedCredits = creatorCharged(input.trigger) ? processingCharge(input.media) : 0;
    let reservation: CreditReservation | undefined;
    let actionRequiredReason: ProcessingJobRecord['actionRequiredReason'];
    if (chargedCredits) {
      try {
        reservation = this.ledger.reserveProcessing(scope, { reservationId: `processing:${input.jobId}`, quantity: chargedCredits, observedAt: input.observedAt, referenceId: input.assetId });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'INSUFFICIENT_PROCESSING_CREDITS') throw error;
        actionRequiredReason = 'INSUFFICIENT_PROCESSING_CREDITS';
      }
    }
    const job: ProcessingJobRecord = {
      ...scope, jobId: input.jobId, assetId: input.assetId, trigger: input.trigger, mediaType: input.media.type,
      durationSeconds: input.media.type === 'VIDEO' ? input.media.durationSeconds : undefined,
      scanProfileVersion: input.scanProfileVersion, plannedFrames, completedFrames: 0, missingFrames: plannedFrames,
      moderationCalls: 0, faceAgeCalls: 0, chargedCredits, reservationId: reservation?.reservationId,
      reservationEventId: reservation?.eventId, state: actionRequiredReason ? 'ACTION_REQUIRED' : reservation ? 'RESERVED' : 'QUEUED', actionRequiredReason, createdAt: input.observedAt
    };
    this.jobs.set(key, job);
    return clone(job);
  }

  retryReservation(scope: BillingScope, jobId: string, observedAt: string): ProcessingJobRecord {
    const job = this.requireJob(scope, jobId);
    if (job.state !== 'ACTION_REQUIRED') return clone(job);
    const reservation = this.ledger.reserveProcessing(scope, { reservationId: `processing:${job.jobId}`, quantity: job.chargedCredits, observedAt, referenceId: job.assetId });
    job.reservationId = reservation.reservationId; job.reservationEventId = reservation.eventId;
    job.actionRequiredReason = undefined; job.state = 'RESERVED';
    return clone(job);
  }

  start(scope: BillingScope, jobId: string): ProcessingJobRecord {
    const job = this.requireJob(scope, jobId);
    if (job.state === 'ACTION_REQUIRED') throw new Error('Processing job requires creator action');
    if (job.state === 'RESERVED' || job.state === 'QUEUED') job.state = 'RUNNING';
    return clone(job);
  }

  complete(scope: BillingScope, jobId: string, input: { completedFrames: number; moderationCalls: number; faceAgeCalls: number; observedAt: string }): ProcessingJobRecord {
    const job = this.requireJob(scope, jobId);
    if (job.state === 'COMPLETED') return clone(job);
    if (job.state === 'ACTION_REQUIRED') throw new Error('Processing job requires creator action');
    if (job.state === 'FAILED' || job.state === 'CANCELLED') throw new Error('Terminal processing job cannot complete');
    for (const [name, value] of Object.entries(input).filter(([name]) => name !== 'observedAt')) {
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer`);
    }
    if (input.completedFrames > job.plannedFrames) throw new Error('Completed frames exceed deterministic frame plan');
    job.completedFrames = input.completedFrames;
    job.missingFrames = job.plannedFrames - input.completedFrames;
    job.moderationCalls = input.moderationCalls;
    job.faceAgeCalls = input.faceAgeCalls;
    if (job.reservationId) {
      this.ledger.finalizeProcessing(scope, job.reservationId, 'COMMIT', input.observedAt);
      job.finalizationEventId = this.latestFinalizationEvent(scope, job.reservationEventId!);
    }
    job.state = 'COMPLETED';
    job.completedAt = input.observedAt;
    return clone(job);
  }

  fail(scope: BillingScope, jobId: string, input: { observedAt: string; cancelled?: boolean }): ProcessingJobRecord {
    const job = this.requireJob(scope, jobId);
    if (job.state === 'FAILED' || job.state === 'CANCELLED') return clone(job);
    if (job.state === 'COMPLETED') throw new Error('Completed processing job cannot fail');
    if (job.reservationId) {
      this.ledger.finalizeProcessing(scope, job.reservationId, 'RELEASE', input.observedAt);
      job.finalizationEventId = this.latestFinalizationEvent(scope, job.reservationEventId!);
    }
    job.state = input.cancelled ? 'CANCELLED' : 'FAILED';
    job.completedAt = input.observedAt;
    return clone(job);
  }

  get(scope: BillingScope, jobId: string): ProcessingJobRecord | undefined {
    const job = this.jobs.get(`${scopeKey(scope)}|${jobId}`);
    return job && clone(job);
  }

  list(scope: BillingScope, state?: ProcessingJobRecord['state']): ProcessingJobRecord[] {
    return [...this.jobs.values()].filter(job => scopeKey(job) === scopeKey(scope) && (!state || job.state === state)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  private requireJob(scope: BillingScope, jobId: string): ProcessingJobRecord {
    const job = this.jobs.get(`${scopeKey(scope)}|${jobId}`);
    if (!job) throw new Error('Unknown processing job');
    return job;
  }

  private latestFinalizationEvent(scope: BillingScope, reservationEventId: string): string | undefined {
    return this.ledger.listEvents(scope).find(event => event.linkedEventId === reservationEventId)?.eventId;
  }
}
