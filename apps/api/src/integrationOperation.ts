import type { ExternalAccount, ExternalSyncJob, ExternalSyncJobStatus, ExternalSyncJobType, ExternalSyncLog } from './domain';
import { integrationDefinitions, type IntegrationOperation } from './integrationStandard';

/**
 * The adapter-neutral surface for queued integration work.  ExternalSyncJob
 * remains the durable worker record; this module deliberately exposes only a
 * safe, stable projection to Studio so new providers do not need their own
 * lifecycle UI or status vocabulary.
 */
export type IntegrationOperationKind =
  | 'import'
  | 'sync_content'
  | 'sync_activity'
  | 'publish'
  | 'update_remote'
  | 'remove_remote'
  | 'other';

export type IntegrationOperationState =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'retry_scheduled'
  | 'requires_attention'
  | 'failed'
  | 'cancelled';

export interface IntegrationOperationResponse {
  id: string;
  kind: IntegrationOperationKind;
  state: IntegrationOperationState;
  /** Retained for diagnostics and filtering; consumers should present state. */
  jobStatus: ExternalSyncJobStatus;
  platform: string;
  platformLabel: string;
  account: {
    id: string;
    label: string;
  };
  progress: {
    discovered: number;
    synchronized: number;
    remaining: number;
  };
  attemptCount: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  error?: {
    code?: string;
    message?: string;
  };
  retryable: boolean;
  cancellable: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A deliberately narrow log projection for Studio diagnostics. */
export interface IntegrationOperationLogResponse {
  id: string;
  level: ExternalSyncLog['level'];
  message: string;
  createdAt: string;
}

const redactSensitiveText = (value: string): string => value
  .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
  .replace(/\b(access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*([=:])\s*([^\s,;]+)/gi, '$1$2[redacted]');

export const toIntegrationOperationLogResponse = (log: ExternalSyncLog): IntegrationOperationLogResponse => ({
  id: log.externalSyncLogId,
  level: log.level,
  message: redactSensitiveText(log.message),
  createdAt: log.createdAt
});

export const integrationOperationForExternalSyncJobType = (type: ExternalSyncJobType): IntegrationOperation => {
  switch (type) {
    case 'publish':
      return 'publish';
    case 'remote_update':
      return 'update_remote';
    case 'remote_delete':
      return 'delete_remote';
    case 'account_import':
    case 'account_scan':
    case 'full_reconciliation':
    case 'content_sync':
      return 'import';
    case 'user_action':
      return 'write_engagement';
    default:
      return 'read_engagement';
  }
};

export const integrationOperationKindForExternalSyncJobType = (type: ExternalSyncJobType): IntegrationOperationKind => {
  switch (type) {
    case 'account_import':
    case 'account_scan':
    case 'full_reconciliation':
      return 'import';
    case 'content_sync':
    case 'content_metadata_sync':
    case 'gallery_sync':
      return 'sync_content';
    case 'activity_sync':
    case 'engagement_sync':
    case 'comment_sync':
      return 'sync_activity';
    case 'publish':
      return 'publish';
    case 'remote_update':
      return 'update_remote';
    case 'remote_delete':
      return 'remove_remote';
    default:
      return 'other';
  }
};

export const integrationOperationStateForExternalSyncJobStatus = (status: ExternalSyncJobStatus): IntegrationOperationState => {
  switch (status) {
    case 'processing':
      return 'in_progress';
    case 'successful':
      return 'completed';
    case 'retry_scheduled':
    case 'rate_limited':
      return 'retry_scheduled';
    case 'authentication_required':
      return 'requires_attention';
    default:
      return status;
  }
};

export const isIntegrationOperationRetryable = (status: ExternalSyncJobStatus): boolean => (
  status === 'failed'
  || status === 'rate_limited'
  || status === 'authentication_required'
  || status === 'retry_scheduled'
);

export const isIntegrationOperationCancellable = (status: ExternalSyncJobStatus): boolean => (
  status === 'queued'
  || status === 'processing'
  || status === 'retry_scheduled'
  || status === 'rate_limited'
  || status === 'authentication_required'
);

export const toIntegrationOperationResponse = (
  job: ExternalSyncJob,
  account: ExternalAccount
): IntegrationOperationResponse => {
  const definition = integrationDefinitions[account.platform];
  const error = job.errorCode || job.errorMessage
    ? { code: job.errorCode, message: job.errorMessage }
    : undefined;

  return {
    id: job.externalSyncJobId,
    kind: integrationOperationKindForExternalSyncJobType(job.type),
    state: integrationOperationStateForExternalSyncJobStatus(job.status),
    jobStatus: job.status,
    platform: account.platform,
    platformLabel: definition?.label || account.platform,
    account: {
      id: account.externalAccountId,
      label: account.externalUsername || account.externalUserId
    },
    progress: job.progress || { discovered: 0, synchronized: 0, remaining: 0 },
    attemptCount: job.attemptCount,
    lastAttemptAt: job.lastAttemptAt,
    nextAttemptAt: job.nextAttemptAt,
    error,
    retryable: isIntegrationOperationRetryable(job.status),
    cancellable: isIntegrationOperationCancellable(job.status),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
};
