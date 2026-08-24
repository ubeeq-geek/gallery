import {
  diffReconciliationSnapshots,
  reconciliationStatus,
  resolveReconciliation
} from '../src/integrationReconciliation';
import { recordPublicationReconciliation } from '../src/integrationReconciliation';
import { resolvePublicationReconciliation } from '../src/integrationReconciliation';
import type { Publication } from '../src/canonicalDomain';

describe('integration reconciliation', () => {
  const baseline = { title: 'Original', tags: ['alpha'], visibility: 'public', remoteId: 'remote-1' };

  it('distinguishes non-overlapping changes from field conflicts', () => {
    const diffs = diffReconciliationSnapshots(
      baseline,
      { ...baseline, title: 'Local title' },
      { ...baseline, tags: ['alpha', 'remote'] }
    );
    expect(diffs.map((diff) => [diff.field, diff.conflict])).toEqual([['tags', false], ['title', false]]);
    expect(reconciliationStatus(diffs)).toBe('non_conflicting_changes');

    const conflict = diffReconciliationSnapshots(baseline, { ...baseline, title: 'Local title' }, { ...baseline, title: 'Remote title' });
    expect(conflict[0]).toMatchObject({ field: 'title', localChanged: true, remoteChanged: true, conflict: true });
    expect(reconciliationStatus(conflict)).toBe('conflict');
  });

  it('requires confirmation and never carries remote identity into a detached copy', () => {
    expect(() => resolveReconciliation({ title: 'Local' }, { title: 'Remote' }, { action: 'accept_remote', confirmed: false }))
      .toThrow('Explicit reconciliation confirmation is required.');
    expect(resolveReconciliation(
      { title: 'Local' },
      { title: 'Remote', remoteId: 'remote-1', externalContentId: 'content-1' },
      { action: 'create_detached_copy', confirmed: true }
    )).toEqual({ local: { title: 'Local' }, detachedCopy: { title: 'Remote' } });
  });

  it('persists a baseline until an explicit conflict resolution changes it', () => {
    const publication: Publication = {
      publicationId: 'publication-1', tenantId: 'tenant', creatorId: 'creator', workId: 'work', destination: 'deviantart',
      status: 'live', visibility: 'public', sync: { status: 'in_sync' }, createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z'
    };
    const initial = recordPublicationReconciliation(publication, { title: 'Original' }, { title: 'Original' }, '2026-08-23T01:00:00.000Z');
    const diverged = recordPublicationReconciliation(initial, { title: 'Local' }, { title: 'Remote' }, '2026-08-23T02:00:00.000Z');
    expect(diverged.sync.reconciliation).toMatchObject({ baseline: { title: 'Original' }, remote: { title: 'Remote' }, status: 'conflict' });
    expect(diverged.sync.status).toBe('conflict');
  });

  it('resolves canonical publication metadata only after confirmation', () => {
    const publication = recordPublicationReconciliation({
      publicationId: 'publication-1', tenantId: 'tenant', creatorId: 'creator', workId: 'work', destination: 'deviantart',
      status: 'live', visibility: 'public', metadataOverrides: { title: 'Local', description: 'Local text', tags: ['local'] },
      sync: { status: 'in_sync' }, createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z'
    }, { title: 'Local', description: 'Local text', tags: ['local'], visibility: 'public' }, { title: 'Remote', description: 'Remote text', tags: ['remote'], visibility: 'public' });
    const result = resolvePublicationReconciliation(publication, { action: 'accept_remote', confirmed: true }, '2026-08-23T03:00:00.000Z');
    expect(result.publication.metadataOverrides).toMatchObject({ title: 'Remote', description: 'Remote text', tags: ['remote'] });
    expect(result.publication.sync.reconciliation?.baseline).toMatchObject({ title: 'Remote' });
  });
});
