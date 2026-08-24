import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { FanvueAuditEvent, FanvueConnection, FanvueExternalReferenceWork, FanvuePublication, FanvueRightsEligibility, FanvueWebhookEnvelope } from './fanvue';

export interface StoredFanvueWebhookEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  connectionId: string;
  signatureVerified: true;
  outcome: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';
  /** Deliberately minimized; raw webhook payloads and fan data are not persisted. */
  subjectIds: Record<string, string>;
  retentionExpiresAt: number;
}

export interface FanvueRepository {
  putConnection(connection: FanvueConnection): Promise<void>;
  getConnection(connectionId: string): Promise<FanvueConnection | null>;
  listConnections(ownerId: string): Promise<FanvueConnection[]>;
  deleteCredentials(connection: FanvueConnection): Promise<void>;
  putPublication(publication: FanvuePublication): Promise<void>;
  getPublication(publicationId: string): Promise<FanvuePublication | null>;
  listPublications(connectionId: string): Promise<FanvuePublication[]>;
  putWebhookEvent(event: StoredFanvueWebhookEvent): Promise<boolean>;
  updateWebhookOutcome(eventId: string, outcome: StoredFanvueWebhookEvent['outcome']): Promise<void>;
  putAuditEvent(event: FanvueAuditEvent): Promise<void>;
  putExternalReference(reference: FanvueExternalReferenceWork): Promise<void>;
  getExternalReferenceByRemotePost(connectionId: string, remotePostUuid: string): Promise<FanvueExternalReferenceWork | null>;
  listExternalReferences(connectionId: string): Promise<FanvueExternalReferenceWork[]>;
  putRightsEligibility(eligibility: FanvueRightsEligibility): Promise<void>;
  getRightsEligibility(ownerId: string, workId: string): Promise<FanvueRightsEligibility | null>;
}

const clean = <T>(item?: Record<string, unknown>): T | null => {
  if (!item) return null;
  const value = { ...item };
  ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'entityType'].forEach((key) => delete value[key]);
  return value as T;
};

/** Explicit Fanvue entities in the integration table; this never writes tokens into Work metadata. */
export class DynamoFanvueRepository implements FanvueRepository {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string) {}

  private put(item: Record<string, unknown>) {
    return this.client.send(new PutCommand({ TableName: this.tableName, Item: item })).then(() => undefined);
  }

  async putConnection(connection: FanvueConnection): Promise<void> {
    const { encryptedCredentialReference, ...profile } = connection;
    await this.put({
      PK: `FANVUE_CONNECTION#${connection.connectionId}`, SK: 'PROFILE',
      GSI1PK: `FANVUE_OWNER#${connection.ownerId}`, GSI1SK: `CONNECTION#${connection.createdAt}#${connection.connectionId}`,
      entityType: 'FANVUE_CONNECTION', ...profile
    });
    if (encryptedCredentialReference) await this.put({
      PK: `FANVUE_CONNECTION#${connection.connectionId}`, SK: 'CREDENTIAL',
      entityType: 'FANVUE_CONNECTION_CREDENTIAL', encryptedCredentialReference, updatedAt: connection.updatedAt
    });
  }

  async getConnection(connectionId: string): Promise<FanvueConnection | null> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName, Key: { PK: `FANVUE_CONNECTION#${connectionId}`, SK: 'PROFILE' }
    }));
    const connection = clean<FanvueConnection>(result.Item);
    if (!connection) return null;
    const credential = await this.client.send(new GetCommand({
      TableName: this.tableName, Key: { PK: `FANVUE_CONNECTION#${connectionId}`, SK: 'CREDENTIAL' },
      ProjectionExpression: 'encryptedCredentialReference'
    }));
    return { ...connection, ...(typeof credential.Item?.encryptedCredentialReference === 'string'
      ? { encryptedCredentialReference: credential.Item.encryptedCredentialReference } : {}) };
  }

  async listConnections(ownerId: string): Promise<FanvueConnection[]> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName, IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
      ExpressionAttributeValues: { ':pk': `FANVUE_OWNER#${ownerId}`, ':sk': 'CONNECTION#' }
    }));
    return (result.Items || []).map((item) => clean<FanvueConnection>(item)!).filter(Boolean);
  }

  async deleteCredentials(connection: FanvueConnection): Promise<void> {
    // The encrypted credential is a separate, access-restricted entity so disconnect can physically purge it.
    await this.client.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { PK: `FANVUE_CONNECTION#${connection.connectionId}`, SK: 'CREDENTIAL' }
    }));
    await this.putConnection({
      ...connection, encryptedCredentialReference: undefined, state: 'DISCONNECTED',
      webhookSubscriptions: [], updatedAt: new Date().toISOString()
    });
  }

  async putPublication(publication: FanvuePublication): Promise<void> {
    await this.put({
      PK: `FANVUE_PUBLICATION#${publication.publicationId}`, SK: 'PROFILE',
      GSI1PK: `FANVUE_CONNECTION#${publication.connectionId}`, GSI1SK: `PUBLICATION#${publication.createdAt}#${publication.publicationId}`,
      entityType: 'FANVUE_PUBLICATION', ...publication
    });
  }

  async getPublication(publicationId: string): Promise<FanvuePublication | null> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName, Key: { PK: `FANVUE_PUBLICATION#${publicationId}`, SK: 'PROFILE' }
    }));
    return clean<FanvuePublication>(result.Item);
  }

  async listPublications(connectionId: string): Promise<FanvuePublication[]> {
    const result = await this.client.send(new QueryCommand({ TableName: this.tableName, IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
      ExpressionAttributeValues: { ':pk': `FANVUE_CONNECTION#${connectionId}`, ':sk': 'PUBLICATION#' } }));
    return (result.Items || []).map((item) => clean<FanvuePublication>(item)!).filter(Boolean);
  }

  async putWebhookEvent(event: StoredFanvueWebhookEvent): Promise<boolean> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { PK: `FANVUE_WEBHOOK#${event.eventId}`, SK: 'ENVELOPE', entityType: 'FANVUE_WEBHOOK_EVENT', ...event },
        ConditionExpression: 'attribute_not_exists(PK)'
      }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }

  async updateWebhookOutcome(eventId: string, outcome: StoredFanvueWebhookEvent['outcome']): Promise<void> {
    await this.client.send(new UpdateCommand({ TableName: this.tableName,
      Key: { PK: `FANVUE_WEBHOOK#${eventId}`, SK: 'ENVELOPE' },
      UpdateExpression: 'SET #outcome = :outcome', ExpressionAttributeNames: { '#outcome': 'outcome' },
      ExpressionAttributeValues: { ':outcome': outcome }, ConditionExpression: 'attribute_exists(PK)' }));
  }

  async putAuditEvent(event: FanvueAuditEvent): Promise<void> {
    await this.put({
      PK: `FANVUE_CONNECTION#${event.connectionId}`,
      SK: `AUDIT#${event.createdAt}#${event.auditEventId}`,
      entityType: 'FANVUE_AUDIT_EVENT', ...event
    });
  }

  async putExternalReference(reference: FanvueExternalReferenceWork): Promise<void> {
    await this.put({
      PK: `FANVUE_CONNECTION#${reference.connectionId}`,
      SK: `EXTERNAL_REFERENCE#${reference.remotePostUuid}`,
      entityType: 'FANVUE_EXTERNAL_REFERENCE_WORK', ...reference
    });
  }

  async getExternalReferenceByRemotePost(connectionId: string, remotePostUuid: string): Promise<FanvueExternalReferenceWork | null> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName,
      Key: { PK: `FANVUE_CONNECTION#${connectionId}`, SK: `EXTERNAL_REFERENCE#${remotePostUuid}` } }));
    return clean<FanvueExternalReferenceWork>(result.Item);
  }

  async listExternalReferences(connectionId: string): Promise<FanvueExternalReferenceWork[]> {
    const result = await this.client.send(new QueryCommand({ TableName: this.tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `FANVUE_CONNECTION#${connectionId}`, ':sk': 'EXTERNAL_REFERENCE#' } }));
    return (result.Items || []).map((item) => clean<FanvueExternalReferenceWork>(item)!).filter(Boolean);
  }

  async putRightsEligibility(eligibility: FanvueRightsEligibility): Promise<void> {
    await this.put({ PK: `FANVUE_OWNER#${eligibility.ownerId}`, SK: `RIGHTS_ELIGIBILITY#${eligibility.workId}`,
      entityType: 'FANVUE_RIGHTS_ELIGIBILITY', ...eligibility });
  }

  async getRightsEligibility(ownerId: string, workId: string): Promise<FanvueRightsEligibility | null> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName,
      Key: { PK: `FANVUE_OWNER#${ownerId}`, SK: `RIGHTS_ELIGIBILITY#${workId}` } }));
    return clean<FanvueRightsEligibility>(result.Item);
  }
}

export class InMemoryFanvueRepository implements FanvueRepository {
  readonly connections = new Map<string, FanvueConnection>();
  readonly publications = new Map<string, FanvuePublication>();
  readonly webhookEvents = new Map<string, StoredFanvueWebhookEvent>();
  readonly auditEvents: FanvueAuditEvent[] = [];
  readonly externalReferences = new Map<string, FanvueExternalReferenceWork>();
  readonly rightsEligibility = new Map<string, FanvueRightsEligibility>();

  async putConnection(value: FanvueConnection) { this.connections.set(value.connectionId, structuredClone(value)); }
  async getConnection(id: string) { return structuredClone(this.connections.get(id) || null); }
  async listConnections(ownerId: string) {
    return [...this.connections.values()].filter((item) => item.ownerId === ownerId).map((item) => structuredClone(item));
  }
  async deleteCredentials(connection: FanvueConnection) {
    await this.putConnection({ ...connection, encryptedCredentialReference: undefined, state: 'DISCONNECTED', webhookSubscriptions: [], updatedAt: new Date().toISOString() });
  }
  async putPublication(value: FanvuePublication) { this.publications.set(value.publicationId, structuredClone(value)); }
  async getPublication(id: string) { return structuredClone(this.publications.get(id) || null); }
  async listPublications(connectionId: string) { return [...this.publications.values()].filter((item) => item.connectionId === connectionId).map((item) => structuredClone(item)); }
  async putWebhookEvent(event: StoredFanvueWebhookEvent) {
    if (this.webhookEvents.has(event.eventId)) return false;
    this.webhookEvents.set(event.eventId, structuredClone(event));
    return true;
  }
  async updateWebhookOutcome(eventId: string, outcome: StoredFanvueWebhookEvent['outcome']) {
    const event = this.webhookEvents.get(eventId);
    if (event) this.webhookEvents.set(eventId, { ...event, outcome });
  }
  async putAuditEvent(event: FanvueAuditEvent) { this.auditEvents.push(structuredClone(event)); }
  async putExternalReference(value: FanvueExternalReferenceWork) { this.externalReferences.set(`${value.connectionId}:${value.remotePostUuid}`, structuredClone(value)); }
  async getExternalReferenceByRemotePost(connectionId: string, remotePostUuid: string) {
    return structuredClone(this.externalReferences.get(`${connectionId}:${remotePostUuid}`) || null);
  }
  async listExternalReferences(connectionId: string) {
    return [...this.externalReferences.values()].filter((item) => item.connectionId === connectionId).map((item) => structuredClone(item));
  }
  async putRightsEligibility(value: FanvueRightsEligibility) { this.rightsEligibility.set(`${value.ownerId}:${value.workId}`, structuredClone(value)); }
  async getRightsEligibility(ownerId: string, workId: string) { return structuredClone(this.rightsEligibility.get(`${ownerId}:${workId}`) || null); }
}

export const minimizeFanvueWebhook = (
  envelope: FanvueWebhookEnvelope,
  retentionDays = 30
): StoredFanvueWebhookEvent => {
  const allowedIdKeys = ['postUuid', 'mediaUuid', 'accountUuid', 'collectionUuid'];
  const subjectIds = Object.fromEntries(allowedIdKeys.flatMap((key) =>
    typeof envelope.payload[key] === 'string' ? [[key, envelope.payload[key] as string]] : []
  ));
  return {
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    occurredAt: envelope.occurredAt,
    connectionId: envelope.connectionId,
    signatureVerified: true,
    outcome: 'RECEIVED',
    subjectIds,
    retentionExpiresAt: Math.floor(Date.now() / 1000) + retentionDays * 86400
  };
};
