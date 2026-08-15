import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CanonicalStore } from './canonicalStore';
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

const clean = <T>(item: Record<string, unknown>): T => {
  const value = { ...item };
  for (const key of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'entityType']) delete value[key];
  return value as T;
};

const tenantPrefix = (tenantId: string): string => `TENANT#${tenantId}`;

export class CanonicalContentRepository implements CanonicalStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  private async put(item: Record<string, unknown>): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  private async get<T>(PK: string, SK: string): Promise<T | null> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK, SK } }));
    return result.Item ? clean<T>(result.Item) : null;
  }

  private async list<T>(PK: string, prefix: string, entityType: string): Promise<T[]> {
    const items: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': PK, ':sk': prefix },
        ExclusiveStartKey
      }));
      items.push(...(result.Items || []).filter((item) => item.entityType === entityType).map((item) => clean<T>(item)));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  private async listIndex<T>(key: string, prefix: string, entityType: string): Promise<T[]> {
    const items: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
        ExpressionAttributeValues: { ':pk': key, ':sk': prefix },
        ExclusiveStartKey
      }));
      items.push(...(result.Items || []).filter((item) => item.entityType === entityType).map((item) => clean<T>(item)));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  async listWorksByCreator(tenantId: string, creatorId: string): Promise<Work[]> {
    const items = await this.listIndex<Work>(`${tenantPrefix(tenantId)}#CREATOR_WORK#${creatorId}`, 'WORK#', 'WORK');
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getWork(tenantId: string, workId: string): Promise<Work | null> {
    return this.get(`${tenantPrefix(tenantId)}#WORK#${workId}`, 'PROFILE');
  }

  async createWork(work: Work): Promise<void> {
    await this.put({
      PK: `${tenantPrefix(work.tenantId)}#WORK#${work.workId}`,
      SK: 'PROFILE',
      GSI1PK: `${tenantPrefix(work.tenantId)}#CREATOR_WORK#${work.creatorId}`,
      GSI1SK: `WORK#${work.updatedAt}#${work.workId}`,
      GSI2PK: `${tenantPrefix(work.tenantId)}#WORK_SLUG#${work.creatorId}`,
      GSI2SK: `SLUG#${work.slug}`,
      entityType: 'WORK',
      ...work
    });
  }

  async updateWork(work: Work): Promise<void> {
    await this.createWork(work);
  }

  async listCanonicalAssetsByWork(tenantId: string, workId: string): Promise<Array<CanonicalAsset & { attachment: WorkAsset }>> {
    const attachments = (await this.list<WorkAsset>(`${tenantPrefix(tenantId)}#WORK#${workId}`, 'ASSET#', 'WORK_ASSET'))
      .sort((a, b) => a.position - b.position);
    const assets = await Promise.all(attachments.map(async (attachment) => {
      const asset = await this.getCanonicalAsset(tenantId, attachment.assetId);
      return asset ? { ...asset, attachment } : null;
    }));
    return assets.filter((asset): asset is CanonicalAsset & { attachment: WorkAsset } => Boolean(asset));
  }

  async getCanonicalAsset(tenantId: string, assetId: string): Promise<CanonicalAsset | null> {
    return this.get(`${tenantPrefix(tenantId)}#ASSET#${assetId}`, 'PROFILE');
  }

  async createCanonicalAsset(asset: CanonicalAsset): Promise<void> {
    await this.put({
      PK: `${tenantPrefix(asset.tenantId)}#ASSET#${asset.assetId}`,
      SK: 'PROFILE',
      GSI1PK: `${tenantPrefix(asset.tenantId)}#CREATOR_ASSET#${asset.creatorId}`,
      GSI1SK: `ASSET#${asset.updatedAt}#${asset.assetId}`,
      entityType: 'CANONICAL_ASSET',
      ...asset
    });
  }

  async updateCanonicalAsset(asset: CanonicalAsset): Promise<void> {
    await this.createCanonicalAsset(asset);
  }

  async attachAssetToWork(tenantId: string, attachment: WorkAsset): Promise<void> {
    await this.put({
      PK: `${tenantPrefix(tenantId)}#WORK#${attachment.workId}`,
      SK: `ASSET#${attachment.position.toString().padStart(8, '0')}#${attachment.assetId}`,
      GSI1PK: `${tenantPrefix(tenantId)}#ASSET_WORK#${attachment.assetId}`,
      GSI1SK: `WORK#${attachment.workId}`,
      entityType: 'WORK_ASSET',
      ...attachment
    });
  }

  async detachAssetFromWork(tenantId: string, workId: string, assetId: string): Promise<void> {
    const attachments = await this.list<WorkAsset>(`${tenantPrefix(tenantId)}#WORK#${workId}`, 'ASSET#', 'WORK_ASSET');
    await Promise.all(attachments.filter((item) => item.assetId === assetId).map((item) => this.client.send(new DeleteCommand({
      TableName: this.tableName,
      Key: {
        PK: `${tenantPrefix(tenantId)}#WORK#${workId}`,
        SK: `ASSET#${item.position.toString().padStart(8, '0')}#${item.assetId}`
      }
    }))));
  }

  async listPublicationsByWork(tenantId: string, workId: string): Promise<Publication[]> {
    const items = await this.listIndex<Publication>(`${tenantPrefix(tenantId)}#WORK_PUBLICATION#${workId}`, 'PUBLICATION#', 'PUBLICATION');
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getPublication(tenantId: string, publicationId: string): Promise<Publication | null> {
    return this.get(`${tenantPrefix(tenantId)}#PUBLICATION#${publicationId}`, 'PROFILE');
  }

  async upsertPublication(publication: Publication): Promise<void> {
    await this.put({
      PK: `${tenantPrefix(publication.tenantId)}#PUBLICATION#${publication.publicationId}`,
      SK: 'PROFILE',
      GSI1PK: `${tenantPrefix(publication.tenantId)}#WORK_PUBLICATION#${publication.workId}`,
      GSI1SK: `PUBLICATION#${publication.updatedAt}#${publication.publicationId}`,
      GSI2PK: publication.integrationAccountId
        ? `${tenantPrefix(publication.tenantId)}#ACCOUNT_PUBLICATION#${publication.integrationAccountId}`
        : `${tenantPrefix(publication.tenantId)}#DESTINATION_PUBLICATION#${publication.destination}`,
      GSI2SK: `PUBLICATION#${publication.updatedAt}#${publication.publicationId}`,
      entityType: 'PUBLICATION',
      ...publication
    });
  }

  async listPublicationIntentsByWork(tenantId: string, workId: string): Promise<PublicationIntent[]> {
    const items = await this.listIndex<PublicationIntent>(`${tenantPrefix(tenantId)}#WORK_PUBLICATION_INTENT#${workId}`, 'PUBLICATION_INTENT#', 'PUBLICATION_INTENT');
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getPublicationIntent(tenantId: string, publicationIntentId: string): Promise<PublicationIntent | null> {
    return this.get(`${tenantPrefix(tenantId)}#PUBLICATION_INTENT#${publicationIntentId}`, 'PROFILE');
  }

  async upsertPublicationIntent(intent: PublicationIntent): Promise<void> {
    await this.put({
      PK: `${tenantPrefix(intent.tenantId)}#PUBLICATION_INTENT#${intent.publicationIntentId}`,
      SK: 'PROFILE',
      GSI1PK: `${tenantPrefix(intent.tenantId)}#WORK_PUBLICATION_INTENT#${intent.workId}`,
      GSI1SK: `PUBLICATION_INTENT#${intent.updatedAt}#${intent.publicationIntentId}`,
      entityType: 'PUBLICATION_INTENT',
      ...intent
    });
  }

  async deletePublicationIntent(tenantId: string, publicationIntentId: string): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { PK: `${tenantPrefix(tenantId)}#PUBLICATION_INTENT#${publicationIntentId}`, SK: 'PROFILE' } }));
  }

  async listCreatorCollections(tenantId: string, creatorId: string): Promise<CreatorCollection[]> {
    const items = await this.listIndex<CreatorCollection>(`${tenantPrefix(tenantId)}#CREATOR_COLLECTION#${creatorId}`, 'COLLECTION#', 'CREATOR_COLLECTION');
    return items.sort((a, b) => a.title.localeCompare(b.title));
  }

  async getCreatorCollection(tenantId: string, collectionId: string): Promise<CreatorCollection | null> {
    return this.get(`${tenantPrefix(tenantId)}#COLLECTION#${collectionId}`, 'PROFILE');
  }

  async createCreatorCollection(collection: CreatorCollection): Promise<void> {
    await this.put({
      PK: `${tenantPrefix(collection.tenantId)}#COLLECTION#${collection.collectionId}`,
      SK: 'PROFILE',
      GSI1PK: `${tenantPrefix(collection.tenantId)}#CREATOR_COLLECTION#${collection.creatorId}`,
      GSI1SK: `COLLECTION#${collection.updatedAt}#${collection.collectionId}`,
      GSI2PK: `${tenantPrefix(collection.tenantId)}#COLLECTION_SLUG#${collection.creatorId}`,
      GSI2SK: `SLUG#${collection.slug}`,
      entityType: 'CREATOR_COLLECTION',
      ...collection
    });
  }

  async updateCreatorCollection(collection: CreatorCollection): Promise<void> {
    await this.createCreatorCollection(collection);
  }

  async listCollectionWorks(tenantId: string, collectionId: string): Promise<CollectionWork[]> {
    return (await this.list<CollectionWork>(`${tenantPrefix(tenantId)}#COLLECTION#${collectionId}`, 'WORK#', 'COLLECTION_WORK'))
      .sort((a, b) => a.position - b.position);
  }

  async replaceCollectionWorks(tenantId: string, collectionId: string, works: CollectionWork[]): Promise<void> {
    const existing = await this.listCollectionWorks(tenantId, collectionId);
    await Promise.all(existing.map((item) => this.client.send(new DeleteCommand({
      TableName: this.tableName,
      Key: {
        PK: `${tenantPrefix(tenantId)}#COLLECTION#${collectionId}`,
        SK: `WORK#${item.position.toString().padStart(8, '0')}#${item.workId}`
      }
    }))));
    await Promise.all(works.map((item) => this.put({
      PK: `${tenantPrefix(tenantId)}#COLLECTION#${collectionId}`,
      SK: `WORK#${item.position.toString().padStart(8, '0')}#${item.workId}`,
      GSI1PK: `${tenantPrefix(tenantId)}#WORK_COLLECTION#${item.workId}`,
      GSI1SK: `COLLECTION#${item.collectionId}`,
      entityType: 'COLLECTION_WORK',
      ...item
    })));
  }

  async getWorkDiscoveryParticipation(tenantId: string, workId: string): Promise<WorkDiscoveryParticipation | null> {
    return this.get(`${tenantPrefix(tenantId)}#WORK#${workId}`, 'DISCOVERY');
  }

  async upsertWorkDiscoveryParticipation(participation: WorkDiscoveryParticipation): Promise<void> {
    await this.put({
      PK: `${tenantPrefix(participation.tenantId)}#WORK#${participation.workId}`,
      SK: 'DISCOVERY',
      GSI1PK: `${tenantPrefix(participation.tenantId)}#DISCOVERY#${participation.state}`,
      GSI1SK: `WORK#${participation.updatedAt}#${participation.workId}`,
      entityType: 'WORK_DISCOVERY',
      ...participation
    });
  }
}
