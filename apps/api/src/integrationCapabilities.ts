import {
  getIntegrationDefinition,
  integrationDefinitions,
  type IntegrationPlatform,
  type IntegrationCapability as RuntimeIntegrationCapability
} from './integrationStandard';

/**
 * Product-facing detail layered on top of the authoritative runtime contract.
 *
 * `integrationStandard` answers whether an operation can run.  This module
 * answers how it should be presented before a creator begins that operation.
 * Keeping the booleans derived prevents a screen from offering a provider
 * action which the adapter will reject later.
 */
export type IntegrationMediaType = 'image' | 'video' | 'audio' | 'literature' | 'carousel' | 'story';
export type IntegrationPlatformId = IntegrationPlatform;

export interface IntegrationCapabilityLimits {
  media?: {
    allowedMimeTypes?: string[];
    maximumItems?: number;
    maximumCaptionCharacters?: number;
    maximumBytes?: number;
  };
  content?: {
    supportedBlockTypes?: string[];
    unsupportedBlockTypes?: string[];
    referenceOnlyImport?: boolean;
  };
  access?: {
    requiresRightsAttestation?: boolean;
    requiresAdultAttestation?: boolean;
    requiresConsentAttestation?: boolean;
    creatorOwnedConnectionRequired?: boolean;
    supportedAudience?: string[];
  };
  webhooks?: {
    supportedEvents: string[];
    delivery: 'none' | 'optional' | 'configured';
  };
  rollout?: {
    state: 'generally_available' | 'controlled_pilot' | 'configuration_required';
    note?: string;
  };
}

export interface IntegrationCapabilityDeclaration {
  platform: IntegrationPlatformId;
  label: string;
  surface: 'studio' | 'api_only' | 'internal' | 'planned';
  availability: 'available' | 'pilot' | 'configuration_required';
  ownerModel: 'creator' | 'user' | 'workspace';
  connectionModel: 'external_account' | 'native_connection';
  studioAdapter?: string;
  import: boolean;
  sourceCopy: boolean;
  publish: Partial<Record<IntegrationMediaType, boolean>>;
  /** A remote announcement is intentionally distinct from a canonical Work publication. */
  announce: boolean;
  update: boolean;
  delete: boolean;
  collections: boolean;
  comments: boolean;
  analytics: boolean;
  aiLabel: { read: boolean; write: boolean; carouselPrecision: 'per-item' | 'whole-carousel' | 'none' };
  scheduling: boolean;
  rateLimits: boolean;
  limits: IntegrationCapabilityLimits;
}

type PresentationDetail = Pick<IntegrationCapabilityDeclaration, 'publish' | 'announce' | 'collections' | 'aiLabel' | 'scheduling' | 'rateLimits' | 'limits'>;

const noAi = { read: false, write: false, carouselPrecision: 'none' as const };
const none: PresentationDetail = {
  publish: {}, announce: false, collections: false, aiLabel: noAi,
  scheduling: false, rateLimits: true, limits: {}
};

/**
 * These details describe media shape and rollout policy only.  Operational
 * truth is derived below from `integrationDefinitions`.
 */
const presentation: Record<IntegrationPlatformId, PresentationDetail> = {
  instagram: {
    ...none,
    publish: { image: true, video: true, carousel: true, story: true },
    aiLabel: { read: true, write: true, carouselPrecision: 'whole-carousel' },
    limits: {
      media: { allowedMimeTypes: ['image/jpeg', 'video/mp4'], maximumItems: 10, maximumCaptionCharacters: 2200, maximumBytes: 100 * 1024 * 1024 },
      rollout: { state: 'controlled_pilot', note: 'Availability depends on approved app review and the configured pilot capabilities.' }
    }
  },
  deviantart: {
    ...none,
    publish: { image: true, video: true, audio: true, literature: true },
    collections: true,
    aiLabel: { read: true, write: true, carouselPrecision: 'none' }
  },
  bluesky: {
    ...none,
    announce: true,
    limits: { rollout: { state: 'configuration_required', note: 'Announcements require the managed OAuth posting service.' } }
  },
  flickr: { ...none },
  soundcloud: { ...none, publish: { audio: true }, collections: true, scheduling: true },
  youtube: {
    ...none,
    limits: { rollout: { state: 'configuration_required', note: 'This release imports and embeds existing videos. Upload, publishing, and remote editing are not enabled yet.' } }
  },
  fanvue: {
    ...none,
    publish: { image: true, video: true }, collections: true, scheduling: true,
    limits: {
      access: { requiresRightsAttestation: true, requiresAdultAttestation: true, requiresConsentAttestation: true, creatorOwnedConnectionRequired: true, supportedAudience: ['free', 'subscriber', 'paid'] },
      rollout: { state: 'controlled_pilot', note: 'Publishing is limited to eligible accounts, verified rights, and approved media.' }
    }
  },
  patreon: {
    ...none,
    limits: {
      webhooks: { supportedEvents: ['members:pledge:create', 'members:pledge:update', 'members:pledge:delete'], delivery: 'configured' },
      rollout: { state: 'controlled_pilot', note: 'Access synchronization is the supported managed workflow. Publishing is not enabled yet.' }
    }
  },
  tumblr: { ...none, publish: { image: true, video: true, audio: true, literature: true }, scheduling: true },
  wordpress: {
    ...none,
    publish: { image: true, literature: true }, collections: true, scheduling: true,
    limits: {
      content: { unsupportedBlockTypes: ['html_fragment', 'video', 'audio', 'file', 'pdf_preview'], referenceOnlyImport: true },
      media: { allowedMimeTypes: ['image/*'] },
      rollout: { state: 'configuration_required', note: 'Per-site permissions and an approved WordPress connection determine the final available controls.' }
    }
  },
  ghost: {
    ...none,
    publish: { image: true, literature: true }, scheduling: true,
    limits: {
      content: { supportedBlockTypes: ['paragraph', 'heading', 'image', 'code', 'link'], referenceOnlyImport: true },
      media: { allowedMimeTypes: ['image/*'] },
      rollout: { state: 'configuration_required', note: 'Ghost supports its constrained Lexical renderer only.' }
    }
  },
  discord: { ...none, announce: true, scheduling: true },
  smugmug: { ...none, publish: { image: true, video: true }, collections: true },
  vimeo: { ...none, publish: { video: true }, collections: true, scheduling: true }
};

const has = (platform: IntegrationPlatformId, capability: RuntimeIntegrationCapability): boolean =>
  getIntegrationDefinition(platform).capabilities.includes(capability);

const availablePublishShapes = (platform: IntegrationPlatformId, requested: PresentationDetail['publish']): PresentationDetail['publish'] => {
  if (!has(platform, 'publish')) return {};
  return requested;
};

const declarationFor = (platform: IntegrationPlatformId): IntegrationCapabilityDeclaration => {
  const detail = presentation[platform];
  const definition = getIntegrationDefinition(platform);
  return {
    platform,
    label: definition.label,
    surface: definition.surface,
    availability: definition.availability,
    ownerModel: definition.ownerModel,
    connectionModel: definition.connectionModel,
    studioAdapter: definition.studioAdapter,
    import: has(platform, 'catalogue_import'),
    sourceCopy: has(platform, 'source_migration'),
    publish: availablePublishShapes(platform, detail.publish),
    announce: detail.announce && has(platform, 'publish'),
    update: has(platform, 'remote_update'),
    delete: has(platform, 'remote_delete'),
    collections: detail.collections && (has(platform, 'catalogue_import') || has(platform, 'publish')),
    comments: has(platform, 'engagement_write'),
    analytics: has(platform, 'engagement_read'),
    aiLabel: detail.aiLabel,
    scheduling: detail.scheduling && has(platform, 'publish'),
    rateLimits: detail.rateLimits,
    limits: detail.limits
  };
};

/** The UI and API route both consume this single derived registry. */
export const integrationCapabilities: Record<IntegrationPlatformId, IntegrationCapabilityDeclaration> =
  Object.fromEntries(Object.keys(integrationDefinitions).map((platform) => [platform, declarationFor(platform as IntegrationPlatformId)])) as Record<IntegrationPlatformId, IntegrationCapabilityDeclaration>;

export const capabilityFor = (platform: IntegrationPlatformId): IntegrationCapabilityDeclaration => integrationCapabilities[platform];

/** Throws during tests/start-up if a presentation declaration drifts from runtime support. */
export const validateIntegrationCapabilityRegistry = (): void => {
  const runtimePlatforms = Object.keys(integrationDefinitions).sort();
  const presentationPlatforms = Object.keys(integrationCapabilities).sort();
  if (runtimePlatforms.join('|') !== presentationPlatforms.join('|')) {
    throw new Error('Integration capability registry must declare every runtime integration exactly once.');
  }
  for (const platform of runtimePlatforms as IntegrationPlatformId[]) {
    const capability = capabilityFor(platform);
    if (capability.import !== has(platform, 'catalogue_import')
      || capability.sourceCopy !== has(platform, 'source_migration')
      || capability.update !== has(platform, 'remote_update')
      || capability.delete !== has(platform, 'remote_delete')
      || capability.analytics !== has(platform, 'engagement_read')
      || capability.comments !== has(platform, 'engagement_write')) {
      throw new Error(`Integration capability declaration for ${platform} does not match its runtime contract.`);
    }
    if (capability.surface === 'studio' && !capability.studioAdapter) {
      throw new Error(`${platform} is Studio-visible but has no Studio adapter.`);
    }
    if (Object.values(capability.publish).some(Boolean) && !has(platform, 'publish')) {
      throw new Error(`${platform} advertises publishing without the runtime publish capability.`);
    }
    if (capability.announce && !has(platform, 'publish')) {
      throw new Error(`${platform} advertises announcements without the runtime publish capability.`);
    }
  }
};
