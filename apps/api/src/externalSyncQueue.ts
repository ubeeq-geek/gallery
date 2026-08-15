import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { AppConfig } from './config';

export interface ExternalSyncQueue {
  enqueue(externalSyncJobId: string, delaySeconds?: number): Promise<void>;
}

export const createInProcessExternalSyncQueue = (
  processJob: (externalSyncJobId: string) => Promise<void>
): ExternalSyncQueue => {
  // The local server has no SQS worker to provide backpressure. Keep a single
  // promise chain so a bulk publish reaches a provider in the visible queue
  // order, rather than starting every upload at once.
  let tail: Promise<void> = Promise.resolve();
  return {
    async enqueue(externalSyncJobId: string, delaySeconds = 0): Promise<void> {
      const delay = Math.max(0, Math.floor(delaySeconds)) * 1000;
      const scheduled = tail.then(async () => {
        if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
        await processJob(externalSyncJobId);
      });
      // A failed job is recorded by its worker, but must not block subsequent
      // jobs queued by the creator.
      tail = scheduled.catch((error) => {
        console.error(`[external-sync-local] job=${externalSyncJobId} message=${error instanceof Error ? error.message : String(error)}`);
      });
    }
  };
};

class SqsExternalSyncQueue implements ExternalSyncQueue {
  private readonly client: SQSClient;

  constructor(private readonly queueUrl: string, region: string) {
    this.client = new SQSClient({ region });
  }

  async enqueue(externalSyncJobId: string, delaySeconds = 0): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify({ externalSyncJobId }),
      DelaySeconds: Math.max(0, Math.min(900, Math.floor(delaySeconds)))
    }));
  }
}

class UnavailableExternalSyncQueue implements ExternalSyncQueue {
  async enqueue(): Promise<void> {
    throw new Error('External sync queue is not configured');
  }
}

export const createExternalSyncQueue = (config: AppConfig): ExternalSyncQueue => (
  config.externalSyncQueueUrl
    ? new SqsExternalSyncQueue(config.externalSyncQueueUrl, config.awsRegion)
    : new UnavailableExternalSyncQueue()
);
