import { randomUUID } from 'crypto';
import { BillingLedger, BillingScope, LimitDecision, processingDecision, storageDecision } from './billing';

export type QuotaCategory = 'STORAGE_BYTES' | 'PROCESSING_CREDITS' | 'DELIVERY_BYTES';

export interface QuotaException extends BillingScope {
  actionId: string;
  category: QuotaCategory;
  amount: number;
  reason: string;
  effectiveFrom: string;
  effectiveTo: string;
  actorId: string;
  evidenceReference?: string;
  createdAt: string;
  revokedByActionId?: string;
}

export interface QuotaRevocation extends BillingScope {
  actionId: string;
  reversesActionId: string;
  reason: string;
  actorId: string;
  createdAt: string;
}

const scopeKey = (scope: BillingScope) => `${scope.product}|${scope.environment}|${scope.dataHomeRegion}|${scope.spaceId}`;
const clone = <T>(value: T): T => structuredClone(value);

/** Append-only support exceptions. Moderation eligibility remains a separate, mandatory gate. */
export class QuotaPolicy {
  private readonly exceptions: QuotaException[] = [];
  private readonly revocations: QuotaRevocation[] = [];

  constructor(private readonly ledger: BillingLedger, private readonly now: () => string = () => new Date().toISOString()) {}

  grant(scope: BillingScope, input: { category: QuotaCategory; amount: number; reason: string; effectiveFrom: string; effectiveTo: string; actorId: string; evidenceReference?: string; idempotencyKey: string }): QuotaException {
    const existing = this.exceptions.find(action => scopeKey(action) === scopeKey(scope) && action.actionId === input.idempotencyKey);
    if (existing) return clone(existing);
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new Error('Quota exception amount must be a positive safe integer');
    if (!input.reason.trim() || !input.actorId.trim()) throw new Error('Quota exception requires reason and actor');
    if (input.effectiveTo <= input.effectiveFrom) throw new Error('Quota exception effective window is invalid');
    const action: QuotaException = {
      ...scope, actionId: input.idempotencyKey, category: input.category, amount: input.amount, reason: input.reason,
      effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo, actorId: input.actorId,
      evidenceReference: input.evidenceReference, createdAt: this.now()
    };
    this.exceptions.push(action);
    if (input.category === 'PROCESSING_CREDITS') {
      this.ledger.grantCredits(scope, {
        quantity: input.amount, source: 'MANUAL_ADJUSTMENT', grantedAt: input.effectiveFrom, expiresAt: input.effectiveTo,
        idempotencyKey: `quota-exception:${action.actionId}`, documentId: action.actionId
      });
    }
    return clone(action);
  }

  revoke(scope: BillingScope, input: { actionId: string; reason: string; actorId: string }): QuotaRevocation {
    const exception = this.exceptions.find(action => scopeKey(action) === scopeKey(scope) && action.actionId === input.actionId);
    if (!exception) throw new Error('Unknown quota exception');
    const existing = this.revocations.find(action => action.reversesActionId === exception.actionId);
    if (existing) return clone(existing);
    if (!input.reason.trim() || !input.actorId.trim()) throw new Error('Quota revocation requires reason and actor');
    const revocation: QuotaRevocation = { ...scope, actionId: randomUUID(), reversesActionId: exception.actionId, reason: input.reason, actorId: input.actorId, createdAt: this.now() };
    if (exception.category === 'PROCESSING_CREDITS') this.ledger.reverseCreditGrant(scope, exception.actionId, revocation.createdAt, `quota-revocation:${exception.actionId}`);
    exception.revokedByActionId = revocation.actionId;
    this.revocations.push(revocation);
    return clone(revocation);
  }

  effectiveAmount(scope: BillingScope, category: QuotaCategory, at: string): number {
    return this.exceptions
      .filter(action => scopeKey(action) === scopeKey(scope) && action.category === category && !action.revokedByActionId && action.effectiveFrom <= at && action.effectiveTo > at)
      .reduce((total, action) => total + action.amount, 0);
  }

  storage(scope: BillingScope, input: { currentBytes: number; proposedBytes: number; planAllowanceBytes: number; operation: 'RETAIN' | 'DELETE' | 'EXPORT'; at: string; policyEligible: boolean }): LimitDecision {
    if (!input.policyEligible && input.operation !== 'DELETE') return { allowed: false, action: 'BLOCK_RETAINED_MEDIA' };
    return storageDecision(input.currentBytes, input.proposedBytes, input.planAllowanceBytes + this.effectiveAmount(scope, 'STORAGE_BYTES', input.at), input.operation);
  }

  processing(scope: BillingScope, input: { availableCredits: number; proposedCharge: number; consumesCredits: boolean; policyEligible: boolean }): LimitDecision {
    if (!input.policyEligible) return { allowed: false, action: 'BLOCK_PROCESSING' };
    return processingDecision(input.availableCredits, input.proposedCharge, input.consumesCredits);
  }

  list(scope: BillingScope): { exceptions: QuotaException[]; revocations: QuotaRevocation[] } {
    return {
      exceptions: this.exceptions.filter(action => scopeKey(action) === scopeKey(scope)).map(clone),
      revocations: this.revocations.filter(action => scopeKey(action) === scopeKey(scope)).map(clone)
    };
  }
}
