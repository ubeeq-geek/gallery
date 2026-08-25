import { marshall } from '@aws-sdk/util-dynamodb';
import { createRegionalScanOutboxHandler, scanDispatchOutbox } from '../src/regionalScanOutboxHandler';

const job = { id: 'scan', product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2', createdAt: 'now' } as any;
const stream = (record: unknown, eventName = 'INSERT') => ({ Records: [{ eventID: 'event', eventName, dynamodb: { NewImage: marshall(record as any, { removeUndefinedValues: true }) } }] }) as any;

describe('regional scan dispatch outbox', () => {
  it('creates deterministic cell-scoped records and dispatches inserts', async () => {
    const record = scanDispatchOutbox(job); const dispatch = jest.fn();
    expect(record.id).toBe('outbox-scan');
    await expect(createRegionalScanOutboxHandler({ cell: { product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2' }, dispatch })(stream(record))).resolves.toEqual({ batchItemFailures: [] });
    expect(dispatch).toHaveBeenCalledWith(record);
  });
  it('ignores updates and unrelated records', async () => {
    const dispatch = jest.fn(); const handler = createRegionalScanOutboxHandler({ cell: { product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2' }, dispatch });
    await handler(stream(scanDispatchOutbox(job), 'MODIFY'));
    await handler(stream({ id: 'result', recordType: 'SCAN_RESULT' }));
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('retries failed and cross-cell records independently', async () => {
    const handler = createRegionalScanOutboxHandler({ cell: { product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2' }, dispatch: jest.fn().mockRejectedValue(new Error('SQS unavailable')) });
    await expect(handler(stream(scanDispatchOutbox(job)))).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'event' }] });
    await expect(handler(stream(scanDispatchOutbox({ ...job, product: 'nightframe' })))).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'event' }] });
  });
});
