import { REKOGNITION_AGE_SIGNAL_DISCLAIMER, RekognitionImageSafetyProvider, type RekognitionClientAdapter } from '../src/rekognitionSafetyProvider';

describe('Rekognition image safety provider', () => {
  it('labels lawful adult explicit content without treating it as a safety hold', async () => {
    const client: RekognitionClientAdapter = {
      detectModerationLabels: jest.fn().mockResolvedValue({ modelVersion: '7', labels: [{ Name: 'Explicit Nudity', Confidence: 99 }] }),
      detectFaces: jest.fn().mockResolvedValue({ modelVersion: '7', faces: [{ AgeRange: { Low: 25, High: 34 }, Confidence: 98 }] })
    };
    const analysis = await new RekognitionImageSafetyProvider(client).analyze(Buffer.from('image'));
    expect(analysis).toMatchObject({ mediaState: 'CLEARED_FOR_POLICY_REVIEW', maturityLabels: ['Explicit Nudity'], ageSensitiveTriggers: ['Explicit Nudity'], ageEstimateDisclaimer: REKOGNITION_AGE_SIGNAL_DISCLAIMER });
    expect(analysis.safetyReviewReason).toBeUndefined();
    expect(analysis.results.every((result) => result.suitableForAutomatedAction === false)).toBe(true);
  });

  it('routes a possible minor in an age-sensitive context to human review without claiming CSAM', async () => {
    const client: RekognitionClientAdapter = {
      detectModerationLabels: jest.fn().mockResolvedValue({ labels: [{ Name: 'Explicit Sexual Activity', Confidence: 91 }] }),
      detectFaces: jest.fn().mockResolvedValue({ faces: [{ AgeRange: { Low: 15, High: 22 }, Confidence: 97 }] })
    };
    const analysis = await new RekognitionImageSafetyProvider(client).analyze(Buffer.from('image'));
    expect(analysis.mediaState).toBe('HUMAN_REVIEW_REQUIRED');
    expect(analysis.results).toEqual(expect.arrayContaining([expect.objectContaining({ disposition: 'automated_signal', suitableForAutomatedAction: false })]));
    expect(analysis.safetyReviewReason).toContain('not a CSAM determination');
  });

  it('always calls face analysis, even when no age-sensitive trigger exists', async () => {
    const detectFaces = jest.fn().mockResolvedValue({ faces: [] });
    const client: RekognitionClientAdapter = { detectModerationLabels: jest.fn().mockResolvedValue({ labels: [{ Name: 'Alcohol', Confidence: 88 }] }), detectFaces };
    const analysis = await new RekognitionImageSafetyProvider(client).analyze(Buffer.from('image'));
    expect(detectFaces).toHaveBeenCalledTimes(1);
    expect(analysis).toMatchObject({ mediaState: 'CLEARED_FOR_POLICY_REVIEW', maturityLabels: [], ageSensitiveTriggers: [], estimatedAgeRanges: [] });
  });
});
