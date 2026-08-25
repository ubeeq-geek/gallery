import {
  PROCESSING_PRICE_BOOK,
  availableProcessingCredits,
  createProcessingReservation,
  dynamoRegionalBillingRepository,
  processingUsageRecord,
  quoteMediaProcessing,
  reconstructProcessingBalance
} from '../src/regionalBilling';
import type { MediaVersion } from '../src/regionalMedia';

describe('regional processing billing', () => {
  const image: MediaVersion = { id: 'image-v1', assetId: 'asset', sha256: 'hash', perceptualFingerprintRefs: [], region: 'us-east-2', ingestSource: 'creator_upload', scanRequiredAt: '2026-08-25T00:00:00.000Z', mediaType: 'image' };
  const video: MediaVersion = { ...image, id: 'video-v1', mediaType: 'video', durationSeconds: 61 };
  const identity = { product: 'eversally' as const, environment: 'production', dataHomeRegion: 'us-east-2' as const, accountId: 'account', creatorId: 'creator', spaceId: 'space', assetId: 'asset', mediaVersionId: image.id, scanGroupId: 'group' };

  it('creates an immutable, versioned quote that explains started-minute pricing', () => {
    expect(quoteMediaProcessing(image)).toMatchObject({ creditUnits: 1, priceBookVersion: PROCESSING_PRICE_BOOK.version, unit: 'PROCESSING_CREDIT', currency: 'CREDIT' });
    expect(quoteMediaProcessing(video)).toMatchObject({ creditUnits: 50, calculation: '2 started minute(s) × 25 credits' });
  });

  it('uses one stable reservation identity for retries', () => {
    const first = createProcessingReservation({ ...identity, media: image, now: new Date('2026-08-25T01:00:00.000Z') });
    const retry = createProcessingReservation({ ...identity, media: image, now: new Date('2026-08-25T01:01:00.000Z') });
    expect(first.id).toBe(retry.id);
    expect(first).toMatchObject({ period: '2026-08', state: 'RESERVED', creditUnits: 1 });
  });
  it('assigns usage to the reservation period at a UTC month boundary', () => { const december = createProcessingReservation({ ...identity, media: image, now: new Date('2026-12-31T23:59:59.999Z') }); const january = createProcessingReservation({ ...identity, mediaVersionId: 'image-v2', scanGroupId: 'group-2', media: image, now: new Date('2027-01-01T00:00:00.000Z') }); expect(december.period).toBe('2026-12'); expect(january.period).toBe('2027-01'); expect(processingUsageRecord({ reservation: december, media: image, createdAt: '2027-01-01T00:01:00.000Z' }).period).toBe('2026-12'); });

  it('posts usage only for the explicit scan-group policy completion event', () => {
    const reservation = createProcessingReservation({ ...identity, media: image, now: new Date('2026-08-25T01:00:00.000Z') });
    expect(processingUsageRecord({ reservation, media: image, createdAt: '2026-08-25T01:05:00.000Z' })).toMatchObject({
      recordType: 'MEDIA_PROCESSING_USAGE', billableEvent: 'SCAN_GROUP_POLICY_COMPLETED', reservationId: reservation.id,
      priceBookVersion: PROCESSING_PRICE_BOOK.version, creditUnits: 1
    });
  });

  it('reconstructs grants, reservations, consumption, releases, refunds, and expiration', () => {
    const balance = reconstructProcessingBalance('account', '2026-08', [
      { type: 'GRANTED', creditUnits: 100 }, { type: 'RESERVED', reservationId: 'one', creditUnits: 50 },
      { type: 'CONSUMED', reservationId: 'one', creditUnits: 50 }, { type: 'RESERVED', reservationId: 'two', creditUnits: 10 },
      { type: 'RELEASED', reservationId: 'two', creditUnits: 10 }, { type: 'REFUNDED', creditUnits: 5 }, { type: 'EXPIRED', creditUnits: 10 }
    ]);
    expect(balance).toMatchObject({ grantedCreditUnits: 100, reservedCreditUnits: 0, consumedCreditUnits: 50, refundedCreditUnits: 5, expiredCreditUnits: 10 });
    expect(availableProcessingCredits(balance)).toBe(45);
  });

  it('rejects duplicate and invalid reservation lifecycle events', () => {
    expect(() => reconstructProcessingBalance('account', '2026-08', [
      { type: 'RESERVED', reservationId: 'one', creditUnits: 1 }, { type: 'RESERVED', reservationId: 'one', creditUnits: 1 }
    ])).toThrow('already recorded');
    expect(() => reconstructProcessingBalance('account', '2026-08', [{ type: 'CONSUMED', reservationId: 'missing', creditUnits: 1 }])).toThrow('invalid');
  });

  it('uses a conditional atomic balance update to prevent concurrent overspend', async () => {
    const send = jest.fn().mockResolvedValue({}); const repository = dynamoRegionalBillingRepository({ client: { send } as any, tableName: 'billing' });
    await repository.reserve({ ...identity, media: image, now: new Date('2026-08-25T01:00:00.000Z') });
    const transaction = send.mock.calls[0][0].input.TransactItems;
    expect(transaction[0].Update.ConditionExpression).toContain('grantedCreditUnits + refundedCreditUnits - expiredCreditUnits - reservedCreditUnits - consumedCreditUnits >= :units');
    expect(transaction[1].Put.ConditionExpression).toBe('attribute_not_exists(PK)');
  });
  it('queries every page of the account-period index without scanning the ledger', async () => { const send = jest.fn().mockResolvedValueOnce({ Items: [{ PK: 'USAGE#1' }], LastEvaluatedKey: { PK: 'USAGE#1' } }).mockResolvedValueOnce({ Items: [{ PK: 'REFUND#1' }] }); const repository = dynamoRegionalBillingRepository({ client: { send } as any, tableName: 'billing' }); await expect(repository.listAccountPeriod('account', '2026-08')).resolves.toEqual([{ PK: 'USAGE#1' }, { PK: 'REFUND#1' }]); expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[0][0].input).toMatchObject({ TableName: 'billing', IndexName: 'account-period-index', KeyConditionExpression: 'GSI1PK = :accountPeriod', ExpressionAttributeValues: { ':accountPeriod': 'ACCOUNT#account#PERIOD#2026-08' } }); expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ PK: 'USAGE#1' }); });

  it('fails closed when a conditional reservation loses a balance race', async () => {
    const conflict = Object.assign(new Error('conditional conflict'), { name: 'TransactionCanceledException' });
    const send = jest.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({});
    const repository = dynamoRegionalBillingRepository({ client: { send } as any, tableName: 'billing' });
    await expect(repository.reserve({ ...identity, media: image, now: new Date('2026-08-25T01:00:00.000Z') })).rejects.toMatchObject({ name: 'ProcessingEntitlementExhausted' });
  });

  it('treats a replayed identical grant as an idempotent success', async () => {
    const conflict = Object.assign(new Error('duplicate'), { name: 'TransactionCanceledException' });
    const send = jest.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({ Item: { accountId: 'account', period: '2026-08', creditUnits: 100, sourceId: 'invoice-line' } });
    const repository = dynamoRegionalBillingRepository({ client: { send } as any, tableName: 'billing' });
    await expect(repository.grant({ accountId: 'account', period: '2026-08', creditUnits: 100, sourceId: 'invoice-line' })).resolves.toBeUndefined();
  });
  it('guards refunds and expirations against the authoritative balance', async () => { const send = jest.fn().mockResolvedValue({}); const repository = dynamoRegionalBillingRepository({ client: { send } as any, tableName: 'billing' }); await repository.refund({ usageId: 'usage', accountId: 'account', period: '2026-08', creditUnits: 5, reason: 'correction' }); await repository.expire({ accountId: 'account', period: '2026-08', creditUnits: 10, sourceId: 'grant-expiry' }); expect(send.mock.calls[0][0].input.TransactItems[0].Update.ConditionExpression).toContain('consumedCreditUnits - refundedCreditUnits >= :units'); expect(send.mock.calls[1][0].input.TransactItems[0].Update.ConditionExpression).toContain('reservedCreditUnits - consumedCreditUnits >= :units'); });
  it('treats replayed atomic consumption as success only when immutable usage matches', async () => { const reservation = createProcessingReservation({ ...identity, media: image, now: new Date('2026-08-25T00:00:00.000Z') }); const usage = processingUsageRecord({ reservation, media: image }); const conflict = Object.assign(new Error('duplicate'), { name: 'TransactionCanceledException' }); const send = jest.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce({ Item: usage }); const repository = dynamoRegionalBillingRepository({ client: { send } as any, tableName: 'billing' }); await expect(repository.finalize({ reservationId: reservation.id, usage })).resolves.toBeUndefined(); });
});
