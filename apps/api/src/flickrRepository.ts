import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AppConfig } from './config';
import { InMemoryFlickrRepository, type FlickrConnection, type FlickrMigration, type FlickrOAuthRequest, type FlickrRepository } from './flickrIntegration';

const clean = <T>(item?: Record<string, unknown>): T | undefined => {
  if (!item) return undefined;
  const value = { ...item };
  for (const key of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'entityType', 'expiresAtEpoch']) delete value[key];
  return value as T;
};

/** Durable Flickr control-plane records in the portable content-core table. */
export class DynamoFlickrRepository implements FlickrRepository {
  private prefix: string;
  constructor(private client: DynamoDBDocumentClient, private tableName: string, tenantId: string) {
    this.prefix = `TENANT#${tenantId}`;
  }
  private async put(item: Record<string, unknown>) { await this.client.send(new PutCommand({ TableName: this.tableName, Item: item })); }
  private async get<T>(PK: string) {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK, SK: 'PROFILE' } }));
    return clean<T>(result.Item);
  }
  async putConnection(value: FlickrConnection) { await this.put({ PK: `${this.prefix}#FLICKR_CONNECTION#${value.connectionId}`, SK: 'PROFILE', entityType: 'FLICKR_CONNECTION', ...value }); }
  getConnection(id: string) { return this.get<FlickrConnection>(`${this.prefix}#FLICKR_CONNECTION#${id}`); }
  async putMigration(value: FlickrMigration) { await this.put({ PK: `${this.prefix}#FLICKR_MIGRATION#${value.migrationId}`, SK: 'PROFILE',
    GSI1PK: `${this.prefix}#FLICKR_CONNECTION_MIGRATION#${value.connectionId}`, GSI1SK: `MIGRATION#${value.updatedAt}#${value.migrationId}`, entityType: 'FLICKR_MIGRATION', ...value }); }
  getMigration(id: string) { return this.get<FlickrMigration>(`${this.prefix}#FLICKR_MIGRATION#${id}`); }
  async getMigrationByConnection(connectionId: string) {
    const result = await this.client.send(new QueryCommand({ TableName: this.tableName, IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)', ExpressionAttributeValues: {
        ':pk': `${this.prefix}#FLICKR_CONNECTION_MIGRATION#${connectionId}`, ':sk': 'MIGRATION#'
      }, ScanIndexForward: false, Limit: 1 }));
    return clean<FlickrMigration>(result.Items?.[0]);
  }
  async putOAuthRequest(value: FlickrOAuthRequest) { await this.put({ PK: `${this.prefix}#FLICKR_OAUTH#${value.requestToken}`, SK: 'PROFILE',
    entityType: 'FLICKR_OAUTH_REQUEST', expiresAtEpoch: Math.floor(new Date(value.expiresAt).getTime() / 1000), ...value }); }
  async takeOAuthRequest(requestToken: string) {
    const result = await this.client.send(new DeleteCommand({ TableName: this.tableName,
      Key: { PK: `${this.prefix}#FLICKR_OAUTH#${requestToken}`, SK: 'PROFILE' }, ReturnValues: 'ALL_OLD' }));
    return clean<FlickrOAuthRequest>(result.Attributes);
  }
}

export const createFlickrRepository = (config: AppConfig): FlickrRepository => config.useContentCoreTable
  ? new DynamoFlickrRepository(DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion })), config.contentCoreTable, config.tenantId)
  : new InMemoryFlickrRepository();
