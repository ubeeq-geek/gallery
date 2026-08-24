import { InMemoryStore } from '../src/inMemoryStore';
import { runExternalSyncSchedule } from '../src/externalSyncScheduler';
import type { AppConfig } from '../src/config';

describe('external sync scheduler', () => {
  it('does not create autonomous catalogue or activity scans when disabled', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    await store.createExternalAccount({
      externalAccountId: 'scheduled-account', userId: 'user-1', creatorIdentityId: 'creator-1',
      externalPlatformCredentialId: 'credential-1', platform: 'deviantart', externalUserId: 'remote-1',
      externalUsername: 'creator', accessTokenEncrypted: 'token', connectionStatus: 'connected', createdAt: now, updatedAt: now
    });
    const queue = { enqueue: jest.fn(async () => undefined) };

    const result = await runExternalSyncSchedule(store, {
      externalScheduledScansEnabled: false,
      externalAccountScanIntervalSeconds: 1,
      externalActivityScanIntervalSeconds: 1,
      externalSyncBaseDelaySeconds: 60
    } as AppConfig, queue, now);

    expect(result).toEqual({ retries: 0, activityScans: 0, catalogueScans: 0 });
    expect(await store.listExternalSyncJobs('scheduled-account')).toEqual([]);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
