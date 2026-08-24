import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from './config';

export interface VimeoUploadJob {
  publicationId: string;
  tenantId: string;
  sourceAssetId: string;
  objectKey: string;
  sizeBytes: number;
  title: string;
  description?: string;
  correlationId: string;
}

export interface VimeoQueue {
  enqueue(job: VimeoUploadJob): Promise<void>;
}

class SqsVimeoQueue implements VimeoQueue {
  constructor(private readonly client: SQSClient, private readonly queueUrl: string) {}

  async enqueue(job: VimeoUploadJob) {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(job)
    }));
  }
}

/** Local development keeps the publication queued for an explicitly invoked worker. */
class LocalVimeoQueue implements VimeoQueue {
  async enqueue(_job: VimeoUploadJob) {}
}

export const createVimeoQueue = (config: AppConfig): VimeoQueue => config.vimeoUploadQueueUrl
  ? new SqsVimeoQueue(new SQSClient({ region: config.awsRegion }), config.vimeoUploadQueueUrl)
  : new LocalVimeoQueue();
