import type { SQSHandler } from 'aws-lambda';
import { createCommunityDeliveryQueue } from './communityDeliveryQueue';
import { loadConfig } from './config';
import { processDiscordDelivery } from './discordCommunity';
import { DynamoStore } from './dynamoStore';

const config = loadConfig();
const store = new DynamoStore(config);
const queue = createCommunityDeliveryQueue(config);

export const handler: SQSHandler = async (event) => {
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    try {
      const payload = JSON.parse(record.body) as { communityDeliveryId?: string };
      if (!payload.communityDeliveryId) throw new Error('Discord community delivery message is missing communityDeliveryId');
      await processDiscordDelivery(store, config, payload.communityDeliveryId, queue.enqueue.bind(queue));
    } catch (error) {
      console.error('[discord-community-delivery] processing failed', {
        message: error instanceof Error ? error.message : 'Unknown failure'
      });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};
