import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { loadConfig } from './config';
import { DynamoStore } from './dynamoStore';
import { processTumblrPublication } from './tumblrPublishing';
import { createTumblrPublishQueue } from './tumblrPublishQueue';

const config = loadConfig();
const store = new DynamoStore(config);
const queue = createTumblrPublishQueue(config);

export const processTumblrPublishBatch = async (event: SQSEvent, process: (publicationId: string) => Promise<void>): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const payload = JSON.parse(record.body) as { publicationId?: unknown };
      if (typeof payload.publicationId !== 'string' || !payload.publicationId.trim()) throw new Error('Tumblr publication message is missing publicationId.');
      await process(payload.publicationId);
    } catch (error) {
      console.error('[tumblr-worker]', JSON.stringify({ action: 'tumblr.publish.message_failed', messageId: record.messageId, error: error instanceof Error ? error.message : 'Unknown batch error.' }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  if (!store.tumblrRepository) throw new Error('Tumblr persistence is not configured.');
  return processTumblrPublishBatch(event, (publicationId) => processTumblrPublication(store.tumblrRepository!, config, publicationId, queue));
};
