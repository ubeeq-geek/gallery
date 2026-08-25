import { createHash } from 'node:crypto';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { MANAGED_DATA_HOMES, type DataHomeLabel, type GlobalRoutingEntry, type ManagedProduct } from './regionalMedia';

export interface GlobalRoutingRepository {
  get(subject: string, product: ManagedProduct): Promise<GlobalRoutingEntry | undefined>;
  create(subject: string, product: ManagedProduct, label: DataHomeLabel): Promise<GlobalRoutingEntry>;
}

export interface RegionalEndpointDirectory {
  endpoint(product: ManagedProduct, region: GlobalRoutingEntry['homeRegion']): string;
}

export const opaqueRoutingId = (subject: string, product: ManagedProduct): string =>
  createHash('sha256').update(`${product}\0${subject}`).digest('hex');

export const assignDataHome = async (input: { subject: string; product: ManagedProduct; label: DataHomeLabel }, repository: GlobalRoutingRepository): Promise<GlobalRoutingEntry> => {
  if (!input.subject.trim()) throw new Error('Authenticated subject is required');
  if (!(input.label in MANAGED_DATA_HOMES)) throw new Error('Unsupported data home');
  const existing = await repository.get(input.subject, input.product);
  if (existing) {
    if (existing.homeRegion !== MANAGED_DATA_HOMES[input.label]) throw new Error('Data home is already assigned; use the migration workflow');
    return existing;
  }
  return repository.create(input.subject, input.product, input.label);
};

export const dynamoGlobalRoutingRepository = (client: DynamoDBDocumentClient, tableName: string): GlobalRoutingRepository => ({
  get: async (subject, product) => {
    const result = await client.send(new GetCommand({ TableName: tableName, Key: { routingId: opaqueRoutingId(subject, product) }, ConsistentRead: true }));
    return result.Item as GlobalRoutingEntry | undefined;
  },
  create: async (subject, product, label) => {
    const routingId = opaqueRoutingId(subject, product);
    const entry: GlobalRoutingEntry = { opaqueSpaceId: routingId, product, homeRegion: MANAGED_DATA_HOMES[label], status: 'ACTIVE' };
    try {
      await client.send(new PutCommand({ TableName: tableName, Item: { routingId, ...entry, createdAt: new Date().toISOString() }, ConditionExpression: 'attribute_not_exists(routingId)' }));
      return entry;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error;
      const existing = await client.send(new GetCommand({ TableName: tableName, Key: { routingId }, ConsistentRead: true }));
      if (!existing.Item || existing.Item.homeRegion !== entry.homeRegion) throw error;
      return existing.Item as GlobalRoutingEntry;
    }
  }
});
