import { BillingLedger, BillingScope, PlanVersion, deliveryDecision, deliveryThresholdsCrossed, launchPlans, processingCharge, processingDecision, storageDecision } from '../src/billing';

const scope: BillingScope = { product: 'EVERSALLY', environment: 'test', spaceId: 'space-1', dataHomeRegion: 'ca-central-1' };
const at = '2026-08-25T12:00:00.000Z';

describe('billing and usage ledger', () => {
  test('charges one image credit and duration-proportional video credits', () => {
    expect(processingCharge({ type: 'IMAGE' })).toBe(1);
    expect(processingCharge({ type: 'VIDEO', durationSeconds: 60 })).toBe(25);
    expect(processingCharge({ type: 'VIDEO', durationSeconds: 61 })).toBe(26);
    expect(processingCharge({ type: 'VIDEO', durationSeconds: 1 })).toBe(1);
  });

  test('reserves earliest-expiring credits and retries are idempotent', () => {
    const ledger = new BillingLedger();
    ledger.grantCredits(scope, { quantity: 10, source: 'FREE_PLAN', grantedAt: at, periodEnd: '2026-09-01T00:00:00.000Z', idempotencyKey: 'free-aug' });
    ledger.grantCredits(scope, { quantity: 30, source: 'PAID_PLAN', grantedAt: at, idempotencyKey: 'paid-aug' });
    const first = ledger.reserveProcessing(scope, { reservationId: 'job-1', quantity: 25, observedAt: at });
    const retry = ledger.reserveProcessing(scope, { reservationId: 'job-1', quantity: 25, observedAt: at });
    expect(retry).toEqual(first);
    expect(first.allocations.map(a => a.quantity)).toEqual([10, 15]);
    ledger.finalizeProcessing(scope, 'job-1', 'COMMIT', at);
    ledger.finalizeProcessing(scope, 'job-1', 'COMMIT', at);
    expect(ledger.balance(scope, undefined, at)).toMatchObject({ availableProcessingCredits: 15, reservedProcessingCredits: 0 });
    expect(ledger.listEvents(scope).filter(e => e.category === 'PROCESSING_CREDITS_COMMITTED')).toHaveLength(1);
  });

  test('does not expire reserved lots and keeps product data isolated', () => {
    const ledger = new BillingLedger();
    ledger.grantCredits(scope, { quantity: 5, source: 'FREE_PLAN', grantedAt: at, periodEnd: '2026-09-01T00:00:00.000Z', idempotencyKey: 'grant' });
    ledger.reserveProcessing(scope, { reservationId: 'held', quantity: 1, observedAt: at });
    expect(ledger.expireCredits(scope, '2026-09-02T00:00:00.000Z')).toBe(0);
    const nightframe = { ...scope, product: 'NIGHTFRAME' as const };
    expect(ledger.balance(nightframe, undefined, at).availableProcessingCredits).toBe(0);
  });

  test('rebuilds storage and period delivery from append-only events', () => {
    const ledger = new BillingLedger();
    ledger.appendUsage(scope, { idempotencyKey: 'asset-a', category: 'STORAGE_BYTES_OBSERVED', quantity: 100, baseUnit: 'BYTE', observedAt: at, periodKey: 'live', sourceSystem: 'asset' });
    ledger.appendUsage(scope, { idempotencyKey: 'reconcile-a', category: 'STORAGE_BYTES_ADJUSTMENT', quantity: -10, baseUnit: 'BYTE', observedAt: at, periodKey: 'live', sourceSystem: 'inventory' });
    ledger.appendUsage(scope, { idempotencyKey: 'cdn-a', category: 'DELIVERY_BYTES_OBSERVED', quantity: 50, baseUnit: 'BYTE', observedAt: at, periodKey: '2026-08', sourceSystem: 'cdn' });
    expect(ledger.balance(scope, { start: '2026-08-01', end: '2026-09-01' }, at)).toMatchObject({ storageBytes: 90, deliveryBytes: 50 });
    expect(deliveryThresholdsCrossed(79, 101, 100)).toEqual([80, 90, 100]);
  });

  test('Nightframe paid access requires an auditable manual settlement', () => {
    const ledger = new BillingLedger();
    const plan: PlanVersion = { ...scope, product: 'NIGHTFRAME', planVersionId: 'nf-creator-v1', code: 'creator', version: 1, priceMinor: 2400, currency: 'USD', period: 'MONTH', storageBytes: 150_000_000_000, deliveryBytes: 35_000_000_000, processingCredits: 1500, transcodeMinutes: 0, features: {}, effectiveFrom: at };
    const result = ledger.approveManualSettlement(plan, { externalReference: 'invoice-42', amountMinor: 2400, currency: 'USD', periodStart: at, periodEnd: '2026-09-25T12:00:00.000Z', evidenceClassification: 'restricted-finance', approvedBy: 'finance-admin' });
    expect(result.entitlement).toMatchObject({ source: 'MANUAL', status: 'ACTIVE', quotas: { processingCredits: 1500 } });
    expect(result.entitlement.creditGrantLotId).toBeDefined();
    expect(ledger.balance({ ...scope, product: 'NIGHTFRAME' }, undefined, at).availableProcessingCredits).toBe(1500);
  });

  test('grants free credits through period end and paid renewal credits for one year exactly once', () => {
    const freeLedger = new BillingLedger(); const freePlan = launchPlans(scope, at)[0];
    freeLedger.activateEntitlement(freePlan, { periodStart: at, periodEnd: '2026-09-01T00:00:00.000Z', source: 'FREE' });
    expect(freeLedger.expireCredits(scope, '2026-09-01T00:00:00.000Z')).toBe(250);

    const paidLedger = new BillingLedger(); const paidPlan = launchPlans(scope, at)[1];
    const paid = paidLedger.recordVerifiedProviderEntitlement(paidPlan, { periodStart: at, periodEnd: '2026-09-25T12:00:00.000Z', billingAccountId: 'payer', providerEventId: 'renewal-1' });
    expect(paidLedger.balance(scope, undefined, '2027-08-25T11:59:59.000Z').availableProcessingCredits).toBe(750);
    expect(paidLedger.expireCredits(scope, '2027-08-25T12:00:00.000Z')).toBe(750);
    expect(paidLedger.recordVerifiedProviderEntitlement(paidPlan, { periodStart: at, periodEnd: '2026-09-25T12:00:00.000Z', billingAccountId: 'payer', providerEventId: 'renewal-1' })).toEqual(paid);
    expect(paidLedger.listEntitlements(scope)).toHaveLength(1);
  });

  test('presents available, reserved, expiring, source, video-equivalent, and recent activity', () => {
    const ledger = new BillingLedger();
    ledger.grantCredits(scope, { quantity: 100, source: 'PROMOTION', grantedAt: at, expiresAt: '2026-09-10T12:00:00.000Z', idempotencyKey: 'promo' });
    ledger.reserveProcessing(scope, { reservationId: 'queued', quantity: 25, observedAt: at, referenceId: 'asset-queued' });
    expect(ledger.processingCreditSummary(scope, at)).toMatchObject({
      availableProcessingCredits: 75, reservedProcessingCredits: 25, expiringWithin30Days: 75,
      nextExpiringQuantity: 75, earliestExpiry: '2026-09-10T12:00:00.000Z', videoEquivalentMinutes: 3,
      bySource: { PROMOTION: { available: 75, reserved: 25, spent: 0, expiredOrRevoked: 0 } }
    });
    expect(ledger.processingCreditSummary(scope, at).recentActivity.map(event => event.category)).toEqual(['PROCESSING_CREDITS_GRANTED', 'PROCESSING_CREDITS_RESERVED']);
  });

  test('distinguishes spent, expired, and revoked credit quantities', () => {
    const ledger = new BillingLedger();
    ledger.grantCredits(scope, { quantity: 5, source: 'PROMOTION', grantedAt: at, expiresAt: '2026-09-01T00:00:00.000Z', idempotencyKey: 'spend-expire' });
    ledger.reserveProcessing(scope, { reservationId: 'spent', quantity: 2, observedAt: at }); ledger.finalizeProcessing(scope, 'spent', 'COMMIT', at);
    ledger.expireCredits(scope, '2026-09-01T00:00:00.000Z');
    ledger.grantCredits(scope, { quantity: 4, source: 'MANUAL_ADJUSTMENT', grantedAt: at, expiresAt: '2026-10-01T00:00:00.000Z', idempotencyKey: 'revoke', documentId: 'adjustment' });
    ledger.reverseCreditGrant(scope, 'adjustment', at, 'reverse');
    expect(ledger.processingCreditSummary(scope, '2026-09-02T00:00:00.000Z').bySource).toMatchObject({
      PROMOTION: { spent: 2, expiredOrRevoked: 3 }, MANUAL_ADJUSTMENT: { spent: 0, expiredOrRevoked: 4 }
    });
  });

  test('publishes launch plans and applies non-overage enforcement policy', () => {
    const plans = launchPlans(scope, at);
    expect(plans.map(p => [p.code, p.priceMinor, p.storageBytes, p.processingCredits])).toEqual([
      ['free', 0, 15_000_000_000, 250], ['creator-starter', 800, 50_000_000_000, 750],
      ['creator', 1600, 150_000_000_000, 1500], ['creator-plus', 3400, 400_000_000_000, 3000],
      ['studio', 7500, 1_000_000_000_000, 6000]
    ]);
    expect(storageDecision(100, 1, 100, 'RETAIN').allowed).toBe(false);
    expect(storageDecision(100, 0, 100, 'DELETE').allowed).toBe(true);
    expect(processingDecision(24, 25).action).toBe('BLOCK_PROCESSING');
    expect(deliveryDecision(79, 101, 100)).toEqual({ allowed: true, action: 'DELIVERY_REVIEW', thresholds: [80, 90, 100] });
  });
});
