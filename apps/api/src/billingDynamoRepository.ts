import { QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { BillingScope, ProcessingCreditLot, UsageEvent } from './billing';

export interface VersionedCreditLot extends ProcessingCreditLot { version: number }

const scopeKey = (scope: BillingScope): string => `BILLING#${scope.product}#${scope.environment}#${scope.dataHomeRegion}#${scope.spaceId}`;
const eventKey = (eventId: string): string => `EVENT#${eventId}`;
const lotKey = (lotId: string): string => `LOT#${lotId}`;
const idempotencyKey = (key: string): string => `IDEMPOTENCY#${key}`;
const clean = <T>(item: Record<string, unknown>): T => { const value = { ...item }; delete value.PK; delete value.SK; delete value.entityType; delete value.version; return value as T; };

/** DynamoDB persistence primitives for atomic, append-only billing mutations. */
export class BillingDynamoRepository {
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string) {}

  async appendUsageEvent(scope: BillingScope, event: UsageEvent): Promise<'APPLIED' | 'DUPLICATE'> {
    this.assertScope(scope, event);
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: idempotencyKey(event.idempotencyKey), entityType: 'BILLING_IDEMPOTENCY', eventId: event.eventId }, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: eventKey(event.eventId), entityType: 'BILLING_USAGE_EVENT', ...event }, ConditionExpression: 'attribute_not_exists(PK)' } }
      ] }));
      return 'APPLIED';
    } catch (error) { if (this.isTransactionConflict(error)) return 'DUPLICATE'; throw error; }
  }

  async grantCreditLot(scope: BillingScope, lot: ProcessingCreditLot, event: UsageEvent): Promise<'APPLIED' | 'DUPLICATE'> {
    this.assertScope(scope, lot); this.assertScope(scope, event);
    if (event.category !== 'PROCESSING_CREDITS_GRANTED' || event.lotId !== lot.lotId) throw new Error('Credit grant event does not match lot');
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: idempotencyKey(event.idempotencyKey), entityType: 'BILLING_IDEMPOTENCY', eventId: event.eventId }, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: eventKey(event.eventId), entityType: 'BILLING_USAGE_EVENT', ...event }, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: lotKey(lot.lotId), entityType: 'BILLING_CREDIT_LOT', version: 1, ...lot }, ConditionExpression: 'attribute_not_exists(PK)' } }
      ] }));
      return 'APPLIED';
    } catch (error) { if (this.isTransactionConflict(error)) return 'DUPLICATE'; throw error; }
  }

  async updateCreditLotWithEvent(scope: BillingScope, previous: VersionedCreditLot, next: ProcessingCreditLot, event: UsageEvent): Promise<void> {
    this.assertScope(scope, previous); this.assertScope(scope, next); this.assertScope(scope, event);
    if (previous.lotId !== next.lotId || event.lotId && event.lotId !== next.lotId) throw new Error('Credit lot update identity mismatch');
    await this.client.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: idempotencyKey(event.idempotencyKey), entityType: 'BILLING_IDEMPOTENCY', eventId: event.eventId }, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: eventKey(event.eventId), entityType: 'BILLING_USAGE_EVENT', ...event }, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: lotKey(next.lotId), entityType: 'BILLING_CREDIT_LOT', version: previous.version + 1, ...next }, ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': previous.version } } }
    ] }));
  }

  async listUsageEvents(scope: BillingScope): Promise<UsageEvent[]> {
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', ExpressionAttributeValues: { ':pk': scopeKey(scope), ':prefix': 'EVENT#' }, ConsistentRead: true }));
    return (response.Items || []).filter(item => item.entityType === 'BILLING_USAGE_EVENT').map(item => clean<UsageEvent>(item)).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  }

  async listCreditLots(scope: BillingScope): Promise<VersionedCreditLot[]> {
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', ExpressionAttributeValues: { ':pk': scopeKey(scope), ':prefix': 'LOT#' }, ConsistentRead: true }));
    return (response.Items || []).filter(item => item.entityType === 'BILLING_CREDIT_LOT').map(item => ({ ...clean<ProcessingCreditLot>(item), version: Number(item.version) }));
  }

  private assertScope(expected: BillingScope, actual: BillingScope): void { if (scopeKey(expected) !== scopeKey(actual)) throw new Error('Billing persistence scope mismatch'); }
  private isTransactionConflict(error: unknown): boolean { return !!error && typeof error === 'object' && 'name' in error && ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(String((error as { name?: unknown }).name)); }
}
