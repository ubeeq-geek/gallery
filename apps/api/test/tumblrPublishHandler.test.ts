import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { processTumblrPublishBatch } from '../src/tumblrPublishHandler';

const record = (messageId: string, body: string): SQSRecord => ({
  messageId, receiptHandle: messageId, body, attributes: { ApproximateReceiveCount: '1', SentTimestamp: '0', SenderId: 'test', ApproximateFirstReceiveTimestamp: '0' },
  messageAttributes: {}, md5OfBody: '', eventSource: 'aws:sqs', eventSourceARN: 'arn:aws:sqs:test:queue', awsRegion: 'ca-central-1'
});

describe('Tumblr publish SQS handler', () => {
  test('returns only failed records so successful publications are not redelivered', async () => {
    const processed: string[] = [];
    const event = { Records: [record('ok', JSON.stringify({ publicationId: 'publication-ok' })), record('failed', JSON.stringify({ publicationId: 'publication-failed' })), record('invalid', '{')] } as SQSEvent;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await processTumblrPublishBatch(event, async (publicationId) => {
      if (publicationId === 'publication-failed') throw new Error('temporary failure');
      processed.push(publicationId);
    });
    expect(processed).toEqual(['publication-ok']);
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'failed' }, { itemIdentifier: 'invalid' }] });
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});
