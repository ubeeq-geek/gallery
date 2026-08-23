import { BatchWriteCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { PatreonPersistence, PatreonRepositorySnapshot } from './patreon';

/** Dedicated integration-table persistence. The snapshot contains encrypted
 * credentials only and is never stored in generic Work or profile records. */
export class PatreonDynamoPersistence implements PatreonPersistence {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string, private readonly tenantId: string) {}
  async load(): Promise<PatreonRepositorySnapshot | null> {
    const items: Array<Record<string, any>> = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: 'integrationId = :id', ExpressionAttributeValues: { ':id': `patreon#${this.tenantId}` }, ConsistentRead: true, ExclusiveStartKey: exclusiveStartKey }));
      items.push(...(response.Items || [])); exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);
    if (!items.length) return null;
    const snapshot: PatreonRepositorySnapshot = {};
    for (const item of items) {
      if (item.category === 'audits') { const audits = Array.isArray(snapshot.audits) ? snapshot.audits : []; audits.push(item.payload); snapshot.audits = audits; continue; }
      if (typeof item.category !== 'string' || typeof item.mapKey !== 'string') continue;
      const entries = (snapshot[item.category] ||= []) as Array<[string, unknown]>; entries.push([item.mapKey, item.payload]);
    }
    return snapshot;
  }
  async save(snapshot: PatreonRepositorySnapshot): Promise<void> {
    const integrationId = `patreon#${this.tenantId}`; const desired = new Map<string, Record<string, unknown>>();
    for (const [category, value] of Object.entries(snapshot)) {
      if (category === 'audits' && Array.isArray(value)) for (const audit of value.slice(-2000) as Array<Record<string, unknown>>) desired.set(`audits#${audit.correlationId}`, { integrationId, recordId: `audits#${audit.correlationId}`, category, mapKey: audit.correlationId, payload: audit });
      else if (Array.isArray(value)) for (const entry of value) if (Array.isArray(entry) && typeof entry[0] === 'string') desired.set(`${category}#${entry[0]}`, { integrationId, recordId: `${category}#${entry[0]}`, category, mapKey: entry[0], payload: entry[1] });
    }
    const existing = new Set<string>(); let exclusiveStartKey: Record<string, unknown> | undefined;
    do { const response = await this.client.send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: 'integrationId = :id', ProjectionExpression: 'integrationId, recordId', ExpressionAttributeValues: { ':id': integrationId }, ExclusiveStartKey: exclusiveStartKey })); for (const item of response.Items || []) if (typeof item.recordId === 'string') existing.add(item.recordId); exclusiveStartKey = response.LastEvaluatedKey; } while (exclusiveStartKey);
    const requests: Array<{ PutRequest?: { Item: Record<string, unknown> }; DeleteRequest?: { Key: Record<string, unknown> } }> = [...desired.values()].map(Item => ({ PutRequest: { Item: JSON.parse(JSON.stringify(Item)) } }));
    for (const recordId of existing) if (!desired.has(recordId)) requests.push({ DeleteRequest: { Key: { integrationId, recordId } } });
    for (let index = 0; index < requests.length; index += 25) {
      let pending: any[] = requests.slice(index, index + 25); let attempts = 0;
      while (pending.length && attempts++ < 5) {
        const response = await this.client.send(new BatchWriteCommand({ RequestItems: { [this.tableName]: pending } }));
        pending = response.UnprocessedItems?.[this.tableName] || [];
        if (pending.length) await new Promise(resolve => setTimeout(resolve, 2 ** attempts * 25));
      }
      if (pending.length) throw new Error('Patreon integration persistence could not complete its bounded DynamoDB retry');
    }
  }
}
