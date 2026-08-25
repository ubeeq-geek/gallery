import type { RegionalScanJob, RegionalScanResult } from './regionalMedia';

export interface RegionalPolicyProfile {
  version: string;
  highRiskModerationLabels: Array<{ name: string; minimumConfidence: number }>;
  ageSensitiveUpperBound: number;
}

export type RegionalPolicyDecision = {
  state: 'CLEARED_FOR_POLICY_REVIEW' | 'HUMAN_REVIEW_REQUIRED' | 'HELD' | 'SCAN_UNAVAILABLE';
  policyVersion: string;
  reasonCode: 'AUTOMATED_NO_RELEVANT_RESULT' | 'RESTRICTED_HIGH_RISK_COMBINATION' | 'SPECIALIST_HASH_SIGNAL' | 'AUTOMATED_SIGNAL_REVIEW' | 'REQUIRED_SCAN_INCOMPLETE';
  automatedCompletionOnly: true;
};

/** Automated output only routes policy/review work; it never proves age, consent, legality, CSAM, or NCII. */
export const evaluateRegionalPolicy = (jobs: RegionalScanJob[], results: RegionalScanResult[], policy: RegionalPolicyProfile): RegionalPolicyDecision => {
  const required = jobs.filter(({ type }) => type !== 'VIDEO_FRAME_PLAN');
  const byJob = new Map(results.map((result) => [result.scanJobId, result]));
  const requiredResults = required.map(({ id }) => byJob.get(id));
  if (requiredResults.some((result) => !result || result.outcome === 'ERROR' || result.outcome === 'UNAVAILABLE')) {
    return { state: 'SCAN_UNAVAILABLE', policyVersion: policy.version, reasonCode: 'REQUIRED_SCAN_INCOMPLETE', automatedCompletionOnly: true };
  }
  const completed = requiredResults as RegionalScanResult[];
  if (completed.some(({ scanType, outcome }) => scanType === 'HASH' && outcome === 'SIGNALLED')) return { state: 'HELD', policyVersion: policy.version, reasonCode: 'SPECIALIST_HASH_SIGNAL', automatedCompletionOnly: true };
  const highRisk = completed.some(({ labels }) => labels.some(({ name, confidence }) => policy.highRiskModerationLabels.some((rule) => rule.name === name && confidence >= rule.minimumConfidence)));
  const ageSensitive = completed.some(({ faceAgeRanges }) => faceAgeRanges.some(({ low, high }) => low < policy.ageSensitiveUpperBound || high < policy.ageSensitiveUpperBound));
  if (highRisk && ageSensitive) return { state: 'HELD', policyVersion: policy.version, reasonCode: 'RESTRICTED_HIGH_RISK_COMBINATION', automatedCompletionOnly: true };
  if (completed.some(({ outcome }) => outcome === 'SIGNALLED')) return { state: 'HUMAN_REVIEW_REQUIRED', policyVersion: policy.version, reasonCode: 'AUTOMATED_SIGNAL_REVIEW', automatedCompletionOnly: true };
  return { state: 'CLEARED_FOR_POLICY_REVIEW', policyVersion: policy.version, reasonCode: 'AUTOMATED_NO_RELEVANT_RESULT', automatedCompletionOnly: true };
};
