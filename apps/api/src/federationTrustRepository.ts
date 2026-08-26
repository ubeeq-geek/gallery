import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FederationError, type FederationInstanceMetadata, type ManagedFederationTrust } from './federation';

/** Durable managed-instance registry with conditional metadata-revision updates. */
export class FederationTrustDynamoRepository {
  private readonly pk: string;
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string, tenantId: string) {
    this.pk = `TENANT#${tenantId}#FEDERATION_TRUST`;
  }

  async get(instanceId: string): Promise<FederationInstanceMetadata | undefined> {
    const response = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: this.pk, SK: `INSTANCE#${instanceId}` }, ConsistentRead: true }));
    return response.Item?.record as FederationInstanceMetadata | undefined;
  }

  async register(metadata: FederationInstanceMetadata, expectedRevision?: number): Promise<void> {
    const create = expectedRevision === undefined;
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: { PK: this.pk, SK: `INSTANCE#${metadata.instanceId}`, entityType: 'FEDERATION_TRUST_INSTANCE', metadataRevision: metadata.metadataRevision, record: metadata, GSI2PK: `FEDERATION_TRUST_STATUS#${metadata.status}`, GSI2SK: `${metadata.metadataUpdatedAt}#${metadata.instanceId}` },
      ConditionExpression: create ? 'attribute_not_exists(PK)' : 'metadataRevision = :expected AND :next > metadataRevision',
      ExpressionAttributeValues: create ? undefined : { ':expected': expectedRevision, ':next': metadata.metadataRevision }
    }));
  }

  async list(): Promise<FederationInstanceMetadata[]> {
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', ExpressionAttributeValues: { ':pk': this.pk, ':prefix': 'INSTANCE#' }, ConsistentRead: true }));
    return (response.Items ?? []).map((item) => item.record as FederationInstanceMetadata);
  }

  async hydrate(trust: ManagedFederationTrust): Promise<void> {
    const records = await this.list();
    for (const metadata of records.sort((a, b) => a.metadataRevision - b.metadataRevision)) trust.register(metadata);
  }
}

export const parseManagedTrustRegistry = (value: string | undefined): FederationInstanceMetadata[] => {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new FederationError('invalid_trust_registry', 'FEDERATION_TRUSTED_INSTANCES_JSON must be valid JSON'); }
  if (!Array.isArray(parsed)) throw new FederationError('invalid_trust_registry', 'Managed trust registry must be an array');
  return parsed as FederationInstanceMetadata[];
};

