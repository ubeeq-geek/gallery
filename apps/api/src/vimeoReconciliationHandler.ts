import type { ScheduledEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from './config';
import { VimeoProvider } from './vimeoProvider';
import { DynamoVimeoRepository } from './vimeoRepository';
import { VimeoUploadWorker } from './vimeoWorker';

const config = loadConfig();
const repository = new DynamoVimeoRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion })),
  config.contentCoreTable
);
const worker = new VimeoUploadWorker(repository, new VimeoProvider(), config.externalTokenEncryptionKey, {
  record: async () => undefined
});

/** Recovery reconciliation is deliberately bounded; the next schedule resumes the scan. */
export const handler = async (_event: ScheduledEvent): Promise<{ checked: number; failed: number }> => {
  const publications = await repository.reconciliationCandidates(100);
  let failed = 0;
  for (const publication of publications) {
    try {
      await worker.reconcile(publication.id);
    } catch {
      failed += 1;
    }
  }
  return { checked: publications.length, failed };
};
