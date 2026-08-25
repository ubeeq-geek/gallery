import { createHash } from 'node:crypto';
import type { MediaProcessingLedgerEntry, ManagedProduct, ManagedRegion } from './regionalMedia';
import type { RegionalPolicyDecision } from './regionalPolicy';

export type RegionalDeliveryPurpose = 'PUBLIC_DERIVATIVE' | 'DESTINATION_INTEGRATION';
export type RegionalDeliveryDenialReason =
  | 'REGION_MISMATCH'
  | 'REQUIRED_SCAN_INCOMPLETE'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'ASSET_HELD'
  | 'DESTINATION_POLICY_NOT_APPROVED'
  | 'PUBLIC_DERIVATIVE_NOT_ELIGIBLE'
  | 'PROCESSING_ENTITLEMENT_EXHAUSTED';

export interface RegionalDeliveryContext {
  product: ManagedProduct;
  dataHomeRegion: ManagedRegion;
  canonicalRegion: ManagedRegion;
  purpose: RegionalDeliveryPurpose;
  policyDecision?: RegionalPolicyDecision;
  destinationPolicyState?: 'PENDING' | 'APPROVED' | 'DENIED';
  publicDeliveryState?: 'PRIVATE' | 'ELIGIBLE' | 'PUBLISHED' | 'REVOKED';
  remainingCreditUnits: number;
  requiredCreditUnits: number;
  overagePermitted?: boolean;
}

export type RegionalDeliveryDecision =
  | { allowed: true; reason: 'REGIONAL_POLICY_GATE_PASSED' }
  | { allowed: false; reason: RegionalDeliveryDenialReason };

/**
 * The final gate shared by public delivery and outbound integrations. Automated
 * no-match only permits the next policy stage; it is deliberately not called a
 * safety clearance.
 */
export const evaluateRegionalDelivery = (input: RegionalDeliveryContext): RegionalDeliveryDecision => {
  if (input.dataHomeRegion !== input.canonicalRegion) return { allowed: false, reason: 'REGION_MISMATCH' };
  if (!input.policyDecision || input.policyDecision.state === 'SCAN_UNAVAILABLE') return { allowed: false, reason: 'REQUIRED_SCAN_INCOMPLETE' };
  if (input.policyDecision.state === 'HELD') return { allowed: false, reason: 'ASSET_HELD' };
  if (input.policyDecision.state === 'HUMAN_REVIEW_REQUIRED') return { allowed: false, reason: 'HUMAN_REVIEW_REQUIRED' };
  if (input.purpose === 'DESTINATION_INTEGRATION' && input.destinationPolicyState !== 'APPROVED') {
    return { allowed: false, reason: 'DESTINATION_POLICY_NOT_APPROVED' };
  }
  if (input.purpose === 'PUBLIC_DERIVATIVE' && input.publicDeliveryState !== 'ELIGIBLE' && input.publicDeliveryState !== 'PUBLISHED') {
    return { allowed: false, reason: 'PUBLIC_DERIVATIVE_NOT_ELIGIBLE' };
  }
  if (!input.overagePermitted && input.remainingCreditUnits < input.requiredCreditUnits) {
    return { allowed: false, reason: 'PROCESSING_ENTITLEMENT_EXHAUSTED' };
  }
  return { allowed: true, reason: 'REGIONAL_POLICY_GATE_PASSED' };
};

export class RegionalDeliveryBlockedError extends Error {
  readonly code = 'policy_blocked' as const;
  constructor(readonly reason: RegionalDeliveryDenialReason) {
    super(`Regional delivery blocked: ${reason}`);
  }
}

export const requireRegionalDelivery = (input: RegionalDeliveryContext): void => {
  const decision = evaluateRegionalDelivery(input);
  if (!decision.allowed) throw new RegionalDeliveryBlockedError(decision.reason);
};

export interface IdempotentMediaProcessingLedgerEntry extends MediaProcessingLedgerEntry {
  id: string;
  mediaVersionId: string;
  scanGroupId: string;
  createdAt: string;
}

/** Creates a cell-scoped immutable ledger identity so completion retries cannot double bill. */
export const mediaProcessingLedgerRecord = (
  usage: MediaProcessingLedgerEntry,
  identity: { mediaVersionId: string; scanGroupId: string; createdAt?: string }
): IdempotentMediaProcessingLedgerEntry => {
  const id = createHash('sha256').update([
    usage.product, usage.dataHomeRegion, usage.spaceId, usage.period, identity.mediaVersionId, identity.scanGroupId
  ].join('\u0000')).digest('hex');
  return { ...usage, ...identity, id: `media-processing-${id}`, createdAt: identity.createdAt || new Date().toISOString() };
};
