import { useEffect, useMemo, useState } from 'react';
import { Card } from '../components/Card';
import { CrudTable, type CrudRow } from '../components/CrudTable';
import { DataToolbar } from '../components/DataToolbar';
import { InspectorPanel } from '../components/InspectorPanel';
import { Pill } from '../components/Pill';
import type { StudioCreator, StudioPost } from '../types';

export function PostsView({
  posts,
  creators
}: {
  posts: StudioPost[];
  creators: StudioCreator[];
}) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const creatorById = new Map(creators.map((creator) => [creator.creatorId, creator]));
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return posts;
    return posts.filter((post) =>
      post.title.toLowerCase().includes(query)
      || (post.summary || '').toLowerCase().includes(query)
      || (creatorById.get(post.creatorId)?.name || '').toLowerCase().includes(query)
    );
  }, [creatorById, posts, search]);

  useEffect(() => {
    if (!filtered.length) {
      setSelectedId('');
      return;
    }
    if (!filtered.some((post) => post.postId === selectedId)) {
      setSelectedId(filtered[0].postId);
    }
  }, [filtered, selectedId]);

  const selected = filtered.find((post) => post.postId === selectedId) || filtered[0];
  const rows: CrudRow[] = filtered.map((post) => ({
    id: post.postId,
    title: post.title,
    subtitle: creatorById.get(post.creatorId)?.name || post.creatorId,
    meta: `${post.media?.length || 0} media refs`,
    badges: <Pill label={post.status} tone={post.status === 'published' ? 'success' : 'warning'} />
  }));

  return (
    <section className="studio-surface-grid">
      <Card title="Posts" eyebrow="Canonical media references">
        <DataToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search posts..."
          primaryAction={<button type="button" className="auth-primary-btn">+ New Post</button>}
        />
        <CrudTable rows={rows} selectedId={selected?.postId} onSelect={(row) => setSelectedId(row.id)} emptyMessage="No posts match this search." />
      </Card>

      <Card title="Post detail" eyebrow="Inspector">
        {selected ? (
          <InspectorPanel
            title={selected.title}
            subtitle={creatorById.get(selected.creatorId)?.name || selected.creatorId}
            status={<Pill label={selected.status} tone={selected.status === 'published' ? 'success' : 'warning'} />}
            actions={
              <>
                <button type="button" className="auth-secondary-btn">Edit</button>
                <button type="button" className="auth-secondary-btn">Media refs</button>
              </>
            }
          >
            <div className="studio-inspector-list">
              <div><strong>Summary</strong><span>{selected.summary || 'No summary'}</span></div>
              <div><strong>Primary media</strong><span>{selected.primaryMediaId || 'None'}</span></div>
              <div><strong>Referenced media</strong><span>{selected.media?.length || 0}</span></div>
            </div>
          </InspectorPanel>
        ) : (
          <div className="studio-empty-state">Select a post to inspect media references and publishing state.</div>
        )}
      </Card>
    </section>
  );
}
