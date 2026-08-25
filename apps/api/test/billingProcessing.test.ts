import { BillingLedger, BillingScope } from '../src/billing';
import { ProcessingMeter } from '../src/billingProcessing';

const scope: BillingScope = { product: 'EVERSALLY', environment: 'test', spaceId: 'space-1', dataHomeRegion: 'ca-central-1' };
const at = '2026-08-25T12:00:00.000Z';

describe('processing metering', () => {
  test('reserves and commits one image credit exactly once across retries', () => {
    const ledger = new BillingLedger();
    ledger.grantCredits(scope, { quantity: 10, source: 'PAID_PLAN', grantedAt: at, idempotencyKey: 'grant' });
    const meter = new ProcessingMeter(ledger);
    const accepted = meter.accept(scope, { jobId: 'job-1', assetId: 'asset-1', trigger: 'CREATOR_UPLOAD', media: { type: 'IMAGE' }, scanProfileVersion: 'v1', observedAt: at });
    expect(accepted).toMatchObject({ chargedCredits: 1, plannedFrames: 1, state: 'RESERVED' });
    expect(meter.accept(scope, { jobId: 'job-1', assetId: 'asset-1', trigger: 'CREATOR_UPLOAD', media: { type: 'IMAGE' }, scanProfileVersion: 'v1', observedAt: at })).toEqual(accepted);
    meter.start(scope, 'job-1');
    meter.complete(scope, 'job-1', { completedFrames: 1, moderationCalls: 1, faceAgeCalls: 1, observedAt: at });
    meter.complete(scope, 'job-1', { completedFrames: 1, moderationCalls: 1, faceAgeCalls: 1, observedAt: at });
    expect(ledger.balance(scope, undefined, at)).toMatchObject({ availableProcessingCredits: 9, reservedProcessingCredits: 0 });
    expect(ledger.listEvents(scope).filter(event => event.category === 'PROCESSING_CREDITS_COMMITTED')).toHaveLength(1);
  });

  test('charges a 60-second video 25 credits while retaining raw frame and call facts', () => {
    const ledger = new BillingLedger();
    ledger.grantCredits(scope, { quantity: 25, source: 'PAID_PLAN', grantedAt: at, idempotencyKey: 'grant' });
    const meter = new ProcessingMeter(ledger);
    const job = meter.accept(scope, { jobId: 'video-1', assetId: 'asset-2', trigger: 'CREATOR_REPLACEMENT', media: { type: 'VIDEO', durationSeconds: 60 }, scanProfileVersion: 'video-v2', observedAt: at });
    expect(job).toMatchObject({ chargedCredits: 25, plannedFrames: 20, durationSeconds: 60 });
    expect(meter.complete(scope, 'video-1', { completedFrames: 19, moderationCalls: 19, faceAgeCalls: 18, observedAt: at })).toMatchObject({ completedFrames: 19, missingFrames: 1, moderationCalls: 19, faceAgeCalls: 18, state: 'COMPLETED' });
  });

  test('does not charge service-initiated scans and releases failed creator reservations', () => {
    const ledger = new BillingLedger();
    ledger.grantCredits(scope, { quantity: 2, source: 'FREE_PLAN', grantedAt: at, periodEnd: '2026-09-01T00:00:00.000Z', idempotencyKey: 'grant' });
    const meter = new ProcessingMeter(ledger);
    expect(meter.accept(scope, { jobId: 'backfill', assetId: 'asset-1', trigger: 'POLICY_BACKFILL', media: { type: 'IMAGE' }, scanProfileVersion: 'v2', observedAt: at })).toMatchObject({ chargedCredits: 0, state: 'QUEUED' });
    meter.accept(scope, { jobId: 'failed', assetId: 'asset-2', trigger: 'CREATOR_UPLOAD', media: { type: 'IMAGE' }, scanProfileVersion: 'v2', observedAt: at });
    expect(meter.fail(scope, 'failed', { observedAt: at })).toMatchObject({ state: 'FAILED' });
    expect(ledger.balance(scope, undefined, at)).toMatchObject({ availableProcessingCredits: 2, reservedProcessingCredits: 0 });
  });

  test('retains insufficient-credit uploads as action required and resumes after a grant', () => {
    const ledger = new BillingLedger(); const meter = new ProcessingMeter(ledger);
    const held = meter.accept(scope, { jobId: 'held', assetId: 'retained-source', trigger: 'CREATOR_UPLOAD', media: { type: 'VIDEO', durationSeconds: 61 }, scanProfileVersion: 'v3', observedAt: at });
    expect(held).toMatchObject({ assetId: 'retained-source', chargedCredits: 26, state: 'ACTION_REQUIRED', actionRequiredReason: 'INSUFFICIENT_PROCESSING_CREDITS' });
    expect(meter.list(scope, 'ACTION_REQUIRED')).toEqual([held]);
    expect(() => meter.start(scope, 'held')).toThrow('requires creator action');
    expect(() => meter.complete(scope, 'held', { completedFrames: 0, moderationCalls: 0, faceAgeCalls: 0, observedAt: at })).toThrow('requires creator action');
    ledger.grantCredits(scope, { quantity: 26, source: 'ES_TOP_UP', grantedAt: at, idempotencyKey: 'top-up' });
    expect(meter.retryReservation(scope, 'held', at)).toMatchObject({ state: 'RESERVED', actionRequiredReason: undefined });
    expect(meter.list(scope, 'ACTION_REQUIRED')).toEqual([]);
    expect(ledger.balance(scope, undefined, at)).toMatchObject({ availableProcessingCredits: 0, reservedProcessingCredits: 26 });
  });
});
