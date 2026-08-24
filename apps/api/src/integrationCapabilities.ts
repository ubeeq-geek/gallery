import type { ExternalPlatform } from './domain';

export type IntegrationMediaType = 'image' | 'video' | 'audio' | 'literature' | 'carousel' | 'story';
export type IntegrationCapability =
  | 'import' | 'source-copy' | 'update' | 'delete' | 'collections' | 'comments' | 'analytics'
  | 'ai-label-read' | 'ai-label-write' | 'carousel-precise' | 'scheduling' | 'rate-limits';

export type IntegrationPlatformId = ExternalPlatform | 'discord';

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
}

/** The UI must read this declaration instead of inferring support from a provider name. */
export const integrationCapabilities: Record<IntegrationPlatformId, IntegrationCapabilityDeclaration> = {
  instagram: { platform: 'instagram', import: true, sourceCopy: false, publish: { image: true, video: true, carousel: true, story: true }, update: false, delete: false, collections: false, comments: true, analytics: true, aiLabel: { read: true, write: true, carouselPrecision: 'whole-carousel' }, scheduling: false, rateLimits: true },
  deviantart: { platform: 'deviantart', import: true, sourceCopy: true, publish: { image: true, video: true, audio: true, literature: true }, update: true, delete: true, collections: true, comments: true, analytics: true, aiLabel: { read: true, write: true, carouselPrecision: 'none' }, scheduling: false, rateLimits: true },
  bluesky: { platform: 'bluesky', import: false, sourceCopy: false, publish: {}, update: false, delete: false, collections: false, comments: false, analytics: false, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: false, rateLimits: true },
  flickr: { platform: 'flickr', import: true, sourceCopy: false, publish: { image: true, video: true }, update: true, delete: true, collections: true, comments: true, analytics: false, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: false, rateLimits: true },
  soundcloud: { platform: 'soundcloud', import: false, sourceCopy: false, publish: { audio: true }, update: true, delete: true, collections: true, comments: true, analytics: true, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: true, rateLimits: true },
  youtube: { platform: 'youtube', import: false, sourceCopy: false, publish: { video: true }, update: true, delete: true, collections: true, comments: true, analytics: true, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: true, rateLimits: true },
  fanvue: { platform: 'fanvue', import: false, sourceCopy: false, publish: { image: true, video: true }, update: true, delete: true, collections: true, comments: false, analytics: false, aiLabel: { read: false, write: true, carouselPrecision: 'none' }, scheduling: true, rateLimits: true },
  patreon: { platform: 'patreon', import: false, sourceCopy: false, publish: { image: true, video: true, audio: true, literature: true }, update: true, delete: true, collections: true, comments: true, analytics: true, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: true, rateLimits: true },
  tumblr: { platform: 'tumblr', import: false, sourceCopy: false, publish: { image: true, video: true, audio: true, literature: true }, update: true, delete: true, collections: false, comments: true, analytics: false, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: true, rateLimits: true },
  wordpress: { platform: 'wordpress', import: false, sourceCopy: false, publish: { image: true, video: true, audio: true, literature: true }, update: true, delete: true, collections: true, comments: true, analytics: false, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: true, rateLimits: true },
  discord: { platform: 'discord', import: false, sourceCopy: false, publish: {}, update: false, delete: false, collections: false, comments: false, analytics: false, aiLabel: { read: false, write: false, carouselPrecision: 'none' }, scheduling: true, rateLimits: true }
};
