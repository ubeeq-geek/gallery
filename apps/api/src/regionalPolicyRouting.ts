import { randomUUID } from 'node:crypto';
import type { ManagedProduct, ManagedRegion } from './regionalMedia';
import type { RegionalPolicyDecision } from './regionalPolicy';
import { createRegionalDeliveryRevocation, type RegionalDeliveryRevocation } from './regionalDeliveryRevocation';

export interface RegionalPolicyRoutingRepository {
  apply(input: {
    assetId: string; product: ManagedProduct; environment: string; dataHomeRegion: ManagedRegion; decision: RegionalPolicyDecision;
    hold?: { id: string; restricted: true; reasonCode: string };
    reviewCase?: { id: string; restrictedSafety: boolean; reasonCode: string };
    deliveryRevocation?: RegionalDeliveryRevocation;
    audit: { action: string; policyVersion: string; automatedCompletionOnly: true; reasonCode: string };
  }): Promise<void>;
}

/** Persists the Asset transition, hold/review case, and audit event through one repository transaction. */
export const routeRegionalPolicyDecision = async (input: { assetId: string; product: ManagedProduct; environment: string; dataHomeRegion: ManagedRegion; decision: RegionalPolicyDecision; repository: RegionalPolicyRoutingRepository }): Promise<void> => {
  const restricted = input.decision.state === 'HELD';
  const needsReview = restricted || input.decision.state === 'HUMAN_REVIEW_REQUIRED';
  await input.repository.apply({
    assetId: input.assetId, product: input.product, environment: input.environment, dataHomeRegion: input.dataHomeRegion, decision: input.decision,
    ...(restricted ? { hold: { id: randomUUID(), restricted: true as const, reasonCode: input.decision.reasonCode } } : {}),
    ...(restricted ? { deliveryRevocation: createRegionalDeliveryRevocation({ product: input.product, environment: input.environment, dataHomeRegion: input.dataHomeRegion, assetId: input.assetId, scanGroupId: `routing-${input.assetId}-${input.decision.policyVersion}`, reasonCode: input.decision.reasonCode }) } : {}),
    ...(needsReview ? { reviewCase: { id: randomUUID(), restrictedSafety: restricted, reasonCode: input.decision.reasonCode } } : {}),
    audit: { action: `regional_asset.${input.decision.state.toLowerCase()}`, policyVersion: input.decision.policyVersion, automatedCompletionOnly: true, reasonCode: input.decision.reasonCode }
  });
};
