import { randomUUID } from 'crypto';

export type BillingProduct = 'EVERSALLY' | 'NIGHTFRAME' | 'UBEEQ';
export type UsageCategory =
  | 'STORAGE_BYTES_OBSERVED' | 'STORAGE_BYTES_ADJUSTMENT' | 'DELIVERY_BYTES_OBSERVED'
  | 'PROCESSING_CREDITS_GRANTED' | 'PROCESSING_CREDITS_RESERVED'
  | 'PROCESSING_CREDITS_COMMITTED' | 'PROCESSING_CREDITS_RELEASED'
  | 'PROCESSING_CREDITS_ADJUSTMENT' | 'PROCESSING_CREDITS_EXPIRED';
export type CreditSource = 'PAID_PLAN' | 'ES_TOP_UP' | 'FREE_PLAN' | 'PROMOTION' | 'MANUAL_ADJUSTMENT';

export interface BillingScope { product: BillingProduct; environment: string; spaceId: string; dataHomeRegion: string }
export interface PlanVersion extends BillingScope {
  planVersionId: string; code: string; version: number; priceMinor: number; currency: string; period: 'MONTH';
  storageBytes: number; deliveryBytes: number; processingCredits: number; transcodeMinutes: 0;
  features: Readonly<Record<string, boolean>>; effectiveFrom: string; effectiveTo?: string;
}
export interface ServiceEntitlement extends BillingScope {
  entitlementId: string; planVersionId: string; billingAccountId?: string; status: 'FREE' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';
  source: 'FREE' | 'PROVIDER' | 'MANUAL'; periodStart: string; periodEnd: string;
  quotas: Readonly<Pick<PlanVersion, 'storageBytes' | 'deliveryBytes' | 'processingCredits' | 'transcodeMinutes'>>;
  createdAt: string; providerEventId?: string; creditGrantLotId?: string;
}
export interface UsageEvent extends BillingScope {
  eventId: string; idempotencyKey: string; category: UsageCategory; quantity: number; baseUnit: 'BYTE' | 'CREDIT';
  observedAt: string; periodKey: string; sourceSystem: string; referenceId?: string; lotId?: string; linkedEventId?: string;
}
export interface ProcessingCreditLot extends BillingScope {
  lotId: string; source: CreditSource; originalQuantity: number; remainingQuantity: number; reservedQuantity: number;
  spentQuantity: number; expiredQuantity: number; revokedQuantity: number;
  grantedAt: string; expiresAt: string; grantPeriodKey: string; documentId?: string; status?: 'AVAILABLE' | 'FROZEN' | 'REVOKED' | 'EXPIRED';
}
export interface CreditReservation { reservationId: string; scope: BillingScope; quantity: number; state: 'RESERVED' | 'COMMITTED' | 'RELEASED'; allocations: Array<{ lotId: string; quantity: number }>; eventId: string }
export interface UsageBalance { storageBytes: number; deliveryBytes: number; availableProcessingCredits: number; reservedProcessingCredits: number; earliestExpiry?: string; measurementLagSeconds?: number }
export interface ProcessingCreditSummary extends UsageBalance {
  expiringWithin30Days: number; nextExpiringQuantity: number; videoEquivalentMinutes: number;
  bySource: Partial<Record<CreditSource, { available: number; reserved: number; spent: number; expiredOrRevoked: number }>>;
  recentActivity: UsageEvent[];
}
export interface ManualSettlement extends BillingScope { settlementId: string; externalReference: string; amountMinor: number; currency: string; periodStart: string; periodEnd: string; evidenceClassification: string; approvedBy: string; approvedAt: string; planVersionId: string }

export interface PaymentAdapter {
  createCheckout(accountId: string, plan: PlanVersion, returnUrls: { success: string; cancel: string }): Promise<{ redirectUrl: string }>;
  createCustomerPortal(subscriptionId: string): Promise<{ redirectUrl: string }>;
  requestCancel(subscriptionId: string, effectiveAt: string): Promise<void>;
  parseAndVerifyWebhook(headers: Record<string, string>, body: Buffer): Promise<VerifiedProviderEvent>;
  fetchAuthoritativeSubscription(subscriptionId: string): Promise<AuthoritativeSubscription>;
  createOneTimeCreditCheckout(accountId: string, creditProductId: string, returnUrls: { success: string; cancel: string }): Promise<{ redirectUrl: string }>;
}

export interface VerifiedProviderEvent {
  eventId: string;
  subscriptionId: string;
  occurredAt: string;
}

export interface AuthoritativeSubscription {
  subscriptionId: string;
  customerId: string;
  priceId: string;
  status: 'ACTIVE' | 'PAID' | 'PENDING' | 'PAST_DUE' | 'CANCELLED';
  currency: string;
  interval: 'MONTH';
  livemode: boolean;
  periodStart: string;
  periodEnd: string;
}

const DAY = 86_400_000;
const scopeKey = (s: BillingScope) => `${s.product}|${s.environment}|${s.dataHomeRegion}|${s.spaceId}`;
const periodKey = (at: string) => at.slice(0, 7);
const clone = <T>(value: T): T => structuredClone(value);

/** Append-only, provider-neutral billing ledger. Persistence adapters can implement the same operations transactionally. */
export class BillingLedger {
  private events: UsageEvent[] = [];
  private lots: ProcessingCreditLot[] = [];
  private reservations = new Map<string, CreditReservation>();
  private idempotency = new Map<string, UsageEvent>();
  private entitlements: ServiceEntitlement[] = [];
  private settlements: ManualSettlement[] = [];

  appendUsage(scope: BillingScope, input: Omit<UsageEvent, keyof BillingScope | 'eventId'>): UsageEvent {
    if (!Number.isSafeInteger(input.quantity)) throw new Error('Usage quantity must be a safe integer');
    const key = `${scopeKey(scope)}|${input.idempotencyKey}`;
    const prior = this.idempotency.get(key);
    if (prior) return clone(prior);
    const event = Object.freeze({ ...scope, ...input, eventId: randomUUID() }) as UsageEvent;
    this.events.push(event); this.idempotency.set(key, event);
    return clone(event);
  }

  grantCredits(scope: BillingScope, input: { quantity: number; source: CreditSource; grantedAt: string; periodEnd?: string; expiresAt?: string; idempotencyKey: string; documentId?: string }): ProcessingCreditLot {
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new Error('Credit grant must be a positive integer');
    const existingEvent = this.idempotency.get(`${scopeKey(scope)}|${input.idempotencyKey}`);
    if (existingEvent?.lotId) return clone(this.lots.find(l => l.lotId === existingEvent.lotId)!);
    if (input.expiresAt && input.source !== 'MANUAL_ADJUSTMENT' && input.source !== 'PROMOTION') throw new Error('Custom expiry is limited to adjustment and promotion lots');
    const expiry = input.source === 'FREE_PLAN'
      ? input.periodEnd
      : input.expiresAt ?? new Date(new Date(input.grantedAt).getTime() + 365 * DAY).toISOString();
    if (!expiry) throw new Error('Free credit grants require a period end');
    if (expiry <= input.grantedAt) throw new Error('Credit expiry must be after grant time');
    const lot: ProcessingCreditLot = { ...scope, lotId: randomUUID(), source: input.source, originalQuantity: input.quantity, remainingQuantity: input.quantity, reservedQuantity: 0, spentQuantity: 0, expiredQuantity: 0, revokedQuantity: 0, grantedAt: input.grantedAt, expiresAt: expiry, grantPeriodKey: periodKey(input.grantedAt), documentId: input.documentId, status: 'AVAILABLE' };
    this.lots.push(lot);
    this.appendUsage(scope, { idempotencyKey: input.idempotencyKey, category: 'PROCESSING_CREDITS_GRANTED', quantity: input.quantity, baseUnit: 'CREDIT', observedAt: input.grantedAt, periodKey: periodKey(input.grantedAt), sourceSystem: 'billing', lotId: lot.lotId });
    return clone(lot);
  }

  reserveProcessing(scope: BillingScope, input: { reservationId: string; quantity: number; observedAt: string; referenceId?: string }): CreditReservation {
    const existing = this.reservations.get(`${scopeKey(scope)}|${input.reservationId}`);
    if (existing) return clone(existing);
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new Error('Reservation must be a positive integer');
    const eligible = this.lots.filter(l => scopeKey(l) === scopeKey(scope) && (l.status ?? 'AVAILABLE') === 'AVAILABLE' && l.expiresAt > input.observedAt && l.remainingQuantity - l.reservedQuantity > 0).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.grantedAt.localeCompare(b.grantedAt));
    if (eligible.reduce((n, l) => n + l.remainingQuantity - l.reservedQuantity, 0) < input.quantity) throw new Error('INSUFFICIENT_PROCESSING_CREDITS');
    let needed = input.quantity; const allocations: Array<{ lotId: string; quantity: number }> = [];
    for (const lot of eligible) { const quantity = Math.min(needed, lot.remainingQuantity - lot.reservedQuantity); if (!quantity) continue; lot.reservedQuantity += quantity; allocations.push({ lotId: lot.lotId, quantity }); needed -= quantity; if (!needed) break; }
    const event = this.appendUsage(scope, { idempotencyKey: `reserve:${input.reservationId}`, category: 'PROCESSING_CREDITS_RESERVED', quantity: input.quantity, baseUnit: 'CREDIT', observedAt: input.observedAt, periodKey: periodKey(input.observedAt), sourceSystem: 'media-processing', referenceId: input.referenceId });
    const reservation: CreditReservation = { reservationId: input.reservationId, scope: clone(scope), quantity: input.quantity, state: 'RESERVED', allocations, eventId: event.eventId };
    this.reservations.set(`${scopeKey(scope)}|${input.reservationId}`, reservation); return clone(reservation);
  }

  finalizeProcessing(scope: BillingScope, reservationId: string, outcome: 'COMMIT' | 'RELEASE', observedAt: string): CreditReservation {
    const reservation = this.reservations.get(`${scopeKey(scope)}|${reservationId}`);
    if (!reservation) throw new Error('Unknown reservation');
    if (reservation.state !== 'RESERVED') return clone(reservation);
    for (const allocation of reservation.allocations) { const lot = this.lots.find(l => l.lotId === allocation.lotId)!; lot.reservedQuantity -= allocation.quantity; if (outcome === 'COMMIT') { lot.remainingQuantity -= allocation.quantity; lot.spentQuantity += allocation.quantity; } }
    reservation.state = outcome === 'COMMIT' ? 'COMMITTED' : 'RELEASED';
    this.appendUsage(scope, { idempotencyKey: `${outcome.toLowerCase()}:${reservationId}`, category: outcome === 'COMMIT' ? 'PROCESSING_CREDITS_COMMITTED' : 'PROCESSING_CREDITS_RELEASED', quantity: reservation.quantity, baseUnit: 'CREDIT', observedAt, periodKey: periodKey(observedAt), sourceSystem: 'media-processing', linkedEventId: reservation.eventId });
    return clone(reservation);
  }

  expireCredits(scope: BillingScope, now: string): number {
    let expired = 0;
    for (const lot of this.lots.filter(l => scopeKey(l) === scopeKey(scope) && l.expiresAt <= now && l.reservedQuantity === 0 && l.remainingQuantity > 0)) { const quantity = lot.remainingQuantity; lot.remainingQuantity = 0; lot.expiredQuantity += quantity; lot.status = 'EXPIRED'; expired += quantity; this.appendUsage(scope, { idempotencyKey: `expire:${lot.lotId}`, category: 'PROCESSING_CREDITS_EXPIRED', quantity, baseUnit: 'CREDIT', observedAt: now, periodKey: periodKey(now), sourceSystem: 'expiry-worker', lotId: lot.lotId }); }
    return expired;
  }

  reverseCreditGrant(scope: BillingScope, documentId: string, observedAt: string, idempotencyKey: string): number {
    const lots = this.lots.filter(lot => scopeKey(lot) === scopeKey(scope) && lot.documentId === documentId && lot.remainingQuantity > 0);
    if (lots.some(lot => lot.reservedQuantity > 0)) throw new Error('Cannot reverse a credit grant with active reservations');
    const quantity = lots.reduce((total, lot) => total + lot.remainingQuantity, 0);
    if (!quantity) return 0;
    for (const lot of lots) { lot.revokedQuantity += lot.remainingQuantity; lot.remainingQuantity = 0; lot.status = 'REVOKED'; }
    this.appendUsage(scope, {
      idempotencyKey, category: 'PROCESSING_CREDITS_ADJUSTMENT', quantity: -quantity, baseUnit: 'CREDIT',
      observedAt, periodKey: periodKey(observedAt), sourceSystem: 'billing-support', referenceId: documentId
    });
    return quantity;
  }

  balance(scope: BillingScope, entitlementPeriod?: { start: string; end: string }, now = new Date().toISOString()): UsageBalance {
    const events = this.events.filter(e => scopeKey(e) === scopeKey(scope));
    const storageBytes = events.filter(e => e.category.startsWith('STORAGE_BYTES_')).reduce((n, e) => n + e.quantity, 0);
    const deliveryBytes = events.filter(e => e.category === 'DELIVERY_BYTES_OBSERVED' && (!entitlementPeriod || (e.observedAt >= entitlementPeriod.start && e.observedAt < entitlementPeriod.end))).reduce((n, e) => n + e.quantity, 0);
    const lots = this.lots.filter(l => scopeKey(l) === scopeKey(scope) && (l.status ?? 'AVAILABLE') === 'AVAILABLE' && l.expiresAt > now);
    return { storageBytes, deliveryBytes, availableProcessingCredits: lots.reduce((n, l) => n + l.remainingQuantity - l.reservedQuantity, 0), reservedProcessingCredits: lots.reduce((n, l) => n + l.reservedQuantity, 0), earliestExpiry: lots.filter(l => l.remainingQuantity > 0).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0]?.expiresAt };
  }

  processingCreditSummary(scope: BillingScope, now = new Date().toISOString(), recentLimit = 20): ProcessingCreditSummary {
    if (!Number.isSafeInteger(recentLimit) || recentLimit < 0) throw new Error('Recent activity limit must be a non-negative integer');
    const balance = this.balance(scope, undefined, now); const cutoff = new Date(new Date(now).getTime() + 30 * DAY).toISOString();
    const scopedLots = this.lots.filter(lot => scopeKey(lot) === scopeKey(scope));
    const spendable = scopedLots.filter(lot => (lot.status ?? 'AVAILABLE') === 'AVAILABLE' && lot.expiresAt > now && lot.remainingQuantity > 0);
    const nextExpiry = spendable.map(lot => lot.expiresAt).sort()[0]; const bySource: ProcessingCreditSummary['bySource'] = {};
    for (const source of [...new Set(scopedLots.map(lot => lot.source))]) {
      const lots = scopedLots.filter(lot => lot.source === source);
      bySource[source] = { available: lots.filter(lot => (lot.status ?? 'AVAILABLE') === 'AVAILABLE' && lot.expiresAt > now).reduce((sum, lot) => sum + lot.remainingQuantity - lot.reservedQuantity, 0), reserved: lots.reduce((sum, lot) => sum + lot.reservedQuantity, 0), spent: lots.reduce((sum, lot) => sum + lot.spentQuantity, 0), expiredOrRevoked: lots.reduce((sum, lot) => sum + lot.expiredQuantity + lot.revokedQuantity, 0) };
    }
    const categories: UsageCategory[] = ['PROCESSING_CREDITS_GRANTED', 'PROCESSING_CREDITS_RESERVED', 'PROCESSING_CREDITS_COMMITTED', 'PROCESSING_CREDITS_RELEASED', 'PROCESSING_CREDITS_ADJUSTMENT', 'PROCESSING_CREDITS_EXPIRED'];
    const recentActivity = this.events.filter(event => scopeKey(event) === scopeKey(scope) && categories.includes(event.category)).sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, recentLimit).map(clone);
    return { ...balance, expiringWithin30Days: spendable.filter(lot => lot.expiresAt <= cutoff).reduce((sum, lot) => sum + lot.remainingQuantity - lot.reservedQuantity, 0), nextExpiringQuantity: nextExpiry ? spendable.filter(lot => lot.expiresAt === nextExpiry).reduce((sum, lot) => sum + lot.remainingQuantity - lot.reservedQuantity, 0) : 0, videoEquivalentMinutes: balance.availableProcessingCredits / 25, bySource, recentActivity };
  }

  activateEntitlement(plan: PlanVersion, input: { periodStart: string; periodEnd: string; source: ServiceEntitlement['source']; billingAccountId?: string }): ServiceEntitlement {
    if (input.source === 'PROVIDER') throw new Error('Provider entitlements require verified webhook orchestration');
    if (input.periodEnd <= input.periodStart) throw new Error('Entitlement period is invalid');
    const entitlementId = randomUUID();
    const creditGrantLotId = this.grantEntitlementCredits(plan, input.source, input.periodStart, input.periodEnd, `entitlement:${entitlementId}`);
    const entitlement: ServiceEntitlement = { product: plan.product, environment: plan.environment, spaceId: plan.spaceId, dataHomeRegion: plan.dataHomeRegion, entitlementId, planVersionId: plan.planVersionId, billingAccountId: input.billingAccountId, status: input.source === 'FREE' ? 'FREE' : 'ACTIVE', source: input.source, periodStart: input.periodStart, periodEnd: input.periodEnd, quotas: { storageBytes: plan.storageBytes, deliveryBytes: plan.deliveryBytes, processingCredits: plan.processingCredits, transcodeMinutes: 0 }, createdAt: new Date().toISOString(), creditGrantLotId };
    this.entitlements.push(Object.freeze(entitlement)); return clone(entitlement);
  }

  /** Trust boundary used only after an adapter has verified a webhook and fetched provider state. */
  recordVerifiedProviderEntitlement(plan: PlanVersion, input: { periodStart: string; periodEnd: string; billingAccountId: string; providerEventId: string }): ServiceEntitlement {
    if (plan.product !== 'EVERSALLY') throw new Error('Provider billing is Eversally-only at launch');
    if (!input.providerEventId) throw new Error('Verified provider event is required');
    if (input.periodEnd <= input.periodStart) throw new Error('Entitlement period is invalid');
    const existing = this.entitlements.find(e => e.source === 'PROVIDER' && e.providerEventId === input.providerEventId);
    if (existing) return clone(existing);
    const creditGrantLotId = this.grantEntitlementCredits(plan, 'PROVIDER', input.periodStart, input.periodEnd, `provider-entitlement:${input.providerEventId}`);
    const entitlement: ServiceEntitlement = Object.freeze({
      product: plan.product, environment: plan.environment, spaceId: plan.spaceId, dataHomeRegion: plan.dataHomeRegion,
      entitlementId: randomUUID(), planVersionId: plan.planVersionId, billingAccountId: input.billingAccountId,
      status: 'ACTIVE', source: 'PROVIDER', periodStart: input.periodStart, periodEnd: input.periodEnd,
      quotas: { storageBytes: plan.storageBytes, deliveryBytes: plan.deliveryBytes, processingCredits: plan.processingCredits, transcodeMinutes: 0 as const },
      createdAt: new Date().toISOString(), providerEventId: input.providerEventId, creditGrantLotId
    });
    this.entitlements.push(entitlement);
    return clone(entitlement);
  }

  approveManualSettlement(plan: PlanVersion, input: Omit<ManualSettlement, keyof BillingScope | 'settlementId' | 'planVersionId' | 'approvedAt'>): { settlement: ManualSettlement; entitlement: ServiceEntitlement } {
    if (plan.product !== 'NIGHTFRAME') throw new Error('Manual settlements are Nightframe-only');
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error('Manual settlement amount must be positive');
    if (input.currency.toUpperCase() !== plan.currency.toUpperCase()) throw new Error('Manual settlement currency does not match plan');
    if (input.periodEnd <= input.periodStart) throw new Error('Manual settlement period is invalid');
    if (!input.externalReference.trim() || !input.approvedBy.trim() || !input.evidenceClassification.trim()) throw new Error('Manual settlement approval evidence is required');
    if (this.settlements.some(s => scopeKey(s) === scopeKey(plan) && s.externalReference === input.externalReference)) throw new Error('Duplicate settlement reference');
    const settlement: ManualSettlement = Object.freeze({ product: plan.product, environment: plan.environment, spaceId: plan.spaceId, dataHomeRegion: plan.dataHomeRegion, settlementId: randomUUID(), planVersionId: plan.planVersionId, approvedAt: new Date().toISOString(), ...input });
    this.settlements.push(settlement);
    return { settlement: clone(settlement), entitlement: this.activateEntitlement(plan, { periodStart: input.periodStart, periodEnd: input.periodEnd, source: 'MANUAL' }) };
  }

  listEvents(scope: BillingScope): UsageEvent[] { return this.events.filter(e => scopeKey(e) === scopeKey(scope)).map(clone); }
  listCreditLots(scope: BillingScope): ProcessingCreditLot[] { return this.lots.filter(lot => scopeKey(lot) === scopeKey(scope)).map(clone); }
  freezeCreditLot(scope: BillingScope, lotId: string): ProcessingCreditLot {
    const lot = this.lots.find(candidate => scopeKey(candidate) === scopeKey(scope) && candidate.lotId === lotId);
    if (!lot) throw new Error('Unknown credit lot');
    if (lot.reservedQuantity) throw new Error('Cannot freeze a credit lot with active reservations');
    if ((lot.status ?? 'AVAILABLE') === 'AVAILABLE') lot.status = 'FROZEN';
    return clone(lot);
  }
  listEntitlements(scope: BillingScope): ServiceEntitlement[] { return this.entitlements.filter(e => scopeKey(e) === scopeKey(scope)).map(clone); }

  private grantEntitlementCredits(plan: PlanVersion, source: ServiceEntitlement['source'], periodStart: string, periodEnd: string, idempotencyKey: string): string | undefined {
    if (!plan.processingCredits) return undefined;
    return this.grantCredits(plan, { quantity: plan.processingCredits, source: source === 'FREE' ? 'FREE_PLAN' : 'PAID_PLAN', grantedAt: periodStart, periodEnd: source === 'FREE' ? periodEnd : undefined, idempotencyKey }).lotId;
  }
}

export const processingCharge = (media: { type: 'IMAGE' } | { type: 'VIDEO'; durationSeconds: number }): number => {
  if (media.type === 'IMAGE') return 1;
  if (!Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0) throw new Error('Validated video duration is required');
  return Math.max(1, Math.ceil(media.durationSeconds / 60 * 25));
};

export const deliveryThresholdsCrossed = (previousBytes: number, currentBytes: number, allowanceBytes: number): number[] =>
  [0.8, 0.9, 1].filter(t => previousBytes < allowanceBytes * t && currentBytes >= allowanceBytes * t).map(t => t * 100);

export type LimitDecision = { allowed: boolean; action: 'ALLOW' | 'BLOCK_RETAINED_MEDIA' | 'BLOCK_PROCESSING' | 'DELIVERY_REVIEW'; thresholds?: number[] };
export const storageDecision = (currentBytes: number, proposedBytes: number, allowanceBytes: number, operation: 'RETAIN' | 'DELETE' | 'EXPORT'): LimitDecision =>
  operation !== 'RETAIN' || currentBytes + proposedBytes <= allowanceBytes ? { allowed: true, action: 'ALLOW' } : { allowed: false, action: 'BLOCK_RETAINED_MEDIA' };
export const processingDecision = (availableCredits: number, proposedCharge: number, consumesCredits = true): LimitDecision =>
  !consumesCredits || proposedCharge <= availableCredits ? { allowed: true, action: 'ALLOW' } : { allowed: false, action: 'BLOCK_PROCESSING' };
export const deliveryDecision = (previousBytes: number, currentBytes: number, allowanceBytes: number): LimitDecision => {
  const thresholds = deliveryThresholdsCrossed(previousBytes, currentBytes, allowanceBytes);
  return thresholds.length ? { allowed: true, action: 'DELIVERY_REVIEW', thresholds } : { allowed: true, action: 'ALLOW' };
};

const GB = 1_000_000_000;
const launchPlanRows = [
  ['free', 0, 15, 5, 250], ['creator-starter', 8, 50, 15, 750], ['creator', 16, 150, 35, 1500],
  ['creator-plus', 34, 400, 75, 3000], ['studio', 75, 1000, 150, 6000]
] as const;

/** Creates immutable launch catalogue snapshots. Nightframe prices are intentionally independent from Eversally. */
export const launchPlans = (scope: BillingScope, effectiveFrom: string): PlanVersion[] => launchPlanRows.map(([code, esPrice, storage, delivery, credits], index) => {
  const nfPrices = [0, 12, 24, 47, 99] as const;
  if (scope.product === 'UBEEQ') throw new Error('Self-hosted Ubeeq requires an operator-supplied catalogue');
  return Object.freeze({ ...scope, planVersionId: `${scope.product.toLowerCase()}-${code}-v1`, code, version: 1, priceMinor: 100 * (scope.product === 'NIGHTFRAME' ? nfPrices[index] : esPrice), currency: 'USD', period: 'MONTH' as const, storageBytes: storage * GB, deliveryBytes: delivery * GB, processingCredits: credits, transcodeMinutes: 0 as const, features: Object.freeze({}), effectiveFrom });
});
