import type { ExternalPlatform } from './domain';
import type { DataStore } from './store';

/** Includes native and newer adapters not yet represented by legacy ExternalAccount. */
export type IntegrationPlatform = ExternalPlatform | 'discord' | 'ghost' | 'smugmug' | 'vimeo';

/**
 * The small, composable surface used to describe an integration.  A provider
 * must opt in to every remote action it exposes; an absent capability is a
 * product decision, not a stubbed API method.
 */
export type IntegrationCapability =
  | 'connect'
  | 'catalogue_import'
  | 'source_migration'
  | 'publish'
  | 'remote_update'
  | 'remote_delete'
  | 'engagement_read'
  | 'engagement_write'
  | 'webhook_receive'
  | 'reconcile';

export type IntegrationOperation =
  | 'connect'
  | 'import'
  | 'migrate_source'
  | 'publish'
  | 'update_remote'
  | 'delete_remote'
  | 'read_engagement'
  | 'write_engagement'
  | 'receive_webhook'
  | 'reconcile';

export interface IntegrationDefinition {
  platform: IntegrationPlatform;
  label: string;
  capabilities: readonly IntegrationCapability[];
  /** Whether this provider needs an isolated OAuth/token broker. */
  credentialCustody: 'application' | 'isolated_broker';
  /** Product surface, independent of whether an adapter happens to exist. */
  surface: 'studio' | 'api_only' | 'internal' | 'planned';
  availability: 'available' | 'pilot' | 'configuration_required';
  ownerModel: 'creator' | 'user' | 'workspace';
  connectionModel: 'external_account' | 'native_connection';
  /** Named Studio adapter required before a platform may be creator-selectable. */
  studioAdapter?: string;
}

const requiredCapability: Record<IntegrationOperation, IntegrationCapability> = {
  connect: 'connect',
  import: 'catalogue_import',
  migrate_source: 'source_migration',
  publish: 'publish',
  update_remote: 'remote_update',
  delete_remote: 'remote_delete',
  read_engagement: 'engagement_read',
  write_engagement: 'engagement_write',
  receive_webhook: 'webhook_receive',
  reconcile: 'reconcile'
};

/** The shipped integrations are deliberately declared conservatively. */
export const integrationDefinitions: Record<IntegrationPlatform, IntegrationDefinition> = {
  deviantart: {
    platform: 'deviantart',
    label: 'DeviantArt',
    capabilities: ['connect', 'catalogue_import', 'source_migration', 'publish', 'remote_update', 'engagement_read', 'engagement_write', 'reconcile'],
    credentialCustody: 'application', surface: 'studio', availability: 'available', ownerModel: 'creator', connectionModel: 'external_account', studioAdapter: 'deviantart'
  },
  youtube: {
    platform: 'youtube',
    label: 'YouTube',
    capabilities: ['connect', 'catalogue_import', 'engagement_read', 'reconcile'],
    credentialCustody: 'application', surface: 'studio', availability: 'configuration_required', ownerModel: 'creator', connectionModel: 'external_account', studioAdapter: 'youtube'
  },
  instagram: {
    platform: 'instagram',
    label: 'Instagram',
    capabilities: ['connect', 'catalogue_import', 'publish', 'remote_update', 'remote_delete', 'engagement_read', 'webhook_receive', 'reconcile'],
    credentialCustody: 'application', surface: 'studio', availability: 'pilot', ownerModel: 'creator', connectionModel: 'external_account', studioAdapter: 'instagram'
  },
  wordpress: {
    platform: 'wordpress',
    label: 'WordPress',
    capabilities: ['connect', 'catalogue_import', 'publish', 'remote_update', 'remote_delete', 'webhook_receive', 'reconcile'],
    credentialCustody: 'application', surface: 'api_only', availability: 'configuration_required', ownerModel: 'user', connectionModel: 'native_connection'
  },
  flickr: {
    platform: 'flickr',
    label: 'Flickr',
    capabilities: ['connect', 'catalogue_import', 'source_migration', 'reconcile'],
    credentialCustody: 'application', surface: 'api_only', availability: 'available', ownerModel: 'creator', connectionModel: 'native_connection'
  },
  soundcloud: {
    platform: 'soundcloud',
    label: 'SoundCloud',
    capabilities: ['connect', 'catalogue_import', 'publish', 'engagement_read', 'engagement_write', 'reconcile'],
    credentialCustody: 'application', surface: 'api_only', availability: 'available', ownerModel: 'creator', connectionModel: 'external_account'
  },
  fanvue: {
    platform: 'fanvue',
    label: 'FanVue',
    capabilities: ['connect', 'catalogue_import', 'publish', 'remote_update', 'remote_delete', 'webhook_receive', 'reconcile'],
    credentialCustody: 'application', surface: 'studio', availability: 'pilot', ownerModel: 'creator', connectionModel: 'native_connection', studioAdapter: 'fanvue'
  },
  patreon: {
    platform: 'patreon',
    label: 'Patreon',
    capabilities: ['connect', 'catalogue_import', 'webhook_receive', 'reconcile'],
    credentialCustody: 'application', surface: 'api_only', availability: 'pilot', ownerModel: 'creator', connectionModel: 'native_connection'
  },
  bluesky: {
    platform: 'bluesky',
    label: 'Bluesky',
    capabilities: ['connect', 'publish'],
    credentialCustody: 'isolated_broker', surface: 'studio', availability: 'configuration_required', ownerModel: 'creator', connectionModel: 'external_account', studioAdapter: 'bluesky'
  },
  tumblr: {
    platform: 'tumblr',
    label: 'Tumblr',
    capabilities: ['connect', 'publish', 'remote_update', 'remote_delete'],
    credentialCustody: 'application', surface: 'studio', availability: 'available', ownerModel: 'creator', connectionModel: 'native_connection', studioAdapter: 'tumblr'
  },
  discord: {
    platform: 'discord',
    label: 'Discord',
    capabilities: ['connect', 'publish'],
    credentialCustody: 'application', surface: 'studio', availability: 'available', ownerModel: 'workspace', connectionModel: 'native_connection', studioAdapter: 'discord'
  },
  ghost: {
    platform: 'ghost',
    label: 'Ghost',
    capabilities: ['connect', 'catalogue_import', 'publish', 'remote_update', 'remote_delete', 'webhook_receive', 'reconcile'],
    credentialCustody: 'application', surface: 'api_only', availability: 'configuration_required', ownerModel: 'creator', connectionModel: 'native_connection'
  },
  smugmug: {
    platform: 'smugmug',
    label: 'SmugMug',
    capabilities: ['connect', 'catalogue_import', 'source_migration', 'publish', 'reconcile'],
    credentialCustody: 'application', surface: 'api_only', availability: 'pilot', ownerModel: 'creator', connectionModel: 'native_connection'
  },
  vimeo: {
    platform: 'vimeo',
    label: 'Vimeo',
    capabilities: ['connect', 'catalogue_import', 'source_migration', 'publish', 'remote_update', 'remote_delete', 'engagement_read', 'webhook_receive', 'reconcile'],
    credentialCustody: 'application', surface: 'api_only', availability: 'configuration_required', ownerModel: 'creator', connectionModel: 'native_connection'
  }
};

export const getIntegrationDefinition = (platform: IntegrationPlatform): IntegrationDefinition => integrationDefinitions[platform];
export const listIntegrationDefinitions = (): IntegrationDefinition[] => Object.values(integrationDefinitions);

export const supportsIntegrationOperation = (
  platform: IntegrationPlatform,
  operation: IntegrationOperation
): boolean => integrationDefinitions[platform].capabilities.includes(requiredCapability[operation]);

export class UnsupportedIntegrationOperationError extends Error {
  constructor(readonly platform: IntegrationPlatform, readonly operation: IntegrationOperation) {
    super(`${integrationDefinitions[platform].label} does not support ${operation}.`);
    this.name = 'UnsupportedIntegrationOperationError';
  }
}

export const requireIntegrationOperation = (platform: IntegrationPlatform, operation: IntegrationOperation): void => {
  if (!supportsIntegrationOperation(platform, operation)) {
    throw new UnsupportedIntegrationOperationError(platform, operation);
  }
};

/**
 * These target types intentionally include integration resources.  The support
 * draft currently covers content/account targets; the common contract prevents
 * a provider connection or a queued publication escaping a later safety hold.
 */
export type IntegrationPolicyTargetType =
  | 'work'
  | 'asset'
  | 'creator'
  | 'external_account'
  | 'integration_connection'
  | 'publication'
  | 'external_content';

export interface IntegrationPolicyTarget {
  type: IntegrationPolicyTargetType;
  id: string;
}

export interface IntegrationPolicyDecision {
  allowed: boolean;
  reason?: string;
  activeHoldTypes: string[];
}

/**
 * An adapter to the support/safety subsystem.  Job creation and execution use
 * the same gate so a hold added after enqueueing still blocks a remote write.
 */
export interface IntegrationPolicyGate {
  evaluate(input: { operation: IntegrationOperation; targets: IntegrationPolicyTarget[] }): Promise<IntegrationPolicyDecision>;
}

export const requireIntegrationPolicy = async (
  gate: IntegrationPolicyGate | undefined,
  operation: IntegrationOperation,
  targets: IntegrationPolicyTarget[]
): Promise<void> => {
  if (!gate) return;
  const decision = await gate.evaluate({ operation, targets });
  if (!decision.allowed) {
    throw new Error(decision.reason || `Integration ${operation} is blocked by an active safety hold.`);
  }
};

export const createStoreIntegrationPolicyGate = (store: Pick<DataStore, 'listActiveIntegrationReviewHolds'>): IntegrationPolicyGate => ({
  async evaluate({ targets }) {
    const holds = await store.listActiveIntegrationReviewHolds(targets.map((target) => ({ targetType: target.type, targetId: target.id })));
    return holds.length
      ? { allowed: false, reason: `Integration is blocked by active hold: ${holds[0].reason}`, activeHoldTypes: holds.map((hold) => hold.holdType) }
      : { allowed: true, activeHoldTypes: [] };
  }
});
