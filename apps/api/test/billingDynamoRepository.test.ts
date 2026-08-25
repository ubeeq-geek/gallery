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

  test('queries records within the full product/environment/region/Space scope', async () => {
    const send = jest.fn().mockResolvedValueOnce({ Items: [{ PK: 'ignored', SK: 'EVENT#event-1', entityType: 'BILLING_USAGE_EVENT', ...event }] }).mockResolvedValueOnce({ Items: [{ PK: 'ignored', SK: 'LOT#lot-1', entityType: 'BILLING_CREDIT_LOT', version: 2, ...lot }] });
    const repository = new BillingDynamoRepository({ send } as unknown as DynamoDBDocumentClient, 'billing-table');
    await expect(repository.listUsageEvents(scope)).resolves.toEqual([event]);
    await expect(repository.listCreditLots(scope)).resolves.toEqual([{ ...lot, version: 2 }]);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues[':pk']).toBe('BILLING#EVERSALLY#test#ca-central-1#space-1');
  });
});
