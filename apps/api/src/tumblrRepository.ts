import { createHash, randomUUID } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import { nativeConnectionHealth } from './integrationAccountHealth';
import type { TumblrApplicationCredentials, TumblrBlogDestination, TumblrConnector, TumblrOAuthState, TumblrPublication } from './tumblrIntegration';
import { issueTumblrOAuthState, verifyTumblrOAuthState } from './tumblrIntegration';

export interface TumblrOAuthStateRecord {
  nonceHash: string;
  tenantId: string;
  userId: string;
  creatorId: string;
  connectorId: string;
  expiresAt: number;
  consumedAt?: string;
  ttlEpochSeconds?: number;
}

export interface TumblrRepository {
  listConnectors(tenantId: string, userId: string, creatorId: string): Promise<TumblrConnector[]>;
  getConnector(tenantId: string, connectorId: string): Promise<TumblrConnector | null>;
  putConnector(connector: TumblrConnector): Promise<void>;
  deleteConnector(tenantId: string, connectorId: string): Promise<void>;
  listDestinations(tenantId: string, connectorId: string): Promise<TumblrBlogDestination[]>;
  getDestination(tenantId: string, destinationId: string): Promise<TumblrBlogDestination | null>;
  putDestination(destination: TumblrBlogDestination): Promise<void>;
  listPublications(tenantId: string, workId: string): Promise<TumblrPublication[]>;
  getPublication(tenantId: string, publicationId: string): Promise<TumblrPublication | null>;
  putPublication(publication: TumblrPublication): Promise<void>;
  putOAuthState(record: TumblrOAuthStateRecord): Promise<void>;
  consumeOAuthState(nonceHash: string, now: number): Promise<TumblrOAuthStateRecord | null>;
  consumeQuota(consumerKey: string, now: Date, hourlyLimit: number, dailyLimit: number): Promise<boolean>;
}

const nonceHash = (nonce: string) => createHash('sha256').update(nonce).digest('base64url');

/** Issues and atomically consumes OAuth state, preventing callback replay. */
export class TumblrOAuthStateService {
  constructor(private readonly repository: TumblrRepository, private readonly signingSecret: string) {}

  async issue(context: Omit<TumblrOAuthState, 'expiresAt' | 'nonce'> & { tenantId: string }, ttlSeconds = 600, now = Date.now()): Promise<string> {
    const token = issueTumblrOAuthState(context, this.signingSecret, ttlSeconds, now);
    const state = verifyTumblrOAuthState(token, this.signingSecret, now);
    await this.repository.putOAuthState({ nonceHash: nonceHash(state.nonce), ...context, expiresAt: state.expiresAt, ttlEpochSeconds: Math.ceil(state.expiresAt / 1000) + 3600 });
    return token;
  }

  async consume(token: string, expected: { tenantId: string; userId: string }, now = Date.now()): Promise<TumblrOAuthState> {
    const state = verifyTumblrOAuthState(token, this.signingSecret, now);
    if (state.userId !== expected.userId) throw new Error('Tumblr OAuth state belongs to another user.');
    const record = await this.repository.consumeOAuthState(nonceHash(state.nonce), now);
    if (!record || record.tenantId !== expected.tenantId || record.userId !== state.userId || record.creatorId !== state.creatorId || record.connectorId !== state.connectorId) {
      throw new Error('Tumblr OAuth state is invalid or has already been used.');
    }
    return state;
  }
}

interface StoredCreatorApplication { clientId: string; clientSecret: string; redirectUri: string }
export interface TumblrOAuthGrant { accessToken: string; refreshToken?: string; expiresAt?: string; scopes: string[] }

/** The only conversion point between plaintext creator credentials and encrypted persistence. */
export const encryptTumblrCreatorApplication = (credentials: TumblrApplicationCredentials, encryptionSecret: string): TumblrConnector['creatorApplicationEncrypted'] => ({
  clientId: encryptExternalCredential(credentials.clientId, encryptionSecret),
  clientSecret: encryptExternalCredential(credentials.clientSecret, encryptionSecret),
  redirectUri: encryptExternalCredential(credentials.redirectUri, encryptionSecret)
});

export const decryptTumblrCreatorApplication = (connector: TumblrConnector, encryptionSecret: string): TumblrApplicationCredentials => {
  if (connector.ownership !== 'creator_owned' || !connector.creatorApplicationEncrypted?.clientId || !connector.creatorApplicationEncrypted.clientSecret || !connector.creatorApplicationEncrypted.redirectUri) {
    throw new Error('Creator-owned Tumblr application credentials are unavailable.');
  }
  const stored: StoredCreatorApplication = {
    clientId: decryptExternalCredential(connector.creatorApplicationEncrypted.clientId, encryptionSecret),
    clientSecret: decryptExternalCredential(connector.creatorApplicationEncrypted.clientSecret, encryptionSecret),
    redirectUri: decryptExternalCredential(connector.creatorApplicationEncrypted.redirectUri, encryptionSecret)
  };
  return stored;
};

export const encryptTumblrOAuthGrant = (grant: TumblrOAuthGrant, encryptionSecret: string): Record<string, unknown> => ({
  accessToken: encryptExternalCredential(grant.accessToken, encryptionSecret),
  ...(grant.refreshToken ? { refreshToken: encryptExternalCredential(grant.refreshToken, encryptionSecret) } : {}),
  ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
  scopes: [...grant.scopes]
});

export const decryptTumblrOAuthGrant = (connector: TumblrConnector, encryptionSecret: string): TumblrOAuthGrant => {
  const stored = connector.credentialsEncrypted;
  if (typeof stored.accessToken !== 'string') throw new Error('Tumblr OAuth credentials are unavailable.');
  return {
    accessToken: decryptExternalCredential(stored.accessToken, encryptionSecret),
    ...(typeof stored.refreshToken === 'string' ? { refreshToken: decryptExternalCredential(stored.refreshToken, encryptionSecret) } : {}),
    ...(typeof stored.expiresAt === 'string' ? { expiresAt: stored.expiresAt } : {}),
    scopes: Array.isArray(stored.scopes) ? stored.scopes.filter((scope): scope is string => typeof scope === 'string') : []
  };
};

export const publicTumblrConnector = (connector: TumblrConnector): Omit<TumblrConnector, 'creatorApplicationEncrypted' | 'credentialsEncrypted'> & { hasCreatorApplication: boolean; hasOAuthGrant: boolean; health: ReturnType<typeof nativeConnectionHealth> } => {
  const { creatorApplicationEncrypted, credentialsEncrypted, ...safe } = connector;
  return {
    ...safe,
    hasCreatorApplication: Boolean(creatorApplicationEncrypted?.clientId && creatorApplicationEncrypted.clientSecret),
    hasOAuthGrant: Object.keys(credentialsEncrypted).length > 0,
    health: nativeConnectionHealth({ platform: 'tumblr', state: connector.status, connectedStates: ['connected'], reauthorizationStates: ['revoked', 'failed'], lastAttemptAt: connector.lastValidatedAt })
  };
};

export class InMemoryTumblrRepository implements TumblrRepository {
  connectors: TumblrConnector[] = [];
  destinations: TumblrBlogDestination[] = [];
  publications: TumblrPublication[] = [];
  oauthStates: TumblrOAuthStateRecord[] = [];
  quotaBuckets = new Map<string, number>();
  async listConnectors(tenantId: string, userId: string, creatorId: string) { return this.connectors.filter((item) => item.tenantId === tenantId && item.userId === userId && item.creatorId === creatorId); }
  async getConnector(tenantId: string, id: string) { return this.connectors.find((item) => item.tenantId === tenantId && item.id === id) || null; }
  async putConnector(value: TumblrConnector) { this.connectors = [...this.connectors.filter((item) => !(item.tenantId === value.tenantId && item.id === value.id)), value]; }
  async deleteConnector(tenantId: string, id: string) { this.connectors = this.connectors.filter((item) => !(item.tenantId === tenantId && item.id === id)); }
  async listDestinations(tenantId: string, connectorId: string) { return this.destinations.filter((item) => item.tenantId === tenantId && item.connectorId === connectorId); }
  async getDestination(tenantId: string, id: string) { return this.destinations.find((item) => item.tenantId === tenantId && item.id === id) || null; }
  async putDestination(value: TumblrBlogDestination) { this.destinations = [...this.destinations.filter((item) => !(item.tenantId === value.tenantId && item.id === value.id)), value]; }
  async listPublications(tenantId: string, workId: string) { return this.publications.filter((item) => item.tenantId === tenantId && item.workId === workId); }
  async getPublication(tenantId: string, id: string) { return this.publications.find((item) => item.tenantId === tenantId && item.id === id) || null; }
  async putPublication(value: TumblrPublication) { this.publications = [...this.publications.filter((item) => !(item.tenantId === value.tenantId && item.id === value.id)), value]; }
  async putOAuthState(value: TumblrOAuthStateRecord) { this.oauthStates.push(value); }
  async consumeOAuthState(hash: string, now: number) {
    const state = this.oauthStates.find((item) => item.nonceHash === hash && !item.consumedAt && item.expiresAt >= now);
    if (!state) return null;
    state.consumedAt = new Date(now).toISOString();
    return { ...state };
  }
  async consumeQuota(consumerKey: string, now: Date, hourlyLimit: number, dailyLimit: number) {
    const hash = nonceHash(consumerKey);
    const hour = `${hash}#HOUR#${now.toISOString().slice(0, 13)}`;
    const day = `${hash}#DAY#${now.toISOString().slice(0, 10)}`;
    if ((this.quotaBuckets.get(hour) || 0) >= hourlyLimit || (this.quotaBuckets.get(day) || 0) >= dailyLimit) return false;
    this.quotaBuckets.set(hour, (this.quotaBuckets.get(hour) || 0) + 1);
    this.quotaBuckets.set(day, (this.quotaBuckets.get(day) || 0) + 1);
    return true;
  }
}

const clean = <T>(item: Record<string, unknown>): T => {
  const value = { ...item };
  for (const key of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'entityType']) delete value[key];
  return value as T;
};
const tenantKey = (tenantId: string) => `TENANT#${tenantId}`;

export class DynamoTumblrRepository implements TumblrRepository {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string) {}
  private async get<T>(pk: string): Promise<T | null> { const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: pk, SK: 'PROFILE' } })); return result.Item ? clean<T>(result.Item) : null; }
  private async query<T>(pk: string, prefix: string): Promise<T[]> { const result = await this.client.send(new QueryCommand({ TableName: this.tableName, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)', ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix } })); return (result.Items || []).map((item) => clean<T>(item)); }
  async listConnectors(tenantId: string, userId: string, creatorId: string) { return (await this.query<TumblrConnector>(`${tenantKey(tenantId)}#TUMBLR_CREATOR#${creatorId}`, 'CONNECTOR#')).filter((item) => item.userId === userId); }
  async getConnector(tenantId: string, id: string) { return this.get<TumblrConnector>(`${tenantKey(tenantId)}#TUMBLR_CONNECTOR#${id}`); }
  async putConnector(value: TumblrConnector) { await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK: `${tenantKey(value.tenantId)}#TUMBLR_CONNECTOR#${value.id}`, SK: 'PROFILE', GSI1PK: `${tenantKey(value.tenantId)}#TUMBLR_CREATOR#${value.creatorId}`, GSI1SK: `CONNECTOR#${value.id}`, entityType: 'TUMBLR_CONNECTOR', ...value } })); }
  async deleteConnector(tenantId: string, id: string) { await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { PK: `${tenantKey(tenantId)}#TUMBLR_CONNECTOR#${id}`, SK: 'PROFILE' } })); }
  async listDestinations(tenantId: string, connectorId: string) { return this.query<TumblrBlogDestination>(`${tenantKey(tenantId)}#TUMBLR_DESTINATIONS#${connectorId}`, 'DESTINATION#'); }
  async getDestination(tenantId: string, id: string) { return this.get<TumblrBlogDestination>(`${tenantKey(tenantId)}#TUMBLR_DESTINATION#${id}`); }
  async putDestination(value: TumblrBlogDestination) { await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK: `${tenantKey(value.tenantId)}#TUMBLR_DESTINATION#${value.id}`, SK: 'PROFILE', GSI1PK: `${tenantKey(value.tenantId)}#TUMBLR_DESTINATIONS#${value.connectorId}`, GSI1SK: `DESTINATION#${value.id}`, entityType: 'TUMBLR_DESTINATION', ...value } })); }
  async listPublications(tenantId: string, workId: string) { return this.query<TumblrPublication>(`${tenantKey(tenantId)}#TUMBLR_PUBLICATIONS#${workId}`, 'PUBLICATION#'); }
  async getPublication(tenantId: string, id: string) { return this.get<TumblrPublication>(`${tenantKey(tenantId)}#TUMBLR_PUBLICATION#${id}`); }
  async putPublication(value: TumblrPublication) { await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK: `${tenantKey(value.tenantId)}#TUMBLR_PUBLICATION#${value.id}`, SK: 'PROFILE', GSI1PK: `${tenantKey(value.tenantId)}#TUMBLR_PUBLICATIONS#${value.workId}`, GSI1SK: `PUBLICATION#${value.updatedAt || ''}#${value.id}`, entityType: 'TUMBLR_PUBLICATION', ...value } })); }
  async putOAuthState(value: TumblrOAuthStateRecord) { await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK: `TUMBLR_OAUTH_STATE#${value.nonceHash}`, SK: 'PROFILE', entityType: 'TUMBLR_OAUTH_STATE', ...value }, ConditionExpression: 'attribute_not_exists(PK)' })); }
  async consumeOAuthState(hash: string, now: number) {
    try {
      const result = await this.client.send(new UpdateCommand({ TableName: this.tableName, Key: { PK: `TUMBLR_OAUTH_STATE#${hash}`, SK: 'PROFILE' }, UpdateExpression: 'SET consumedAt = :consumedAt', ConditionExpression: 'attribute_not_exists(consumedAt) AND expiresAt >= :now', ExpressionAttributeValues: { ':consumedAt': new Date(now).toISOString(), ':now': now }, ReturnValues: 'ALL_NEW' }));
      return result.Attributes ? clean<TumblrOAuthStateRecord>(result.Attributes) : null;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
      throw error;
    }
  }
  async consumeQuota(consumerKey: string, now: Date, hourlyLimit: number, dailyLimit: number) {
    const hash = nonceHash(consumerKey);
    const ttl = Math.floor(now.getTime() / 1000) + 172800;
    const update = (period: string, limit: number) => ({
      Update: { TableName: this.tableName, Key: { PK: `TUMBLR_QUOTA#${hash}`, SK: period }, UpdateExpression: 'ADD requestCount :one SET ttlEpochSeconds = :ttl, entityType = :entityType', ConditionExpression: 'attribute_not_exists(requestCount) OR requestCount < :limit', ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':ttl': ttl, ':entityType': 'TUMBLR_QUOTA' } }
    });
    try {
      // The hourly and daily claims succeed or fail together; a saturated daily
      // bucket can no longer leak capacity from the hourly bucket.
      await this.client.send(new TransactWriteCommand({ TransactItems: [update(`HOUR#${now.toISOString().slice(0, 13)}`, hourlyLimit), update(`DAY#${now.toISOString().slice(0, 10)}`, dailyLimit)] }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'TransactionCanceledException') return false;
      throw error;
    }
  }
}

export const newTumblrConnectorId = () => randomUUID();
