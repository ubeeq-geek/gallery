import { Card } from '../components/Card';
import type { StudioEntry, StudioMetrics, StudioPost } from '../types';

export function DashboardView({
  metrics,
  posts,
  entries
}: {
  metrics: StudioMetrics;
  posts: StudioPost[];
  entries: StudioEntry[];
}) {
  return (
    <>
      <Card title="Needs attention" eyebrow="Activity">
        <div className="studio-summary-list">
          {entries.length > 0 && <div><strong>{metrics.reviewItems || entries.length} item{(metrics.reviewItems || entries.length) === 1 ? '' : 's'} awaiting review</strong><span>Open Entries to continue.</span></div>}
          {posts.slice(0, 3).map((post) => <div key={post.postId}><strong>{post.title}</strong><span>{post.status}</span></div>)}
          {!entries.length && !posts.length && <p className="small">No items need attention right now.</p>}
        </div>
      </Card>
    </>
  );
}
