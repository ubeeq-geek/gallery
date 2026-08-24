import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from './config';
import { VimeoProvider } from './vimeoProvider';
import { DynamoVimeoRepository } from './vimeoRepository';
import type { VimeoUploadJob } from './vimeoQueue';
import { VimeoUploadWorker } from './vimeoWorker';

const config = loadConfig();
const repository = new DynamoVimeoRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion })),
  config.contentCoreTable
);
const s3 = new S3Client({ region: config.awsRegion });
const worker = new VimeoUploadWorker(repository, new VimeoProvider(), config.externalTokenEncryptionKey, {
  record: async (event) => repository.saveAudit({
    id: event.correlationId,
    ownerId: (await repository.publication(event.publicationId))?.ownerId || 'unknown',
    actorId: 'vimeo-upload-worker',
    action: event.action,
    result: event.result === 'success' ? 'SUCCESS' : 'FAILED',
    correlationId: event.correlationId,
    publicationId: event.publicationId,
    detail: event.detail as Record<string, string> | undefined,
    createdAt: new Date().toISOString()
  })
});

const parseJob = (body: string): VimeoUploadJob => {
  const job = JSON.parse(body) as Partial<VimeoUploadJob>;
  if (!job.publicationId || !job.objectKey || !job.sizeBytes || !job.correlationId || !job.title) throw new Error('Invalid Vimeo upload job');
  return job as VimeoUploadJob;
};

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const job = parseJob(record.body);
      const result = await worker.run({
        publicationId: job.publicationId,
        title: job.title,
        description: job.description,
        correlationId: job.correlationId,
        source: {
          sizeBytes: job.sizeBytes,
          read: async (offset, length) => {
            const response = await s3.send(new GetObjectCommand({
              Bucket: config.mediaBucket,
              Key: job.objectKey,
              Range: `bytes=${offset}-${offset + length - 1}`
            }));
            if (!response.Body) throw new Error('Canonical Vimeo source is unavailable');
            return Buffer.from(await response.Body.transformToByteArray());
          }
        }
      });
      if (result.state === 'FAILED' && result.lastFailureRetryable) failures.push({ itemIdentifier: record.messageId });
    } catch {
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};
