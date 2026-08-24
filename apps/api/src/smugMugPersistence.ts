import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import type { SmugMugCredentialVault } from './smugMugGateway';
import type { SmugMugConnection, SmugMugMigration, SmugMugMigrationItem, SmugMugRemoteCollection, SmugMugRemoteImage, SmugMugRepository } from './smugMugIntegration';

/** DynamoDB persistence for resumable migrations. All records live in the content-core table. */
export class DynamoSmugMugRepository implements SmugMugRepository {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string) {}

  private async put(PK: string, SK: string, entityType: string, value: unknown) {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK, SK, entityType, value } }));
  }
  private async get<T>(PK: string, SK: string): Promise<T | undefined> {
    const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK, SK } }));
    return response.Item?.value as T | undefined;
  }
  private async list<T>(PK: string, prefix: string): Promise<T[]> {
    const values: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(new QueryCommand({
        TableName: this.tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': PK, ':sk': prefix }, ExclusiveStartKey
      }));
      values.push(...(response.Items || []).map((item) => item.value as T));
      ExclusiveStartKey = response.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return values;
  }
  private async putAll<T>(values: T[], write: (value: T) => Promise<void>) {
    for (let offset = 0; offset < values.length; offset += 20) await Promise.all(values.slice(offset, offset + 20).map(write));
  }

  async putConnection(value: SmugMugConnection) {
    await Promise.all([
      this.put(`SMUGMUG_CONNECTION#${value.id}`, 'PROFILE', 'SMUGMUG_CONNECTION', value),
      this.put(`SMUGMUG_OAUTH_STATE#${value.oauthState}`, 'CONNECTION', 'SMUGMUG_OAUTH_STATE', { connectionId: value.id })
    ]);
  }
  getConnection(id: string) { return this.get<SmugMugConnection>(`SMUGMUG_CONNECTION#${id}`, 'PROFILE'); }
  async findAuthorizingConnection(state: string) {
    const lookup = await this.get<{ connectionId: string }>(`SMUGMUG_OAUTH_STATE#${state}`, 'CONNECTION');
    const connection = lookup ? await this.getConnection(lookup.connectionId) : undefined;
    return connection?.state === 'AUTHORIZING' ? connection : undefined;
  }
  putMigration(value: SmugMugMigration) { return this.put(`SMUGMUG_MIGRATION#${value.id}`, 'PROFILE', 'SMUGMUG_MIGRATION', value); }
  getMigration(id: string) { return this.get<SmugMugMigration>(`SMUGMUG_MIGRATION#${id}`, 'PROFILE'); }
  async mergeCollections(id: string, values: SmugMugRemoteCollection[]) { await this.putAll(values, (value) => this.put(`SMUGMUG_CONNECTION#${id}`, `COLLECTION#${value.remoteId}`, 'SMUGMUG_EXTERNAL_COLLECTION', value)); }
  getCollections(id: string) { return this.list<SmugMugRemoteCollection>(`SMUGMUG_CONNECTION#${id}`, 'COLLECTION#'); }
  async mergeImages(id: string, values: SmugMugRemoteImage[]) { await this.putAll(values, (value) => this.put(`SMUGMUG_CONNECTION#${id}`, `IMAGE#${value.remoteId}`, 'SMUGMUG_REMOTE_IMAGE', value)); }
  getImages(id: string) { return this.list<SmugMugRemoteImage>(`SMUGMUG_CONNECTION#${id}`, 'IMAGE#'); }
  async putItems(id: string, values: SmugMugMigrationItem[]) { await this.putAll(values, (value) => this.put(`SMUGMUG_MIGRATION#${id}`, `ITEM#${value.remoteId}`, 'SMUGMUG_MIGRATION_ITEM', value)); }
  getItems(id: string) { return this.list<SmugMugMigrationItem>(`SMUGMUG_MIGRATION#${id}`, 'ITEM#'); }
}

/** Encrypted OAuth token storage. The credential record is independently replaceable/deletable. */
export class DynamoSmugMugCredentialVault implements SmugMugCredentialVault {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string, private readonly encryptionKey: string) {}
  async put(credential: { token: string; tokenSecret: string }) {
    const reference = randomUUID();
    await this.write(reference, credential);
    return reference;
  }
  async get(reference: string) {
    const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: `SMUGMUG_CREDENTIAL#${reference}`, SK: 'SECRET' } }));
    const encrypted = response.Item?.encryptedCredential;
    if (typeof encrypted !== 'string') return undefined;
    return JSON.parse(decryptExternalCredential(encrypted, this.encryptionKey)) as { token: string; tokenSecret: string };
  }
  async replace(reference: string, credential: { token: string; tokenSecret: string }) { await this.write(reference, credential); return reference; }
  async delete(reference: string) { await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { PK: `SMUGMUG_CREDENTIAL#${reference}`, SK: 'SECRET' } })); }
  private async write(reference: string, credential: { token: string; tokenSecret: string }) {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: {
      PK: `SMUGMUG_CREDENTIAL#${reference}`, SK: 'SECRET', entityType: 'SMUGMUG_CREDENTIAL',
      encryptedCredential: encryptExternalCredential(JSON.stringify(credential), this.encryptionKey), updatedAt: new Date().toISOString()
    } }));
  }
}
