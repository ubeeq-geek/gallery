import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { AppConfig } from './config';

export interface ExternalSyncQueue {
  enqueue(externalSyncJobId: string, delaySeconds?: number): Promise<void>;
}

export const createInProcessExternalSyncQueue = (
  processJob: (externalSyncJobId: string) => Promise<void>
): ExternalSyncQueue => ({
  async enqueue(externalSyncJobId: string, delaySeconds = 0): Promise<void> {
    const delay = Math.max(0, Math.floor(delaySeconds)) * 1000;
    setTimeout(() => {
      void processJob(externalSyncJobId).catch((error) => {
        console.error(`[external-sync-local] job=${externalSyncJobId} message=${error instanceof Error ? error.message : String(error)}`);
      });
    }, delay);
  }
});

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
