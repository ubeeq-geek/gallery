import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from './api';

type StudioSection =
  | 'dashboard'
  | 'files-media'
  | 'posts'
  | 'creator-groupings'
  | 'collections'
  | 'creators'
  | 'challenges'
  | 'entries'
  | 'users'
  | 'moderation';

const sectionDefs: Array<{ key: StudioSection; label: string; description: string }> = [
  { key: 'dashboard', label: 'Dashboard', description: 'Overview and action queues for Studio.' },
  { key: 'files-media', label: 'Files & Media', description: 'File-level and media-level resources.' },
  { key: 'posts', label: 'Posts', description: 'Canonical post CRUD with media references.' },
  { key: 'creator-groupings', label: 'Creator Groupings', description: 'Series, gallery, and set grouping resources.' },
  { key: 'collections', label: 'Collections', description: 'User collections with privacy + moderation behavior.' },
  { key: 'creators', label: 'Creators', description: 'Creator account CRUD and ownership management.' },
  { key: 'challenges', label: 'Challenges', description: 'Admin-managed challenge lifecycle + prizes + winners.' },
  { key: 'entries', label: 'Entries', description: 'Entry approvals and contributor (Beeker) promotions.' },
  { key: 'users', label: 'Users', description: 'Role ladder, promotions/demotions, and account controls.' },
  { key: 'moderation', label: 'Moderation', description: 'Blocks, bans, and destructive-action safeguards.' }
];

const readSection = (search: string): StudioSection => {
  const params = new URLSearchParams(search);
  const candidate = params.get('section');
  if (!candidate) return 'dashboard';
  const found = sectionDefs.find((item) => item.key === candidate);
  return found?.key || 'dashboard';
};

export function StudioWorkspace() {
  const location = useLocation();
  const section = useMemo(() => readSection(location.search), [location.search]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [creators, setCreators] = useState<Array<{ artistId: string; name: string; slug: string }>>([]);
  const [files, setFiles] = useState<Array<{ fileId: string; originalFilename?: string; sourceKind: string; creatorId: string }>>([]);
  const [posts, setPosts] = useState<Array<{ postId: string; title: string; status: string; artistId: string }>>([]);
  const [galleries, setGalleries] = useState<Array<{ galleryId: string; title: string; artistId: string }>>([]);
  const [metrics, setMetrics] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const [nextCreators, nextFiles, nextPosts, nextGalleries, nextMetrics] = await Promise.all([
          api.adminListCreators(),
          api.adminListFiles(),
          api.adminListPosts(),
          api.adminListGalleries(),
          api.studioMetrics()
        ]);
        if (cancelled) return;
        setCreators((nextCreators as any[]) || []);
        setFiles((nextFiles as any[]) || []);
        setPosts((nextPosts as any[]) || []);
        setGalleries((nextGalleries as any[]) || []);
        setMetrics((nextMetrics as Record<string, number>) || {});
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load Studio workspace');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const sectionMeta = sectionDefs.find((item) => item.key === section) || sectionDefs[0];

  return (
    <div className="layout studio-dashboard-shell">
      <aside className="studio-sidebar panel">
        <div className="studio-brand-card">
          <strong>Ubeeq</strong>
          <span>STUDIO</span>
        </div>
        <nav className="studio-sidebar-nav">
          {sectionDefs.map((item) => (
            <Link
              key={item.key}
              className={`studio-nav-item no-underline${item.key === section ? ' studio-nav-item-active' : ''}`}
              to={item.key === 'dashboard' ? '/studio/workspace' : `/studio/workspace?section=${item.key}`}
            >
              <span>{item.label}</span>
              <span aria-hidden="true">›</span>
            </Link>
          ))}
        </nav>
      </aside>

      <section className="studio-main">
        <section className="panel">
          <h2>{sectionMeta.label}</h2>
          <p className="small">{sectionMeta.description}</p>
          {loading && <p className="small">Loading workspace data…</p>}
          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel">
          <h3>Live data snapshot</h3>
          <div className="studio-crud-grid">
            <article className="studio-crud-card"><h4>Creators</h4><p>{creators.length}</p></article>
            <article className="studio-crud-card"><h4>Files</h4><p>{files.length}</p></article>
            <article className="studio-crud-card"><h4>Posts</h4><p>{posts.length}</p></article>
            <article className="studio-crud-card"><h4>Galleries</h4><p>{galleries.length}</p></article>
          </div>
          <p className="small">Total users: {metrics.totalUsers || 0} · Admin review items: {metrics.adminReviewItems || 0}</p>
        </section>

        {section === 'files-media' && (
          <section className="panel">
            <h3>Files</h3>
            <ul>
              {files.slice(0, 20).map((file) => (
                <li key={file.fileId}>{file.originalFilename || file.fileId} · {file.sourceKind} · creator {file.creatorId}</li>
              ))}
            </ul>
            <h3 className="mt-4">Media integration path</h3>
            <p className="small">Media item CRUD continues through `/admin/images` with gallery context, while files are now first-class under `/admin/files`.</p>
          </section>
        )}

        {section === 'posts' && (
          <section className="panel">
            <h3>Posts</h3>
            <ul>
              {posts.slice(0, 25).map((post) => <li key={post.postId}>{post.title} ({post.status}) · creator {post.artistId}</li>)}
            </ul>
          </section>
        )}

        {section === 'creators' && (
          <section className="panel">
            <h3>Creators</h3>
            <ul>
              {creators.slice(0, 25).map((creator) => <li key={creator.artistId}>{creator.name} / {creator.slug}</li>)}
            </ul>
          </section>
        )}

        {['users', 'moderation', 'entries', 'challenges', 'creator-groupings', 'collections'].includes(section) && (
          <section className="panel">
            <h3>{sectionMeta.label} implementation notes</h3>
            <p className="small">
              This section now uses the new Studio workspace shell. Next API wiring for this section should be attached here
              (instead of the legacy Artist workspace), so `/studio/workspace?section={section}` never falls back to old UI.
            </p>
          </section>
        )}
      </section>
    </div>
  );
}
