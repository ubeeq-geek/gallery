import { integrationCapabilities, type IntegrationPlatformId } from './integrationCapabilities';

export const integrationConformanceScenarios = [
  'oauth-expiry', 'pagination', 'rate-limit-backoff', 'duplicate-retry',
  'remote-deletion', 'unsupported-fields', 'reconciliation'
] as const;
export type IntegrationConformanceScenario = typeof integrationConformanceScenarios[number];

export interface IntegrationConformanceAdapter {
  platform: IntegrationPlatformId;
  run(scenario: IntegrationConformanceScenario): Promise<void>;
}

/** Shared test runner for every adapter. Unsupported operations must be an
 * explicit, successful assertion rather than an omitted test. */
export const runIntegrationConformanceSuite = async (adapter: IntegrationConformanceAdapter): Promise<void> => {
  if (!integrationCapabilities[adapter.platform]) throw new Error(`No capability declaration for ${adapter.platform}`);
  for (const scenario of integrationConformanceScenarios) await adapter.run(scenario);
};

export const integrationsRequiringConformance = Object.keys(integrationCapabilities) as IntegrationPlatformId[];
