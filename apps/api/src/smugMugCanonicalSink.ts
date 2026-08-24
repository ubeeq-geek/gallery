import { createHash } from 'crypto';
import type { AppConfig } from './config';
import type { CanonicalStore } from './canonicalStore';
import { readStoredUbeeqWorkImage, storeUbeeqWorkImage } from './externalContentStorage';
import { SmugMugError, type SmugMugMigrationSink, type SmugMugOutboundSource, type SmugMugRemoteCollection, type SmugMugRemoteImage } from './smugMugIntegration';

export interface SmugMugContentScanner {
  scan(input: { body: Buffer; mimeType: string; filename?: string }): Promise<{ safe: boolean; reason?: string }>;
}

/** Fail-closed image scanner used by the migration worker. It verifies the declared
 * media type and requires Sharp to parse the quarantined payload before storage. */
export class SmugMugImageScanner implements SmugMugContentScanner {
  async scan({ body, mimeType }: { body: Buffer; mimeType: string; filename?: string }) {
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff'].includes(mimeType.toLowerCase())) return { safe: false, reason: 'unsupported_mime' };
    try {
      const sharp = (await import('sharp')).default;
      const metadata = await sharp(body, { failOn: 'error', limitInputPixels: true }).metadata();
      if (!metadata.width || !metadata.height || !metadata.format) return { safe: false, reason: 'invalid_image' };
      return { safe: true };
    } catch {
      return { safe: false, reason: 'invalid_image' };
    }
  }
}

const stableId = (kind: string, remoteId: string) => `smugmug-${kind}-${createHash('sha256').update(remoteId).digest('hex').slice(0, 32)}`;
const slug = (title: string, remoteId: string) => `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'smugmug'}-${createHash('sha256').update(remoteId).digest('hex').slice(0, 8)}`;

/** Writes staged, private SmugMug references into the canonical model. It never opts a Work into Discovery. */
export class SmugMugCanonicalSink implements SmugMugMigrationSink {
  constructor(
    private readonly store: CanonicalStore,
    private readonly config: AppConfig,
    private readonly scanner: SmugMugContentScanner
  ) {}

  async importReference({ connectionId, creatorId, image, collections }: { connectionId: string; creatorId: string; image: SmugMugRemoteImage; collections: SmugMugRemoteCollection[] }) {
    const now = new Date().toISOString();
    const workId = stableId('work', image.remoteId);
    const assetId = stableId('reference', image.remoteId);
    const existing = await this.store.getWork(this.config.tenantId, workId);
    if (!existing) await this.store.createWork({
      workId, tenantId: this.config.tenantId, creatorId, kind: 'image', title: image.title || image.filename || 'SmugMug image',
      slug: slug(image.title || image.filename || 'SmugMug image', image.remoteId), slugHistory: [], description: image.caption,
      tags: image.keywords, contentRating: 'general', aiDisclosure: 'none', heavyTopics: [], status: 'draft',
      origin: { type: 'import', platform: 'smugmug', integrationAccountId: connectionId, remoteId: image.remoteId, remoteUrl: image.url, importedAt: now },
      primaryAssetId: assetId, revision: 1, createdAt: now, updatedAt: now
    });
    if (!(await this.store.getCanonicalAsset(this.config.tenantId, assetId))) {
      await this.store.createCanonicalAsset({
        assetId, tenantId: this.config.tenantId, creatorId, kind: 'image', status: 'ready', mimeType: image.mimeType || 'image/unknown',
        originalFilename: image.filename, sizeBytes: image.byteSize, width: image.width, height: image.height,
        storage: { mode: 'external', externalUrl: image.url }, metadata: this.provenance(image), createdAt: now, updatedAt: now
      });
      await this.store.attachAssetToWork(this.config.tenantId, { workId, assetId, role: 'primary', position: 0, caption: image.caption });
    }
    await this.store.upsertPublication({
      publicationId: stableId('publication', image.remoteId), tenantId: this.config.tenantId, creatorId, workId, destination: 'smugmug',
      integrationAccountId: connectionId, status: 'live', visibility: this.visibility(image), remoteId: image.remoteId, remoteUrl: image.url,
      metadataOverrides: { title: image.title, description: image.caption, tags: image.keywords, fields: { privacy: image.privacy, licence: image.licence } },
      sync: { status: 'in_sync', lastSuccessfulAt: now }, providerData: { galleryId: image.galleryId, position: image.position, originalAvailable: image.originalAvailable },
      createdAt: now, updatedAt: now
    });
    const remoteCollection = collections.find((item) => item.remoteId === image.galleryId);
    if (remoteCollection) await this.placeInCollection(creatorId, workId, remoteCollection, now);
  }

  async findAssetByChecksum(creatorId: string, checksum: string) {
    const works = await this.store.listWorksByCreator(this.config.tenantId, creatorId);
    for (const work of works) {
      const match = (await this.store.listCanonicalAssetsByWork(this.config.tenantId, work.workId)).find((asset) => asset.checksumSha256 === checksum && asset.storage.mode === 'hosted');
      if (match) return match.assetId;
    }
    return undefined;
  }

  async quarantine({ creatorId, image, body, mimeType, checksum }: { connectionId: string; creatorId: string; image: SmugMugRemoteImage; body: Buffer; mimeType: string; checksum: string }) {
    const assetId = stableId('source', `${image.remoteId}:${checksum}`);
    const scan = await this.scanner.scan({ body, mimeType, filename: image.filename });
    if (!scan.safe) return { assetId, scanPassed: false };
    const stored = await storeUbeeqWorkImage(this.config, { tenantId: this.config.tenantId, creatorId, assetId, contentType: mimeType, body });
    const now = new Date().toISOString();
    await this.store.createCanonicalAsset({
      assetId, tenantId: this.config.tenantId, creatorId, kind: 'image', status: 'ready', mimeType,
      originalFilename: image.filename, sizeBytes: stored.byteSize, checksumSha256: checksum, width: image.width, height: image.height,
      storage: { mode: 'hosted', objectKey: stored.objectKey, thumbnailObjectKey: stored.thumbnailObjectKey }, metadata: this.provenance(image), createdAt: now, updatedAt: now
    });
    const workId = stableId('work', image.remoteId);
    await this.store.attachAssetToWork(this.config.tenantId, { workId, assetId, role: 'source', position: 0, caption: image.caption });
    const work = await this.store.getWork(this.config.tenantId, workId);
    if (work) await this.store.updateWork({ ...work, primaryAssetId: assetId, status: 'ready', revision: work.revision + 1, updatedAt: now });
    return { assetId, scanPassed: true };
  }

  private async placeInCollection(creatorId: string, workId: string, remote: SmugMugRemoteCollection, now: string) {
    const collectionId = stableId('collection', remote.remoteId);
    if (!(await this.store.getCreatorCollection(this.config.tenantId, collectionId))) await this.store.createCreatorCollection({
      collectionId, tenantId: this.config.tenantId, creatorId, type: remote.kind === 'ALBUM' ? 'collection' : 'gallery', title: remote.title,
      slug: slug(remote.title, remote.remoteId), slugHistory: [], description: remote.description, status: 'draft', visibility: 'private', createdAt: now, updatedAt: now
    });
    const placements = await this.store.listCollectionWorks(this.config.tenantId, collectionId);
    if (!placements.some((item) => item.workId === workId)) await this.store.replaceCollectionWorks(this.config.tenantId, collectionId, [...placements, { collectionId, workId, position: remote.position, addedAt: now }]);
  }

  private visibility(image: SmugMugRemoteImage): 'private' | 'unlisted' | 'public' {
    const value = String(image.privacy.visibility || '').toLowerCase();
    return value === 'public' ? 'public' : value === 'unlisted' ? 'unlisted' : 'private';
  }
  private provenance(image: SmugMugRemoteImage): Record<string, string | number | boolean | null> {
    return { source: 'smugmug', remoteId: image.remoteId, remoteUrl: image.url, galleryId: image.galleryId, originalFilename: image.filename || null,
      sourceQuality: image.originalAvailable ? 'highest_available' : 'external_reference_only', privacySnapshot: JSON.stringify(image.privacy), licenceSnapshot: JSON.stringify(image.licence),
      exifSnapshot: image.exif ? JSON.stringify(this.privateExif(image.exif)) : null };
  }
  private privateExif(exif: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(exif).filter(([key]) => !/(gps|location|latitude|longitude)/i.test(key)));
  }
}

/** Loads only creator-owned hosted canonical image assets for an explicit outbound request. */
export class SmugMugCanonicalOutboundSource implements SmugMugOutboundSource {
  constructor(private readonly store: CanonicalStore, private readonly config: AppConfig) {}

  async load(creatorId: string, workId: string) {
    const work = await this.store.getWork(this.config.tenantId, workId);
    if (!work || work.creatorId !== creatorId) throw new SmugMugError('WORK_NOT_FOUND', 404);
    const assets = await this.store.listCanonicalAssetsByWork(this.config.tenantId, workId);
    const asset = assets.find((item) => item.assetId === work.primaryAssetId && item.status === 'ready' && item.storage.mode === 'hosted')
      || assets.find((item) => item.status === 'ready' && item.storage.mode === 'hosted');
    if (!asset?.storage.objectKey || !asset.mimeType.startsWith('image/')) throw new SmugMugError('HOSTED_IMAGE_REQUIRED', 409);
    return {
      body: await readStoredUbeeqWorkImage(this.config, asset.storage.objectKey), filename: asset.originalFilename || `${work.slug}.jpg`,
      mimeType: asset.mimeType, title: work.title, caption: work.description, keywords: work.tags
    };
  }

  async record(input: { connectionId: string; creatorId: string; workId: string; remoteId: string; remoteUrl?: string; remoteUri?: string; visibility: 'private' | 'unlisted' | 'public' }) {
    const now = new Date().toISOString();
    await this.store.upsertPublication({
      publicationId: stableId('publication', input.remoteId), tenantId: this.config.tenantId, creatorId: input.creatorId, workId: input.workId,
      destination: 'smugmug', integrationAccountId: input.connectionId, status: 'live', visibility: input.visibility, remoteId: input.remoteId,
      remoteUrl: input.remoteUrl, sync: { status: 'in_sync', lastSuccessfulAt: now }, providerData: { remoteUri: input.remoteUri, explicitlyPublished: true },
      createdAt: now, updatedAt: now, publishedAt: now
    });
  }

  async loadMetadata(connectionId: string, creatorId: string, workId: string) {
    const work = await this.store.getWork(this.config.tenantId, workId);
    if (!work || work.creatorId !== creatorId) throw new SmugMugError('WORK_NOT_FOUND', 404);
    const publication = (await this.store.listPublicationsByWork(this.config.tenantId, workId)).find((item) => item.destination === 'smugmug' && item.integrationAccountId === connectionId && item.status === 'live');
    const remoteUri = publication?.providerData?.remoteUri;
    if (typeof remoteUri !== 'string') throw new SmugMugError('SMUGMUG_PUBLICATION_NOT_FOUND', 404);
    return { remoteUri, title: work.title, caption: work.description, keywords: work.tags };
  }

  async recordMetadataSync(connectionId: string, creatorId: string, workId: string) {
    const publication = (await this.store.listPublicationsByWork(this.config.tenantId, workId)).find((item) => item.destination === 'smugmug' && item.integrationAccountId === connectionId);
    if (!publication || publication.creatorId !== creatorId) throw new SmugMugError('SMUGMUG_PUBLICATION_NOT_FOUND', 404);
    const now = new Date().toISOString();
    await this.store.upsertPublication({ ...publication, sync: { ...publication.sync, status: 'in_sync', lastAttemptAt: now, lastSuccessfulAt: now }, updatedAt: now });
  }
}
