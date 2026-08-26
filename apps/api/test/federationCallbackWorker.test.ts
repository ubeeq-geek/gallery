import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { FederationCallbackDynamoPersistence, createFederationCallbackWorker, parseFederationCallbackQueueMessage } from '../src/federationCallbackWorker';

const message = () => ({ job: { id: 'callback-1', idempotencyKey: 'callback:1', operation: 'status.callback', status: 'queued', attemptCount: 0, createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z' }, callback: { callbackId: 'callback-1', actorUri: 'https://nightfra.me/actors/1', homeInstanceId: 'nightframe', destinationInstanceId: 'eversally', event: 'publication.status', status: 'published', occurredAt: '2026-08-26T00:00:00.000Z' }, targetOrigin: 'https://nightfra.me' });
const record = (messageId: string, body: string): SQSRecord => ({ messageId, receiptHandle: '', body, attributes: {} as never, messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs', eventSourceARN: '', awsRegion: 'ca-central-1' });

describe('federation callback worker', () => {
  it('rejects arbitrary targets, mismatched ids, and completed jobs', () => {
    expect(() => parseFederationCallbackQueueMessage(JSON.stringify({ ...message(), targetOrigin: 'http://nightfra.me' }))).toThrow('HTTPS origin');
    expect(() => parseFederationCallbackQueueMessage(JSON.stringify({ ...message(), callback: { ...message().callback, callbackId: 'other' } }))).toThrow('identifiers');
    expect(() => parseFederationCallbackQueueMessage(JSON.stringify({ ...message(), job: { ...message().job, status: 'delivered' } }))).toThrow('not queued');
  });
  it('reports only malformed or failed records for SQS partial retry', async () => {
    const deliver = jest.fn(async (value: ReturnType<typeof message>) => { if (value.job.id === 'callback-fail') throw new Error('storage down'); return value.job; });
    const failed = message(); failed.job.id = 'callback-fail'; failed.callback.callbackId = 'callback-fail';
    const event = { Records: [record('ok', JSON.stringify(message())), record('bad-json', '{'), record('failed', JSON.stringify(failed))] } as SQSEvent;
    await expect(createFederationCallbackWorker({ deliver } as never)(event)).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'bad-json' }, { itemIdentifier: 'failed' }] });
    expect(deliver).toHaveBeenCalledTimes(2);
  });
  it('persists payloads immutably and conditionally advances attempts', async () => {
    const send = jest.fn<Promise<{ Item: { record: ReturnType<typeof message> } }>, [any]>(async () => ({ Item: { record: message() } })); const repository = new FederationCallbackDynamoPersistence({ send } as never, 'core', 'eversally');
    await repository.create(message() as never);
    await repository.update({ ...message().job, status: 'delivered', attemptCount: 1 } as never);
    expect(send.mock.calls[0][0].input.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(send.mock.calls[2][0].input.ConditionExpression).toContain('attempt');
    expect(send.mock.calls[2][0].input.ExpressionAttributeValues[':previous']).toBe(0);
  });
});
