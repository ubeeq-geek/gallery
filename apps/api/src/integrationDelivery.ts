import { requireRegionalDelivery, type RegionalDeliveryContext } from './regionalDelivery';

export type IntegrationDeliveryErrorCode =
  | 'authentication_required'
  | 'permission_denied'
  | 'rate_limited'
  | 'temporarily_unavailable'
  | 'invalid_request'
  | 'policy_blocked'
  | 'ambiguous_submission';

export type IntegrationDeliveryStatus = 'queued' | 'processing' | 'retry_scheduled' | 'sent' | 'failed' | 'cancelled';

export interface IntegrationDeliveryJob {
  integrationDeliveryJobId: string;
  idempotencyKey: string;
  integrationAccountId: string;
  publicationId: string;
  operation: 'publish' | 'update' | 'delete';
  status: IntegrationDeliveryStatus;
  attemptCount: number;
  nextAttemptAt?: string;
  errorCode?: IntegrationDeliveryErrorCode;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

/** Must be called before bytes are submitted to any destination provider. */
export const authorizeIntegrationDelivery = (context: Omit<RegionalDeliveryContext, 'purpose' | 'publicDeliveryState'>): void =>
  requireRegionalDelivery({ ...context, purpose: 'DESTINATION_INTEGRATION' });

export const shouldRetryIntegrationDelivery = (
  operation: IntegrationDeliveryJob['operation'],
  errorCode: IntegrationDeliveryErrorCode,
  attemptCount: number,
  maximumAmbiguousAttempts = 3
): boolean => (
  errorCode === 'rate_limited'
  || errorCode === 'temporarily_unavailable'
  || (errorCode === 'ambiguous_submission' && operation === 'publish' && attemptCount < maximumAmbiguousAttempts)
);

export const deliveryRetryDelaySeconds = (attemptCount: number, baseDelaySeconds: number, random = Math.random): number => {
  const base = Math.max(1, Math.floor(baseDelaySeconds));
  const ceiling = Math.min(3600, base * (2 ** Math.min(Math.max(0, attemptCount - 1), 10)));
  const lower = Math.ceil(ceiling / 2);
  return lower + Math.floor(random() * (ceiling - lower + 1));
};

export const recordDeliveryFailure = (
  job: IntegrationDeliveryJob,
  errorCode: IntegrationDeliveryErrorCode,
  errorMessage: string,
  baseDelaySeconds: number,
  now = new Date(),
  random = Math.random
): IntegrationDeliveryJob => {
  const attemptCount = job.attemptCount + 1;
  const retry = shouldRetryIntegrationDelivery(job.operation, errorCode, attemptCount);
  const delaySeconds = retry ? deliveryRetryDelaySeconds(attemptCount, baseDelaySeconds, random) : undefined;
  return {
    ...job,
    attemptCount,
    status: retry ? 'retry_scheduled' : 'failed',
    nextAttemptAt: delaySeconds ? new Date(now.getTime() + delaySeconds * 1000).toISOString() : undefined,
    errorCode,
    errorMessage,
    updatedAt: now.toISOString()
  };
};
