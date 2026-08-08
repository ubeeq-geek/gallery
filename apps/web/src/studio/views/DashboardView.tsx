import { Card } from '../components/Card';
import type { StudioCreator, StudioEntry, StudioFile, StudioMetrics, StudioPost } from '../types';

export function DashboardView({
  metrics,
  creators,
  files,
  posts,
  entries
}: {
  metrics: StudioMetrics;
  creators: StudioCreator[];
  files: StudioFile[];
  posts: StudioPost[];
  entries: StudioEntry[];
}) {
  return (
    <>
      <section className="studio-stat-grid">
        <article className="panel"><p>Creators</p><h3>{metrics.creators || creators.length}</h3><span>managed in Studio</span></article>
        <article className="panel"><p>Files</p><h3>{metrics.files || files.length}</h3><span>separate from media items</span></article>
        <article className="panel"><p>Posts</p><h3>{metrics.posts || posts.length}</h3><span>canonical media references</span></article>
        <article className="panel"><p>Review items</p><h3>{metrics.reviewItems || entries.length}</h3><span>entries awaiting action</span></article>
      </section>

      <section className="studio-surface-grid">
        <Card title="Studio overview" eyebrow="Unified workflows">
          <div className="studio-overview-cards">
            <div className="studio-overview-card success">
              <h4>Creator ownership</h4>
              <p>Creators and admins manage multiple creator accounts in one Studio surface.</p>
              <span>{creators.length} creator records loaded</span>
            </div>
            <div className="studio-overview-card info">
              <h4>Media architecture</h4>
              <p>Files stay distinct from derived media items and downstream post references.</p>
              <span>{metrics.mediaItems || 0} media items tracked</span>
            </div>
            <div className="studio-overview-card warning">
              <h4>Contribution ladder</h4>
              <p>Approved entries can promote users into the contributor role while keeping the configured display label in UI.</p>
              <span>{metrics.contributors || 0} contributors active</span>
            </div>
          </div>
        </Card>

        <Card title="Recent workbench activity" eyebrow="Live snapshot">
          <div className="studio-summary-list">
            {creators.slice(0, 3).map((creator) => <div key={creator.creatorId}><strong>{creator.name}</strong><span>Creator</span></div>)}
            {posts.slice(0, 3).map((post) => <div key={post.postId}><strong>{post.title}</strong><span>{post.status}</span></div>)}
            {!creators.length && !posts.length && <p className="small">No Studio data loaded yet.</p>}
          </div>
        </Card>
      </section>
    </>
  );
}
