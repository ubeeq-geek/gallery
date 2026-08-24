import type { MediaScanState, ScanResult } from './supportSafety';

export type TextSafetyCategory = 'sexual_content' | 'hate_extremism' | 'grooming_solicitation' | 'threats_coercion' | 'sextortion' | 'minor_sexual_context';

export interface TextSafetyProviderLabel {
  category: TextSafetyCategory;
  confidence: number;
}

export interface TextSafetyClientAdapter {
  readonly providerName: string;
  readonly modelName: string;
  readonly modelVersion: string;
  classify(input: { text: string; context: 'description' | 'caption' | 'comment' | 'message' | 'support_submission' }): Promise<{ labels: TextSafetyProviderLabel[]; unavailable?: boolean; errorCode?: string }>;
}

export interface TextSafetyAnalysis {
  result: Omit<ScanResult, 'scanResultId' | 'scanJobId' | 'targetId' | 'contentHash' | 'createdAt'>;
  mediaState: Extract<MediaScanState, 'CLEARED_FOR_POLICY_REVIEW' | 'HUMAN_REVIEW_REQUIRED' | 'SCAN_UNAVAILABLE'>;
  reviewCategories: TextSafetyCategory[];
  reviewReason?: string;
  errorCode?: string;
}

const supportedCategories = new Set<TextSafetyCategory>(['sexual_content', 'hate_extremism', 'grooming_solicitation', 'threats_coercion', 'sextortion', 'minor_sexual_context']);

/** Converts a configured text classifier into review signals; it cannot establish CSAM or NCII. */
export class TextSafetyProvider {
  constructor(private readonly client: TextSafetyClientAdapter, private readonly reviewThreshold = 0.7) {
    if (reviewThreshold < 0 || reviewThreshold > 1) throw new Error('Review threshold must be between zero and one');
  }

  async analyze(text: string, context: Parameters<TextSafetyClientAdapter['classify']>[0]['context']): Promise<TextSafetyAnalysis> {
    const normalized = text.trim();
    if (!normalized) throw new Error('Text is required');
    const response = await this.client.classify({ text: normalized, context });
    const labels = response.labels.filter((label) => supportedCategories.has(label.category) && Number.isFinite(label.confidence) && label.confidence >= 0 && label.confidence <= 1);
    if (response.unavailable) return {
      result: { provider: this.client.providerName, modelName: this.client.modelName, modelVersion: this.client.modelVersion, scanType: 'text_safety', labels: [], disposition: 'scan_unavailable', suitableForAutomatedAction: false },
      mediaState: 'SCAN_UNAVAILABLE', reviewCategories: [], errorCode: response.errorCode || 'provider_unavailable'
    };
    const reviewCategories = [...new Set(labels.filter(({ confidence }) => confidence >= this.reviewThreshold).map(({ category }) => category))];
    const signal = reviewCategories.length > 0;
    return {
      result: { provider: this.client.providerName, modelName: this.client.modelName, modelVersion: this.client.modelVersion, scanType: 'text_safety', labels: labels.map(({ category, confidence }) => ({ label: category, confidence })), disposition: signal ? 'automated_signal' : 'automated_no_match', suitableForAutomatedAction: false },
      mediaState: signal ? 'HUMAN_REVIEW_REQUIRED' : 'CLEARED_FOR_POLICY_REVIEW',
      reviewCategories,
      reviewReason: signal ? 'Text-safety signals require contextual human review and are not a CSAM or NCII determination.' : undefined
    };
  }
}
