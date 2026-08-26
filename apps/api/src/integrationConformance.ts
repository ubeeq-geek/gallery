import {
  integrationCapabilities,
  type IntegrationPlatformId,
  validateIntegrationCapabilityRegistry
} from './integrationCapabilities';

export const integrationConformanceScenarios = [
  'oauth-expiry', 'pagination', 'rate-limit-backoff', 'duplicate-retry',
  'remote-deletion', 'unsupported-fields', 'reconciliation'
] as const;
export type IntegrationConformanceScenario = typeof integrationConformanceScenarios[number];

/** A scenario must report concrete assertions; a no-op is not conformance. */
export interface IntegrationConformanceEvidence {
  assertions: number;
  summary: string;
}

export interface IntegrationConformanceAdapter {
  platform: IntegrationPlatformId;
  scenarios: Record<IntegrationConformanceScenario, () => Promise<IntegrationConformanceEvidence>>;
}

/** Shared test runner for every adapter. Unsupported operations must be an
 * explicit, successful assertion rather than an omitted test. */
export const runIntegrationConformanceSuite = async (adapter: IntegrationConformanceAdapter): Promise<void> => {
  validateIntegrationCapabilityRegistry();
  if (!integrationCapabilities[adapter.platform]) throw new Error(`No capability declaration for ${adapter.platform}`);
  for (const scenario of integrationConformanceScenarios) {
    const evidence = await adapter.scenarios[scenario]();
    if (!Number.isInteger(evidence?.assertions) || evidence.assertions < 1 || !evidence.summary.trim()) {
      throw new Error(`${adapter.platform} conformance scenario ${scenario} did not report executable assertions.`);
    }
  }
};

export const integrationsRequiringConformance = Object.keys(integrationCapabilities) as IntegrationPlatformId[];
