import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { FederatedPublication, FederationAuditRecord, FederationDeliveryJob, FederationGrant, RemoteCreatorProjection } from './federation';
import { prepareFederationAuditRecord } from './federationAudit';

const clean = <T>(item?: Record<string, unknown>): T | undefined => item?.record as T | undefined;
const epoch = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/** Durable, conditionally-written federation records in the existing content-core table. */
export class FederationDynamoRepository {
  private readonly pk: string;
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string, tenantId: string) {
    this.pk = `TENANT#${tenantId}#FEDERATION`;
  }

  async getGrant(id: string): Promise<FederationGrant | undefined> { return clean<FederationGrant>((await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: this.pk, SK: `GRANT#${id}` }, ConsistentRead: true }))).Item); }
  async getProjection(actorUri: string): Promise<RemoteCreatorProjection | undefined> { return clean<RemoteCreatorProjection>((await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: this.pk, SK: `PROJECTION#${encodeURIComponent(actorUri)}` }, ConsistentRead: true }))).Item); }
  async getPublication(id: string): Promise<FederatedPublication | undefined> { return clean<FederatedPublication>((await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: this.pk, SK: `PUBLICATION#${id}` }, ConsistentRead: true }))).Item); }

  async createGrant(grant: FederationGrant, audit: FederationAuditRecord): Promise<void> {
    await this.transactPut({ SK: `GRANT#${grant.id}`, entityType: 'FEDERATION_GRANT', record: grant, GSI1PK: `FEDERATION_ACTOR#${grant.actorUri}`, GSI1SK: `DESTINATION#${grant.destinationInstanceId}`, GSI2PK: `FEDERATION_GRANT_STATUS#${grant.status}`, GSI2SK: `${grant.expiresAt ?? 'NONE'}#${grant.id}` }, audit, 'attribute_not_exists(PK)');
  }

  async updateGrant(previous: FederationGrant, next: FederationGrant, audit: FederationAuditRecord): Promise<void> {
    await this.transactPut({ SK: `GRANT#${next.id}`, entityType: 'FEDERATION_GRANT', record: next, GSI1PK: `FEDERATION_ACTOR#${next.actorUri}`, GSI1SK: `DESTINATION#${next.destinationInstanceId}`, GSI2PK: `FEDERATION_GRANT_STATUS#${next.status}`, GSI2SK: `${next.expiresAt ?? 'NONE'}#${next.id}` }, audit, '#record.#updatedAt = :previous', { '#record': 'record', '#updatedAt': 'updatedAt' }, { ':previous': previous.updatedAt });
  }

  async saveProjection(previousRevision: number | undefined, projection: RemoteCreatorProjection, audit: FederationAuditRecord): Promise<void> {
    await this.transactPut({ SK: `PROJECTION#${encodeURIComponent(projection.actorUri)}`, entityType: 'FEDERATION_PROJECTION', record: projection, GSI1PK: `FEDERATION_ACTOR#${projection.actorUri}`, GSI1SK: `PROJECTION#${projection.homeInstanceId}` }, audit, previousRevision === undefined ? 'attribute_not_exists(PK)' : '#record.#revision = :previous', { '#record': 'record', '#revision': 'profileRevision' }, previousRevision === undefined ? undefined : { ':previous': previousRevision });
  }

  async savePublication(previousRevision: number | undefined, publication: FederatedPublication, audit: FederationAuditRecord): Promise<void> {
    await this.transactPut({ SK: `PUBLICATION#${publication.id}`, entityType: 'FEDERATION_PUBLICATION', record: publication, GSI1PK: `FEDERATION_WORK#${publication.sourceWorkUri}`, GSI1SK: `DESTINATION#${publication.id}`, GSI2PK: `FEDERATION_PUBLICATION_STATE#${publication.localStatus}`, GSI2SK: `${publication.lastSynchronizedAt}#${publication.id}` }, audit, previousRevision === undefined ? 'attribute_not_exists(PK)' : '#record.#revision = :previous', { '#record': 'record', '#revision': 'sourceRevision' }, previousRevision === undefined ? undefined : { ':previous': previousRevision });
  }

  async claimNonce(sourceInstanceId: string, nonce: string, expiresAt: string): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK: this.pk, SK: `NONCE#${sourceInstanceId}#${nonce}`, entityType: 'FEDERATION_NONCE', ttlEpochSeconds: epoch(expiresAt) }, ConditionExpression: 'attribute_not_exists(PK)' }));
  }

  async putIdempotency(key: string, result: unknown, expiresAt: string): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK: this.pk, SK: `IDEMPOTENCY#${key}`, entityType: 'FEDERATION_IDEMPOTENCY', record: result, ttlEpochSeconds: epoch(expiresAt) }, ConditionExpression: 'attribute_not_exists(PK)' }));
  }

  async saveDelivery(previousAttempt: number | undefined, job: FederationDeliveryJob, audit: FederationAuditRecord): Promise<void> {
    await this.transactPut({ SK: `DELIVERY#${job.id}`, entityType: 'FEDERATION_DELIVERY', record: job, GSI2PK: `FEDERATION_DELIVERY_STATUS#${job.status}`, GSI2SK: `${job.nextAttemptAt ?? job.updatedAt}#${job.id}` }, audit, previousAttempt === undefined ? 'attribute_not_exists(PK)' : '#record.#attempt = :previous', { '#record': 'record', '#attempt': 'attemptCount' }, previousAttempt === undefined ? undefined : { ':previous': previousAttempt });
  }

  async listByIndex(indexName: 'GSI1' | 'GSI2', partition: string): Promise<Record<string, unknown>[]> {
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName, IndexName: indexName, KeyConditionExpression: `${indexName}PK = :pk`, ExpressionAttributeValues: { ':pk': partition } }));
    return (response.Items ?? []).map((item) => item.record as Record<string, unknown>);
  }

  private async transactPut(item: Record<string, unknown>, audit: FederationAuditRecord, condition: string, names?: Record<string, string>, values?: Record<string, unknown>): Promise<void> {
    const envelope = prepareFederationAuditRecord(audit);
    await this.client.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: this.tableName, Item: { PK: this.pk, ...item }, ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
      { Put: { TableName: this.tableName, Item: { PK: this.pk, SK: `AUDIT#${audit.occurredAt}#${audit.id}`, entityType: 'FEDERATION_AUDIT', occurredAt: audit.occurredAt, envelope, ttlEpochSeconds: envelope.retainedUntil ? epoch(envelope.retainedUntil) : undefined }, ConditionExpression: 'attribute_not_exists(PK)' } }
    ] }));
  }
}
