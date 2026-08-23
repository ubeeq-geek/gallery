import type { AiDisclosure, ContentRating, HeavyTopic, PostBlock } from './domain';

export type TenantId = string;
export type WorkKind = 'image' | 'gallery' | 'video' | 'audio' | 'literature' | 'article' | 'animation' | 'mixed';
export type WorkStatus = 'draft' | 'ready' | 'archived' | 'deleted';
export type WorkOriginType = 'local' | 'import';
export type ContentAvailability = 'metadata_only' | 'external_reference' | 'display_copy' | 'original_hosted';
export type CanonicalAssetKind = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other';
export type CanonicalAssetStatus = 'processing' | 'ready' | 'failed' | 'replaced' | 'deleted';
export type WorkAssetRole = 'primary' | 'content' | 'attachment' | 'source' | 'preview';
export type CreatorCollectionType = 'collection' | 'gallery' | 'series' | 'playlist';
export type CreatorCollectionStatus = 'draft' | 'published' | 'archived' | 'deleted';
export type PublicationDestination = 'eversally' | 'deviantart' | 'youtube' | 'soundcloud' | 'fanvue' | 'bluesky' | 'tumblr';
export type PublicationStatus = 'draft' | 'scheduled' | 'queued' | 'publishing' | 'live' | 'updating' | 'failed' | 'missing' | 'removed' | 'unknown';
export type PublicationVisibility = 'private' | 'unlisted' | 'public';
export type PublicationSyncStatus = 'not_applicable' | 'in_sync' | 'local_newer' | 'remote_newer' | 'conflict' | 'error' | 'unknown';
export type PublicationIntentStatus = 'draft' | 'live' | 'scheduled';
export type DiscoveryParticipationState = 'none' | 'eligible' | 'opted_in' | 'removed';

export interface Work {
  workId: string;
  tenantId: TenantId;
  creatorId: string;
  kind: WorkKind;
  title: string;
  slug: string;
  slugHistory: string[];
  description?: string;
  tags: string[];
  body?: PostBlock[];
  contentRating: ContentRating;
  aiDisclosure: AiDisclosure;
  heavyTopics: HeavyTopic[];
  status: WorkStatus;
  origin: {
    type: WorkOriginType;
    platform?: PublicationDestination;
    integrationAccountId?: string;
    remoteId?: string;
    remoteUrl?: string;
    importedAt?: string;
  };
  primaryAssetId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deletedAt?: string;
}

export interface CanonicalAsset {
  assetId: string;
  tenantId: TenantId;
  creatorId: string;
  kind: CanonicalAssetKind;
  status: CanonicalAssetStatus;
  mimeType: string;
  originalFilename?: string;
  sizeBytes?: number;
  checksumSha256?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  storage: {
    mode: 'hosted' | 'external';
    objectKey?: string;
    thumbnailObjectKey?: string;
    externalUrl?: string;
  };
  metadata?: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
  replacedByAssetId?: string;
  deletedAt?: string;
}

export interface WorkAsset {
  workId: string;
  assetId: string;
  role: WorkAssetRole;
  position: number;
  caption?: string;
  altText?: string;
}

export interface CreatorCollection {
  collectionId: string;
  tenantId: TenantId;
  creatorId: string;
  type: CreatorCollectionType;
  title: string;
  slug: string;
  slugHistory: string[];
  description?: string;
  coverAssetId?: string;
  status: CreatorCollectionStatus;
  visibility: PublicationVisibility;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deletedAt?: string;
}

export interface CollectionWork {
  collectionId: string;
  workId: string;
  position: number;
  addedAt: string;
}

export interface Publication {
  publicationId: string;
  tenantId: TenantId;
  creatorId: string;
  workId: string;
  destination: PublicationDestination;
  integrationAccountId?: string;
  status: PublicationStatus;
  visibility: PublicationVisibility;
  remoteId?: string;
  remoteUrl?: string;
  remoteCreatedAt?: string;
  remoteUpdatedAt?: string;
  metadataOverrides?: {
    title?: string;
    description?: string;
    tags?: string[];
    fields?: Record<string, unknown>;
  };
  sync: {
    status: PublicationSyncStatus;
    lastAttemptAt?: string;
    lastSuccessfulAt?: string;
    localRevision?: number;
    remoteMetadataFingerprint?: string;
    remoteContentFingerprint?: string;
    errorCode?: string;
    errorMessage?: string;
    /** Provider-neutral reconciliation state; raw provider payloads never belong here. */
    reconciliation?: {
      baseline?: Record<string, unknown>;
      remote?: Record<string, unknown>;
      status: 'in_sync' | 'local_newer' | 'remote_newer' | 'non_conflicting_changes' | 'conflict';
      fields: Array<{
        field: string;
        lastSynced: unknown;
        local: unknown;
        remote: unknown;
        localChanged: boolean;
        remoteChanged: boolean;
        conflict: boolean;
      }>;
      updatedAt: string;
    };
  };
  providerData?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  removedAt?: string;
}

export interface PublicationIntent {
  publicationIntentId: string;
  tenantId: TenantId;
  creatorId: string;
  workId: string;
  destination: PublicationDestination;
  integrationAccountId?: string;
  enabled: boolean;
  desiredStatus: PublicationIntentStatus;
  scheduledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkDiscoveryParticipation {
  workId: string;
  tenantId: TenantId;
  creatorId: string;
  state: DiscoveryParticipationState;
  optedInAt?: string;
  withdrawnAt?: string;
  removedAt?: string;
  removalReason?: string;
  updatedAt: string;
}

export interface CanonicalWorkView extends Work {
  assets: Array<CanonicalAsset & { attachment: WorkAsset }>;
  contentAvailability: ContentAvailability;
  publications: Publication[];
  publicationIntents: PublicationIntent[];
  collections: CreatorCollection[];
  discovery: WorkDiscoveryParticipation;
}

export const contentAvailabilityForAssets = (assets: CanonicalWorkView['assets']): ContentAvailability => {
  if (!assets.length) return 'metadata_only';
  const hosted = assets.filter((asset) => asset.storage.mode === 'hosted' && asset.status === 'ready');
  if (hosted.some((asset) => asset.metadata?.sourceCopyQuality !== 'display_copy')) return 'original_hosted';
  if (hosted.length) return 'display_copy';
  return 'external_reference';
};

export const DEFAULT_TENANT_ID = 'default';
