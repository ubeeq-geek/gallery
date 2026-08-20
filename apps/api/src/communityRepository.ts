import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { CommunityDelivery, CommunityDestination, CommunityEvent, CommunityInstallation } from './domain';

const clean = <T>(item: Record<string, unknown>): T => {
  const value = { ...item };
  for (const key of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'entityType']) delete value[key];
  return value as T;
};

/** Durable storage for native community delivery integrations. */
export class CommunityRepository {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string) {}

  private async put(item: Record<string, unknown>): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  private async get<T>(PK: string, SK: string): Promise<T | null> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK, SK } }));
    return result.Item ? clean<T>(result.Item) : null;
  }

  private async list<T>(index: 'PK' | 'GSI1' | 'GSI2', key: string, prefix: string, entityType: string, limit = 100): Promise<T[]> {
    const items: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        ...(index === 'PK' ? {} : { IndexName: index }),
        KeyConditionExpression: `${index === 'PK' ? 'PK' : `${index}PK`} = :pk AND begins_with(${index === 'PK' ? 'SK' : `${index}SK`}, :sk)`,
        ExpressionAttributeValues: { ':pk': key, ':sk': prefix },
        Limit: Math.min(1000, limit - items.length),
        ExclusiveStartKey
      }));
      items.push(...(result.Items || []).filter((item) => item.entityType === entityType).map((item) => clean<T>(item)));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey && items.length < limit);
    return items;
  }

  async listCommunityInstallationsByUser(userId: string): Promise<CommunityInstallation[]> {
    return (await this.list<CommunityInstallation>('PK', `USER#${userId}`, 'COMMUNITY_INSTALLATION#', 'COMMUNITY_INSTALLATION'))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async getCommunityInstallation(communityInstallationId: string): Promise<CommunityInstallation | null> {
    const result = await this.list<CommunityInstallation>('GSI1', `COMMUNITY_INSTALLATION#${communityInstallationId}`, 'PROFILE', 'COMMUNITY_INSTALLATION', 1);
    return result[0] || null;
  }

  async upsertCommunityInstallation(installation: CommunityInstallation): Promise<void> {
    await this.put({
      PK: `USER#${installation.userId}`,
      SK: `COMMUNITY_INSTALLATION#${installation.provider}#${installation.communityInstallationId}`,
      GSI1PK: `COMMUNITY_INSTALLATION#${installation.communityInstallationId}`,
      GSI1SK: 'PROFILE',
      entityType: 'COMMUNITY_INSTALLATION',
      ...installation
    });
  }

  async deleteCommunityInstallation(communityInstallationId: string): Promise<void> {
    const installation = await this.getCommunityInstallation(communityInstallationId);
    if (!installation) return;
    // Destinations are children of an installation rather than of a user. Remove
    // them explicitly so a disconnected Discord server cannot leave an active
    // channel destination behind.
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const children = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `COMMUNITY_INSTALLATION#${communityInstallationId}`,
          ':sk': 'DESTINATION#'
        },
        ExclusiveStartKey
      }));
      await Promise.all((children.Items || []).map((item) => this.client.send(new DeleteCommand({
        TableName: this.tableName,
        Key: { PK: item.PK, SK: item.SK }
      }))));
      ExclusiveStartKey = children.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: {
      PK: `USER#${installation.userId}`,
      SK: `COMMUNITY_INSTALLATION#${installation.provider}#${installation.communityInstallationId}`
    }}));
  }

  async listCommunityDestinationsByCreator(creatorIdentityId: string): Promise<CommunityDestination[]> {
    return (await this.list<CommunityDestination>('GSI2', `COMMUNITY_CREATOR#${creatorIdentityId}`, 'DESTINATION#', 'COMMUNITY_DESTINATION'))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async getCommunityDestination(communityDestinationId: string): Promise<CommunityDestination | null> {
    const result = await this.list<CommunityDestination>('GSI1', `COMMUNITY_DESTINATION#${communityDestinationId}`, 'PROFILE', 'COMMUNITY_DESTINATION', 1);
    return result[0] || null;
  }

  async upsertCommunityDestination(destination: CommunityDestination): Promise<void> {
    await this.put({
      PK: `COMMUNITY_INSTALLATION#${destination.communityInstallationId}`,
      SK: `DESTINATION#${destination.communityDestinationId}`,
      GSI1PK: `COMMUNITY_DESTINATION#${destination.communityDestinationId}`,
      GSI1SK: 'PROFILE',
      GSI2PK: `COMMUNITY_CREATOR#${destination.creatorIdentityId}`,
      GSI2SK: `DESTINATION#${destination.updatedAt}#${destination.communityDestinationId}`,
      // GSI1 is retained for direct addressability; a creator list uses GSI2.
      entityType: 'COMMUNITY_DESTINATION',
      ...destination
    });
  }

  async deleteCommunityDestination(communityDestinationId: string): Promise<void> {
    const destination = await this.getCommunityDestination(communityDestinationId);
    if (!destination) return;
    await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: {
      PK: `COMMUNITY_INSTALLATION#${destination.communityInstallationId}`,
      SK: `DESTINATION#${destination.communityDestinationId}`
    }}));
  }

  async getCommunityEventByIdempotency(tenantId: string, idempotencyKey: string): Promise<CommunityEvent | null> {
    return this.get<CommunityEvent>(`TENANT#${tenantId}#COMMUNITY_EVENT_KEY#${idempotencyKey}`, 'PROFILE');
  }

  async getCommunityEvent(communityEventId: string): Promise<CommunityEvent | null> {
    const result = await this.list<CommunityEvent>('GSI1', `COMMUNITY_EVENT#${communityEventId}`, 'PROFILE', 'COMMUNITY_EVENT', 1);
    return result[0] || null;
  }

  async createCommunityEvent(event: CommunityEvent): Promise<void> {
    await this.put({
      PK: `TENANT#${event.tenantId}#COMMUNITY_EVENT_KEY#${event.idempotencyKey}`,
      SK: 'PROFILE',
      GSI1PK: `COMMUNITY_EVENT#${event.communityEventId}`,
      GSI1SK: 'PROFILE',
      entityType: 'COMMUNITY_EVENT',
      ...event
    });
  }

  async getCommunityDelivery(communityDeliveryId: string): Promise<CommunityDelivery | null> {
    const result = await this.list<CommunityDelivery>('GSI1', `COMMUNITY_DELIVERY#${communityDeliveryId}`, 'PROFILE', 'COMMUNITY_DELIVERY', 1);
    return result[0] || null;
  }

  async listCommunityDeliveriesByCreator(creatorIdentityId: string, limit = 100): Promise<CommunityDelivery[]> {
    // Deliveries are indexed by creator on GSI2 to preserve the destination's GSI1 identity lookup.
    const items: CommunityDelivery[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName, IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :sk)',
        ExpressionAttributeValues: { ':pk': `COMMUNITY_CREATOR_DELIVERY#${creatorIdentityId}`, ':sk': 'DELIVERY#' },
        Limit: Math.min(1000, limit - items.length), ExclusiveStartKey
      }));
      items.push(...(result.Items || []).filter((item) => item.entityType === 'COMMUNITY_DELIVERY').map((item) => clean<CommunityDelivery>(item)));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey && items.length < limit);
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async upsertCommunityDelivery(delivery: CommunityDelivery): Promise<void> {
    await this.put({
      PK: `COMMUNITY_EVENT#${delivery.communityEventId}`,
      SK: `DELIVERY#${delivery.communityDeliveryId}`,
      GSI1PK: `COMMUNITY_DELIVERY#${delivery.communityDeliveryId}`,
      GSI1SK: 'PROFILE',
      GSI2PK: `COMMUNITY_CREATOR_DELIVERY#${delivery.creatorIdentityId}`,
      GSI2SK: `DELIVERY#${delivery.updatedAt}#${delivery.communityDeliveryId}`,
      entityType: 'COMMUNITY_DELIVERY',
      ...delivery
    });
  }
}
