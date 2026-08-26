import type { ExternalAccount, ExternalAccountConnectionStatus, ExternalPlatform } from './domain';
import { capabilityFor, type IntegrationPlatformId } from './integrationCapabilities';

export type IntegrationTokenHealth = 'valid' | 'expires_soon' | 'expired' | 'unknown';
export type IntegrationAccountHealthState = ExternalAccountConnectionStatus | 'attention';
export type IntegrationAccountRecommendedAction = 'none' | 'reconnect' | 'wait' | 'retry_sync' | 'review_setup';

const EXPIRY_WARNING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const timestamp = (value?: string): number | undefined => {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Provider-neutral health projection from the durable external-account record. */
export const deriveIntegrationAccountHealth = (account: ExternalAccount, nowMs = Date.now()) => {
  const expiresAtMs = timestamp(account.tokenExpiresAt);
  const rateLimitedUntilMs = timestamp(account.rateLimitedUntil);
  const tokenStatus: IntegrationTokenHealth = expiresAtMs === undefined
    ? 'unknown'
    : expiresAtMs <= nowMs ? 'expired'
      : expiresAtMs - nowMs <= EXPIRY_WARNING_WINDOW_MS ? 'expires_soon' : 'valid';
  const coolingDown = Boolean(rateLimitedUntilMs && rateLimitedUntilMs > nowMs);
  const state: IntegrationAccountHealthState = account.connectionStatus !== 'connected'
    ? account.connectionStatus
    : coolingDown ? 'rate_limited'
      : tokenStatus === 'expired' ? 'authentication_required'
        : tokenStatus === 'expires_soon' || account.lastIssue ? 'attention' : 'connected';
  const recommendedAction: IntegrationAccountRecommendedAction = state === 'authentication_required'
    ? 'reconnect'
    : state === 'rate_limited' && coolingDown ? 'wait'
      : account.lastIssue?.code === 'invalid_response' || account.lastIssue?.code === 'unsupported' ? 'review_setup'
        : state === 'temporarily_unavailable' || Boolean(account.lastIssue) ? 'retry_sync' : 'none';
  const capabilities = capabilityFor(account.platform as ExternalPlatform as IntegrationPlatformId);
  return {
    state,
    token: { status: tokenStatus, expiresAt: account.tokenExpiresAt, grantedScopes: account.grantedScopes || [] },
    sync: {
      lastAttemptAt: account.lastSyncAttemptAt,
      lastSuccessfulAt: account.lastSuccessfulSyncAt,
      rateLimitedUntil: account.rateLimitedUntil,
      coolingDown
    },
    issue: account.lastIssue,
    recommendedAction,
    capabilities
  };
};
