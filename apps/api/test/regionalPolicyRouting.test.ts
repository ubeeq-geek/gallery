import { routeRegionalPolicyDecision } from '../src/regionalPolicyRouting';

describe('regional policy routing', () => {
  it('atomically requests a restricted hold, review case, and audit record', async () => {
    const apply = jest.fn().mockResolvedValue(undefined);
    await routeRegionalPolicyDecision({ assetId: 'asset', product: 'nightframe', environment: 'production', dataHomeRegion: 'eu-central-1', decision: { state: 'HELD', policyVersion: 'v1', reasonCode: 'RESTRICTED_HIGH_RISK_COMBINATION', automatedCompletionOnly: true }, repository: { apply } });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ hold: expect.objectContaining({ restricted: true }), deliveryRevocation: expect.objectContaining({ recordType: 'DELIVERY_REVOCATION_OUTBOX', paths: ['/assets/asset/*'] }), reviewCase: expect.objectContaining({ restrictedSafety: true }), audit: expect.objectContaining({ policyVersion: 'v1', automatedCompletionOnly: true }) }));
  });
  it('does not create a review or hold for automated no-match completion', async () => {
    const apply = jest.fn().mockResolvedValue(undefined);
    await routeRegionalPolicyDecision({ assetId: 'asset', product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2', decision: { state: 'CLEARED_FOR_POLICY_REVIEW', policyVersion: 'v1', reasonCode: 'AUTOMATED_NO_RELEVANT_RESULT', automatedCompletionOnly: true }, repository: { apply } });
    expect(apply.mock.calls[0][0]).not.toHaveProperty('hold');
    expect(apply.mock.calls[0][0]).not.toHaveProperty('reviewCase');
  });
});
