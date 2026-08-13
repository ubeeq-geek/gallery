import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Card } from '../components/Card';
import { CrudTable, type CrudRow } from '../components/CrudTable';
import { DataToolbar } from '../components/DataToolbar';
import { InspectorPanel } from '../components/InspectorPanel';
import { Pill } from '../components/Pill';
import type { StudioCreator, StudioPost } from '../types';
import { PostEditorView } from './PostEditorView';

const postTypeOptions = [
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
  { value: 'story', label: 'Story' },
  { value: 'audio', label: 'Audio' }
] as const;

const getPostType = (post: StudioPost): 'image' | 'video' | 'story' | 'audio' => {
  const raw = post.postType || post.metadata?.postType;
  if (raw === 'image' || raw === 'video' || raw === 'story' || raw === 'audio') return raw;
  return post.primaryMediaId ? 'image' : 'story';
};

export function PostsView({
  posts,
  creators,
  onPostSaved
}: {
  posts: StudioPost[];
  creators: StudioCreator[];
  onPostSaved?: (post: StudioPost) => void | Promise<void>;
}) {
  const location = useLocation();
  const editingPostId = useMemo(() => new URLSearchParams(location.search).get('postId') || '', [location.search]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'image' | 'video' | 'story' | 'audio'>('all');
  const creatorById = new Map(creators.map((creator) => [creator.creatorId, creator]));
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return posts.filter((post) => {
      if (typeFilter !== 'all' && getPostType(post) !== typeFilter) return false;
      if (!query) return true;
      return post.title.toLowerCase().includes(query)
        || (post.summary || '').toLowerCase().includes(query)
        || (creatorById.get(post.creatorId)?.name || '').toLowerCase().includes(query);
    });
  }, [creatorById, posts, search, typeFilter]);

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
    badges: (
      <>
        <Pill label={getPostType(post)} tone="info" />
        <Pill label={post.status} tone={post.status === 'published' ? 'success' : 'warning'} />
      </>
    )
  }));

  const editingPost = posts.find((post) => post.postId === editingPostId);
  if (editingPost) return <PostEditorView post={editingPost} creators={creators} onSaved={onPostSaved} />;

  return (
    <section className="studio-surface-grid">
      <Card title="Posts" eyebrow="Canonical media references">
        <DataToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search posts..."
          primaryAction={
            <div className="studio-inline-actions">
              <button type="button" className={`auth-secondary-btn${typeFilter === 'all' ? ' is-active' : ''}`} onClick={() => setTypeFilter('all')}>All</button>
              {postTypeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`auth-secondary-btn${typeFilter === option.value ? ' is-active' : ''}`}
                  onClick={() => setTypeFilter(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          }
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
                <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=posts&creatorId=${encodeURIComponent(selected.creatorId)}&postId=${encodeURIComponent(selected.postId)}`}>Edit</Link>
                <button type="button" className="auth-secondary-btn">Media refs</button>
              </>
            }
          >
            <div className="studio-inspector-list">
              <div><strong>Summary</strong><span>{selected.summary || 'No summary'}</span></div>
              <div><strong>Type</strong><span>{getPostType(selected)}</span></div>
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
