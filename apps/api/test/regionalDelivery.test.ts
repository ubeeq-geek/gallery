import {
  evaluateRegionalDelivery,
  mediaProcessingLedgerRecord,
  RegionalDeliveryBlockedError
} from '../src/regionalDelivery';
import { authorizeIntegrationDelivery } from '../src/integrationDelivery';
import type { RegionalPolicyDecision } from '../src/regionalPolicy';

describe('regional delivery admission', () => {
  const cleared: RegionalPolicyDecision = {
    state: 'CLEARED_FOR_POLICY_REVIEW', policyVersion: 'policy-v1',
    reasonCode: 'AUTOMATED_NO_RELEVANT_RESULT', automatedCompletionOnly: true
  };
  const base = {
    product: 'eversally' as const, dataHomeRegion: 'us-east-2' as const, canonicalRegion: 'us-east-2' as const,
    policyDecision: cleared, destinationPolicyState: 'APPROVED' as const, remainingCreditUnits: 10, requiredCreditUnits: 1
  };

  it('allows only eligible public derivatives after complete regional policy processing', () => {
    expect(evaluateRegionalDelivery({ ...base, purpose: 'PUBLIC_DERIVATIVE', publicDeliveryState: 'ELIGIBLE' })).toEqual({ allowed: true, reason: 'REGIONAL_POLICY_GATE_PASSED' });
    expect(evaluateRegionalDelivery({ ...base, purpose: 'PUBLIC_DERIVATIVE', publicDeliveryState: 'PRIVATE' })).toEqual({ allowed: false, reason: 'PUBLIC_DERIVATIVE_NOT_ELIGIBLE' });
  });

  it.each([
    [undefined, 'REQUIRED_SCAN_INCOMPLETE'],
    [{ ...cleared, state: 'SCAN_UNAVAILABLE', reasonCode: 'REQUIRED_SCAN_INCOMPLETE' }, 'REQUIRED_SCAN_INCOMPLETE'],
    [{ ...cleared, state: 'HUMAN_REVIEW_REQUIRED', reasonCode: 'AUTOMATED_SIGNAL_REVIEW' }, 'HUMAN_REVIEW_REQUIRED'],
    [{ ...cleared, state: 'HELD', reasonCode: 'SPECIALIST_HASH_SIGNAL' }, 'ASSET_HELD']
  ] as const)('fails closed for policy decision %p', (policyDecision, reason) => {
    expect(evaluateRegionalDelivery({ ...base, purpose: 'DESTINATION_INTEGRATION', policyDecision: policyDecision as RegionalPolicyDecision | undefined })).toEqual({ allowed: false, reason });
  });

  it('blocks cross-region and exhausted-entitlement integration submissions', () => {
    expect(() => authorizeIntegrationDelivery({ ...base, canonicalRegion: 'eu-central-1' })).toThrow(RegionalDeliveryBlockedError);
    expect(() => authorizeIntegrationDelivery({ ...base, remainingCreditUnits: 0 })).toThrow('PROCESSING_ENTITLEMENT_EXHAUSTED');
    expect(() => authorizeIntegrationDelivery({ ...base, remainingCreditUnits: 0, overagePermitted: true })).not.toThrow();
  });

  it('keeps destination policy separate from automated scan output', () => {
    expect(evaluateRegionalDelivery({ ...base, purpose: 'DESTINATION_INTEGRATION', destinationPolicyState: 'PENDING' })).toEqual({
      allowed: false, reason: 'DESTINATION_POLICY_NOT_APPROVED'
    });
  });
});

describe('regional usage ledger', () => {
  it('uses a stable cell, period, media version, and scan group identity', () => {
    const usage = {
      product: 'nightframe' as const, dataHomeRegion: 'eu-central-1' as const, creatorId: 'creator-1', spaceId: 'space-1', period: '2026-08',
      mediaType: 'video' as const, sourceImageCount: 0, videoDurationSeconds: 61, sampledFrameCount: 22,
      moderationCalls: 22, faceAgeCalls: 22, estimatedProviderCost: 0.25, creditUnits: 50
    };
    const first = mediaProcessingLedgerRecord(usage, { mediaVersionId: 'version-1', scanGroupId: 'group-1', createdAt: '2026-08-25T00:00:00.000Z' });
    const retry = mediaProcessingLedgerRecord(usage, { mediaVersionId: 'version-1', scanGroupId: 'group-1', createdAt: '2026-08-25T00:01:00.000Z' });
    expect(first.id).toBe(retry.id);
    expect(first).toMatchObject({ moderationCalls: 22, faceAgeCalls: 22, creditUnits: 50 });
  });
});
