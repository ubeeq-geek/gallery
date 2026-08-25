import type { DynamoDBStreamEvent } from 'aws-lambda';
import { marshall } from '@aws-sdk/util-dynamodb';
import { createRegionalDeliveryRevocation } from '../src/regionalDeliveryRevocation';
import { createRegionalDeliveryRevocationHandler } from '../src/regionalDeliveryRevocationHandler';

describe('regional delivery revocation stream handler', () => {
  it('processes inserted pending outbox records and ignores unrelated records', async () => {
    const command = createRegionalDeliveryRevocation({ product: 'eversally', environment: 'test', dataHomeRegion: 'us-east-2', assetId: 'asset', scanGroupId: 'group', reasonCode: 'SPECIALIST_HASH_SIGNAL' });
    const invalidate = jest.fn().mockResolvedValue({ invalidationId: 'invalidate-1' });
    const markComplete = jest.fn().mockResolvedValue(undefined);
    const handler = createRegionalDeliveryRevocationHandler({ product: 'eversally', environment: 'test', dataHomeRegion: 'us-east-2', invalidator: { invalidate }, repository: { markComplete } });
    await handler({ Records: [
      { eventName: 'MODIFY', dynamodb: { NewImage: marshall(command) } },
      { eventName: 'INSERT', dynamodb: { NewImage: marshall(command) } }
    ] } as unknown as DynamoDBStreamEvent, {} as any, () => undefined);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(markComplete).toHaveBeenCalledWith(expect.objectContaining({ invalidationId: 'invalidate-1', state: 'COMPLETE' }));
  });
});
