import { BillingLedger, BillingScope } from '../src/billing';
import { QuotaPolicy } from '../src/billingQuota';

const scope: BillingScope = { product: 'EVERSALLY', environment: 'test', spaceId: 'space-1', dataHomeRegion: 'ca-central-1' };
const start = '2026-08-25T00:00:00.000Z';
const end = '2026-08-30T00:00:00.000Z';

describe('quota exceptions', () => {
  test('adds time-bound storage capacity without editing the plan allowance', () => {
    const policy = new QuotaPolicy(new BillingLedger(), () => start);
    const action = policy.grant(scope, { category: 'STORAGE_BYTES', amount: 50, reason: 'Temporary migration capacity', effectiveFrom: start, effectiveTo: end, actorId: 'support-1', evidenceReference: 'case-42', idempotencyKey: 'exception-1' });
    expect(policy.grant(scope, { category: 'STORAGE_BYTES', amount: 999, reason: 'changed replay', effectiveFrom: start, effectiveTo: end, actorId: 'support-1', idempotencyKey: 'exception-1' })).toEqual(action);
    expect(policy.storage(scope, { currentBytes: 100, proposedBytes: 40, planAllowanceBytes: 100, operation: 'RETAIN', at: start, policyEligible: true }).allowed).toBe(true);
    expect(policy.storage(scope, { currentBytes: 100, proposedBytes: 40, planAllowanceBytes: 100, operation: 'RETAIN', at: end, policyEligible: true }).allowed).toBe(false);
  });

  test('grants processing exceptions as expiring traceable adjustment lots', () => {
    const ledger = new BillingLedger();
    const policy = new QuotaPolicy(ledger, () => start);
    policy.grant(scope, { category: 'PROCESSING_CREDITS', amount: 25, reason: 'Approved ingest exception', effectiveFrom: start, effectiveTo: end, actorId: 'support-1', idempotencyKey: 'processing-1' });
    expect(ledger.balance(scope, undefined, start).availableProcessingCredits).toBe(25);
    expect(ledger.listEvents(scope)[0]).toMatchObject({ category: 'PROCESSING_CREDITS_GRANTED', quantity: 25, lotId: expect.any(String) });
    expect(ledger.expireCredits(scope, end)).toBe(25);
  });

  test('reverses unused processing exception credits with a linked adjustment', () => {
    const ledger = new BillingLedger();
    const policy = new QuotaPolicy(ledger, () => '2026-08-26T00:00:00.000Z');
    policy.grant(scope, { category: 'PROCESSING_CREDITS', amount: 10, reason: 'Temporary exception', effectiveFrom: start, effectiveTo: end, actorId: 'support-1', idempotencyKey: 'processing-revoke' });
    policy.revoke(scope, { actionId: 'processing-revoke', reason: 'Granted in error', actorId: 'support-2' });
    expect(ledger.balance(scope, undefined, start).availableProcessingCredits).toBe(0);
    expect(ledger.listEvents(scope).at(-1)).toMatchObject({ category: 'PROCESSING_CREDITS_ADJUSTMENT', quantity: -10, referenceId: 'processing-revoke' });
  });

  test('records revocation and never permits quota exceptions to bypass policy holds', () => {
    const policy = new QuotaPolicy(new BillingLedger(), () => start);
    policy.grant(scope, { category: 'STORAGE_BYTES', amount: 1000, reason: 'Capacity review', effectiveFrom: start, effectiveTo: end, actorId: 'support-1', idempotencyKey: 'storage-1' });
    const revocation = policy.revoke(scope, { actionId: 'storage-1', reason: 'Exception no longer required', actorId: 'support-2' });
    expect(policy.revoke(scope, { actionId: 'storage-1', reason: 'replay', actorId: 'support-3' })).toEqual(revocation);
    expect(policy.effectiveAmount(scope, 'STORAGE_BYTES', start)).toBe(0);
    expect(policy.storage(scope, { currentBytes: 0, proposedBytes: 1, planAllowanceBytes: 100, operation: 'RETAIN', at: start, policyEligible: false }).allowed).toBe(false);
    expect(policy.processing(scope, { availableCredits: 100, proposedCharge: 1, consumesCredits: true, policyEligible: false }).allowed).toBe(false);
    expect(policy.storage(scope, { currentBytes: 100, proposedBytes: 0, planAllowanceBytes: 100, operation: 'DELETE', at: start, policyEligible: false }).allowed).toBe(true);
  });
});
