import type { ScheduledHandler } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { loadConfig } from './config';
import { DynamoStore } from './dynamoStore';
import { createExternalSyncQueue } from './externalSyncQueue';

export const handler: ScheduledHandler = async () => {
  const config = loadConfig();
  const store = new DynamoStore(config);
  const queue = createExternalSyncQueue(config);
  const now = new Date().toISOString();
  const jobs = await store.listDueExternalSyncJobs(now, 50);
  let queued = 0;
  for (const job of jobs) {
    try {
      await queue.enqueue(job.externalSyncJobId);
      await store.updateExternalSyncJob({
        ...job,
        status: 'queued',
        nextAttemptAt: undefined,
        updatedAt: now
      });
      queued += 1;
    } catch (error) {
      console.error(`[external-sync-scheduler] enqueue_failed job=${job.externalSyncJobId} message=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const scanBefore = new Date(Date.now() - config.externalAccountScanIntervalSeconds * 1000).toISOString();
  const accounts = await store.listExternalAccountsForScheduledScan(50);
  let scans = 0;
  for (const account of accounts) {
    if (account.connectionStatus !== 'connected') continue;
    if (account.lastSuccessfulSyncAt && account.lastSuccessfulSyncAt > scanBefore) continue;
    const accountJobs = await store.listExternalSyncJobs(account.externalAccountId, 20);
    if (accountJobs.some((job) => ['queued', 'processing', 'retry_scheduled', 'rate_limited'].includes(job.status))) continue;
    const scanJob = {
      externalSyncJobId: randomUUID(),
      externalAccountId: account.externalAccountId,
      type: 'account_scan' as const,
      status: 'queued' as const,
      progress: { discovered: 0, synchronized: 0, remaining: 0 },
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    };
    try {
      await store.createExternalSyncJob(scanJob);
      await queue.enqueue(scanJob.externalSyncJobId);
      scans += 1;
    } catch (error) {
      await store.updateExternalSyncJob({
        ...scanJob,
        status: 'retry_scheduled',
        nextAttemptAt: new Date(Date.now() + config.externalSyncBaseDelaySeconds * 1000).toISOString(),
        errorCode: 'QUEUE_UNAVAILABLE',
        errorMessage: 'The synchronization queue is unavailable',
        updatedAt: new Date().toISOString()
      });
      console.error(`[external-sync-scheduler] scan_enqueue_failed account=${account.externalAccountId} message=${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.info(`[external-sync-scheduler] retries=${queued} scans=${scans}`);
};
