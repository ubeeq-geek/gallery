import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { VimeoAuditEvent, VimeoConnection, VimeoEmbedPolicy, VimeoExternalReferenceWork, VimeoInsightSnapshot, VimeoOAuthAttempt, VimeoPublication, VimeoRepository } from './vimeoIntegration';

const clean = <T>(item?: Record<string, unknown>): T | undefined => {
  if (!item) return undefined;
  const { PK: _pk, SK: _sk, entityType: _type, ...value } = item;
  return value as T;
};

/** Durable single-table adapter. Provider payloads and media bytes are never written here. */
export class DynamoVimeoRepository implements VimeoRepository {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string) {}

  private async get<T>(PK: string, SK: string) {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK, SK } }));
    return clean<T>(result.Item);
  }

  private async put(PK: string, SK: string, entityType: string, value: object) {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK, SK, entityType, ...value } }));
  }

  async connection(id: string) { return this.get<VimeoConnection>(`VIMEO_CONNECTION#${id}`, 'PROFILE'); }
  async saveConnection(value: VimeoConnection) { await this.put(`VIMEO_CONNECTION#${value.id}`, 'PROFILE', 'VIMEO_CONNECTION', value); }
  async publication(id: string) { return this.get<VimeoPublication>(`VIMEO_PUBLICATION#${id}`, 'PROFILE'); }
  async publicationByKey(key: string) { return this.get<VimeoPublication>(`VIMEO_IDEMPOTENCY#${key}`, 'PUBLICATION'); }
  async publicationByRemoteVideoId(connectionId: string, remoteVideoId: string) { return this.get<VimeoPublication>(`VIMEO_REMOTE#${connectionId}#${remoteVideoId}`, 'PUBLICATION'); }
  async reconciliationCandidates(limit = 100) {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': 'VIMEO_RECONCILIATION', ':sk': 'PUBLICATION#' },
      Limit: Math.min(100, Math.max(1, limit))
    }));
    return (result.Items || []).map((item) => clean<VimeoPublication>(item)!).filter((value) => value && Boolean(value.remoteUrl) && ['PROCESSING', 'PUBLISHED'].includes(value.state));
  }
  async createPublicationIfAbsent(value: VimeoPublication) {
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName, Item: { PK: `VIMEO_PUBLICATION#${value.id}`, SK: 'PROFILE', entityType: 'VIMEO_PUBLICATION', ...value } } },
        { Put: { TableName: this.tableName, Item: { PK: `VIMEO_IDEMPOTENCY#${value.idempotencyKey}`, SK: 'PUBLICATION', entityType: 'VIMEO_PUBLICATION_LOOKUP', ...value }, ConditionExpression: 'attribute_not_exists(PK)' } }
      ] }));
      return value;
    } catch (error) {
      if ((error as { name?: string }).name !== 'TransactionCanceledException') throw error;
      const existing = await this.publicationByKey(value.idempotencyKey);
      if (!existing) throw error;
      return existing;
    }
  }
  async savePublication(value: VimeoPublication) {
    await Promise.all([
      this.put(`VIMEO_PUBLICATION#${value.id}`, 'PROFILE', 'VIMEO_PUBLICATION', value),
      this.put(`VIMEO_IDEMPOTENCY#${value.idempotencyKey}`, 'PUBLICATION', 'VIMEO_PUBLICATION_LOOKUP', value),
      value.remoteVideoId ? this.put(`VIMEO_REMOTE#${value.connectionId}#${value.remoteVideoId}`, 'PUBLICATION', 'VIMEO_PUBLICATION_LOOKUP', value) : Promise.resolve(),
      value.remoteUrl ? this.put('VIMEO_RECONCILIATION', `PUBLICATION#${value.id}`, 'VIMEO_RECONCILIATION_CANDIDATE', value) : Promise.resolve()
    ]);
  }
  async saveExternalReference(value: VimeoExternalReferenceWork) { await this.put(`VIMEO_CONNECTION#${value.connectionId}`, `REFERENCE#${value.remoteVideoId}`, 'VIMEO_EXTERNAL_REFERENCE', value); }
  async externalReferences(connectionId: string) {
    const result = await this.client.send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': `VIMEO_CONNECTION#${connectionId}`, ':sk': 'REFERENCE#' } }));
    return (result.Items || []).map((item) => clean<VimeoExternalReferenceWork>(item)!).filter(Boolean);
  }
  async embedPolicy(publicationId: string) { return this.get<VimeoEmbedPolicy>(`VIMEO_PUBLICATION#${publicationId}`, 'EMBED_POLICY'); }
  async saveEmbedPolicy(value: VimeoEmbedPolicy) { await this.put(`VIMEO_PUBLICATION#${value.publicationId}`, 'EMBED_POLICY', 'VIMEO_EMBED_POLICY', value); }
  async saveInsight(value: VimeoInsightSnapshot) { await this.put(`VIMEO_PUBLICATION#${value.publicationId}`, `INSIGHT#${value.capturedAt}#${value.metric}#${value.id}`, 'VIMEO_INSIGHT', value); }
  async saveAudit(value: VimeoAuditEvent) { await this.put(`VIMEO_OWNER#${value.ownerId}`, `AUDIT#${value.createdAt}#${value.id}`, 'VIMEO_AUDIT', value); }
  async rememberOAuth(stateHash: string, attempt: VimeoOAuthAttempt) { await this.put(`VIMEO_OAUTH#${stateHash}`, 'STATE', 'VIMEO_OAUTH_STATE', attempt); }
  async consumeOAuth(stateHash: string) {
    const key = `VIMEO_OAUTH#${stateHash}`;
    const value = await this.get<VimeoOAuthAttempt>(key, 'STATE');
    await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: { PK: key, SK: 'STATE' } }));
    return value && value.expiresAt >= Date.now() ? value : undefined;
  }
  async rememberWebhook(eventId: string) {
    try {
      await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK: `VIMEO_WEBHOOK#${eventId}`, SK: 'EVENT', entityType: 'VIMEO_WEBHOOK_EVENT', expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 }, ConditionExpression: 'attribute_not_exists(PK)' }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
}
