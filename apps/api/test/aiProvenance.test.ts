import { instagramDisclosureSnapshot, requiresInstagramCarouselDisclosureChoice } from '../src/aiProvenance';

describe('platform-neutral AI provenance', () => {
  const work = { kind: 'human-created' as const, source: 'creator-declaration' as const };

  it('keeps a mixed Instagram carousel blocked until the creator chooses a conservative disclosure', () => {
    const snapshot = instagramDisclosureSnapshot(work, [
      { assetId: 'human', provenance: work },
      { assetId: 'ai', provenance: { kind: 'ai-generated', source: 'content-credentials' } }
    ], 'CAROUSEL');
    expect(requiresInstagramCarouselDisclosureChoice(snapshot)).toBe(true);
    expect(snapshot.platformDisclosure).toBeUndefined();

    const conservative = instagramDisclosureSnapshot(work, [
      { assetId: 'human', provenance: work },
      { assetId: 'ai', provenance: { kind: 'ai-generated', source: 'content-credentials' } }
    ], 'CAROUSEL', 'disclose-all');
    expect(conservative.platformDisclosure).toBe(true);
    expect(requiresInstagramCarouselDisclosureChoice(conservative)).toBe(false);
  });

  it('maps a single effective AI provenance directly to the Instagram disclosure field', () => {
    expect(instagramDisclosureSnapshot(work, [{ assetId: 'ai', provenance: { kind: 'ai-assisted', source: 'creator-declaration' } }], 'IMAGE').platformDisclosure).toBe(true);
    expect(instagramDisclosureSnapshot(work, [{ assetId: 'human', provenance: work }], 'REEL').platformDisclosure).toBe(false);
  });
});
