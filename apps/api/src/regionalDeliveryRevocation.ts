import { createHash } from 'node:crypto';
import type { ManagedProduct, ManagedRegion } from './regionalMedia';

export interface RegionalDeliveryRevocation {
  id: string;
  recordType: 'DELIVERY_REVOCATION_OUTBOX';
  product: ManagedProduct;
  environment: string;
  dataHomeRegion: ManagedRegion;
  assetId: string;
  scanGroupId: string;
  paths: string[];
  callerReference: string;
  state: 'PENDING';
  reasonCode: string;
  createdAt: string;
}

const safePathSegment = (value: string): string => {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Asset identifier is not safe for a public delivery path');
  return value;
};

/** Creates an idempotent command to be written atomically with a regional hold. */
export const createRegionalDeliveryRevocation = (input: {
  product: ManagedProduct; environment: string; dataHomeRegion: ManagedRegion; assetId: string;
  scanGroupId: string; reasonCode: string; createdAt?: string;
}): RegionalDeliveryRevocation => {
  const assetId = safePathSegment(input.assetId);
  const digest = createHash('sha256').update([input.product, input.environment, input.dataHomeRegion, assetId, input.scanGroupId].join('\u0000')).digest('hex');
  return {
    ...input, assetId, id: `revocation-${digest}`, recordType: 'DELIVERY_REVOCATION_OUTBOX',
    paths: [`/assets/${assetId}/*`], callerReference: `regional-hold-${digest}`, state: 'PENDING',
    createdAt: input.createdAt || new Date().toISOString()
  };
};

export interface RegionalDeliveryInvalidator {
  invalidate(input: { paths: string[]; callerReference: string }): Promise<{ invalidationId: string }>;
}

export interface RegionalDeliveryRevocationRepository {
  markComplete(input: Omit<RegionalDeliveryRevocation, 'state'> & { state: 'COMPLETE'; invalidationId: string; completedAt: string }): Promise<void>;
}

/** Executes only in the command's owning cell and records the provider invalidation identifier. */
export const processRegionalDeliveryRevocation = async (
  command: RegionalDeliveryRevocation,
  cell: { product: ManagedProduct; environment: string; dataHomeRegion: ManagedRegion },
  invalidator: RegionalDeliveryInvalidator,
  repository: RegionalDeliveryRevocationRepository
): Promise<void> => {
  if (command.product !== cell.product || command.environment !== cell.environment || command.dataHomeRegion !== cell.dataHomeRegion) {
    throw new Error('Cross-cell delivery revocation rejected');
  }
  const { invalidationId } = await invalidator.invalidate({ paths: command.paths, callerReference: command.callerReference });
  await repository.markComplete({ ...command, state: 'COMPLETE', invalidationId, completedAt: new Date().toISOString() });
};
