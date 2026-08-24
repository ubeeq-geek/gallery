import { TextSafetyProvider, type TextSafetyClientAdapter } from '../src/textSafetyProvider';

const client = (classify: TextSafetyClientAdapter['classify']): TextSafetyClientAdapter => ({ providerName: 'configured-text-safety', modelName: 'text-moderator', modelVersion: '2', classify });

describe('text safety provider', () => {
  it('routes configured high-confidence signals to contextual human review', async () => {
    const provider = new TextSafetyProvider(client(jest.fn().mockResolvedValue({ labels: [{ category: 'grooming_solicitation', confidence: 0.91 }, { category: 'minor_sexual_context', confidence: 0.88 }] })));
    const analysis = await provider.analyze('Concerning supplied text', 'comment');
    expect(analysis).toMatchObject({ mediaState: 'HUMAN_REVIEW_REQUIRED', reviewCategories: ['grooming_solicitation', 'minor_sexual_context'] });
    expect(analysis.result).toMatchObject({ disposition: 'automated_signal', suitableForAutomatedAction: false });
    expect(analysis.reviewReason).toContain('not a CSAM or NCII determination');
  });

  it('does not escalate low-confidence labels or turn them into legal conclusions', async () => {
    const provider = new TextSafetyProvider(client(jest.fn().mockResolvedValue({ labels: [{ category: 'sexual_content', confidence: 0.45 }] })));
    const analysis = await provider.analyze('Ambiguous supplied text', 'description');
    expect(analysis).toMatchObject({ mediaState: 'CLEARED_FOR_POLICY_REVIEW', reviewCategories: [], reviewReason: undefined });
    expect(analysis.result).toMatchObject({ disposition: 'automated_no_match', suitableForAutomatedAction: false });
  });

  it('represents provider failure as scan unavailable', async () => {
    const provider = new TextSafetyProvider(client(jest.fn().mockResolvedValue({ labels: [], unavailable: true, errorCode: 'timeout' })));
    const analysis = await provider.analyze('Text that could not be scanned', 'support_submission');
    expect(analysis).toMatchObject({ mediaState: 'SCAN_UNAVAILABLE', errorCode: 'timeout', reviewCategories: [] });
    expect(analysis.result.disposition).toBe('scan_unavailable');
  });

  it('rejects empty text before calling a provider', async () => {
    const classify = jest.fn();
    await expect(new TextSafetyProvider(client(classify)).analyze('   ', 'message')).rejects.toThrow('Text is required');
    expect(classify).not.toHaveBeenCalled();
  });
});
