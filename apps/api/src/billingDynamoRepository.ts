import { QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { BillingScope, CreditReservation, ProcessingCreditLot, UsageEvent } from './billing';

export interface VersionedCreditLot extends ProcessingCreditLot { version: number }
export interface VersionedCreditReservation extends CreditReservation { version: number }

const scopeKey = (scope: BillingScope): string => `BILLING#${scope.product}#${scope.environment}#${scope.dataHomeRegion}#${scope.spaceId}`;
const eventKey = (eventId: string): string => `EVENT#${eventId}`;
const lotKey = (lotId: string): string => `LOT#${lotId}`;
const idempotencyKey = (key: string): string => `IDEMPOTENCY#${key}`;
const reservationKey = (reservationId: string): string => `RESERVATION#${reservationId}`;
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

  async reserveCreditLots(scope: BillingScope, previousLots: readonly VersionedCreditLot[], nextLots: readonly ProcessingCreditLot[], reservation: CreditReservation, event: UsageEvent): Promise<'APPLIED' | 'DUPLICATE'> {
    this.assertScope(scope, event); this.assertReservation(scope, reservation, event, 'RESERVED');
    if (!previousLots.length || previousLots.length !== nextLots.length || previousLots.length > 22) throw new Error('Reservation must update between one and 22 credit lots');
    const updates = previousLots.map((previous, index) => {
      const next = nextLots[index]; this.assertScope(scope, previous); this.assertScope(scope, next);
      if (previous.lotId !== next.lotId || next.reservedQuantity < previous.reservedQuantity || next.remainingQuantity !== previous.remainingQuantity) throw new Error('Invalid credit reservation lot transition');
      return { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: lotKey(next.lotId), entityType: 'BILLING_CREDIT_LOT', version: previous.version + 1, ...next }, ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': previous.version } } };
    });
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: idempotencyKey(event.idempotencyKey), entityType: 'BILLING_IDEMPOTENCY', eventId: event.eventId }, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: eventKey(event.eventId), entityType: 'BILLING_USAGE_EVENT', ...event }, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: reservationKey(reservation.reservationId), entityType: 'BILLING_CREDIT_RESERVATION', version: 1, ...reservation }, ConditionExpression: 'attribute_not_exists(PK)' } },
        ...updates
      ] }));
      return 'APPLIED';
    } catch (error) { if (this.isTransactionConflict(error)) return 'DUPLICATE'; throw error; }
  }

  async finalizeCreditReservation(scope: BillingScope, previousLots: readonly VersionedCreditLot[], nextLots: readonly ProcessingCreditLot[], previousReservation: VersionedCreditReservation, nextReservation: CreditReservation, event: UsageEvent): Promise<'APPLIED' | 'DUPLICATE'> {
    this.assertScope(scope, event); this.assertReservation(scope, nextReservation, event, nextReservation.state);
    if (previousReservation.state !== 'RESERVED' || nextReservation.reservationId !== previousReservation.reservationId || nextReservation.state === 'RESERVED') throw new Error('Invalid reservation finalization transition');
    if (!previousLots.length || previousLots.length !== nextLots.length || previousLots.length > 22) throw new Error('Finalization must update between one and 22 credit lots');
    const updates = previousLots.map((previous, index) => {
      const next = nextLots[index]; this.assertScope(scope, previous); this.assertScope(scope, next);
      const allocation = previousReservation.allocations.find(item => item.lotId === previous.lotId)?.quantity;
      if (!allocation || previous.lotId !== next.lotId || previous.reservedQuantity - next.reservedQuantity !== allocation) throw new Error('Invalid finalized credit lot allocation');
      if (nextReservation.state === 'COMMITTED' && previous.remainingQuantity - next.remainingQuantity !== allocation) throw new Error('Committed credits do not match allocation');
      if (nextReservation.state === 'RELEASED' && previous.remainingQuantity !== next.remainingQuantity) throw new Error('Released reservation changed remaining credits');
      return { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: lotKey(next.lotId), entityType: 'BILLING_CREDIT_LOT', version: previous.version + 1, ...next }, ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': previous.version } } };
    });
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: idempotencyKey(event.idempotencyKey), entityType: 'BILLING_IDEMPOTENCY', eventId: event.eventId }, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: eventKey(event.eventId), entityType: 'BILLING_USAGE_EVENT', ...event }, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: this.tableName, Item: { PK: scopeKey(scope), SK: reservationKey(nextReservation.reservationId), entityType: 'BILLING_CREDIT_RESERVATION', version: previousReservation.version + 1, ...nextReservation }, ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': previousReservation.version } } },
        ...updates
      ] }));
      return 'APPLIED';
    } catch (error) { if (this.isTransactionConflict(error)) return 'DUPLICATE'; throw error; }
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
  private assertReservation(scope: BillingScope, reservation: CreditReservation, event: UsageEvent, state: CreditReservation['state']): void {
    if (scopeKey(scope) !== scopeKey(reservation.scope) || reservation.state !== state || reservation.quantity !== event.quantity) throw new Error('Reservation event does not match reservation');
  }
  private isTransactionConflict(error: unknown): boolean { return !!error && typeof error === 'object' && 'name' in error && ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(String((error as { name?: unknown }).name)); }
}
