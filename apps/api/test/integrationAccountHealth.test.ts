import type { ExternalAccount } from '../src/domain';
import { deriveIntegrationAccountHealth } from '../src/integrationAccountHealth';

const account = (overrides: Partial<ExternalAccount> = {}): ExternalAccount => ({
  externalAccountId: 'account-1', userId: 'user-1', externalPlatformCredentialId: 'credential-1',
  platform: 'youtube', externalUserId: 'channel-1', externalUsername: 'Channel one',
  accessTokenEncrypted: 'ciphertext', connectionStatus: 'connected',
  createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z', ...overrides
});

describe('deriveIntegrationAccountHealth', () => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  it('reports expiring tokens and exposes the provider capability declaration', () => {
    const result = deriveIntegrationAccountHealth(account({
      tokenExpiresAt: '2026-08-27T12:00:00.000Z',
      grantedScopes: ['https://www.googleapis.com/auth/youtube.readonly']
    }), now);
    expect(result.state).toBe('attention');
    expect(result.token.status).toBe('expires_soon');
    expect(result.token.grantedScopes).toEqual(['https://www.googleapis.com/auth/youtube.readonly']);
    expect(result.capabilities.platform).toBe('youtube');
  });
  it('prioritizes an active provider cooldown over an otherwise healthy token', () => {
    const result = deriveIntegrationAccountHealth(account({
      tokenExpiresAt: '2026-09-25T12:00:00.000Z', rateLimitedUntil: '2026-08-25T12:03:00.000Z'
    }), now);
    expect(result.state).toBe('rate_limited');
    expect(result.sync.coolingDown).toBe(true);
  });
  it('keeps a durable issue actionable until the account recovers', () => {
    const result = deriveIntegrationAccountHealth(account({
      lastIssue: {
        code: 'invalid_response',
        message: 'YouTube returned an unexpected response.',
        remediation: 'Review the integration setup and retry the action.',
        occurredAt: '2026-08-25T11:00:00.000Z'
      }
    }), now);
    expect(result.state).toBe('attention');
    expect(result.issue?.code).toBe('invalid_response');
    expect(result.recommendedAction).toBe('review_setup');
  });
});
