import { recordDeliveryFailure, shouldRetryIntegrationDelivery } from '../src/integrationDelivery';

describe('integration delivery standard', () => {
  const job = {
    integrationDeliveryJobId: 'delivery-1', idempotencyKey: 'pub-1:revision-2', integrationAccountId: 'account-1', publicationId: 'pub-1',
    operation: 'publish' as const, status: 'processing' as const, attemptCount: 0,
    createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z'
  };

  it('retries only transient and bounded ambiguous publish failures', () => {
    expect(shouldRetryIntegrationDelivery('publish', 'rate_limited', 1)).toBe(true);
    expect(shouldRetryIntegrationDelivery('publish', 'ambiguous_submission', 2)).toBe(true);
    expect(shouldRetryIntegrationDelivery('publish', 'ambiguous_submission', 3)).toBe(false);
    expect(shouldRetryIntegrationDelivery('update', 'ambiguous_submission', 1)).toBe(false);
  });

  it('schedules deterministic jittered retry state without retrying a policy block', () => {
    const retry = recordDeliveryFailure(job, 'temporarily_unavailable', 'Remote outage', 60, new Date('2026-08-23T01:00:00.000Z'), () => 0);
    expect(retry).toMatchObject({ status: 'retry_scheduled', attemptCount: 1, nextAttemptAt: '2026-08-23T01:00:30.000Z' });
    const blocked = recordDeliveryFailure(job, 'policy_blocked', 'Held for review', 60, new Date('2026-08-23T01:00:00.000Z'));
    expect(blocked).toMatchObject({ status: 'failed', errorCode: 'policy_blocked' });
  });
});
