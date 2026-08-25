import { randomUUID } from 'crypto';
import { BillingLedger, BillingScope, deliveryThresholdsCrossed } from './billing';

export interface StorageReconciliation {
  reconciliationId: string;
  scope: BillingScope;
  inventoryBytes: number;
  ledgerBytesBefore: number;
  differenceBytes: number;
  adjustmentEventId?: string;
  observedAt: string;
  sourceReference: string;
}

export interface DeliveryLogWindow {
  windowId: string;
  start: string;
  end: string;
  deliveredBytes: number;
  successfulResponses: number;
  sourceReference: string;
}

export interface DeliveryReviewAction extends BillingScope {
  actionId: string;
  category: 'DELIVERY';
  thresholdPercent: 80 | 90 | 100;
  measuredBytes: number;
  allowanceBytes: number;
  periodStart: string;
  periodEnd: string;
  sourceEventId: string;
  createdAt: string;
  state: 'OPEN';
}

export interface DeliveryMeasurement {
  eventId: string;
  measuredBytes: number;
  measurementLagSeconds: number;
  lastProcessedWindowEnd: string;
  reviewActions: DeliveryReviewAction[];
}

const scopeKey = (scope: BillingScope) => `${scope.product}|${scope.environment}|${scope.dataHomeRegion}|${scope.spaceId}`;
const clone = <T>(value: T): T => structuredClone(value);
const assertNonNegativeInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
};

/** Append-only storage inventory reconciliation and CDN delivery attribution. */
export class UsageMeter {
  private readonly reconciliations = new Map<string, StorageReconciliation>();
  private readonly deliveryWindows = new Map<string, DeliveryMeasurement>();
  private readonly deliveryActions: DeliveryReviewAction[] = [];

  constructor(private readonly ledger: BillingLedger, private readonly now: () => string = () => new Date().toISOString()) {}

  recordStorageDelta(scope: BillingScope, input: { idempotencyKey: string; bytes: number; observedAt: string; assetId: string; sourceSystem?: string }) {
    if (!Number.isSafeInteger(input.bytes) || input.bytes === 0) throw new Error('Storage delta must be a non-zero safe integer');
    return this.ledger.appendUsage(scope, {
      idempotencyKey: `storage:${input.idempotencyKey}`, category: 'STORAGE_BYTES_OBSERVED', quantity: input.bytes,
      baseUnit: 'BYTE', observedAt: input.observedAt, periodKey: 'live', sourceSystem: input.sourceSystem ?? 'asset-lifecycle', referenceId: input.assetId
    });
  }

  reconcileStorage(scope: BillingScope, input: { reconciliationId: string; inventoryBytes: number; observedAt: string; sourceReference: string }): StorageReconciliation {
    assertNonNegativeInteger(input.inventoryBytes, 'Inventory bytes');
    const key = `${scopeKey(scope)}|${input.reconciliationId}`;
    const existing = this.reconciliations.get(key);
    if (existing) return clone(existing);
    const ledgerBytesBefore = this.ledger.balance(scope, undefined, input.observedAt).storageBytes;
    const differenceBytes = input.inventoryBytes - ledgerBytesBefore;
    const adjustment = differenceBytes === 0 ? undefined : this.ledger.appendUsage(scope, {
      idempotencyKey: `storage-reconciliation:${input.reconciliationId}`, category: 'STORAGE_BYTES_ADJUSTMENT', quantity: differenceBytes,
      baseUnit: 'BYTE', observedAt: input.observedAt, periodKey: 'live', sourceSystem: 'object-inventory', referenceId: input.sourceReference
    });
    const reconciliation: StorageReconciliation = {
      reconciliationId: input.reconciliationId, scope: clone(scope), inventoryBytes: input.inventoryBytes, ledgerBytesBefore,
      differenceBytes, adjustmentEventId: adjustment?.eventId, observedAt: input.observedAt, sourceReference: input.sourceReference
    };
    this.reconciliations.set(key, reconciliation);
    return clone(reconciliation);
  }

  ingestDeliveryWindow(scope: BillingScope, period: { start: string; end: string; allowanceBytes: number }, window: DeliveryLogWindow): DeliveryMeasurement {
    assertNonNegativeInteger(window.deliveredBytes, 'Delivered bytes');
    assertNonNegativeInteger(window.successfulResponses, 'Successful responses');
    assertNonNegativeInteger(period.allowanceBytes, 'Delivery allowance');
    if (period.allowanceBytes === 0) throw new Error('Delivery allowance must be positive');
    if (window.end <= window.start || window.start < period.start || window.end > period.end) throw new Error('Delivery window must be contained in the entitlement period');
    const key = `${scopeKey(scope)}|${window.windowId}`;
    const existing = this.deliveryWindows.get(key);
    if (existing) return clone(existing);
    const previousBytes = this.ledger.balance(scope, period, window.end).deliveryBytes;
    const event = this.ledger.appendUsage(scope, {
      idempotencyKey: `delivery-window:${window.windowId}`, category: 'DELIVERY_BYTES_OBSERVED', quantity: window.deliveredBytes,
      baseUnit: 'BYTE', observedAt: window.end, periodKey: period.start.slice(0, 7), sourceSystem: 'delivery-log', referenceId: window.sourceReference
    });
    const measuredBytes = previousBytes + window.deliveredBytes;
    const createdAt = this.now();
    const reviewActions = deliveryThresholdsCrossed(previousBytes, measuredBytes, period.allowanceBytes).map(threshold => ({
      ...scope, actionId: randomUUID(), category: 'DELIVERY' as const, thresholdPercent: threshold as 80 | 90 | 100,
      measuredBytes, allowanceBytes: period.allowanceBytes, periodStart: period.start, periodEnd: period.end,
      sourceEventId: event.eventId, createdAt, state: 'OPEN' as const
    }));
    this.deliveryActions.push(...reviewActions);
    const measurement: DeliveryMeasurement = {
      eventId: event.eventId, measuredBytes,
      measurementLagSeconds: Math.max(0, Math.floor((new Date(createdAt).getTime() - new Date(window.end).getTime()) / 1000)),
      lastProcessedWindowEnd: window.end, reviewActions
    };
    this.deliveryWindows.set(key, measurement);
    return clone(measurement);
  }

  listDeliveryActions(scope: BillingScope): DeliveryReviewAction[] {
    return this.deliveryActions.filter(action => scopeKey(action) === scopeKey(scope)).map(clone);
  }
}
