import { integrationCapabilities, validateIntegrationCapabilityRegistry } from '../src/integrationCapabilities';
import { integrationsRequiringConformance, runIntegrationConformanceSuite } from '../src/integrationConformance';

describe('integration capability registry', () => {
  it('derives advertised operations from the runtime integration contract', () => {
    expect(() => validateIntegrationCapabilityRegistry()).not.toThrow();
    expect(integrationCapabilities.youtube.import).toBe(true);
    expect(integrationCapabilities.youtube.publish).toEqual({});
    expect(integrationCapabilities.bluesky.announce).toBe(true);
    expect(integrationCapabilities.bluesky.publish).toEqual({});
    expect(integrationCapabilities.patreon.publish).toEqual({});
    expect(integrationCapabilities.smugmug.sourceCopy).toBe(true);
    expect(integrationCapabilities.vimeo.publish.video).toBe(true);
  });

  it('exposes platform limits instead of leaving policy embedded in UI assumptions', () => {
    expect(integrationCapabilities.instagram.limits.rollout?.state).toBe('controlled_pilot');
    expect(integrationCapabilities.wordpress.limits.content?.unsupportedBlockTypes).toContain('html_fragment');
    expect(integrationCapabilities.ghost.limits.content?.supportedBlockTypes).toContain('image');
    expect(integrationCapabilities.fanvue.limits.access?.requiresConsentAttestation).toBe(true);
    expect(integrationCapabilities.patreon.limits.webhooks?.supportedEvents).toContain('members:pledge:update');
  });

  it('runs the same scenario vocabulary for every declared adapter', async () => {
    for (const platform of integrationsRequiringConformance) {
      const seen: string[] = [];
      await runIntegrationConformanceSuite({ platform, run: async (scenario) => { seen.push(scenario); } });
      expect(seen).toEqual(['oauth-expiry', 'pagination', 'rate-limit-backoff', 'duplicate-retry', 'remote-deletion', 'unsupported-fields', 'reconciliation']);
    }
  });
});
