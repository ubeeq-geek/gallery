import { appendPublicationDisclosureSnapshot, createPublicationDisclosureSnapshot, creatorAiProvenance, unknownAiProvenance } from '../src/aiProvenance';
import { InMemoryStore } from '../src/inMemoryStore';
import type { Publication, Work } from '../src/canonicalDomain';

const now = '2026-08-24T12:00:00.000Z';
const work: Work = {
  workId: 'work-1', tenantId: 'test', creatorId: 'creator-1', kind: 'image', title: 'Work', slug: 'work', slugHistory: ['work'],
  tags: [], contentRating: 'general', aiDisclosure: 'ai-generated',
  aiProvenance: { assertion: 'ai-generated', sources: [{ kind: 'creator', assertion: 'ai-generated', assertedAt: now }], updatedAt: now },
  heavyTopics: [], status: 'ready', origin: { type: 'local' }, revision: 3, createdAt: now, updatedAt: now
};
const publication: Publication = {
  publicationId: 'publication-1', tenantId: 'test', creatorId: 'creator-1', workId: 'work-1', destination: 'instagram',
  status: 'draft', visibility: 'public', sync: { status: 'local_newer' }, createdAt: now, updatedAt: now
};

describe('AI provenance and publication disclosure snapshots', () => {
  it('preserves unknown imported provenance instead of claiming no AI', () => {
    expect(unknownAiProvenance({ kind: 'import', platform: 'instagram', remoteId: 'remote-1', assertedAt: now })).toMatchObject({ assertion: 'unknown' });
  });

  it('keeps creator disclosure assertions as provenance history', () => {
    const first = creatorAiProvenance('none', now);
    const changed = creatorAiProvenance('ai-assisted', '2026-08-24T13:00:00.000Z', first);
    expect(changed.assertion).toBe('ai-assisted');
    expect(changed.sources).toEqual([
      expect.objectContaining({ kind: 'creator', assertion: 'none' }),
      expect.objectContaining({ kind: 'creator', assertion: 'ai-assisted' })
    ]);
  });

  it('appends one immutable snapshot per stable attempt key', () => {
    const first = createPublicationDisclosureSnapshot({ publicationId: publication.publicationId, attemptKey: 'attempt-1', work, assetChecksumsSha256: ['abc'], capturedAt: now });
    const saved = appendPublicationDisclosureSnapshot(publication, first);
    expect(saved.disclosureSnapshots).toEqual([first]);
    expect(appendPublicationDisclosureSnapshot(saved, { ...first, capturedAt: 'later' }).disclosureSnapshots).toEqual([first]);
    const changed = createPublicationDisclosureSnapshot({ publicationId: publication.publicationId, attemptKey: 'attempt-1', work: { ...work, aiDisclosure: 'none' }, capturedAt: now });
    expect(() => appendPublicationDisclosureSnapshot(saved, changed)).toThrow('immutable');
  });

  it('rejects mutation or removal of persisted disclosure history', async () => {
    const store = new InMemoryStore();
    const snapshot = createPublicationDisclosureSnapshot({ publicationId: publication.publicationId, attemptKey: 'attempt-1', work, capturedAt: now });
    const saved = appendPublicationDisclosureSnapshot(publication, snapshot);
    await store.upsertPublication(saved);
    await expect(store.upsertPublication({ ...saved, disclosureSnapshots: [] })).rejects.toThrow('cannot be removed');
    await expect(store.upsertPublication({ ...saved, disclosureSnapshots: [{ ...snapshot, aiDisclosure: 'none' }] })).rejects.toThrow('immutable');
  });
});
