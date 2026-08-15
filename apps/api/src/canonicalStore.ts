import type {
  CanonicalAsset,
  CollectionWork,
  CreatorCollection,
  Publication,
  PublicationIntent,
  Work,
  WorkAsset,
  WorkDiscoveryParticipation
} from './canonicalDomain';

export interface CanonicalStore {
  listWorksByCreator(tenantId: string, creatorId: string): Promise<Work[]>;
  getWork(tenantId: string, workId: string): Promise<Work | null>;
  createWork(work: Work): Promise<void>;
  updateWork(work: Work): Promise<void>;

  listCanonicalAssetsByWork(tenantId: string, workId: string): Promise<Array<CanonicalAsset & { attachment: WorkAsset }>>;
  getCanonicalAsset(tenantId: string, assetId: string): Promise<CanonicalAsset | null>;
  createCanonicalAsset(asset: CanonicalAsset): Promise<void>;
  updateCanonicalAsset(asset: CanonicalAsset): Promise<void>;
  attachAssetToWork(tenantId: string, attachment: WorkAsset): Promise<void>;
  detachAssetFromWork(tenantId: string, workId: string, assetId: string): Promise<void>;

  listPublicationsByWork(tenantId: string, workId: string): Promise<Publication[]>;
  getPublication(tenantId: string, publicationId: string): Promise<Publication | null>;
  upsertPublication(publication: Publication): Promise<void>;
  listPublicationIntentsByWork(tenantId: string, workId: string): Promise<PublicationIntent[]>;
  getPublicationIntent(tenantId: string, publicationIntentId: string): Promise<PublicationIntent | null>;
  upsertPublicationIntent(intent: PublicationIntent): Promise<void>;
  deletePublicationIntent(tenantId: string, publicationIntentId: string): Promise<void>;

  listCreatorCollections(tenantId: string, creatorId: string): Promise<CreatorCollection[]>;
  getCreatorCollection(tenantId: string, collectionId: string): Promise<CreatorCollection | null>;
  createCreatorCollection(collection: CreatorCollection): Promise<void>;
  updateCreatorCollection(collection: CreatorCollection): Promise<void>;
  listCollectionWorks(tenantId: string, collectionId: string): Promise<CollectionWork[]>;
  replaceCollectionWorks(tenantId: string, collectionId: string, works: CollectionWork[]): Promise<void>;

  getWorkDiscoveryParticipation(tenantId: string, workId: string): Promise<WorkDiscoveryParticipation | null>;
  upsertWorkDiscoveryParticipation(participation: WorkDiscoveryParticipation): Promise<void>;
}
