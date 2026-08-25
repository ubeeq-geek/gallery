import { createRegionalDeliveryRevocation, processRegionalDeliveryRevocation } from '../src/regionalDeliveryRevocation';

describe('regional public delivery revocation', () => {
  it('creates a deterministic cell-scoped invalidation command', () => {
    const input = { product: 'nightframe' as const, environment: 'production', dataHomeRegion: 'eu-central-1' as const, assetId: 'asset_123', scanGroupId: 'scan-group-1', reasonCode: 'SPECIALIST_HASH_SIGNAL' };
    const first = createRegionalDeliveryRevocation({ ...input, createdAt: '2026-08-25T00:00:00.000Z' });
    const retry = createRegionalDeliveryRevocation({ ...input, createdAt: '2026-08-25T00:01:00.000Z' });
    expect(first.id).toBe(retry.id);
    expect(first.callerReference).toBe(retry.callerReference);
    expect(first).toMatchObject({ recordType: 'DELIVERY_REVOCATION_OUTBOX', paths: ['/assets/asset_123/*'], state: 'PENDING' });
  });

  it('rejects identifiers that could escape the public asset prefix', () => {
    expect(() => createRegionalDeliveryRevocation({ product: 'eversally', environment: 'test', dataHomeRegion: 'us-east-2', assetId: '../private', scanGroupId: 'group', reasonCode: 'RESTRICTED_HIGH_RISK_COMBINATION' })).toThrow('not safe');
  });

  it('invalidates and records completion only in the owning product and region cell', async () => {
    const command = createRegionalDeliveryRevocation({ product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2', assetId: 'asset', scanGroupId: 'group', reasonCode: 'SPECIALIST_HASH_SIGNAL' });
    const invalidate = jest.fn().mockResolvedValue({ invalidationId: 'invalidation-1' });
    const markComplete = jest.fn().mockResolvedValue(undefined);
    await processRegionalDeliveryRevocation(command, { product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2' }, { invalidate }, { markComplete });
    expect(invalidate).toHaveBeenCalledWith({ paths: ['/assets/asset/*'], callerReference: command.callerReference });
    expect(markComplete).toHaveBeenCalledWith(expect.objectContaining({ state: 'COMPLETE', invalidationId: 'invalidation-1' }));
    await expect(processRegionalDeliveryRevocation(command, { product: 'nightframe', environment: 'production', dataHomeRegion: 'us-east-2' }, { invalidate }, { markComplete })).rejects.toThrow('Cross-cell');
  });
});
