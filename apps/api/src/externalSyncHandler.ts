import type { SQSHandler } from 'aws-lambda';
import { loadConfig } from './config';
import { DynamoStore } from './dynamoStore';
import { processExternalSyncJob } from './externalSyncWorker';

export const handler: SQSHandler = async (event) => {
  const config = loadConfig();
  const store = new DynamoStore(config);
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    try {
      const payload = JSON.parse(record.body) as { externalSyncJobId?: string };
      if (!payload.externalSyncJobId) throw new Error('External sync message is missing externalSyncJobId');
      await processExternalSyncJob(store, config, payload.externalSyncJobId);
    } catch (error) {
      console.error('[external-sync] job failed', { message: error instanceof Error ? error.message : 'Unknown failure' });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};
