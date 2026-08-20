import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { AppConfig } from './config';

export interface CommunityDeliveryQueue { enqueue(communityDeliveryId: string, delaySeconds?: number): Promise<void>; }

export const createInProcessCommunityDeliveryQueue = (process: (id: string) => Promise<void>): CommunityDeliveryQueue => {
  let tail = Promise.resolve();
  return { async enqueue(id: string, delaySeconds = 0) {
    const scheduled = tail.then(async () => {
      if (delaySeconds) await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, delaySeconds) * 1000));
      await process(id);
    });
    tail = scheduled.catch((error) => console.error(`[community-delivery-local] id=${id} ${error instanceof Error ? error.message : String(error)}`));
  }};
};

export const createCommunityDeliveryQueue = (config: AppConfig): CommunityDeliveryQueue => {
  if (!config.discordCommunityQueueUrl) return { async enqueue() { throw new Error('Discord community delivery queue is not configured'); } };
  const client = new SQSClient({ region: config.awsRegion });
  return { async enqueue(communityDeliveryId, delaySeconds = 0) {
    await client.send(new SendMessageCommand({ QueueUrl: config.discordCommunityQueueUrl, MessageBody: JSON.stringify({ communityDeliveryId }), DelaySeconds: Math.min(900, Math.max(0, Math.floor(delaySeconds))) }));
  }};
};
