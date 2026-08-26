import type { IntegrationOperation, IntegrationPlatform } from './integrationStandard';

/** OAuth permissions required by the operations currently implemented here. */
const requiredScopes: Partial<Record<IntegrationPlatform, Partial<Record<IntegrationOperation, readonly string[]>>>> = {
  youtube: {
    import: ['https://www.googleapis.com/auth/youtube.readonly'],
    read_engagement: ['https://www.googleapis.com/auth/youtube.readonly'],
    reconcile: ['https://www.googleapis.com/auth/youtube.readonly']
  }
};

export const requiredScopesForIntegrationOperation = (
  platform: IntegrationPlatform,
  operation: IntegrationOperation
): readonly string[] => requiredScopes[platform]?.[operation] || [];
