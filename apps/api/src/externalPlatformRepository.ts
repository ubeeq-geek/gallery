import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type {
  Asset,
  ExternalAccount,
  ExternalAccountCreatorAssignment,
  ExternalPlatformCredential,
  ExternalCollection,
  ExternalCollectionMapping,
  ExternalComment,
  ExternalEngagementSnapshot,
  ExternalPublication,
  SpacePublication,
  ExternalSyncJob,
  ExternalSyncLog,
  UbeeqCollection,
  UbeeqCollectionAsset
} from './domain';

const stripEntityFields = <T>(item: Record<string, unknown>): T => {
  const clean = { ...item };
  delete clean.PK;
  delete clean.SK;
  delete clean.GSI1PK;
  delete clean.GSI1SK;
  delete clean.GSI2PK;
  delete clean.GSI2SK;
  delete clean.entityType;
  return clean as T;
};

export class ExternalPlatformRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  private async put(item: Record<string, unknown>): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  private async delete(PK: string, SK: string): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { PK, SK } }));
  }

  private async get<T>(PK: string, SK: string): Promise<T | null> {
    const response = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { PK, SK }
    }));
    return response.Item ? stripEntityFields<T>(response.Item) : null;
  }

  private async listByPartition<T>(PK: string, prefix: string, entityType: string, limit?: number): Promise<T[]> {
    const response = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': prefix },
      Limit: limit
    }));
    return (response.Items || [])
      .filter((item) => item.entityType === entityType)
      .map((item) => stripEntityFields<T>(item));
  }

  private async listByIndex<T>(
    indexName: 'GSI1' | 'GSI2',
    keyName: 'GSI1PK' | 'GSI2PK',
    sortKeyName: 'GSI1SK' | 'GSI2SK',
    key: string,
    prefix: string,
    entityType: string,
    limit?: number
  ): Promise<T[]> {
    const response = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: indexName,
      KeyConditionExpression: `#pk = :pk AND begins_with(#sk, :prefix)`,
      ExpressionAttributeNames: { '#pk': keyName, '#sk': sortKeyName },
      ExpressionAttributeValues: { ':pk': key, ':prefix': prefix },
      Limit: limit
    }));
    return (response.Items || [])
      .filter((item) => item.entityType === entityType)
      .map((item) => stripEntityFields<T>(item));
  }

  async listExternalAccountsByCreatorIdentity(creatorIdentityId: string): Promise<ExternalAccount[]> {
    const [legacyAccounts, assignments] = await Promise.all([
      this.listByIndex<ExternalAccount>(
      'GSI1',
      'GSI1PK',
      'GSI1SK',
      `CREATOR_EXTERNAL_ACCOUNT#${creatorIdentityId}`,
      'ACCOUNT#',
      'EXTERNAL_ACCOUNT'
      ),
      this.listByIndex<ExternalAccountCreatorAssignment>(
        'GSI1',
        'GSI1PK',
        'GSI1SK',
        `CREATOR_EXTERNAL_ACCOUNT#${creatorIdentityId}`,
        'ASSIGNMENT#',
        'EXTERNAL_ACCOUNT_CREATOR_ASSIGNMENT'
      )
    ]);
    const assignedAccounts = await Promise.all(assignments.map((assignment) => this.getExternalAccount(assignment.externalAccountId)));
    const accounts = [...legacyAccounts, ...assignedAccounts.filter((account): account is ExternalAccount => Boolean(account))];
    return [...new Map(accounts.map((account) => [account.externalAccountId, account])).values()];
  }

  async listExternalAccountsByUser(userId: string): Promise<ExternalAccount[]> {
    return this.listByIndex(
      'GSI2',
      'GSI2PK',
      'GSI2SK',
      `USER_EXTERNAL_ACCOUNT#${userId}`,
      'ACCOUNT#',
      'EXTERNAL_ACCOUNT'
    );
  }

  async getExternalAccount(externalAccountId: string): Promise<ExternalAccount | null> {
    return this.get(`EXTERNAL_ACCOUNT#${externalAccountId}`, 'PROFILE');
  }

  async listExternalAccountCreatorAssignments(externalAccountId: string): Promise<ExternalAccountCreatorAssignment[]> {
    return this.listByPartition(
      `EXTERNAL_ACCOUNT#${externalAccountId}`,
      'CREATOR_ASSIGNMENT#',
      'EXTERNAL_ACCOUNT_CREATOR_ASSIGNMENT'
    );
  }

  async replaceExternalAccountCreatorAssignments(externalAccountId: string, assignments: ExternalAccountCreatorAssignment[]): Promise<void> {
    const existing = await this.listExternalAccountCreatorAssignments(externalAccountId);
    await Promise.all(existing.map((assignment) => this.delete(
      `EXTERNAL_ACCOUNT#${externalAccountId}`,
      `CREATOR_ASSIGNMENT#${assignment.creatorIdentityId}`
    )));
    await Promise.all(assignments.map((assignment) => this.put({
      PK: `EXTERNAL_ACCOUNT#${externalAccountId}`,
      SK: `CREATOR_ASSIGNMENT#${assignment.creatorIdentityId}`,
      GSI1PK: `CREATOR_EXTERNAL_ACCOUNT#${assignment.creatorIdentityId}`,
      GSI1SK: `ASSIGNMENT#${externalAccountId}`,
      GSI2PK: `USER_EXTERNAL_ACCOUNT_ASSIGNMENT#${assignment.userId}`,
      GSI2SK: `ASSIGNMENT#${externalAccountId}#${assignment.creatorIdentityId}`,
      entityType: 'EXTERNAL_ACCOUNT_CREATOR_ASSIGNMENT',
      ...assignment
    })));
  }

  async createExternalAccount(account: ExternalAccount): Promise<void> {
    await this.put({
      PK: `EXTERNAL_ACCOUNT#${account.externalAccountId}`,
      SK: 'PROFILE',
      GSI1PK: `CREATOR_EXTERNAL_ACCOUNT#${account.primaryCreatorIdentityId || account.creatorIdentityId || 'UNASSIGNED'}`,
      GSI1SK: `ACCOUNT#${account.platform}#${account.externalUsername.toLowerCase()}#${account.externalAccountId}`,
      GSI2PK: `USER_EXTERNAL_ACCOUNT#${account.userId}`,
      GSI2SK: `ACCOUNT#${account.platform}#${account.externalUsername.toLowerCase()}#${account.externalAccountId}`,
      entityType: 'EXTERNAL_ACCOUNT',
      ...account
    });
    await this.put({
      PK: `EXTERNAL_ACCOUNT_SCHEDULE#${account.platform}`,
      SK: `ACCOUNT#${account.externalAccountId}`,
      entityType: 'EXTERNAL_ACCOUNT_SCHEDULE',
      externalAccountId: account.externalAccountId,
      connectionStatus: account.connectionStatus,
      lastSuccessfulSyncAt: account.lastSuccessfulSyncAt,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt
    });
  }

  async updateExternalAccount(account: ExternalAccount): Promise<void> {
    await this.createExternalAccount(account);
  }

  async getExternalPlatformCredential(externalPlatformCredentialId: string): Promise<ExternalPlatformCredential | null> {
    return this.get(`EXTERNAL_PLATFORM_CREDENTIAL#${externalPlatformCredentialId}`, 'PROFILE');
  }

  async listExternalPlatformCredentialsByCreatorIdentity(creatorIdentityId: string): Promise<ExternalPlatformCredential[]> {
    return this.listByIndex(
      'GSI1',
      'GSI1PK',
      'GSI1SK',
      `CREATOR_EXTERNAL_PLATFORM_CREDENTIAL#${creatorIdentityId}`,
      'CREDENTIAL#',
      'EXTERNAL_PLATFORM_CREDENTIAL'
    );
  }

  async listExternalPlatformCredentialsByUser(userId: string): Promise<ExternalPlatformCredential[]> {
    return this.listByIndex(
      'GSI2',
      'GSI2PK',
      'GSI2SK',
      `USER_EXTERNAL_PLATFORM_CREDENTIAL#${userId}`,
      'CREDENTIAL#',
      'EXTERNAL_PLATFORM_CREDENTIAL'
    );
  }

  async createExternalPlatformCredential(credential: ExternalPlatformCredential): Promise<void> {
    await this.put({
      PK: `EXTERNAL_PLATFORM_CREDENTIAL#${credential.externalPlatformCredentialId}`,
      SK: 'PROFILE',
      GSI1PK: `CREATOR_EXTERNAL_PLATFORM_CREDENTIAL#${credential.creatorIdentityId || 'ACCOUNT'}`,
      GSI1SK: `CREDENTIAL#${credential.platform}#${credential.externalPlatformCredentialId}`,
      GSI2PK: `USER_EXTERNAL_PLATFORM_CREDENTIAL#${credential.userId}`,
      GSI2SK: `CREDENTIAL#${credential.platform}#${credential.externalPlatformCredentialId}`,
      entityType: 'EXTERNAL_PLATFORM_CREDENTIAL',
      ...credential
    });
  }

  async updateExternalPlatformCredential(credential: ExternalPlatformCredential): Promise<void> {
    await this.createExternalPlatformCredential(credential);
  }

  async deleteExternalPlatformCredential(externalPlatformCredentialId: string): Promise<void> {
    await this.delete(`EXTERNAL_PLATFORM_CREDENTIAL#${externalPlatformCredentialId}`, 'PROFILE');
  }

  async listExternalAccountsForScheduledScan(limit = 100): Promise<ExternalAccount[]> {
    const schedule = await this.listByPartition<{ externalAccountId: string }>(
      'EXTERNAL_ACCOUNT_SCHEDULE#deviantart',
      'ACCOUNT#',
      'EXTERNAL_ACCOUNT_SCHEDULE',
      limit
    );
    const accounts = await Promise.all(schedule.map((item) => this.getExternalAccount(item.externalAccountId)));
    return accounts.filter((account): account is ExternalAccount => Boolean(account));
  }

  async listAssetsByCreatorIdentity(creatorIdentityId: string): Promise<Asset[]> {
    return this.listByIndex(
      'GSI1',
      'GSI1PK',
      'GSI1SK',
      `CREATOR_ASSET#${creatorIdentityId}`,
      'ASSET#',
      'ASSET'
    );
  }

  async getAsset(assetId: string): Promise<Asset | null> {
    return this.get(`ASSET#${assetId}`, 'PROFILE');
  }

  async createAsset(asset: Asset): Promise<void> {
    await this.put({
      PK: `ASSET#${asset.assetId}`,
      SK: 'PROFILE',
      GSI1PK: `CREATOR_ASSET#${asset.creatorIdentityId}`,
      GSI1SK: `ASSET#${asset.updatedAt}#${asset.assetId}`,
      GSI2PK: `USER_ASSET#${asset.userId}`,
      GSI2SK: `ASSET#${asset.updatedAt}#${asset.assetId}`,
      entityType: 'ASSET',
      ...asset
    });
  }

  async updateAsset(asset: Asset): Promise<void> {
    await this.createAsset(asset);
  }

  async getExternalPublication(externalAccountId: string, externalContentId: string): Promise<ExternalPublication | null> {
    return this.get(`EXTERNAL_ACCOUNT#${externalAccountId}`, `PUBLICATION#${externalContentId}`);
  }

  async listExternalPublications(externalAccountId: string): Promise<ExternalPublication[]> {
    const items = await this.listByPartition<ExternalPublication>(
      `EXTERNAL_ACCOUNT#${externalAccountId}`,
      'PUBLICATION#',
      'EXTERNAL_PUBLICATION'
    );
    return items.sort((a, b) => (b.publishedAt || b.createdAt).localeCompare(a.publishedAt || a.createdAt));
  }

  async createExternalPublication(publication: ExternalPublication): Promise<void> {
    await this.put({
      PK: `EXTERNAL_ACCOUNT#${publication.externalAccountId}`,
      SK: `PUBLICATION#${publication.externalContentId}`,
      GSI1PK: `ASSET_PUBLICATION#${publication.assetId}`,
      GSI1SK: `PUBLICATION#${publication.updatedAt}#${publication.externalPublicationId}`,
      GSI2PK: `EXTERNAL_PUBLICATION#${publication.externalPublicationId}`,
      GSI2SK: 'PROFILE',
      entityType: 'EXTERNAL_PUBLICATION',
      ...publication
    });
  }

  async updateExternalPublication(publication: ExternalPublication, previousExternalContentId?: string): Promise<void> {
    if (previousExternalContentId && previousExternalContentId !== publication.externalContentId) {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.tableName,
              Key: {
                PK: `EXTERNAL_ACCOUNT#${publication.externalAccountId}`,
                SK: `PUBLICATION#${previousExternalContentId}`
              }
            }
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                PK: `EXTERNAL_ACCOUNT#${publication.externalAccountId}`,
                SK: `PUBLICATION#${publication.externalContentId}`,
                GSI1PK: `ASSET_PUBLICATION#${publication.assetId}`,
                GSI1SK: `PUBLICATION#${publication.updatedAt}#${publication.externalPublicationId}`,
                GSI2PK: `EXTERNAL_PUBLICATION#${publication.externalPublicationId}`,
                GSI2SK: 'PROFILE',
                entityType: 'EXTERNAL_PUBLICATION',
                ...publication
              }
            }
          }
        ]
      }));
      return;
    }
    await this.createExternalPublication(publication);
  }

  async getSpacePublication(assetId: string): Promise<SpacePublication | null> {
    return this.get(`ASSET#${assetId}`, 'SPACE_PUBLICATION');
  }

  async upsertSpacePublication(publication: SpacePublication): Promise<void> {
    await this.put({
      PK: `ASSET#${publication.assetId}`,
      SK: 'SPACE_PUBLICATION',
      GSI1PK: `SPACE_PUBLICATION#${publication.published ? 'PUBLISHED' : 'DRAFT'}`,
      GSI1SK: `ASSET#${publication.updatedAt}#${publication.assetId}`,
      entityType: 'SPACE_PUBLICATION',
      ...publication
    });
  }

  async listExternalCollections(externalAccountId: string): Promise<ExternalCollection[]> {
    const items = await this.listByPartition<ExternalCollection>(
      `EXTERNAL_ACCOUNT#${externalAccountId}`,
      'EXTERNAL_COLLECTION#',
      'EXTERNAL_COLLECTION'
    );
    return items.sort((a, b) => (a.position || 0) - (b.position || 0) || a.name.localeCompare(b.name));
  }

  async createExternalCollection(collection: ExternalCollection): Promise<void> {
    await this.put({
      PK: `EXTERNAL_ACCOUNT#${collection.externalAccountId}`,
      SK: `EXTERNAL_COLLECTION#${collection.externalCollectionExternalId}`,
      GSI1PK: `EXTERNAL_COLLECTION#${collection.externalCollectionId}`,
      GSI1SK: 'PROFILE',
      GSI2PK: `EXTERNAL_COLLECTION_EXTERNAL#${collection.platform}#${collection.externalAccountId}`,
      GSI2SK: `COLLECTION#${collection.externalCollectionExternalId}`,
      entityType: 'EXTERNAL_COLLECTION',
      ...collection
    });
  }

  async updateExternalCollection(collection: ExternalCollection): Promise<void> {
    await this.createExternalCollection(collection);
  }

  async listUbeeqCollectionsByCreatorIdentity(creatorIdentityId: string): Promise<UbeeqCollection[]> {
    const items = await this.listByIndex<UbeeqCollection>(
      'GSI1',
      'GSI1PK',
      'GSI1SK',
      `CREATOR_UBEEQ_COLLECTION#${creatorIdentityId}`,
      'COLLECTION#',
      'UBEEQ_COLLECTION'
    );
    return items.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  async createUbeeqCollection(collection: UbeeqCollection): Promise<void> {
    await this.put({
      PK: `UBEEQ_COLLECTION#${collection.ubeeqCollectionId}`,
      SK: 'PROFILE',
      GSI1PK: `CREATOR_UBEEQ_COLLECTION#${collection.creatorIdentityId}`,
      GSI1SK: `COLLECTION#${collection.position.toString().padStart(8, '0')}#${collection.ubeeqCollectionId}`,
      GSI2PK: `USER_UBEEQ_COLLECTION#${collection.userId}`,
      GSI2SK: `COLLECTION#${collection.updatedAt}#${collection.ubeeqCollectionId}`,
      entityType: 'UBEEQ_COLLECTION',
      ...collection
    });
  }

  async updateUbeeqCollection(collection: UbeeqCollection): Promise<void> {
    await this.createUbeeqCollection(collection);
  }

  async listUbeeqCollectionAssets(ubeeqCollectionId: string): Promise<UbeeqCollectionAsset[]> {
    return this.listByPartition(`UBEEQ_COLLECTION#${ubeeqCollectionId}`, 'ASSET#', 'UBEEQ_COLLECTION_ASSET');
  }

  async replaceUbeeqCollectionAssets(ubeeqCollectionId: string, assets: UbeeqCollectionAsset[]): Promise<void> {
    const existing = await this.listUbeeqCollectionAssets(ubeeqCollectionId);
    await Promise.all(existing.map((item) => this.delete(`UBEEQ_COLLECTION#${ubeeqCollectionId}`, `ASSET#${item.assetId}`)));
    await Promise.all(assets.map((item) => this.put({
      PK: `UBEEQ_COLLECTION#${item.ubeeqCollectionId}`,
      SK: `ASSET#${item.assetId}`,
      GSI1PK: `ASSET_UBEEQ_COLLECTION#${item.assetId}`,
      GSI1SK: `COLLECTION#${item.ubeeqCollectionId}`,
      entityType: 'UBEEQ_COLLECTION_ASSET',
      ...item
    })));
  }

  async listExternalCollectionMappings(externalAccountId: string): Promise<ExternalCollectionMapping[]> {
    return this.listByPartition(
      `EXTERNAL_ACCOUNT#${externalAccountId}`,
      'COLLECTION_MAPPING#',
      'EXTERNAL_COLLECTION_MAPPING'
    );
  }

  async createExternalCollectionMapping(mapping: ExternalCollectionMapping): Promise<void> {
    await this.put({
      PK: `EXTERNAL_ACCOUNT#${mapping.externalAccountId}`,
      SK: `COLLECTION_MAPPING#${mapping.externalCollectionId}`,
      GSI1PK: `UBEEQ_COLLECTION_MAPPING#${mapping.ubeeqCollectionId}`,
      GSI1SK: `MAPPING#${mapping.externalCollectionMappingId}`,
      GSI2PK: `EXTERNAL_COLLECTION_MAPPING#${mapping.externalCollectionMappingId}`,
      GSI2SK: 'PROFILE',
      entityType: 'EXTERNAL_COLLECTION_MAPPING',
      ...mapping
    });
  }

  async updateExternalCollectionMapping(mapping: ExternalCollectionMapping): Promise<void> {
    await this.createExternalCollectionMapping(mapping);
  }

  async listExternalEngagementSnapshots(externalPublicationId: string, limit = 100): Promise<ExternalEngagementSnapshot[]> {
    const items = await this.listByPartition<ExternalEngagementSnapshot>(
      `EXTERNAL_PUBLICATION#${externalPublicationId}`,
      'ENGAGEMENT#',
      'EXTERNAL_ENGAGEMENT_SNAPSHOT',
      limit
    );
    return items.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }

  async createExternalEngagementSnapshot(snapshot: ExternalEngagementSnapshot): Promise<void> {
    await this.put({
      PK: `EXTERNAL_PUBLICATION#${snapshot.externalPublicationId}`,
      SK: `ENGAGEMENT#${snapshot.capturedAt}#${snapshot.externalEngagementSnapshotId}`,
      entityType: 'EXTERNAL_ENGAGEMENT_SNAPSHOT',
      ...snapshot
    });
  }

  async listExternalComments(externalPublicationId: string, limit = 100): Promise<ExternalComment[]> {
    const items = await this.listByPartition<ExternalComment>(
      `EXTERNAL_PUBLICATION#${externalPublicationId}`,
      'COMMENT#',
      'EXTERNAL_COMMENT',
      limit
    );
    return items.sort((a, b) => (b.createdAtRemote || b.lastSyncedAt).localeCompare(a.createdAtRemote || a.lastSyncedAt));
  }

  async createExternalComment(comment: ExternalComment): Promise<void> {
    await this.put({
      PK: `EXTERNAL_PUBLICATION#${comment.externalPublicationId}`,
      SK: `COMMENT#${comment.externalCommentExternalId}`,
      GSI1PK: `EXTERNAL_COMMENT#${comment.externalCommentId}`,
      GSI1SK: 'PROFILE',
      entityType: 'EXTERNAL_COMMENT',
      ...comment
    });
  }

  async updateExternalComment(comment: ExternalComment): Promise<void> {
    await this.createExternalComment(comment);
  }

  async getExternalSyncJob(externalSyncJobId: string): Promise<ExternalSyncJob | null> {
    const items = await this.listByIndex<ExternalSyncJob>(
      'GSI1',
      'GSI1PK',
      'GSI1SK',
      `EXTERNAL_SYNC_JOB#${externalSyncJobId}`,
      'PROFILE',
      'EXTERNAL_SYNC_JOB',
      1
    );
    return items[0] || null;
  }

  async listExternalSyncJobs(externalAccountId: string, limit = 100): Promise<ExternalSyncJob[]> {
    const items = await this.listByPartition<ExternalSyncJob>(
      `EXTERNAL_ACCOUNT#${externalAccountId}`,
      'SYNC_JOB#',
      'EXTERNAL_SYNC_JOB',
      limit
    );
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listDueExternalSyncJobs(now: string, limit = 100): Promise<ExternalSyncJob[]> {
    const statuses = ['retry_scheduled', 'rate_limited'];
    const pages = await Promise.all(statuses.map(async (status) => {
      const response = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK <= :now',
        ExpressionAttributeValues: {
          ':pk': `EXTERNAL_SYNC_JOB_STATUS#${status}`,
          ':now': `JOB#${now}~`
        },
        Limit: limit
      }));
      return (response.Items || [])
        .filter((item) => item.entityType === 'EXTERNAL_SYNC_JOB')
        .map((item) => stripEntityFields<ExternalSyncJob>(item))
        .filter((item) => item.nextAttemptAt && item.nextAttemptAt <= now);
    }));
    return pages.flat()
      .sort((a, b) => String(a.nextAttemptAt).localeCompare(String(b.nextAttemptAt)))
      .slice(0, limit);
  }

  async createExternalSyncJob(job: ExternalSyncJob): Promise<void> {
    await this.put({
      PK: `EXTERNAL_ACCOUNT#${job.externalAccountId}`,
      SK: `SYNC_JOB#${job.externalSyncJobId}`,
      GSI1PK: `EXTERNAL_SYNC_JOB#${job.externalSyncJobId}`,
      GSI1SK: 'PROFILE',
      GSI2PK: `EXTERNAL_SYNC_JOB_STATUS#${job.status}`,
      GSI2SK: `JOB#${job.nextAttemptAt || job.createdAt}#${job.externalSyncJobId}`,
      entityType: 'EXTERNAL_SYNC_JOB',
      ...job
    });
  }

  async updateExternalSyncJob(job: ExternalSyncJob): Promise<void> {
    await this.createExternalSyncJob(job);
  }

  async listExternalSyncLogs(externalSyncJobId: string, limit = 100): Promise<ExternalSyncLog[]> {
    const items = await this.listByPartition<ExternalSyncLog>(
      `EXTERNAL_SYNC_JOB#${externalSyncJobId}`,
      'LOG#',
      'EXTERNAL_SYNC_LOG',
      limit
    );
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async appendExternalSyncLog(log: ExternalSyncLog): Promise<void> {
    await this.put({
      PK: `EXTERNAL_SYNC_JOB#${log.externalSyncJobId}`,
      SK: `LOG#${log.createdAt}#${log.externalSyncLogId}`,
      entityType: 'EXTERNAL_SYNC_LOG',
      ...log
    });
  }
}
