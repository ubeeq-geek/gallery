import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { AppConfig } from './config';

export interface TumblrPublishQueue { enqueue(publicationId: string, delaySeconds?: number): Promise<void> }

export const createTumblrPublishQueue = (config: AppConfig): TumblrPublishQueue => {
  if (!config.tumblrPublishQueueUrl) return { async enqueue() { throw new Error('Tumblr publishing queue is not configured.'); } };
  const client = new SQSClient({ region: config.awsRegion });
  return { async enqueue(publicationId, delaySeconds = 0) {
    await client.send(new SendMessageCommand({ QueueUrl: config.tumblrPublishQueueUrl, MessageBody: JSON.stringify({ publicationId }), DelaySeconds: Math.min(900, Math.max(0, Math.floor(delaySeconds))) }));
  } };
};

export const createInProcessTumblrPublishQueue = (process: (publicationId: string) => Promise<void>): TumblrPublishQueue => ({
  async enqueue(publicationId, delaySeconds = 0) {
    const timer = setTimeout(() => void process(publicationId), Math.max(0, delaySeconds) * 1000);
    timer.unref();
  }
});
