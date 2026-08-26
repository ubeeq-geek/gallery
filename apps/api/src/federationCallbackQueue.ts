import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from './config';
import { FederationError } from './federation';
import type { FederationCallbackQueue, FederationCallbackQueueMessage } from './federationCallback';

export class SqsFederationCallbackQueue implements FederationCallbackQueue {
  constructor(private readonly client: SQSClient, private readonly queueUrl: string) {}
  async enqueue(message: FederationCallbackQueueMessage, delaySeconds = 0): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(message), DelaySeconds: Math.max(0, Math.min(900, Math.floor(delaySeconds))) }));
  }
}

export const createFederationCallbackQueue = (config: AppConfig): FederationCallbackQueue => {
  if (!config.federationCallbackQueueUrl) throw new FederationError('federation_not_configured', 'Federation callback queue is not configured');
  return new SqsFederationCallbackQueue(new SQSClient({ region: config.awsRegion }), config.federationCallbackQueueUrl);
};

