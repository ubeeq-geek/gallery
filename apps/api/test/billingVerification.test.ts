import { IntegrationVerificationPolicy, VerificationThresholdVersion } from '../src/billingVerification';

const version: VerificationThresholdVersion = { versionId: 'es-thresholds-v1', product: 'EVERSALLY', effectiveFrom: '2026-01-01T00:00:00.000Z', creatorReviewAt: 5, integrationReviewAt: 10, creatorRereviewAt: 25, integrationRereviewAt: 50 };
const at = '2026-08-25T00:00:00.000Z';

describe('Creator and integration verification safeguards', () => {
  test('free tenants cannot add a second active Creator or integration account', () => {
    const policy = new IntegrationVerificationPolicy([version]);
    expect(policy.evaluate({ tenantId: 'free', product: 'EVERSALLY', proposedObjectId: 'creator-2', objectType: 'CREATOR_PROFILE', paid: false, activeCreators: 1, activeIntegrationAccounts: 0, previouslyApproved: false, observedAt: at }).proposedStatus).toBe('REJECTED_FREE_LIMIT');
    expect(policy.evaluate({ tenantId: 'free', product: 'EVERSALLY', proposedObjectId: 'connection-2', objectType: 'INTEGRATION_ACCOUNT', paid: false, activeCreators: 1, activeIntegrationAccounts: 1, previouslyApproved: false, observedAt: at }).proposedStatus).toBe('REJECTED_FREE_LIMIT');
  });

  test('warns before and holds only the proposed paid object at the threshold', () => {
    const policy = new IntegrationVerificationPolicy([version]);
    expect(policy.evaluate({ tenantId: 'paid', product: 'EVERSALLY', proposedObjectId: 'creator-5', objectType: 'CREATOR_PROFILE', paid: true, activeCreators: 4, activeIntegrationAccounts: 3, previouslyApproved: false, observedAt: at })).toMatchObject({ allowed: true, proposedStatus: 'ACTIVE', warning: true });
    const held = policy.evaluate({ tenantId: 'paid', product: 'EVERSALLY', proposedObjectId: 'creator-6', objectType: 'CREATOR_PROFILE', paid: true, activeCreators: 5, activeIntegrationAccounts: 3, previouslyApproved: false, observedAt: at });
    expect(held).toMatchObject({ allowed: false, proposedStatus: 'PENDING_VERIFICATION', reviewCase: { trigger: 'THRESHOLD', thresholdVersionId: version.versionId } });
    expect(policy.decide(held.reviewCase!.caseId, { status: 'APPROVED', reviewer: 'support', reason: 'Verified manager workflow', observedAt: at })).toMatchObject({ status: 'APPROVED', reviewer: 'support' });
    expect(policy.history('paid')).toHaveLength(2);
  });

  test('uses re-review thresholds and permits concrete risk-based early review', () => {
    const policy = new IntegrationVerificationPolicy([version]);
    expect(policy.evaluate({ tenantId: 'agency', product: 'EVERSALLY', proposedObjectId: 'connection-50', objectType: 'INTEGRATION_ACCOUNT', paid: true, activeCreators: 10, activeIntegrationAccounts: 49, previouslyApproved: true, observedAt: at }).warning).toBe(true);
    expect(policy.evaluate({ tenantId: 'agency', product: 'EVERSALLY', proposedObjectId: 'connection-51', objectType: 'INTEGRATION_ACCOUNT', paid: true, activeCreators: 10, activeIntegrationAccounts: 50, previouslyApproved: true, observedAt: at })).toMatchObject({ proposedStatus: 'PENDING_VERIFICATION', reviewCase: { trigger: 'REREVIEW' } });
    expect(() => policy.openRiskReview({ tenantId: 'risk', product: 'EVERSALLY', proposedObjectId: 'connection', objectType: 'INTEGRATION_ACCOUNT', concreteSignal: ' ', observedAt: at })).toThrow('concrete risk signal');
    expect(policy.openRiskReview({ tenantId: 'risk', product: 'EVERSALLY', proposedObjectId: 'connection', objectType: 'INTEGRATION_ACCOUNT', concreteSignal: 'Repeated OAuth failures', observedAt: at })).toMatchObject({ trigger: 'RISK', status: 'PENDING' });
  });
});
