import type { ExternalAccount, ExternalSyncJob, ExternalSyncLog } from '../src/domain';
import {
  integrationOperationForExternalSyncJobType,
  integrationOperationKindForExternalSyncJobType,
  isIntegrationOperationCancellable,
  isIntegrationOperationRetryable,
  toIntegrationOperationLogResponse,
  toIntegrationOperationResponse
} from '../src/integrationOperation';

const account: ExternalAccount = {
  externalAccountId: 'youtube-account-1',
  externalPlatformCredentialId: 'credential-1',
  userId: 'user-1',
  platform: 'youtube',
  externalUserId: 'channel-1',
  externalUsername: 'Ubeeq Geek',
  accessTokenEncrypted: 'not-exposed',
  connectionStatus: 'connected',
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z'
};

const job = (overrides: Partial<ExternalSyncJob> = {}): ExternalSyncJob => ({
  externalSyncJobId: 'job-1',
  externalAccountId: account.externalAccountId,
  type: 'content_sync',
  status: 'failed',
  payload: { accessToken: 'must-not-be-returned' },
  progress: { discovered: 4, synchronized: 2, remaining: 2 },
  attemptCount: 3,
  errorCode: 'REMOTE_UNAVAILABLE',
  errorMessage: 'The remote platform was unavailable.',
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:01:00.000Z',
  ...overrides
});

describe('integration operation projection', () => {
  it('maps durable worker job types to the neutral integration vocabulary', () => {
    expect(integrationOperationForExternalSyncJobType('content_sync')).toBe('import');
    expect(integrationOperationForExternalSyncJobType('remote_update')).toBe('update_remote');
    expect(integrationOperationForExternalSyncJobType('remote_delete')).toBe('delete_remote');
    expect(integrationOperationKindForExternalSyncJobType('gallery_sync')).toBe('sync_content');
    expect(integrationOperationKindForExternalSyncJobType('comment_sync')).toBe('sync_activity');
  });

  it('exposes safe status controls without leaking job payloads', () => {
    const operation = toIntegrationOperationResponse(job(), account);

    expect(operation).toMatchObject({
      id: 'job-1',
      kind: 'sync_content',
      state: 'failed',
      platform: 'youtube',
      platformLabel: 'YouTube',
      account: { id: 'youtube-account-1', label: 'Ubeeq Geek' },
      progress: { discovered: 4, synchronized: 2, remaining: 2 },
      retryable: true,
      cancellable: false
    });
    expect(operation).not.toHaveProperty('payload');
    expect(JSON.stringify(operation)).not.toContain('must-not-be-returned');
  });

  it('identifies only active operations as cancellable and repairable operations as retryable', () => {
    expect(isIntegrationOperationCancellable('processing')).toBe(true);
    expect(isIntegrationOperationCancellable('successful')).toBe(false);
    expect(isIntegrationOperationRetryable('authentication_required')).toBe(true);
    expect(isIntegrationOperationRetryable('cancelled')).toBe(false);
  });

  it('returns only safe diagnostic log fields and redacts credential-like text', () => {
    const log: ExternalSyncLog = {
      externalSyncLogId: 'log-1',
      externalSyncJobId: 'job-1',
      level: 'error',
      message: 'Authorization: Bearer top-secret client_secret=also-secret',
      detail: { accessToken: 'token', clientSecret: 'secret' },
      createdAt: '2026-08-26T00:01:00.000Z'
    };

    const response = toIntegrationOperationLogResponse(log);

    expect(response).toEqual({
      id: 'log-1',
      level: 'error',
      message: 'Authorization: Bearer [redacted] client_secret=[redacted]',
      createdAt: '2026-08-26T00:01:00.000Z'
    });
    expect(response).not.toHaveProperty('detail');
    expect(JSON.stringify(response)).not.toMatch(/top-secret|also-secret|clientSecret/);
  });
});
