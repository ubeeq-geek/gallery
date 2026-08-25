import { BillingLedger, BillingScope } from '../src/billing';
import { UsageMeter } from '../src/billingUsage';

const scope: BillingScope = { product: 'EVERSALLY', environment: 'test', spaceId: 'space-1', dataHomeRegion: 'ca-central-1' };
const period = { start: '2026-08-01T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z', allowanceBytes: 100 };

describe('storage and delivery metering', () => {
  test('records asset deltas and reconciles inventory differences with an explicit adjustment', () => {
    const ledger = new BillingLedger();
    const meter = new UsageMeter(ledger);
    meter.recordStorageDelta(scope, { idempotencyKey: 'asset-1-finalized', bytes: 100, observedAt: '2026-08-02T00:00:00.000Z', assetId: 'asset-1' });
    const result = meter.reconcileStorage(scope, { reconciliationId: 'inventory-2026-08-03', inventoryBytes: 90, observedAt: '2026-08-03T00:00:00.000Z', sourceReference: 's3-inventory-42' });
    expect(result).toMatchObject({ ledgerBytesBefore: 100, differenceBytes: -10 });
    expect(result.adjustmentEventId).toBeDefined();
    expect(ledger.balance(scope, undefined, '2026-08-03T00:00:00.000Z').storageBytes).toBe(90);
    expect(meter.reconcileStorage(scope, { reconciliationId: 'inventory-2026-08-03', inventoryBytes: 999, observedAt: '2026-08-03T00:00:00.000Z', sourceReference: 'changed' })).toEqual(result);
  });

  test('creates auditable reviews at delivery thresholds without blocking delivery', () => {
    const ledger = new BillingLedger();
    const meter = new UsageMeter(ledger, () => '2026-08-25T12:00:00.000Z');
    const first = meter.ingestDeliveryWindow(scope, period, { windowId: 'cdn-1', start: '2026-08-25T10:00:00.000Z', end: '2026-08-25T11:00:00.000Z', deliveredBytes: 79, successfulResponses: 5, sourceReference: 'cdn-log-1' });
    expect(first.reviewActions).toHaveLength(0);
    const crossed = meter.ingestDeliveryWindow(scope, period, { windowId: 'cdn-2', start: '2026-08-25T11:00:00.000Z', end: '2026-08-25T11:30:00.000Z', deliveredBytes: 22, successfulResponses: 2, sourceReference: 'cdn-log-2' });
    expect(crossed).toMatchObject({ measuredBytes: 101, measurementLagSeconds: 1800, lastProcessedWindowEnd: '2026-08-25T11:30:00.000Z' });
    expect(crossed.reviewActions.map(action => action.thresholdPercent)).toEqual([80, 90, 100]);
    expect(meter.listDeliveryActions(scope)).toHaveLength(3);
    expect(ledger.balance(scope, period, '2026-08-25T12:00:00.000Z').deliveryBytes).toBe(101);
  });

  test('deduplicates replayed delivery windows without duplicate usage or alerts', () => {
    const ledger = new BillingLedger();
    const meter = new UsageMeter(ledger, () => '2026-08-25T12:00:00.000Z');
    const window = { windowId: 'cdn-replay', start: '2026-08-25T10:00:00.000Z', end: '2026-08-25T11:00:00.000Z', deliveredBytes: 90, successfulResponses: 5, sourceReference: 'cdn-log' };
    const first = meter.ingestDeliveryWindow(scope, period, window);
    expect(meter.ingestDeliveryWindow(scope, period, { ...window, deliveredBytes: 999 })).toEqual(first);
    expect(ledger.balance(scope, period).deliveryBytes).toBe(90);
    expect(meter.listDeliveryActions(scope).map(action => action.thresholdPercent)).toEqual([80, 90]);
  });
});
