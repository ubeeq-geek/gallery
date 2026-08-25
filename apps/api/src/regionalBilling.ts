import { createHash } from 'node:crypto';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { usageForMedia, type ManagedProduct, type ManagedRegion, type MediaProcessingLedgerEntry, type MediaVersion } from './regionalMedia';

export const PROCESSING_PRICE_BOOK = {
  version: 'regional-processing-2026-08-25',
  effectiveAt: '2026-08-25T00:00:00.000Z',
  unit: 'PROCESSING_CREDIT' as const,
  currency: 'CREDIT' as const,
  imageCredits: 1,
  videoCreditsPerStartedMinute: 25,
  estimatedProviderCostUsdPerAnalysisCall: 0.001
} as const;

export type ProcessingReservationState = 'RESERVED' | 'CONSUMED' | 'RELEASED' | 'EXPIRED';
export interface ProcessingChargeQuote {
  creditUnits: number;
  priceBookVersion: string;
  priceBookEffectiveAt: string;
  unit: typeof PROCESSING_PRICE_BOOK.unit;
  currency: typeof PROCESSING_PRICE_BOOK.currency;
  calculation: string;
}

export interface ProcessingReservation extends ProcessingChargeQuote {
  id: string;
  recordType: 'PROCESSING_CREDIT_RESERVATION';
  product: ManagedProduct;
  environment: string;
  dataHomeRegion: ManagedRegion;
  accountId: string;
  creatorId: string;
  spaceId: string;
  assetId: string;
  mediaVersionId: string;
  scanGroupId: string;
  period: string;
  state: ProcessingReservationState;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  releasedAt?: string;
  releaseReason?: string;
}

export interface ProcessingCreditBalance {
  accountId: string;
  period: string;
  grantedCreditUnits: number;
  reservedCreditUnits: number;
  consumedCreditUnits: number;
  refundedCreditUnits: number;
  expiredCreditUnits: number;
  overagePermitted: boolean;
}

export interface VersionedMediaProcessingLedgerEntry extends MediaProcessingLedgerEntry, ProcessingChargeQuote {
  id: string;
  recordType: 'MEDIA_PROCESSING_USAGE';
  environment: string;
  accountId: string;
  assetId: string;
  mediaVersionId: string;
  scanGroupId: string;
  reservationId: string;
  billableEvent: 'SCAN_GROUP_POLICY_COMPLETED';
  createdAt: string;
  GSI1PK: string;
  GSI1SK: string;
}

export const billingPeriod = (date: Date): string => date.toISOString().slice(0, 7);
export const processingBalanceKey = (accountId: string, period: string): string => `BALANCE#${accountId}#${period}`;
export const processingAccountPeriodKey = (accountId: string, period: string): string => `ACCOUNT#${accountId}#PERIOD#${period}`;
const ledgerIndex = (accountId: string, period: string, sort: string) => ({ GSI1PK: processingAccountPeriodKey(accountId, period), GSI1SK: sort });
export const processingReservationKey = (mediaVersionId: string, scanGroupId: string): string => `RESERVATION#${createHash('sha256').update(`${mediaVersionId}\0${scanGroupId}`).digest('hex')}`;
export const processingUsageKey = (mediaVersionId: string, scanGroupId: string): string => `USAGE#${createHash('sha256').update(`${mediaVersionId}\0${scanGroupId}`).digest('hex')}`;

export const quoteMediaProcessing = (media: Pick<MediaVersion, 'mediaType' | 'durationSeconds'>): ProcessingChargeQuote => {
  if (media.mediaType === 'video' && (!Number.isFinite(media.durationSeconds) || (media.durationSeconds || 0) <= 0)) throw new Error('Validated video duration is required for a processing quote');
  const startedMinutes = media.mediaType === 'video' ? Math.ceil((media.durationSeconds || 0) / 60) : 0;
  return {
    creditUnits: media.mediaType === 'image' ? PROCESSING_PRICE_BOOK.imageCredits : startedMinutes * PROCESSING_PRICE_BOOK.videoCreditsPerStartedMinute,
    priceBookVersion: PROCESSING_PRICE_BOOK.version,
    priceBookEffectiveAt: PROCESSING_PRICE_BOOK.effectiveAt,
    unit: PROCESSING_PRICE_BOOK.unit,
    currency: PROCESSING_PRICE_BOOK.currency,
    calculation: media.mediaType === 'image'
      ? `${PROCESSING_PRICE_BOOK.imageCredits} credit per source image`
      : `${startedMinutes} started minute(s) × ${PROCESSING_PRICE_BOOK.videoCreditsPerStartedMinute} credits`
  };
};

export const availableProcessingCredits = (balance: ProcessingCreditBalance): number =>
  balance.grantedCreditUnits + balance.refundedCreditUnits - balance.expiredCreditUnits - balance.reservedCreditUnits - balance.consumedCreditUnits;

/** Reconstructs a balance from immutable grants and reservation lifecycle events. */
export const reconstructProcessingBalance = (accountId: string, period: string, events: Array<
  | { type: 'GRANTED' | 'REFUNDED' | 'EXPIRED'; creditUnits: number; overagePermitted?: boolean }
  | { type: 'RESERVED' | 'CONSUMED' | 'RELEASED'; reservationId: string; creditUnits: number }
>): ProcessingCreditBalance => {
  const result: ProcessingCreditBalance = { accountId, period, grantedCreditUnits: 0, reservedCreditUnits: 0, consumedCreditUnits: 0, refundedCreditUnits: 0, expiredCreditUnits: 0, overagePermitted: false };
  const reservations = new Map<string, { creditUnits: number; state: 'RESERVED' | 'CONSUMED' | 'RELEASED' }>();
  for (const event of events) {
    if (!Number.isSafeInteger(event.creditUnits) || event.creditUnits <= 0) throw new Error('Credit lifecycle quantities must be positive integers');
    if (event.type === 'GRANTED') { result.grantedCreditUnits += event.creditUnits; result.overagePermitted ||= event.overagePermitted === true; continue; }
    if (event.type === 'REFUNDED') { result.refundedCreditUnits += event.creditUnits; continue; }
    if (event.type === 'EXPIRED') { result.expiredCreditUnits += event.creditUnits; continue; }
    if (!('reservationId' in event)) throw new Error('Reservation lifecycle is invalid');
    const current = reservations.get(event.reservationId);
    if (event.type === 'RESERVED') {
      if (current) throw new Error('Reservation was already recorded');
      reservations.set(event.reservationId, { creditUnits: event.creditUnits, state: 'RESERVED' }); result.reservedCreditUnits += event.creditUnits; continue;
    }
    if (!current || current.state !== 'RESERVED' || current.creditUnits !== event.creditUnits) throw new Error('Reservation lifecycle is invalid');
    result.reservedCreditUnits -= event.creditUnits;
    if (event.type === 'CONSUMED') { result.consumedCreditUnits += event.creditUnits; current.state = 'CONSUMED'; }
    else current.state = 'RELEASED';
  }
  return result;
};

export interface ProcessingReservationInput {
  product: ManagedProduct; environment: string; dataHomeRegion: ManagedRegion; accountId: string; creatorId: string; spaceId: string;
  assetId: string; mediaVersionId: string; scanGroupId: string; media: Pick<MediaVersion, 'mediaType' | 'durationSeconds'>; now?: Date;
}

export interface RegionalBillingRepository {
  listAccountPeriod(accountId: string, period: string): Promise<Record<string, unknown>[]>;
  grant(input: { accountId: string; period: string; creditUnits: number; sourceId: string; overagePermitted?: boolean; expiresAt?: string; now?: Date }): Promise<void>;
  reserve(input: ProcessingReservationInput): Promise<ProcessingReservation>;
  finalize(input: { reservationId: string; usage: VersionedMediaProcessingLedgerEntry; now?: Date }): Promise<void>;
  release(input: { reservationId: string; reason: string; now?: Date }): Promise<void>;
  releaseExpired(input: { reservationId: string; now?: Date }): Promise<void>;
  refund(input: { usageId: string; accountId: string; period: string; creditUnits: number; reason: string; now?: Date }): Promise<void>;
  expire(input: { accountId: string; period: string; creditUnits: number; sourceId: string; now?: Date }): Promise<void>;
}

export const createProcessingReservation = (input: ProcessingReservationInput): ProcessingReservation => {
  const now = input.now || new Date(); const period = billingPeriod(now); const quote = quoteMediaProcessing(input.media); const { media: _media, now: _now, ...identity } = input;
  const id = processingReservationKey(input.mediaVersionId, input.scanGroupId); const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  return { id, recordType: 'PROCESSING_CREDIT_RESERVATION', ...identity, ...quote, period, state: 'RESERVED', createdAt: now.toISOString(), expiresAt };
};

export const processingUsageRecord = (input: { reservation: ProcessingReservation; media: MediaVersion; createdAt?: string; estimatedProviderCost?: number }): VersionedMediaProcessingLedgerEntry => {
  const usage = usageForMedia({ product: input.reservation.product, region: input.reservation.dataHomeRegion, creatorId: input.reservation.creatorId, spaceId: input.reservation.spaceId, period: input.reservation.period, media: input.media });
  usage.estimatedProviderCost = input.estimatedProviderCost ?? Number(((usage.moderationCalls + usage.faceAgeCalls) * PROCESSING_PRICE_BOOK.estimatedProviderCostUsdPerAnalysisCall).toFixed(6));
  if (usage.creditUnits !== input.reservation.creditUnits) throw new Error('Final usage does not match the reserved price quote');
  const createdAt = input.createdAt || new Date().toISOString(); const id = processingUsageKey(input.reservation.mediaVersionId, input.reservation.scanGroupId);
  return { ...usage, id, recordType: 'MEDIA_PROCESSING_USAGE', environment: input.reservation.environment, accountId: input.reservation.accountId, assetId: input.reservation.assetId, mediaVersionId: input.reservation.mediaVersionId, scanGroupId: input.reservation.scanGroupId, reservationId: input.reservation.id, billableEvent: 'SCAN_GROUP_POLICY_COMPLETED', priceBookVersion: input.reservation.priceBookVersion, priceBookEffectiveAt: input.reservation.priceBookEffectiveAt, unit: input.reservation.unit, currency: input.reservation.currency, calculation: input.reservation.calculation, createdAt, ...ledgerIndex(input.reservation.accountId, input.reservation.period, `USAGE#${createdAt}#${id}`) };
};

export const dynamoRegionalBillingRepository = (input: { client: DynamoDBDocumentClient; tableName: string }): RegionalBillingRepository => ({
  listAccountPeriod: async (accountId, period) => {
    const records: Record<string, unknown>[] = []; let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await input.client.send(new QueryCommand({ TableName: input.tableName, IndexName: 'account-period-index', KeyConditionExpression: 'GSI1PK = :accountPeriod', ExpressionAttributeValues: { ':accountPeriod': processingAccountPeriodKey(accountId, period) }, ExclusiveStartKey: exclusiveStartKey }));
      records.push(...(response.Items || [])); exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return records;
  },
  grant: async ({ accountId, period, creditUnits, sourceId, overagePermitted = false, expiresAt, now = new Date() }) => {
    if (!Number.isSafeInteger(creditUnits) || creditUnits <= 0) throw new Error('Granted credits must be a positive integer');
    const grantId = `GRANT#${createHash('sha256').update(`${accountId}\0${period}\0${sourceId}`).digest('hex')}`;
    try {
      await input.client.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: input.tableName, Key: { PK: processingBalanceKey(accountId, period) }, UpdateExpression: 'SET accountId = if_not_exists(accountId, :accountId), period = if_not_exists(period, :period), GSI1PK = if_not_exists(GSI1PK, :gsiPk), GSI1SK = if_not_exists(GSI1SK, :balance), grantedCreditUnits = if_not_exists(grantedCreditUnits, :zero) + :units, reservedCreditUnits = if_not_exists(reservedCreditUnits, :zero), consumedCreditUnits = if_not_exists(consumedCreditUnits, :zero), refundedCreditUnits = if_not_exists(refundedCreditUnits, :zero), expiredCreditUnits = if_not_exists(expiredCreditUnits, :zero), overagePermitted = :overage', ExpressionAttributeValues: { ':accountId': accountId, ':period': period, ':gsiPk': processingAccountPeriodKey(accountId, period), ':balance': 'BALANCE', ':zero': 0, ':units': creditUnits, ':overage': overagePermitted } } },
        { Put: { TableName: input.tableName, Item: { PK: grantId, id: grantId, recordType: 'PROCESSING_CREDIT_GRANT', accountId, period, creditUnits, sourceId, overagePermitted, expiresAt, createdAt: now.toISOString(), ...ledgerIndex(accountId, period, `GRANT#${now.toISOString()}#${grantId}`) }, ConditionExpression: 'attribute_not_exists(PK)' } }
      ] }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') throw error;
      const existing = await input.client.send(new GetCommand({ TableName: input.tableName, Key: { PK: grantId }, ConsistentRead: true }));
      if (existing.Item?.accountId !== accountId || existing.Item?.period !== period || existing.Item?.creditUnits !== creditUnits || existing.Item?.sourceId !== sourceId) throw error;
    }
  },
  reserve: async (request) => {
    const reservation = createProcessingReservation(request); const balanceKey = processingBalanceKey(reservation.accountId, reservation.period);
    try {
      await input.client.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: input.tableName, Key: { PK: balanceKey },
          UpdateExpression: 'ADD reservedCreditUnits :units',
          ConditionExpression: 'accountId = :accountId AND period = :period AND (overagePermitted = :true OR grantedCreditUnits + refundedCreditUnits - expiredCreditUnits - reservedCreditUnits - consumedCreditUnits >= :units)',
          ExpressionAttributeValues: { ':units': reservation.creditUnits, ':accountId': reservation.accountId, ':period': reservation.period, ':true': true } } },
        { Put: { TableName: input.tableName, Item: { ...reservation, PK: reservation.id, ...ledgerIndex(reservation.accountId, reservation.period, `RESERVATION#${reservation.createdAt}#${reservation.id}`) }, ConditionExpression: 'attribute_not_exists(PK)' } }
      ] }));
      return reservation;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') throw error;
      const existing = await input.client.send(new GetCommand({ TableName: input.tableName, Key: { PK: reservation.id }, ConsistentRead: true }));
      if (existing.Item?.state === 'RESERVED' && existing.Item.accountId === reservation.accountId && existing.Item.creditUnits === reservation.creditUnits && existing.Item.scanGroupId === reservation.scanGroupId) return existing.Item as ProcessingReservation;
      throw Object.assign(new Error('Processing entitlement is exhausted or unavailable'), { name: 'ProcessingEntitlementExhausted' });
    }
  },
  finalize: async ({ reservationId, usage, now = new Date() }) => {
    try { await input.client.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: input.tableName, Key: { PK: processingBalanceKey(usage.accountId, usage.period) }, UpdateExpression: 'ADD reservedCreditUnits :negative, consumedCreditUnits :units', ConditionExpression: 'accountId = :accountId AND reservedCreditUnits >= :units', ExpressionAttributeValues: { ':negative': -usage.creditUnits, ':units': usage.creditUnits, ':accountId': usage.accountId } } },
      { Update: { TableName: input.tableName, Key: { PK: reservationId }, UpdateExpression: 'SET #state = :consumed, consumedAt = :now REMOVE expiresAtEpochSeconds', ConditionExpression: '#state = :reserved AND accountId = :accountId AND creditUnits = :units', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':consumed': 'CONSUMED', ':reserved': 'RESERVED', ':accountId': usage.accountId, ':units': usage.creditUnits, ':now': now.toISOString() } } },
      { Put: { TableName: input.tableName, Item: { ...usage, PK: usage.id, ...ledgerIndex(usage.accountId, usage.period, `USAGE#${usage.createdAt}#${usage.id}`) }, ConditionExpression: 'attribute_not_exists(PK)' } }
    ] })); } catch (error) { if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') throw error; const existing = await input.client.send(new GetCommand({ TableName: input.tableName, Key: { PK: usage.id }, ConsistentRead: true })); if (existing.Item?.reservationId !== reservationId || existing.Item?.creditUnits !== usage.creditUnits) throw error; }
  },
  release: async ({ reservationId, reason, now = new Date() }) => {
    const response = await input.client.send(new GetCommand({ TableName: input.tableName, Key: { PK: reservationId }, ConsistentRead: true })); const reservation = response.Item as ProcessingReservation | undefined;
    if (!reservation) throw new Error('Processing reservation not found'); if (reservation.state === 'RELEASED') return; if (reservation.state !== 'RESERVED') throw new Error('Only a reserved processing charge can be released');
    await input.client.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: input.tableName, Key: { PK: processingBalanceKey(reservation.accountId, reservation.period) }, UpdateExpression: 'ADD reservedCreditUnits :negative', ConditionExpression: 'reservedCreditUnits >= :units', ExpressionAttributeValues: { ':negative': -reservation.creditUnits, ':units': reservation.creditUnits } } },
      { Update: { TableName: input.tableName, Key: { PK: reservationId }, UpdateExpression: 'SET #state = :released, releasedAt = :now, releaseReason = :reason REMOVE expiresAtEpochSeconds', ConditionExpression: '#state = :reserved', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':released': 'RELEASED', ':reserved': 'RESERVED', ':now': now.toISOString(), ':reason': reason } } }
    ] }));
  },
  releaseExpired: async ({ reservationId, now = new Date() }) => {
    const response = await input.client.send(new GetCommand({ TableName: input.tableName, Key: { PK: reservationId }, ConsistentRead: true })); const reservation = response.Item as ProcessingReservation | undefined;
    if (!reservation || reservation.state !== 'RESERVED') return;
    if (new Date(reservation.expiresAt).getTime() > now.getTime()) throw new Error('Processing reservation has not expired');
    const repository = dynamoRegionalBillingRepository(input);
    await repository.release({ reservationId, reason: 'RESERVATION_EXPIRED', now });
  },
  refund: async ({ usageId, accountId, period, creditUnits, reason, now = new Date() }) => {
    const refundId = `REFUND#${createHash('sha256').update(`${usageId}\0${reason}`).digest('hex')}`;
    await input.client.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: input.tableName, Key: { PK: processingBalanceKey(accountId, period) }, UpdateExpression: 'ADD refundedCreditUnits :units', ConditionExpression: 'accountId = :accountId AND consumedCreditUnits - refundedCreditUnits >= :units', ExpressionAttributeValues: { ':units': creditUnits, ':accountId': accountId } } },
      { Put: { TableName: input.tableName, Item: { PK: refundId, id: refundId, recordType: 'PROCESSING_CREDIT_REFUND', usageId, accountId, period, creditUnits, reason, createdAt: now.toISOString(), ...ledgerIndex(accountId, period, `REFUND#${now.toISOString()}#${refundId}`) }, ConditionExpression: 'attribute_not_exists(PK)' } }
    ] }));
  },
  expire: async ({ accountId, period, creditUnits, sourceId, now = new Date() }) => {
    if (!Number.isSafeInteger(creditUnits) || creditUnits <= 0) throw new Error('Expired credits must be a positive integer');
    const expirationId = `EXPIRATION#${createHash('sha256').update(`${accountId}\0${period}\0${sourceId}`).digest('hex')}`;
    await input.client.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: input.tableName, Key: { PK: processingBalanceKey(accountId, period) }, UpdateExpression: 'ADD expiredCreditUnits :units', ConditionExpression: 'accountId = :accountId AND grantedCreditUnits + refundedCreditUnits - expiredCreditUnits - reservedCreditUnits - consumedCreditUnits >= :units', ExpressionAttributeValues: { ':units': creditUnits, ':accountId': accountId } } },
      { Put: { TableName: input.tableName, Item: { PK: expirationId, id: expirationId, recordType: 'PROCESSING_CREDIT_EXPIRATION', accountId, period, creditUnits, sourceId, createdAt: now.toISOString(), ...ledgerIndex(accountId, period, `EXPIRATION#${now.toISOString()}#${expirationId}`) }, ConditionExpression: 'attribute_not_exists(PK)' } }
    ] }));
  }
});
