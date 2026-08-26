import {
  createStoreIntegrationPolicyGate,
  requireIntegrationOperation,
  type IntegrationOperation,
  type IntegrationPlatform,
  type IntegrationPolicyTarget
} from './integrationStandard';
import type { DataStore } from './store';

/** A single admission check for both queued and provider-native integrations. */
export const requireIntegrationAdmission = async (
  store: Pick<DataStore, 'listActiveIntegrationReviewHolds'>,
  input: {
    platform: IntegrationPlatform;
    operation: IntegrationOperation;
    targets: IntegrationPolicyTarget[];
  }
): Promise<void> => {
  requireIntegrationOperation(input.platform, input.operation);
  const decision = await createStoreIntegrationPolicyGate(store).evaluate({
    operation: input.operation,
    targets: input.targets
  });
  if (!decision.allowed) {
    throw new Error(decision.reason || `Integration ${input.operation} is blocked by an active safety hold.`);
  }
};
