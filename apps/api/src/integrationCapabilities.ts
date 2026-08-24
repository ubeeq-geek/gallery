import type { ExternalPlatform } from './domain';

export type IntegrationMediaType = 'image' | 'video' | 'audio' | 'literature' | 'carousel' | 'story';
export type IntegrationCapability =
  | 'import' | 'source-copy' | 'update' | 'delete' | 'collections' | 'comments' | 'analytics'
  | 'ai-label-read' | 'ai-label-write' | 'carousel-precise' | 'scheduling' | 'rate-limits';

export type IntegrationPlatformId = ExternalPlatform | 'discord' | 'ghost';

export interface IntegrationCapabilityLimits {
  /** Constraints that a client can show before it offers a publish control. */
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
  import: boolean;
  sourceCopy: boolean;
  publish: Partial<Record<IntegrationMediaType, boolean>>;
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

/** The UI must read this declaration instead of inferring support from a provider name. */
const none = { limits: {} };
export const integrationCapabilities: Record<IntegrationPlatformId, IntegrationCapabilityDeclaration> = {
  instagram: { platform: 'instagram', import: true, sourceCopy: false, publish: { image: true, video: true, carousel: true, story: true }, update: false, delete: false, collections: false, comments: true, analytics: true, aiLabel: { read: true, write: true, carouselPrecision: 'whole-carousel' }, scheduling: false, rateLimits: true, limits: { media: { allowedMimeTypes: ['image/jpeg', 'video/mp4'], maximumItems: 10, maximumCaptionCharacters: 2200, maximumBytes: 100 * 1024 * 1024 }, rollout: { state: 'controlled_pilot', note: 'Availability depends on approved app review and the configured pilot capabilities.' } } },
  deviantart: { platform: 'deviantart', import: true, sourceCopy: true, publish: { image: true, video: true, audio: true, literature: true }, update: true, delete: true, collections: true, comments: true, analytics: true, aiLabel: { read: true, write: true, carouselPrecision: 'none' }, scheduling: false, rateLimits: true, ...none },
  bluesky: { platform: 'bluesky', import: false, sourceCopy: false, publish: {}, update: false, delete: false, collections: false, comments: false, analytics: false, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: false, rateLimits: true, limits: { rollout: { state: 'configuration_required', note: 'Announcement records can be drafted; delivery requires the managed OAuth posting service.' } } },
  flickr: { platform: 'flickr', import: true, sourceCopy: false, publish: { image: true, video: true }, update: true, delete: true, collections: true, comments: true, analytics: false, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: false, rateLimits: true, ...none },
  soundcloud: { platform: 'soundcloud', import: false, sourceCopy: false, publish: { audio: true }, update: true, delete: true, collections: true, comments: true, analytics: true, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: true, rateLimits: true, ...none },
  youtube: { platform: 'youtube', import: false, sourceCopy: false, publish: { video: true }, update: true, delete: true, collections: true, comments: true, analytics: true, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: true, rateLimits: true, ...none },
  fanvue: { platform: 'fanvue', import: false, sourceCopy: false, publish: { image: true, video: true }, update: true, delete: true, collections: true, comments: false, analytics: false, aiLabel: { read: false, write: true, carouselPrecision: 'none' }, scheduling: true, rateLimits: true, limits: { access: { requiresRightsAttestation: true, requiresAdultAttestation: true, requiresConsentAttestation: true, creatorOwnedConnectionRequired: true, supportedAudience: ['free', 'subscriber', 'paid'] }, rollout: { state: 'controlled_pilot', note: 'Publishing is limited to eligible accounts, verified rights, and approved media.' } } },
  patreon: { platform: 'patreon', import: false, sourceCopy: false, publish: { image: true, video: true, audio: true, literature: true }, update: true, delete: true, collections: true, comments: true, analytics: true, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: true, rateLimits: true, limits: { webhooks: { supportedEvents: ['members:pledge:create', 'members:pledge:update', 'members:pledge:delete'], delivery: 'configured' }, rollout: { state: 'controlled_pilot', note: 'Post publishing remains a companion task; access synchronization is the supported managed workflow.' } } },
  tumblr: { platform: 'tumblr', import: false, sourceCopy: false, publish: { image: true, video: true, audio: true, literature: true }, update: true, delete: true, collections: false, comments: true, analytics: false, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: true, rateLimits: true, ...none },
  wordpress: { platform: 'wordpress', import: false, sourceCopy: false, publish: { image: true, literature: true }, update: true, delete: true, collections: true, comments: true, analytics: false, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: true, rateLimits: true, limits: { content: { unsupportedBlockTypes: ['html_fragment', 'video', 'audio', 'file', 'pdf_preview'], referenceOnlyImport: true }, media: { allowedMimeTypes: ['image/*'] }, rollout: { state: 'configuration_required', note: 'Per-site permissions and an approved WordPress connection determine the final available controls.' } } },
  ghost: { platform: 'ghost', import: true, sourceCopy: false, publish: { image: true, literature: true }, update: true, delete: true, collections: false, comments: false, analytics: false, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: true, rateLimits: true, limits: { content: { supportedBlockTypes: ['paragraph', 'heading', 'image', 'code', 'link'], referenceOnlyImport: true }, media: { allowedMimeTypes: ['image/*'] }, rollout: { state: 'configuration_required', note: 'Ghost supports its constrained Lexical renderer only.' } } },
  discord: { platform: 'discord', import: false, sourceCopy: false, publish: {}, update: false, delete: false, collections: false, comments: false, analytics: false, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: true, rateLimits: true, ...none }
};

export const capabilityFor = (platform: IntegrationPlatformId): IntegrationCapabilityDeclaration => integrationCapabilities[platform];
