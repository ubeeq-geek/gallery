import { createHash, randomUUID } from 'crypto';

export type SmugMugMigrationMode = 'REFERENCE_ONLY' | 'SELECTED_SOURCE_MIGRATION' | 'FULL_CATALOGUE_MIGRATION';
export type SmugMugSourceQuality = 'ORIGINAL' | 'HIGHEST_AVAILABLE' | 'EXTERNAL_REFERENCE_ONLY';

export interface SmugMugCapabilities {
  inventory: boolean;
  originalDownloads: boolean;
  exif: boolean;
  passwordProtectedGalleries: false;
}

export interface SmugMugConnection {
  id: string;
  userId: string;
  creatorId: string;
  accountId?: string;
  accountName?: string;
  encryptedCredentialRef?: string;
  oauthState: string;
  capabilities?: SmugMugCapabilities;
  state: 'AUTHORIZING' | 'CONNECTED' | 'INVENTORY_READY' | 'DISCONNECTED' | 'ERROR';
  inventoryCursor?: string;
  lastInventoryAt?: string;
  lastSyncAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SmugMugRemoteCollection {
  remoteId: string;
  remoteUri?: string;
  kind: 'FOLDER' | 'GALLERY' | 'ALBUM';
  parentRemoteId?: string;
  title: string;
  description?: string;
  position: number;
  privacy: Record<string, unknown>;
}

export interface SmugMugRemoteImage {
  remoteId: string;
  galleryId: string;
  url: string;
  filename?: string;
  title?: string;
  caption?: string;
  keywords: string[];
  capturedAt?: string;
  position: number;
  byteSize?: number;
  width?: number;
  height?: number;
  mimeType?: string;
  checksum?: string;
  checksumAlgorithm?: 'md5' | 'sha256';
  originalAvailable: boolean;
  sourceUrl?: string;
  privacy: Record<string, unknown>;
  licence: Record<string, unknown>;
  exif?: Record<string, unknown>;
}

export interface SmugMugInventoryPage {
  collections: SmugMugRemoteCollection[];
  images: SmugMugRemoteImage[];
  nextCursor?: string;
}

export interface SmugMugMigration {
  id: string;
  connectionId: string;
  userId: string;
  creatorId: string;
  mode?: SmugMugMigrationMode;
  selectedGalleryIds: string[];
  status: 'REVIEW' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'PAUSED';
  estimatedBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface SmugMugMigrationItem {
  migrationId: string;
  remoteId: string;
  requestedQuality: SmugMugSourceQuality;
  state: 'PENDING' | 'REFERENCE_IMPORTED' | 'TRANSFERRED' | 'DEDUPLICATED' | 'QUARANTINED' | 'FAILED';
  attempts: number;
  idempotencyKey: string;
  checksum?: string;
  canonicalAssetId?: string;
  errorCode?: string;
}

export interface SmugMugGateway {
  startAuthorization(state: string): Promise<{ authorizationUrl: string; credentialRef: string }>;
  completeAuthorization(credentialRef: string, verifier: string): Promise<{
    credentialRef: string;
    accountId: string;
    accountName: string;
    capabilities: SmugMugCapabilities;
  }>;
  inventory(credentialRef: string, cursor?: string): Promise<SmugMugInventoryPage>;
  download(credentialRef: string, image: SmugMugRemoteImage): Promise<{ body: Buffer; mimeType: string }>;
  deleteCredential?(credentialRef: string): Promise<void>;
  publish?(credentialRef: string, input: { galleryUri: string; body: Buffer; filename: string; mimeType: string; title: string; caption?: string; keywords: string[] }): Promise<{ remoteId: string; remoteUrl?: string; remoteUri?: string }>;
  updateMetadata?(credentialRef: string, input: { remoteUri: string; title: string; caption?: string; keywords: string[] }): Promise<void>;
}

export interface SmugMugOutboundSource {
  load(creatorId: string, workId: string): Promise<{ body: Buffer; filename: string; mimeType: string; title: string; caption?: string; keywords: string[] }>;
  record(input: { connectionId: string; creatorId: string; workId: string; remoteId: string; remoteUrl?: string; remoteUri?: string; visibility: 'private' | 'unlisted' | 'public' }): Promise<void>;
  loadMetadata(connectionId: string, creatorId: string, workId: string): Promise<{ remoteUri: string; title: string; caption?: string; keywords: string[] }>;
  recordMetadataSync(connectionId: string, creatorId: string, workId: string): Promise<void>;
}

export interface SmugMugMigrationSink {
  importReference(input: { connectionId: string; creatorId: string; image: SmugMugRemoteImage; collections: SmugMugRemoteCollection[] }): Promise<void>;
  findAssetByChecksum(creatorId: string, checksum: string): Promise<string | undefined>;
  quarantine(input: { connectionId: string; creatorId: string; image: SmugMugRemoteImage; body: Buffer; mimeType: string; checksum: string }): Promise<{ assetId: string; scanPassed: boolean }>;
}

export interface SmugMugRepository {
  putConnection(connection: SmugMugConnection): Promise<void>;
  getConnection(id: string): Promise<SmugMugConnection | undefined>;
  findAuthorizingConnection(oauthState: string): Promise<SmugMugConnection | undefined>;
  putMigration(migration: SmugMugMigration): Promise<void>;
  getMigration(id: string): Promise<SmugMugMigration | undefined>;
  mergeCollections(connectionId: string, collections: SmugMugRemoteCollection[]): Promise<void>;
  getCollections(connectionId: string): Promise<SmugMugRemoteCollection[]>;
  mergeImages(connectionId: string, images: SmugMugRemoteImage[]): Promise<void>;
  getImages(connectionId: string): Promise<SmugMugRemoteImage[]>;
  putItems(migrationId: string, items: SmugMugMigrationItem[]): Promise<void>;
  getItems(migrationId: string): Promise<SmugMugMigrationItem[]>;
}

export class InMemorySmugMugRepository implements SmugMugRepository {
  connections = new Map<string, SmugMugConnection>();
  migrations = new Map<string, SmugMugMigration>();
  collections = new Map<string, SmugMugRemoteCollection[]>();
  images = new Map<string, SmugMugRemoteImage[]>();
  items = new Map<string, SmugMugMigrationItem[]>();
  async putConnection(value: SmugMugConnection) { this.connections.set(value.id, structuredClone(value)); }
  async getConnection(id: string) { const value = this.connections.get(id); return value && structuredClone(value); }
  async findAuthorizingConnection(state: string) { const value = [...this.connections.values()].find((item) => item.oauthState === state && item.state === 'AUTHORIZING'); return value && structuredClone(value); }
  async putMigration(value: SmugMugMigration) { this.migrations.set(value.id, structuredClone(value)); }
  async getMigration(id: string) { const value = this.migrations.get(id); return value && structuredClone(value); }
  async mergeCollections(id: string, values: SmugMugRemoteCollection[]) { this.collections.set(id, this.merge(this.collections.get(id) || [], values)); }
  async getCollections(id: string) { return structuredClone(this.collections.get(id) || []); }
  async mergeImages(id: string, values: SmugMugRemoteImage[]) { this.images.set(id, this.merge(this.images.get(id) || [], values)); }
  async getImages(id: string) { return structuredClone(this.images.get(id) || []); }
  async putItems(id: string, values: SmugMugMigrationItem[]) { this.items.set(id, structuredClone(values)); }
  async getItems(id: string) { return structuredClone(this.items.get(id) || []); }
  private merge<T extends { remoteId: string }>(current: T[], incoming: T[]) { return [...new Map([...current, ...incoming].map((item) => [item.remoteId, item])).values()]; }
}

/** Migration-only orchestration. It never calls a provider mutation or a publication destination. */
export class SmugMugIntegrationService {
  constructor(
    private readonly gateway: SmugMugGateway,
    private readonly sink: SmugMugMigrationSink,
    readonly repository: SmugMugRepository = new InMemorySmugMugRepository(),
    private readonly outbound?: SmugMugOutboundSource
  ) {}

  async start(userId: string, creatorId: string) {
    const now = new Date().toISOString();
    const connection: SmugMugConnection = { id: randomUUID(), userId, creatorId, oauthState: randomUUID(), state: 'AUTHORIZING', createdAt: now, updatedAt: now };
    const auth = await this.gateway.startAuthorization(connection.oauthState);
    connection.encryptedCredentialRef = auth.credentialRef;
    await this.repository.putConnection(connection);
    return { connection, authorizationUrl: auth.authorizationUrl };
  }

  async callback(state: string, verifier: string) {
    const connection = await this.repository.findAuthorizingConnection(state);
    if (!connection?.encryptedCredentialRef) throw new SmugMugError('INVALID_OAUTH_STATE', 400);
    const account = await this.gateway.completeAuthorization(connection.encryptedCredentialRef, verifier);
    Object.assign(connection, account, { encryptedCredentialRef: account.credentialRef, state: 'CONNECTED', updatedAt: new Date().toISOString() });
    await this.repository.putConnection(connection);
    return connection;
  }

  async ownedConnection(id: string, userId: string) {
    const connection = await this.repository.getConnection(id);
    if (!connection) throw new SmugMugError('CONNECTION_NOT_FOUND', 404);
    if (connection.userId !== userId) throw new SmugMugError('CONNECTION_FORBIDDEN', 403);
    return connection;
  }

  async inventory(id: string, userId: string) {
    const connection = await this.ownedConnection(id, userId);
    if (!connection.encryptedCredentialRef || connection.state === 'DISCONNECTED') throw new SmugMugError('CONNECTION_UNAVAILABLE', 409);
    let cursor = connection.inventoryCursor;
    let pages = 0;
    do {
      const page = await this.gateway.inventory(connection.encryptedCredentialRef, cursor);
      await this.repository.mergeCollections(id, page.collections);
      await this.repository.mergeImages(id, page.images);
      cursor = page.nextCursor;
      connection.inventoryCursor = cursor;
      connection.updatedAt = new Date().toISOString();
      await this.repository.putConnection(connection);
      pages += 1;
    } while (cursor && pages < 100);
    if (cursor) return { connection, complete: false, cursor };
    connection.state = 'INVENTORY_READY';
    connection.lastInventoryAt = connection.updatedAt = new Date().toISOString();
    const images = await this.repository.getImages(id);
    connection.capabilities = { ...(connection.capabilities || { inventory: true, exif: false, passwordProtectedGalleries: false }), originalDownloads: images.some((image) => image.originalAvailable) };
    const migration: SmugMugMigration = {
      id: randomUUID(), connectionId: id, userId, creatorId: connection.creatorId, selectedGalleryIds: [], status: 'REVIEW',
      estimatedBytes: images.reduce((total, image) => total + (image.byteSize || 0), 0), createdAt: connection.updatedAt, updatedAt: connection.updatedAt
    };
    await this.repository.putConnection(connection);
    await this.repository.putMigration(migration);
    return { connection, complete: true, migration, collectionCount: (await this.repository.getCollections(id)).length, imageCount: images.length };
  }

  async confirm(migrationId: string, userId: string, mode: SmugMugMigrationMode, selectedGalleryIds: string[] = []) {
    const migration = await this.ownedMigration(migrationId, userId);
    if (migration.status !== 'REVIEW') throw new SmugMugError('MIGRATION_ALREADY_CONFIRMED', 409);
    const connection = await this.ownedConnection(migration.connectionId, userId);
    const images = (await this.repository.getImages(connection.id)).filter((image) => mode !== 'SELECTED_SOURCE_MIGRATION' || selectedGalleryIds.includes(image.galleryId));
    if (mode === 'SELECTED_SOURCE_MIGRATION' && selectedGalleryIds.length === 0) throw new SmugMugError('GALLERY_SELECTION_REQUIRED', 400);
    migration.mode = mode;
    migration.selectedGalleryIds = [...new Set(selectedGalleryIds)];
    migration.status = 'RUNNING';
    migration.updatedAt = new Date().toISOString();
    await this.repository.putMigration(migration);
    await this.repository.putItems(migration.id, images.map((image) => ({
      migrationId, remoteId: image.remoteId,
      requestedQuality: mode === 'REFERENCE_ONLY' || !connection.capabilities?.originalDownloads || !image.originalAvailable ? 'EXTERNAL_REFERENCE_ONLY' : 'HIGHEST_AVAILABLE',
      state: 'PENDING', attempts: 0, idempotencyKey: createHash('sha256').update(`${migrationId}:${image.remoteId}:${mode}`).digest('hex')
    })));
    return this.resume(migrationId, userId);
  }

  async resume(migrationId: string, userId: string) {
    const migration = await this.ownedMigration(migrationId, userId);
    if (!migration.mode) throw new SmugMugError('MIGRATION_NOT_CONFIRMED', 409);
    const connection = await this.ownedConnection(migration.connectionId, userId);
    const collections = await this.repository.getCollections(connection.id);
    const images = await this.repository.getImages(connection.id);
    const items = await this.repository.getItems(migration.id);
    migration.status = 'RUNNING';
    for (const item of items.filter((candidate) => candidate.state === 'PENDING' || (candidate.state === 'FAILED' && candidate.attempts < 3))) {
      const image = images.find((candidate) => candidate.remoteId === item.remoteId)!;
      item.attempts += 1;
      try {
        await this.sink.importReference({ connectionId: connection.id, creatorId: migration.creatorId, image, collections });
        if (item.requestedQuality === 'EXTERNAL_REFERENCE_ONLY') { item.state = 'REFERENCE_IMPORTED'; continue; }
        const transfer = await this.gateway.download(connection.encryptedCredentialRef!, image);
        if (image.mimeType && transfer.mimeType !== image.mimeType) throw new SmugMugError('MIME_MISMATCH', 422);
        const checksum = createHash('sha256').update(transfer.body).digest('hex');
        const providerChecksum = image.checksum
          ? createHash(image.checksumAlgorithm || (image.checksum.length === 32 ? 'md5' : 'sha256')).update(transfer.body).digest('hex')
          : undefined;
        if (image.checksum && providerChecksum?.toLowerCase() !== image.checksum.toLowerCase()) throw new SmugMugError('CHECKSUM_MISMATCH', 422);
        item.checksum = checksum;
        const existing = await this.sink.findAssetByChecksum(migration.creatorId, checksum);
        if (existing) { item.canonicalAssetId = existing; item.state = 'DEDUPLICATED'; continue; }
        const quarantined = await this.sink.quarantine({ connectionId: connection.id, creatorId: migration.creatorId, image, ...transfer, checksum });
        item.canonicalAssetId = quarantined.assetId;
        item.state = quarantined.scanPassed ? 'TRANSFERRED' : 'QUARANTINED';
      } catch (error) {
        item.state = 'FAILED';
        item.errorCode = error instanceof SmugMugError ? error.code : 'TRANSFER_FAILED';
        // Validation, permission, and policy failures are deterministic and must
        // not be retried automatically. Only transient gateway failures consume
        // the remaining bounded attempts on a later resume.
        if (error instanceof SmugMugError) item.attempts = 3;
      }
    }
    migration.updatedAt = new Date().toISOString();
    migration.status = items.some((item) => item.state === 'FAILED') ? 'PARTIAL' : 'COMPLETED';
    await this.repository.putItems(migration.id, items);
    await this.repository.putMigration(migration);
    return { migration, items };
  }

  async sync(id: string, userId: string) {
    const result = await this.inventory(id, userId);
    const connection = await this.ownedConnection(id, userId);
    connection.lastSyncAt = connection.updatedAt = new Date().toISOString();
    await this.repository.putConnection(connection);
    return result;
  }

  async disconnect(id: string, userId: string) {
    const connection = await this.ownedConnection(id, userId);
    if (connection.encryptedCredentialRef) await this.gateway.deleteCredential?.(connection.encryptedCredentialRef);
    connection.state = 'DISCONNECTED';
    connection.encryptedCredentialRef = undefined;
    connection.updatedAt = new Date().toISOString();
    await this.repository.putConnection(connection);
  }

  /** Explicit phase-three operation. Inventory, import, sync, and connect never call this. */
  async publishSelected(id: string, userId: string, galleryId: string, workIds: string[]) {
    const connection = await this.ownedConnection(id, userId);
    if (!this.outbound || !this.gateway.publish || !connection.encryptedCredentialRef) throw new SmugMugError('OUTBOUND_PUBLISHING_UNAVAILABLE', 409);
    const gallery = (await this.repository.getCollections(id)).find((item) => item.remoteId === galleryId && (item.kind === 'GALLERY' || item.kind === 'ALBUM'));
    if (!gallery?.remoteUri) throw new SmugMugError('SMUGMUG_GALLERY_NOT_PUBLISHABLE', 409);
    const uniqueWorkIds = [...new Set(workIds)].slice(0, 100);
    if (!uniqueWorkIds.length) throw new SmugMugError('WORK_SELECTION_REQUIRED', 400);
    const results: Array<{ workId: string; status: 'published' | 'failed'; remoteId?: string; errorCode?: string }> = [];
    for (const workId of uniqueWorkIds) {
      try {
        const source = await this.outbound.load(connection.creatorId, workId);
        const remote = await this.gateway.publish(connection.encryptedCredentialRef, { galleryUri: gallery.remoteUri, ...source });
        const privacy = String(gallery.privacy.visibility || '').toLowerCase();
        const visibility = privacy === 'public' ? 'public' : privacy === 'unlisted' ? 'unlisted' : 'private';
        await this.outbound.record({ connectionId: id, creatorId: connection.creatorId, workId, ...remote, visibility });
        results.push({ workId, status: 'published', remoteId: remote.remoteId });
      } catch (error) {
        results.push({ workId, status: 'failed', errorCode: error instanceof SmugMugError ? error.code : 'PUBLISH_FAILED' });
      }
    }
    return { connectionId: id, galleryId, results };
  }

  async syncSelectedMetadata(id: string, userId: string, workIds: string[]) {
    const connection = await this.ownedConnection(id, userId);
    if (!this.outbound || !this.gateway.updateMetadata || !connection.encryptedCredentialRef) throw new SmugMugError('METADATA_SYNC_UNAVAILABLE', 409);
    const uniqueWorkIds = [...new Set(workIds)].slice(0, 100);
    if (!uniqueWorkIds.length) throw new SmugMugError('WORK_SELECTION_REQUIRED', 400);
    const results: Array<{ workId: string; status: 'updated' | 'failed'; errorCode?: string }> = [];
    for (const workId of uniqueWorkIds) {
      try {
        const metadata = await this.outbound.loadMetadata(id, connection.creatorId, workId);
        await this.gateway.updateMetadata(connection.encryptedCredentialRef, metadata);
        await this.outbound.recordMetadataSync(id, connection.creatorId, workId);
        results.push({ workId, status: 'updated' });
      } catch (error) {
        results.push({ workId, status: 'failed', errorCode: error instanceof SmugMugError ? error.code : 'METADATA_SYNC_FAILED' });
      }
    }
    return { connectionId: id, results };
  }

  private async ownedMigration(id: string, userId: string) {
    const migration = await this.repository.getMigration(id);
    if (!migration) throw new SmugMugError('MIGRATION_NOT_FOUND', 404);
    if (migration.userId !== userId) throw new SmugMugError('MIGRATION_FORBIDDEN', 403);
    return migration;
  }

}

export class SmugMugError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
