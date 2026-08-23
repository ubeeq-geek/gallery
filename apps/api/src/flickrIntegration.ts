import { createHash, randomUUID } from 'crypto';
import type { Express, Request } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth } from './auth';
import type { AppConfig } from './config';
import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import { FlickrClient } from './flickrClient';
import type { CanonicalStore } from './canonicalStore';
import type { CollectionWork, CreatorCollection, Publication, Work } from './canonicalDomain';
import { quarantineFlickrSource, type QuarantinedFlickrSource } from './flickrSourceMigration';

export type FlickrMigrationMode = 'REFERENCE_IMPORT' | 'SELECTED_SOURCE_MIGRATION' | 'FULL_CATALOGUE_MIGRATION';
export type FlickrRemoteState = 'ACTIVE' | 'REMOTE_CHANGED' | 'MISSING';
export type FlickrTransferStatus = 'NOT_REQUESTED' | 'QUEUED' | 'QUARANTINED' | 'VALIDATED' | 'UNAVAILABLE' | 'FAILED';

export interface FlickrConnection {
  connectionId: string;
  userId: string;
  creatorId: string;
  accountId: string;
  username: string;
  encryptedTokenRef: string;
  scopes: ['read'];
  state: 'CONNECTED' | 'DISCONNECTED';
  capabilities: { inventory: boolean; originals: boolean; exif: boolean };
  ownershipValidatedAt: string;
  lastInventoryAt?: string;
  lastSyncAt?: string;
  createdAt: string;
}

export interface FlickrOAuthRequest {
  requestToken: string;
  encryptedRequestTokenSecret: string;
  userId: string;
  creatorId: string;
  expiresAt: string;
}

export interface FlickrManifestPhoto {
  remoteId: string;
  remoteUrl: string;
  title?: string;
  description?: string;
  tags: string[];
  albumIds: string[];
  capturedAt?: string;
  uploadedAt?: string;
  licence?: string;
  visibility: 'public' | 'friends' | 'family' | 'private';
  previewUrl?: string;
  /** Private, short-lived provider capability. Removed from browser projections. */
  originalSourceUrl?: string;
  originalFilename?: string;
  originalSizeBytes?: number;
  originalAvailable: boolean;
  metadataHash: string;
}

export interface FlickrMigrationItem {
  remoteId: string;
  mode: FlickrMigrationMode;
  sourceQuality?: 'original' | 'highest_available';
  transferStatus: FlickrTransferStatus;
  checksumSha256?: string;
  quarantineObjectKey?: string;
  quarantinedMimeType?: string;
  quarantinedSizeBytes?: number;
  scanOutcome?: 'pending' | 'clean' | 'blocked';
  dedupeStatus: 'UNCHECKED' | 'CHECKSUM_MATCH' | 'CREATOR_CONFIRMED_MATCH' | 'UNIQUE';
  retryCount: number;
  nextRetryAt?: string;
  errorCode?: string;
}

export interface FlickrExternalCollection {
  remoteAlbumId: string;
  title: string;
  description?: string;
  orderedRemotePhotoIds: string[];
  mappedCollectionId?: string;
}

export interface FlickrPublication {
  remotePhotoId: string;
  workId: string;
  visibilitySnapshot: FlickrManifestPhoto['visibility'];
  licenceSnapshot?: string;
  metadataHash: string;
  state: FlickrRemoteState;
  lastSyncAt: string;
}

export interface FlickrProvenance {
  remotePhotoId: string;
  /** Kept in the private integration record and removed from browser projections. */
  sourceUrl: string;
  accountId: string;
  originalFilename?: string;
  licenceSnapshot?: string;
  importedAt: string;
  creatorAttestedOwnership: true;
}

export interface FlickrMigration {
  migrationId: string;
  connectionId: string;
  userId: string;
  status: 'INVENTORY_READY' | 'CONFIRMED' | 'RUNNING' | 'REVIEW' | 'COMPLETE';
  cursor?: string;
  mode?: FlickrMigrationMode;
  confirmedAt?: string;
  storageConfirmed: boolean;
  discoveryEnabled: false;
  photos: FlickrManifestPhoto[];
  albums: FlickrExternalCollection[];
  publications: FlickrPublication[];
  provenance: FlickrProvenance[];
  items: FlickrMigrationItem[];
  estimatedBytes?: number;
  auditEvents: Array<{
    eventId: string;
    action: 'INVENTORY_CAPTURED' | 'MIGRATION_CONFIRMED' | 'SOURCE_TRANSFERRED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_FAILED';
    remoteId?: string;
    occurredAt: string;
    details?: Record<string, string | number | boolean>;
  }>;
  createdAt: string;
  updatedAt: string;
}

/** Repository boundary is intentionally portable; production adapters can use the core table. */
export interface FlickrRepository {
  putConnection(value: FlickrConnection): Promise<void>;
  getConnection(id: string): Promise<FlickrConnection | undefined>;
  putMigration(value: FlickrMigration): Promise<void>;
  getMigration(id: string): Promise<FlickrMigration | undefined>;
  getMigrationByConnection(connectionId: string): Promise<FlickrMigration | undefined>;
  putOAuthRequest(value: FlickrOAuthRequest): Promise<void>;
  takeOAuthRequest(requestToken: string): Promise<FlickrOAuthRequest | undefined>;
}

export class InMemoryFlickrRepository implements FlickrRepository {
  private connections = new Map<string, FlickrConnection>();
  private migrations = new Map<string, FlickrMigration>();
  private oauthRequests = new Map<string, FlickrOAuthRequest>();
  async putConnection(value: FlickrConnection) { this.connections.set(value.connectionId, structuredClone(value)); }
  async getConnection(id: string) { const value = this.connections.get(id); return value && structuredClone(value); }
  async putMigration(value: FlickrMigration) { this.migrations.set(value.migrationId, structuredClone(value)); }
  async getMigration(id: string) { const value = this.migrations.get(id); return value && structuredClone(value); }
  async getMigrationByConnection(connectionId: string) {
    const value = [...this.migrations.values()].find((migration) => migration.connectionId === connectionId);
    return value && structuredClone(value);
  }
  async putOAuthRequest(value: FlickrOAuthRequest) { this.oauthRequests.set(value.requestToken, structuredClone(value)); }
  async takeOAuthRequest(requestToken: string) {
    const value = this.oauthRequests.get(requestToken); this.oauthRequests.delete(requestToken);
    return value && structuredClone(value);
  }
}

const hashMetadata = (photo: Omit<FlickrManifestPhoto, 'metadataHash'>) =>
  createHash('sha256').update(JSON.stringify(photo)).digest('hex');

export const normalizeFlickrPhoto = (photo: Omit<FlickrManifestPhoto, 'metadataHash'>): FlickrManifestPhoto => ({
  ...photo,
  tags: [...new Set(photo.tags.map((tag) => tag.trim()).filter(Boolean))],
  albumIds: [...new Set(photo.albumIds)],
  metadataHash: hashMetadata(photo)
});

export class FlickrMigrationService {
  constructor(private repository: FlickrRepository, private canonicalStore?: CanonicalStore, private tenantId = 'default',
    private config?: AppConfig, private sourceTransfer: typeof quarantineFlickrSource = quarantineFlickrSource,
    private scanQuarantine: (objectKey: string) => Promise<'pending' | 'clean' | 'blocked'> = async () => 'pending') {}

  private stableId(prefix: string, ...parts: string[]) {
    return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
  }

  private slug(value: string, fallback: string) {
    return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 96) || fallback;
  }

  /** Materializes reference-only canonical records. It never creates hosting or Discovery intent. */
  private async materializeReferences(migration: FlickrMigration, connection: FlickrConnection, photos: FlickrManifestPhoto[]) {
    if (!this.canonicalStore) return;
    const now = new Date().toISOString();
    const workByRemoteId = new Map<string, string>();
    for (const photo of photos) {
      const workId = this.stableId('flickr-work', connection.accountId, photo.remoteId);
      workByRemoteId.set(photo.remoteId, workId);
      const existing = await this.canonicalStore.getWork(this.tenantId, workId);
      const work: Work = existing || {
        workId, tenantId: this.tenantId, creatorId: connection.creatorId, kind: 'image',
        title: photo.title?.trim() || 'Untitled Flickr photo', slug: this.slug(photo.title || '', `flickr-${photo.remoteId}`), slugHistory: [],
        description: photo.description, tags: photo.tags, contentRating: 'general', aiDisclosure: 'none', heavyTopics: [], status: 'draft',
        origin: { type: 'import', platform: 'flickr', integrationAccountId: connection.connectionId, remoteId: photo.remoteId, importedAt: now },
        revision: 1, createdAt: now, updatedAt: now
      };
      if (existing) await this.canonicalStore.updateWork({ ...existing, title: photo.title?.trim() || existing.title, description: photo.description,
        tags: photo.tags, revision: existing.revision + 1, updatedAt: now });
      else await this.canonicalStore.createWork(work);
      const publication: Publication = {
        publicationId: this.stableId('flickr-publication', connection.accountId, photo.remoteId), tenantId: this.tenantId,
        creatorId: connection.creatorId, workId, destination: 'flickr', integrationAccountId: connection.connectionId,
        status: 'live', visibility: 'private', remoteId: photo.remoteId, remoteUrl: photo.remoteUrl,
        metadataOverrides: { title: photo.title, description: photo.description, tags: photo.tags,
          fields: { flickrVisibilitySnapshot: photo.visibility, flickrLicenceSnapshot: photo.licence } },
        sync: { status: 'in_sync', lastSuccessfulAt: now, remoteMetadataFingerprint: photo.metadataHash },
        providerData: { sourceQuality: photo.originalAvailable ? 'original_available' : 'external_reference_only' }, createdAt: now, updatedAt: now
      };
      await this.canonicalStore.upsertPublication(publication);
      await this.canonicalStore.upsertWorkDiscoveryParticipation({ workId, tenantId: this.tenantId, creatorId: connection.creatorId, state: 'none', updatedAt: now });
    }
    for (const album of migration.albums) {
      const collectionId = this.stableId('flickr-collection', connection.accountId, album.remoteAlbumId);
      const existing = await this.canonicalStore.getCreatorCollection(this.tenantId, collectionId);
      const collection: CreatorCollection = existing || { collectionId, tenantId: this.tenantId, creatorId: connection.creatorId, type: 'collection',
        title: album.title, slug: this.slug(album.title, `flickr-album-${album.remoteAlbumId}`), slugHistory: [], description: album.description,
        status: 'draft', visibility: 'private', createdAt: now, updatedAt: now };
      if (existing) await this.canonicalStore.updateCreatorCollection({ ...existing, title: album.title, description: album.description, updatedAt: now });
      else await this.canonicalStore.createCreatorCollection(collection);
      const links: CollectionWork[] = album.orderedRemotePhotoIds.flatMap((remoteId, position) => {
        const workId = workByRemoteId.get(remoteId); return workId ? [{ collectionId, workId, position, addedAt: now }] : [];
      });
      await this.canonicalStore.replaceCollectionWorks(this.tenantId, collectionId, links);
      album.mappedCollectionId = collectionId;
    }
  }

  async migrateConfirmedSources(migration: FlickrMigration): Promise<FlickrMigration> {
    if (!this.canonicalStore || !this.config || !migration.mode || migration.mode === 'REFERENCE_IMPORT') return migration;
    if (!migration.confirmedAt || !migration.storageConfirmed) throw new Error('Migration has not been confirmed');
    const connection = await this.repository.getConnection(migration.connectionId);
    if (!connection) throw new Error('Flickr connection is no longer available');
    const items: FlickrMigrationItem[] = [];
    for (const item of migration.items) {
      if (item.transferStatus === 'UNAVAILABLE' || item.transferStatus === 'VALIDATED') { items.push(item); continue; }
      if (item.transferStatus === 'FAILED' && (!item.nextRetryAt || item.retryCount >= 3 || item.nextRetryAt > new Date().toISOString())) { items.push(item); continue; }
      const photo = migration.photos.find((candidate) => candidate.remoteId === item.remoteId);
      if (!photo?.originalSourceUrl) { items.push({ ...item, transferStatus: 'UNAVAILABLE', errorCode: 'ORIGINAL_UNAVAILABLE' }); continue; }
      try {
        const stored: QuarantinedFlickrSource = item.quarantineObjectKey && item.checksumSha256 && item.quarantinedMimeType && item.quarantinedSizeBytes
          ? { objectKey: item.quarantineObjectKey, checksumSha256: item.checksumSha256, mimeType: item.quarantinedMimeType,
            sizeBytes: item.quarantinedSizeBytes, scanOutcome: await this.scanQuarantine(item.quarantineObjectKey) }
          : await this.sourceTransfer(this.config, { creatorId: connection.creatorId,
            migrationId: migration.migrationId, remoteId: photo.remoteId, sourceUrl: photo.originalSourceUrl });
        const scanOutcome = stored.scanOutcome === 'pending' ? await this.scanQuarantine(stored.objectKey) : stored.scanOutcome;
        if (scanOutcome === 'blocked') {
          items.push({ ...item, transferStatus: 'FAILED', checksumSha256: stored.checksumSha256, quarantineObjectKey: stored.objectKey,
            quarantinedMimeType: stored.mimeType, quarantinedSizeBytes: stored.sizeBytes, scanOutcome, dedupeStatus: 'UNCHECKED',
            retryCount: item.retryCount, errorCode: 'QUARANTINE_SCAN_BLOCKED' });
          continue;
        }
        if (scanOutcome !== 'clean') {
          items.push({ ...item, transferStatus: 'QUARANTINED', checksumSha256: stored.checksumSha256, quarantineObjectKey: stored.objectKey,
            quarantinedMimeType: stored.mimeType, quarantinedSizeBytes: stored.sizeBytes, scanOutcome, dedupeStatus: 'UNCHECKED',
            retryCount: item.retryCount, errorCode: undefined });
          continue;
        }
        const assetId = this.stableId('flickr-asset', connection.creatorId, stored.checksumSha256);
        const existing = await this.canonicalStore.getCanonicalAsset(this.tenantId, assetId);
        const workId = this.stableId('flickr-work', connection.accountId, photo.remoteId);
        if (!existing) await this.canonicalStore.createCanonicalAsset({ assetId, tenantId: this.tenantId, creatorId: connection.creatorId,
          kind: 'image', status: 'ready', mimeType: stored.mimeType, originalFilename: photo.originalFilename,
          sizeBytes: stored.sizeBytes, checksumSha256: stored.checksumSha256, storage: { mode: 'hosted', objectKey: stored.objectKey },
          metadata: { source: 'flickr', remoteId: photo.remoteId, sourceCopyQuality: item.sourceQuality || 'highest_available',
            captureDate: photo.capturedAt || null, scanOutcome }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        const attached = await this.canonicalStore.listCanonicalAssetsByWork(this.tenantId, workId);
        if (!attached.some((asset) => asset.assetId === assetId)) await this.canonicalStore.attachAssetToWork(this.tenantId, { workId, assetId, role: 'primary', position: 0 });
        const work = await this.canonicalStore.getWork(this.tenantId, workId);
        if (work && work.primaryAssetId !== assetId) await this.canonicalStore.updateWork({ ...work, primaryAssetId: assetId, revision: work.revision + 1, updatedAt: new Date().toISOString() });
        items.push({ ...item, transferStatus: 'VALIDATED', checksumSha256: stored.checksumSha256, quarantineObjectKey: stored.objectKey,
          quarantinedMimeType: stored.mimeType, quarantinedSizeBytes: stored.sizeBytes, scanOutcome, retryCount: item.retryCount,
          dedupeStatus: existing ? 'CHECKSUM_MATCH' : 'UNIQUE', errorCode: undefined, nextRetryAt: undefined });
      } catch (error) {
        const code = error instanceof Error ? error.message : 'FLICKR_SOURCE_TRANSFER_FAILED';
        const transient = code.includes('TEMPORARILY');
        const retryCount = item.retryCount + (transient ? 1 : 0);
        items.push({ ...item, transferStatus: code.includes('UNAVAILABLE') && !transient ? 'UNAVAILABLE' : 'FAILED', retryCount,
          nextRetryAt: transient && retryCount < 3 ? new Date(Date.now() + Math.min(3600, 30 * 2 ** retryCount) * 1000).toISOString() : undefined,
          errorCode: code });
      }
    }
    const complete = items.every((item) => item.transferStatus === 'VALIDATED' || item.transferStatus === 'UNAVAILABLE');
    const transferEvents: FlickrMigration['auditEvents'] = items.flatMap((item) => {
      const previous = migration.items.find((candidate) => candidate.remoteId === item.remoteId);
      if (previous?.transferStatus === item.transferStatus) return [];
      const action = item.transferStatus === 'VALIDATED' ? 'SOURCE_TRANSFERRED'
        : item.transferStatus === 'UNAVAILABLE' ? 'SOURCE_UNAVAILABLE'
          : item.transferStatus === 'FAILED' ? 'SOURCE_FAILED' : undefined;
      return action ? [{ eventId: randomUUID(), action, remoteId: item.remoteId, occurredAt: new Date().toISOString(),
        details: { transferStatus: item.transferStatus, retryCount: item.retryCount, ...(item.errorCode ? { errorCode: item.errorCode } : {}) } }] : [];
    });
    const updated: FlickrMigration = { ...migration, items, auditEvents: [...(migration.auditEvents || []), ...transferEvents],
      status: complete ? 'COMPLETE' : 'REVIEW', updatedAt: new Date().toISOString() };
    await this.repository.putMigration(updated); return updated;
  }

  async inventory(connection: FlickrConnection, photos: FlickrManifestPhoto[], cursor?: string, albums: FlickrExternalCollection[] = [], append = false): Promise<FlickrMigration> {
    const now = new Date().toISOString();
    const previous = await this.repository.getMigrationByConnection(connection.connectionId);
    const previousPhotos = new Map(previous?.photos.map((photo) => [photo.remoteId, photo]));
    const mergedPhotos = append && previous ? [...previous.photos.filter((photo) => !photos.some((next) => next.remoteId === photo.remoteId)), ...photos] : photos;
    const publications = mergedPhotos.map((photo): FlickrPublication => {
      const oldPhoto = previousPhotos.get(photo.remoteId);
      return {
        remotePhotoId: photo.remoteId,
        workId: previous?.publications.find((item) => item.remotePhotoId === photo.remoteId)?.workId
          || `flickr-${connection.accountId}-${photo.remoteId}`,
        visibilitySnapshot: photo.visibility,
        licenceSnapshot: photo.licence,
        metadataHash: photo.metadataHash,
        state: oldPhoto && oldPhoto.metadataHash !== photo.metadataHash ? 'REMOTE_CHANGED' : 'ACTIVE',
        lastSyncAt: now
      };
    });
    if (!append && !cursor && previous) {
      publications.push(...previous.publications.filter((item) => !photos.some((photo) => photo.remoteId === item.remotePhotoId)).map((item) => ({ ...item, state: 'MISSING' as const, lastSyncAt: now })));
    }
    const migration: FlickrMigration = {
      migrationId: previous?.migrationId || randomUUID(), connectionId: connection.connectionId, userId: connection.userId,
      status: 'INVENTORY_READY', cursor, storageConfirmed: false, discoveryEnabled: false,
      photos: mergedPhotos, albums: albums.length ? albums : (previous?.albums || []), publications,
      provenance: mergedPhotos.map((photo) => ({ remotePhotoId: photo.remoteId, sourceUrl: photo.remoteUrl,
        accountId: connection.accountId, originalFilename: photo.originalFilename, licenceSnapshot: photo.licence,
        importedAt: previous?.provenance.find((item) => item.remotePhotoId === photo.remoteId)?.importedAt || now,
        creatorAttestedOwnership: true })),
      items: previous?.items || [], estimatedBytes: mergedPhotos.some((p) => p.originalSizeBytes !== undefined)
        ? mergedPhotos.reduce((total, photo) => total + (photo.originalSizeBytes || 0), 0) : undefined,
      auditEvents: [...(previous?.auditEvents || []), { eventId: randomUUID(), action: 'INVENTORY_CAPTURED', occurredAt: now,
        details: { photoCount: mergedPhotos.length, albumCount: albums.length || previous?.albums.length || 0, complete: !cursor } }],
      createdAt: previous?.createdAt || now, updatedAt: now
    };
    await this.repository.putMigration(migration);
    await this.repository.putConnection({ ...connection, lastInventoryAt: now });
    return migration;
  }

  async confirm(migration: FlickrMigration, mode: FlickrMigrationMode, selectedIds: string[], storageConfirmed: boolean): Promise<FlickrMigration> {
    if (!['REFERENCE_IMPORT', 'SELECTED_SOURCE_MIGRATION', 'FULL_CATALOGUE_MIGRATION'].includes(mode)) throw new Error('A valid migration mode is required');
    if (migration.status !== 'INVENTORY_READY' && migration.status !== 'REVIEW') throw new Error('Migration cannot be confirmed in its current state');
    const selected = mode === 'FULL_CATALOGUE_MIGRATION' || mode === 'REFERENCE_IMPORT'
      ? migration.photos
      : migration.photos.filter((p) => selectedIds.includes(p.remoteId));
    if (mode !== 'REFERENCE_IMPORT' && !storageConfirmed) throw new Error('Storage and cost confirmation is required for source migration');
    if (mode === 'SELECTED_SOURCE_MIGRATION' && selected.length === 0) throw new Error('Select at least one Flickr photo');
    const now = new Date().toISOString();
    const updated: FlickrMigration = { ...migration, mode, status: 'CONFIRMED', confirmedAt: now, storageConfirmed, updatedAt: now,
      items: selected.map((photo) => ({ remoteId: photo.remoteId, mode,
        sourceQuality: mode === 'REFERENCE_IMPORT' ? undefined : (photo.originalAvailable ? 'original' : 'highest_available'),
        transferStatus: mode === 'REFERENCE_IMPORT' ? 'NOT_REQUESTED' : (photo.originalAvailable ? 'QUEUED' : 'UNAVAILABLE'),
        dedupeStatus: 'UNCHECKED', retryCount: 0, errorCode: mode !== 'REFERENCE_IMPORT' && !photo.originalAvailable ? 'ORIGINAL_UNAVAILABLE' : undefined })) };
    const connection = await this.repository.getConnection(migration.connectionId);
    if (!connection) throw new Error('Flickr connection is no longer available');
    if (mode !== 'REFERENCE_IMPORT' && !connection.capabilities.originals) throw new Error('Flickr did not provide any eligible original source files; use reference import instead');
    await this.materializeReferences(updated, connection, selected);
    updated.auditEvents = [...(updated.auditEvents || []), { eventId: randomUUID(), action: 'MIGRATION_CONFIRMED', occurredAt: now,
      details: { mode, selectedCount: selected.length, storageConfirmed } }];
    await this.repository.putMigration(updated);
    return updated;
  }
}

const owns = (req: Request, userId: string) => req.authUser?.userId === userId;
const migrationForBrowser = (migration: FlickrMigration) => ({
  ...migration,
  photos: migration.photos.map(({ remoteUrl: _remoteUrl, originalSourceUrl: _originalSourceUrl, ...photo }) => photo),
  provenance: migration.provenance.map(({ sourceUrl: _sourceUrl, ...item }) => item)
});

const textContent = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { _content?: unknown })._content === 'string') return (value as { _content: string })._content;
  return undefined;
};

const providerPhoto = (value: Record<string, unknown>, albumIds: string[]): FlickrManifestPhoto => {
  const remoteId = String(value.id || '');
  const owner = String(value.owner || value.pathalias || 'me');
  const source = {
    remoteId,
    remoteUrl: `https://www.flickr.com/photos/${encodeURIComponent(owner)}/${encodeURIComponent(remoteId)}`,
    title: textContent(value.title), description: textContent(value.description),
    tags: String(value.tags || '').split(' ').filter(Boolean), albumIds,
    capturedAt: typeof value.datetaken === 'string' ? value.datetaken : undefined,
    uploadedAt: value.dateupload ? new Date(Number(value.dateupload) * 1000).toISOString() : undefined,
    licence: value.license === undefined ? undefined : String(value.license),
    visibility: value.ispublic === 1 ? 'public' as const : value.isfriend === 1 ? 'friends' as const : value.isfamily === 1 ? 'family' as const : 'private' as const,
    previewUrl: typeof value.url_m === 'string' ? value.url_m : undefined,
    originalSourceUrl: typeof value.url_o === 'string' ? value.url_o : undefined,
    originalFilename: typeof value.originalformat === 'string' ? `${remoteId}.${value.originalformat}` : undefined,
    originalSizeBytes: undefined,
    originalAvailable: typeof value.url_o === 'string'
  };
  return normalizeFlickrPhoto(source);
};

/** Mounts the migration control plane. Workers populate manifests; these routes never publish. */
export const registerFlickrRoutes = (app: Express, config: AppConfig, repository: FlickrRepository = new InMemoryFlickrRepository(), injectedClient?: FlickrClient, canonicalStore?: CanonicalStore) => {
  const service = new FlickrMigrationService(repository, canonicalStore, config.tenantId, config);
  const client = config.flickrApiKey && config.flickrApiSecret
    ? (injectedClient || new FlickrClient(config.flickrApiKey, config.flickrApiSecret, fetch, config.flickrMinimumRequestIntervalMs)) : undefined;
  app.post('/api/integrations/flickr/connections/start', requireAuth, async (req, res) => {
    if (!config.flickrApiKey || !config.flickrApiSecret || !config.flickrOAuthCallbackUrl) return res.status(503).json({ message: 'Flickr integration is not configured.' });
    const creatorId = typeof req.body.creatorId === 'string' ? req.body.creatorId.trim() : '';
    if (!creatorId) return res.status(400).json({ message: 'creatorId is required.' });
    const state = jwt.sign({ purpose: 'flickr_connection', userId: req.authUser!.userId, creatorId }, config.unlockJwtSecret, { expiresIn: '10m' });
    try {
      const callback = new URL(config.flickrOAuthCallbackUrl); callback.searchParams.set('state', state);
      const result = await client!.requestToken(callback.toString());
      const requestToken = result.get('oauth_token')!;
      await repository.putOAuthRequest({ requestToken, encryptedRequestTokenSecret: encryptExternalCredential(result.get('oauth_token_secret')!, config.externalTokenEncryptionKey),
        userId: req.authUser!.userId, creatorId, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
      return res.status(201).json({ authorizationUrl: `https://www.flickr.com/services/oauth/authorize?oauth_token=${encodeURIComponent(requestToken)}&perms=read`, stateExpiresInSeconds: 600 });
    } catch (error) { return res.status(502).json({ message: error instanceof Error ? error.message : 'Flickr authorization could not be started.' }); }
  });

  app.get('/api/integrations/flickr/oauth/callback', async (req, res) => {
    try {
      const state = jwt.verify(String(req.query.state || ''), config.unlockJwtSecret) as { purpose: string; userId: string; creatorId: string };
      if (state.purpose !== 'flickr_connection') throw new Error('Invalid state');
      const requestToken = String(req.query.oauth_token || '').trim();
      const verifier = String(req.query.oauth_verifier || '').trim();
      const pending = await repository.takeOAuthRequest(requestToken);
      if (!pending || pending.userId !== state.userId || pending.creatorId !== state.creatorId || pending.expiresAt <= new Date().toISOString() || !verifier) throw new Error('Invalid request token');
      const access = await client!.accessToken(requestToken, decryptExternalCredential(pending.encryptedRequestTokenSecret, config.externalTokenEncryptionKey), verifier);
      const accountId = access.get('user_nsid') || '';
      const token = access.get('oauth_token')!;
      const tokenSecret = access.get('oauth_token_secret')!;
      if (!accountId) throw new Error('Missing Flickr account');
      const now = new Date().toISOString();
      const connection: FlickrConnection = { connectionId: randomUUID(), userId: state.userId, creatorId: state.creatorId, accountId,
        username: access.get('username') || access.get('fullname') || accountId,
        encryptedTokenRef: encryptExternalCredential(JSON.stringify({ token, tokenSecret }), config.externalTokenEncryptionKey),
        scopes: ['read'], state: 'CONNECTED', capabilities: { inventory: true, originals: false, exif: true }, ownershipValidatedAt: now, createdAt: now };
      await repository.putConnection(connection);
      return res.status(201).json({ connection: { ...connection, encryptedTokenRef: undefined } });
    } catch { return res.status(400).json({ message: 'Invalid or expired Flickr authorization.' }); }
  });

  app.post('/api/integrations/flickr/connections/:id/inventory', requireAuth, async (req, res) => {
    const connection = await repository.getConnection(req.params.id);
    if (!connection || !owns(req, connection.userId) || connection.state !== 'CONNECTED') return res.status(404).json({ message: 'Flickr connection not found.' });
    try {
      const credentials = JSON.parse(decryptExternalCredential(connection.encryptedTokenRef, config.externalTokenEncryptionKey)) as { token: string; tokenSecret: string };
      const page = Math.max(1, Number(req.body.cursor || 1));
      const [inventory, rawAlbums] = await Promise.all([client!.inventoryPage(credentials, page), page === 1 ? client!.albums(credentials) : Promise.resolve([])]);
      const albumPairs = await Promise.all(rawAlbums.map(async (album) => {
        const id = String(album.id || ''); return [id, await client!.albumPhotoIds(credentials, id)] as const;
      }));
      const albumIdsByPhoto = new Map<string, string[]>();
      albumPairs.forEach(([albumId, ids]) => ids.forEach((id) => albumIdsByPhoto.set(id, [...(albumIdsByPhoto.get(id) || []), albumId])));
      const photos = inventory.photos.map((photo) => providerPhoto(photo, albumIdsByPhoto.get(String(photo.id || '')) || []));
      const albums: FlickrExternalCollection[] = rawAlbums.map((album) => ({ remoteAlbumId: String(album.id || ''), title: textContent(album.title) || 'Untitled album',
        description: textContent(album.description), orderedRemotePhotoIds: albumPairs.find(([id]) => id === String(album.id || ''))?.[1] || [] }));
      const nextCursor = inventory.page < inventory.pages ? String(inventory.page + 1) : undefined;
      await repository.putConnection({ ...connection, capabilities: { ...connection.capabilities,
        originals: connection.capabilities.originals || photos.some((photo) => photo.originalAvailable) } });
      return res.status(202).json(migrationForBrowser(await service.inventory(connection, photos, nextCursor, albums, page > 1)));
    } catch (error) { return res.status(502).json({ message: error instanceof Error ? error.message : 'Flickr inventory failed.' }); }
  });
  app.get('/api/integrations/flickr/migrations/:id', requireAuth, async (req, res) => {
    const migration = await repository.getMigration(req.params.id);
    return !migration || !owns(req, migration.userId) ? res.status(404).json({ message: 'Migration not found.' }) : res.json(migrationForBrowser(migration));
  });
  app.post('/api/integrations/flickr/migrations/:id/confirm', requireAuth, async (req, res) => {
    const migration = await repository.getMigration(req.params.id);
    if (!migration || !owns(req, migration.userId)) return res.status(404).json({ message: 'Migration not found.' });
    try { return res.json(migrationForBrowser(await service.confirm(migration, req.body.mode, Array.isArray(req.body.selectedPhotoIds) ? req.body.selectedPhotoIds : [], req.body.storageConfirmed === true))); }
    catch (error) { return res.status(400).json({ message: error instanceof Error ? error.message : 'Invalid migration confirmation.' }); }
  });
  app.post('/api/integrations/flickr/migrations/:id/resume', requireAuth, async (req, res) => {
    const migration = await repository.getMigration(req.params.id);
    if (!migration || !owns(req, migration.userId)) return res.status(404).json({ message: 'Migration not found.' });
    const running = { ...migration, status: 'RUNNING' as const, updatedAt: new Date().toISOString() }; await repository.putMigration(running);
    try { return res.status(202).json(migrationForBrowser(await service.migrateConfirmedSources(running))); }
    catch (error) { return res.status(400).json({ message: error instanceof Error ? error.message : 'Migration could not resume.' }); }
  });
  app.post('/api/integrations/flickr/connections/:id/sync', requireAuth, async (req, res) => {
    const connection = await repository.getConnection(req.params.id);
    if (!connection || !owns(req, connection.userId) || connection.state !== 'CONNECTED') return res.status(404).json({ message: 'Flickr connection not found.' });
    const updated = { ...connection, lastSyncAt: new Date().toISOString() }; await repository.putConnection(updated); return res.status(202).json({ status: 'QUEUED' });
  });
  app.delete('/api/integrations/flickr/connections/:id', requireAuth, async (req, res) => {
    const connection = await repository.getConnection(req.params.id);
    if (!connection || !owns(req, connection.userId)) return res.status(404).json({ message: 'Flickr connection not found.' });
    await repository.putConnection({ ...connection, state: 'DISCONNECTED', encryptedTokenRef: '', capabilities: { inventory: false, originals: false, exif: false } });
    return res.status(204).send();
  });
};
