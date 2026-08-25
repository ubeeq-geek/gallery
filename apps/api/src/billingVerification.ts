import { randomUUID } from 'crypto';

export type VerificationObjectType = 'CREATOR_PROFILE' | 'INTEGRATION_ACCOUNT';
export interface VerificationThresholdVersion {
  versionId: string; product: 'EVERSALLY' | 'NIGHTFRAME'; effectiveFrom: string; effectiveTo?: string;
  creatorReviewAt: number; integrationReviewAt: number; creatorRereviewAt: number; integrationRereviewAt: number;
}
export interface VerificationCase {
  caseId: string; tenantId: string; product: 'EVERSALLY' | 'NIGHTFRAME'; proposedObjectId: string; objectType: VerificationObjectType;
  thresholdVersionId: string; trigger: 'THRESHOLD' | 'REREVIEW' | 'RISK'; triggerDetail: string;
  status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'MORE_INFORMATION'; createdAt: string;
  reviewer?: string; reason?: string; decisionAt?: string;
}
export interface VerificationDecision {
  allowed: boolean; proposedStatus: 'ACTIVE' | 'PENDING_VERIFICATION' | 'REJECTED_FREE_LIMIT'; warning: boolean; reviewCase?: VerificationCase;
}

/** Applies product-configured operational review gates without changing paid entitlements or existing objects. */
export class IntegrationVerificationPolicy {
  private readonly caseEvents: VerificationCase[] = [];
  constructor(private readonly versions: readonly VerificationThresholdVersion[], private readonly now: () => string = () => new Date().toISOString()) {}

  evaluate(input: { tenantId: string; product: VerificationThresholdVersion['product']; proposedObjectId: string; objectType: VerificationObjectType; paid: boolean; activeCreators: number; activeIntegrationAccounts: number; previouslyApproved: boolean; observedAt?: string }): VerificationDecision {
    for (const count of [input.activeCreators, input.activeIntegrationAccounts]) if (!Number.isSafeInteger(count) || count < 0) throw new Error('Active counts must be non-negative integers');
    const observedAt = input.observedAt ?? this.now();
    const version = this.version(input.product, observedAt);
    const active = input.objectType === 'CREATOR_PROFILE' ? input.activeCreators : input.activeIntegrationAccounts;
    if (!input.paid) return active >= 1 ? { allowed: false, proposedStatus: 'REJECTED_FREE_LIMIT', warning: true } : { allowed: true, proposedStatus: 'ACTIVE', warning: false };
    const initial = input.objectType === 'CREATOR_PROFILE' ? version.creatorReviewAt : version.integrationReviewAt;
    const rereview = input.objectType === 'CREATOR_PROFILE' ? version.creatorRereviewAt : version.integrationRereviewAt;
    const gate = input.previouslyApproved ? rereview : initial;
    if (active < gate) return { allowed: true, proposedStatus: 'ACTIVE', warning: active === gate - 1 };
    const reviewCase = this.open({ ...input, thresholdVersionId: version.versionId }, input.previouslyApproved ? 'REREVIEW' : 'THRESHOLD', `${active} active ${input.objectType.toLowerCase()} records`, observedAt);
    return { allowed: false, proposedStatus: 'PENDING_VERIFICATION', warning: true, reviewCase };
  }

  openRiskReview(input: { tenantId: string; product: VerificationThresholdVersion['product']; proposedObjectId: string; objectType: VerificationObjectType; concreteSignal: string; observedAt?: string }): VerificationCase {
    if (!input.concreteSignal.trim()) throw new Error('A concrete risk signal is required');
    const observedAt = input.observedAt ?? this.now(); const version = this.version(input.product, observedAt);
    return this.open({ ...input, thresholdVersionId: version.versionId }, 'RISK', input.concreteSignal, observedAt);
  }

  decide(caseId: string, input: { status: 'APPROVED' | 'DECLINED' | 'MORE_INFORMATION'; reviewer: string; reason: string; observedAt?: string }): VerificationCase {
    const current = [...this.caseEvents].reverse().find(item => item.caseId === caseId);
    if (!current || current.status !== 'PENDING') throw new Error('Pending verification case not found');
    if (!input.reviewer.trim() || !input.reason.trim()) throw new Error('Reviewer and reason are required');
    const decision: VerificationCase = Object.freeze({ ...current, status: input.status, reviewer: input.reviewer, reason: input.reason, decisionAt: input.observedAt ?? this.now() });
    this.caseEvents.push(decision); return structuredClone(decision);
  }

  history(tenantId: string): VerificationCase[] { return this.caseEvents.filter(item => item.tenantId === tenantId).map(item => structuredClone(item)); }

  private version(product: VerificationThresholdVersion['product'], at: string): VerificationThresholdVersion {
    const matches = this.versions.filter(item => item.product === product && item.effectiveFrom <= at && (!item.effectiveTo || item.effectiveTo > at)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    if (matches.length !== 1) throw new Error(matches.length ? 'Overlapping verification threshold versions' : 'No effective verification threshold version');
    return matches[0];
  }
  private open(input: { tenantId: string; product: VerificationThresholdVersion['product']; proposedObjectId: string; objectType: VerificationObjectType; thresholdVersionId: string }, trigger: VerificationCase['trigger'], detail: string, at: string): VerificationCase {
    const prior = [...this.caseEvents].reverse().find(item => item.tenantId === input.tenantId && item.proposedObjectId === input.proposedObjectId && item.status === 'PENDING');
    if (prior) return structuredClone(prior);
    const reviewCase: VerificationCase = Object.freeze({ caseId: randomUUID(), ...input, trigger, triggerDetail: detail, status: 'PENDING', createdAt: at });
    this.caseEvents.push(reviewCase); return structuredClone(reviewCase);
  }
}
