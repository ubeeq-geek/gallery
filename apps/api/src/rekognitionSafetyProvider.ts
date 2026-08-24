import type { MediaScanState, ScanResult } from './supportSafety';

export const REKOGNITION_AGE_SIGNAL_DISCLAIMER = 'Estimated age ranges are risk signals only and are not proof of age.';

const matureLabels = new Set(['Explicit Sexual Activity', 'Explicit Nudity', 'Hate Symbols']);
const ageSensitiveLabels = new Set(['Explicit Sexual Activity', 'Explicit Nudity', 'Non-Explicit Nudity', 'Swimwear or Underwear', 'Kissing', 'Implied Nudity', 'Violence', 'Visually Disturbing']);

export interface RekognitionModerationLabel {
  Name?: string;
  Confidence?: number;
}

export interface RekognitionFaceDetail {
  AgeRange?: { Low?: number; High?: number };
  Confidence?: number;
}

export interface RekognitionClientAdapter {
  detectModerationLabels(input: { imageBytes: Uint8Array; minConfidence?: number }): Promise<{ labels?: RekognitionModerationLabel[]; modelVersion?: string }>;
  detectFaces(input: { imageBytes: Uint8Array }): Promise<{ faces?: RekognitionFaceDetail[]; modelVersion?: string }>;
}

export interface RekognitionImageAnalysis {
  results: Array<Omit<ScanResult, 'scanResultId' | 'scanJobId' | 'targetId' | 'contentHash' | 'createdAt'>>;
  mediaState: Extract<MediaScanState, 'CLEARED_FOR_POLICY_REVIEW' | 'HUMAN_REVIEW_REQUIRED'>;
  maturityLabels: string[];
  ageSensitiveTriggers: string[];
  estimatedAgeRanges: Array<{ low: number; high: number; confidence: number }>;
  ageEstimateDisclaimer?: typeof REKOGNITION_AGE_SIGNAL_DISCLAIMER;
  safetyReviewReason?: string;
}

/** General moderation triage only. This adapter never returns a legal CSAM/NCII determination. */
export class RekognitionImageSafetyProvider {
  constructor(private readonly client: RekognitionClientAdapter, private readonly minConfidence = 70) {}

  async analyze(imageBytes: Uint8Array): Promise<RekognitionImageAnalysis> {
    if (!imageBytes.byteLength) throw new Error('Image bytes are required');
    const moderation = await this.client.detectModerationLabels({ imageBytes, minConfidence: this.minConfidence });
    const labels = (moderation.labels || [])
      .filter((label): label is Required<RekognitionModerationLabel> => typeof label.Name === 'string' && typeof label.Confidence === 'number')
      .map((label) => ({ label: label.Name, confidence: label.Confidence / 100 }));
    const maturity = [...new Set(labels.filter(({ label }) => matureLabels.has(label)).map(({ label }) => label))];
    const triggers = [...new Set(labels.filter(({ label }) => ageSensitiveLabels.has(label)).map(({ label }) => label))];
    let faceResponse: Awaited<ReturnType<RekognitionClientAdapter['detectFaces']>> | undefined;
    if (triggers.length) faceResponse = await this.client.detectFaces({ imageBytes });
    const ages = (faceResponse?.faces || []).flatMap((face) => {
      const low = face.AgeRange?.Low; const high = face.AgeRange?.High;
      return typeof low === 'number' && typeof high === 'number' ? [{ low, high, confidence: (face.Confidence || 0) / 100 }] : [];
    });
    const possibleMinorInAgeSensitiveContext = triggers.length > 0 && ages.some(({ low }) => low < 18);
    const moderationVersion = moderation.modelVersion || 'unspecified';
    const results: RekognitionImageAnalysis['results'] = [{ provider: 'aws-rekognition', modelName: 'DetectModerationLabels', modelVersion: moderationVersion, scanType: 'image_moderation', labels, disposition: possibleMinorInAgeSensitiveContext ? 'automated_signal' : 'automated_no_match', suitableForAutomatedAction: false }];
    if (faceResponse) results.push({ provider: 'aws-rekognition', modelName: 'DetectFaces', modelVersion: faceResponse.modelVersion || moderationVersion, scanType: 'face_age_signal', labels: ages.flatMap(({ low, high, confidence }, index) => [{ label: `face_${index + 1}_estimated_age_${low}_${high}`, confidence }]), disposition: possibleMinorInAgeSensitiveContext ? 'automated_signal' : 'automated_no_match', suitableForAutomatedAction: false });
    return {
      results,
      mediaState: possibleMinorInAgeSensitiveContext ? 'HUMAN_REVIEW_REQUIRED' : 'CLEARED_FOR_POLICY_REVIEW',
      maturityLabels: maturity,
      ageSensitiveTriggers: triggers,
      estimatedAgeRanges: ages,
      ageEstimateDisclaimer: ages.length ? REKOGNITION_AGE_SIGNAL_DISCLAIMER : undefined,
      safetyReviewReason: possibleMinorInAgeSensitiveContext ? 'Age-sensitive content may include an underage subject; restricted human review is required. This is not a CSAM determination.' : undefined
    };
  }
}
