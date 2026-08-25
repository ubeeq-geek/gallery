import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BillingScope, ProcessingCreditLot, UsageEvent } from '../src/billing';
import { BillingDynamoRepository } from '../src/billingDynamoRepository';

const scope: BillingScope = { product: 'EVERSALLY', environment: 'test', spaceId: 'space-1', dataHomeRegion: 'ca-central-1' };
const lot: ProcessingCreditLot = { ...scope, lotId: 'lot-1', source: 'ES_TOP_UP', originalQuantity: 500, remainingQuantity: 500, reservedQuantity: 0, spentQuantity: 0, expiredQuantity: 0, revokedQuantity: 0, grantedAt: '2026-08-25T00:00:00.000Z', expiresAt: '2027-08-25T00:00:00.000Z', grantPeriodKey: '2026-08', status: 'AVAILABLE' };
const event: UsageEvent = { ...scope, eventId: 'event-1', idempotencyKey: 'payment-1', category: 'PROCESSING_CREDITS_GRANTED', quantity: 500, baseUnit: 'CREDIT', observedAt: lot.grantedAt, periodKey: '2026-08', sourceSystem: 'billing', lotId: lot.lotId };

describe('billing DynamoDB persistence', () => {
  test('atomically persists an idempotency lock, grant event, and credit lot', async () => {
    const send = jest.fn().mockResolvedValue({}); const repository = new BillingDynamoRepository({ send } as unknown as DynamoDBDocumentClient, 'billing-table');
    await expect(repository.grantCreditLot(scope, lot, event)).resolves.toBe('APPLIED');
    const items = send.mock.calls[0][0].input.TransactItems;
    expect(items).toHaveLength(3);
    expect(items.map((item: any) => item.Put.Item.SK)).toEqual(['IDEMPOTENCY#payment-1', 'EVENT#event-1', 'LOT#lot-1']);
    expect(items.every((item: any) => item.Put.ConditionExpression === 'attribute_not_exists(PK)')).toBe(true);
  });

  test('reports conditional transaction cancellation as an idempotent duplicate', async () => {
    const conflict = Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });
    const repository = new BillingDynamoRepository({ send: jest.fn().mockRejectedValue(conflict) } as unknown as DynamoDBDocumentClient, 'billing-table');
    await expect(repository.grantCreditLot(scope, lot, event)).resolves.toBe('DUPLICATE');
    await expect(repository.appendUsageEvent(scope, { ...event, category: 'PROCESSING_CREDITS_ADJUSTMENT' })).resolves.toBe('DUPLICATE');
  });

  test('conditionally updates a lot and appends its event in one transaction', async () => {
    const send = jest.fn().mockResolvedValue({}); const repository = new BillingDynamoRepository({ send } as unknown as DynamoDBDocumentClient, 'billing-table');
    const next = { ...lot, remainingQuantity: 499, spentQuantity: 1 };
    await repository.updateCreditLotWithEvent(scope, { ...lot, version: 4 }, next, { ...event, eventId: 'commit-1', idempotencyKey: 'commit-1', category: 'PROCESSING_CREDITS_COMMITTED', quantity: 1 });
    const update = send.mock.calls[0][0].input.TransactItems[2].Put;
    expect(update.Item).toMatchObject({ SK: 'LOT#lot-1', version: 5, remainingQuantity: 499, spentQuantity: 1 });
    expect(update).toMatchObject({ ConditionExpression: '#version = :version', ExpressionAttributeValues: { ':version': 4 } });
  });

  test('atomically reserves allocations across multiple versioned lots', async () => {
    const send = jest.fn().mockResolvedValue({}); const repository = new BillingDynamoRepository({ send } as unknown as DynamoDBDocumentClient, 'billing-table');
    const second = { ...lot, lotId: 'lot-2', expiresAt: '2027-09-25T00:00:00.000Z' };
    const reservation = { reservationId: 'job-1', scope, quantity: 25, state: 'RESERVED' as const, allocations: [{ lotId: lot.lotId, quantity: 10 }, { lotId: second.lotId, quantity: 15 }], eventId: 'reserve-event' };
    const reserveEvent: UsageEvent = { ...event, eventId: 'reserve-event', idempotencyKey: 'reserve:job-1', category: 'PROCESSING_CREDITS_RESERVED', quantity: 25, lotId: undefined };
    await expect(repository.reserveCreditLots(scope, [{ ...lot, version: 1 }, { ...second, version: 3 }], [{ ...lot, reservedQuantity: 10 }, { ...second, reservedQuantity: 15 }], reservation, reserveEvent)).resolves.toBe('APPLIED');
    const items = send.mock.calls[0][0].input.TransactItems;
    expect(items.map((item: any) => item.Put.Item.SK)).toEqual(['IDEMPOTENCY#reserve:job-1', 'EVENT#reserve-event', 'RESERVATION#job-1', 'LOT#lot-1', 'LOT#lot-2']);
    expect(items.slice(3).map((item: any) => item.Put.ExpressionAttributeValues[':version'])).toEqual([1, 3]);
  });

  test('atomically commits reservation allocations and rejects inconsistent lot deltas', async () => {
    const send = jest.fn().mockResolvedValue({}); const repository = new BillingDynamoRepository({ send } as unknown as DynamoDBDocumentClient, 'billing-table');
    const reserved = { ...lot, reservedQuantity: 2, version: 2 };
    const priorReservation = { reservationId: 'job-2', scope, quantity: 2, state: 'RESERVED' as const, allocations: [{ lotId: lot.lotId, quantity: 2 }], eventId: 'reserve-event', version: 1 };
    const committed = { reservationId: priorReservation.reservationId, scope, quantity: 2, state: 'COMMITTED' as const, allocations: priorReservation.allocations, eventId: priorReservation.eventId };
    const commitEvent: UsageEvent = { ...event, eventId: 'commit-event', idempotencyKey: 'commit:job-2', category: 'PROCESSING_CREDITS_COMMITTED', quantity: 2, lotId: undefined };
    await expect(repository.finalizeCreditReservation(scope, [reserved], [{ ...lot, remainingQuantity: 498, spentQuantity: 2 }], priorReservation, committed, commitEvent)).resolves.toBe('APPLIED');
    expect(send.mock.calls[0][0].input.TransactItems[2].Put).toMatchObject({ ConditionExpression: '#version = :version', ExpressionAttributeValues: { ':version': 1 }, Item: { version: 2, state: 'COMMITTED' } });
    await expect(repository.finalizeCreditReservation(scope, [reserved], [{ ...lot, remainingQuantity: 499, spentQuantity: 1 }], priorReservation, committed, commitEvent)).rejects.toThrow('Committed credits do not match allocation');
  });

  test('queries records within the full product/environment/region/Space scope', async () => {
    const send = jest.fn().mockResolvedValueOnce({ Items: [{ PK: 'ignored', SK: 'EVENT#event-1', entityType: 'BILLING_USAGE_EVENT', ...event }] }).mockResolvedValueOnce({ Items: [{ PK: 'ignored', SK: 'LOT#lot-1', entityType: 'BILLING_CREDIT_LOT', version: 2, ...lot }] });
    const repository = new BillingDynamoRepository({ send } as unknown as DynamoDBDocumentClient, 'billing-table');
    await expect(repository.listUsageEvents(scope)).resolves.toEqual([event]);
    await expect(repository.listCreditLots(scope)).resolves.toEqual([{ ...lot, version: 2 }]);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues[':pk']).toBe('BILLING#EVERSALLY#test#ca-central-1#space-1');
  });
});
