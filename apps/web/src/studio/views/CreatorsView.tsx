import { useEffect, useMemo, useState } from 'react';
import { Card } from '../components/Card';
import { CrudTable, type CrudRow } from '../components/CrudTable';
import { DataToolbar } from '../components/DataToolbar';
import { InspectorPanel } from '../components/InspectorPanel';
import { Pill } from '../components/Pill';
import type { StudioCreator, StudioFile, StudioPost } from '../types';

const slugSuggestion = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function CreatorsView({
  creators,
  posts,
  files,
  onCreateCreator
}: {
  creators: StudioCreator[];
  posts: StudioPost[];
  files: StudioFile[];
  onCreateCreator: (payload: { name: string; slug: string }) => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string>('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return creators;
    return creators.filter((creator) =>
      creator.name.toLowerCase().includes(query) || creator.slug.toLowerCase().includes(query)
    );
  }, [creators, search]);

  useEffect(() => {
    if (!filtered.length) {
      setSelectedId('');
      return;
    }
    if (!filtered.some((creator) => creator.creatorId === selectedId)) {
      setSelectedId(filtered[0].creatorId);
    }
  }, [filtered, selectedId]);

  const selected = filtered.find((creator) => creator.creatorId === selectedId) || filtered[0];
  const rows: CrudRow[] = filtered.map((creator) => ({
    id: creator.creatorId,
    title: creator.name,
    subtitle: `slug: ${creator.slug}`,
    meta: `${posts.filter((post) => post.creatorId === creator.creatorId).length} posts · ${files.filter((file) => file.creatorId === creator.creatorId).length} files`,
    badges: <Pill label={creator.status === 'inactive' ? 'Inactive' : 'Active'} tone={creator.status === 'inactive' ? 'warning' : 'success'} />
  }));

  const submit = async () => {
    const trimmedName = name.trim();
    const trimmedSlug = (slug.trim() || slugSuggestion(trimmedName));
    if (!trimmedName || !trimmedSlug) return;
    await onCreateCreator({ name: trimmedName, slug: trimmedSlug });
    setName('');
    setSlug('');
  };

  return (
    <section className="studio-surface-grid">
      <Card title="Creators" eyebrow="Ownership and identity">
        <DataToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search creators..."
          primaryAction={<button type="button" className="auth-primary-btn" onClick={() => void submit()}>+ New Creator</button>}
        />
        <div className="studio-inline-form">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Creator name" />
          <input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="creator-slug" />
        </div>
        <CrudTable rows={rows} selectedId={selected?.creatorId} onSelect={(row) => setSelectedId(row.id)} emptyMessage="No creators match this search." />
      </Card>

      <Card title="Creator detail" eyebrow="Inspector">
        {selected ? (
          <InspectorPanel
            title={selected.name}
            subtitle={`/${selected.slug}`}
            status={<Pill label={selected.status === 'inactive' ? 'Inactive' : 'Active'} tone={selected.status === 'inactive' ? 'warning' : 'success'} />}
            actions={
              <>
                <button type="button" className="auth-secondary-btn">Edit</button>
                <button type="button" className="auth-secondary-btn">Ownership</button>
              </>
            }
          >
            <div className="studio-inspector-list">
              <div><strong>Creator ID</strong><span>{selected.creatorId || selected.creatorId}</span></div>
              <div><strong>Posts</strong><span>{posts.filter((post) => post.creatorId === selected.creatorId).length}</span></div>
              <div><strong>Files</strong><span>{files.filter((file) => file.creatorId === selected.creatorId).length}</span></div>
            </div>
          </InspectorPanel>
        ) : (
          <div className="studio-empty-state">Select a creator to inspect ownership and content counts.</div>
        )}
      </Card>
    </section>
  );
}
