import { Link } from 'react-router-dom';
import { Card } from '../components/Card';
import type { StudioCreator, StudioEntry, StudioFile, StudioMetrics, StudioPost } from '../types';

export function DashboardView({
  metrics,
  creators,
  files,
  posts,
  entries,
  activeCreatorId
}: {
  metrics: StudioMetrics;
  creators: StudioCreator[];
  files: StudioFile[];
  posts: StudioPost[];
  entries: StudioEntry[];
  activeCreatorId: string;
}) {
  const activeCreator = creators.find((creator) => creator.creatorId === activeCreatorId);
  const creatorWorkCount = activeCreator
    ? posts.filter((post) => post.creatorId === activeCreator.creatorId).length + files.filter((file) => file.creatorId === activeCreator.creatorId).length
    : 0;
  return (
    <>
      <Card title={`Good to see you${activeCreator ? `, ${activeCreator.name}` : ''}`} eyebrow="Home">
        <p className="studio-home-intro">Choose one task to continue managing your creative catalogue.</p>
        <div className="studio-task-grid">
          <Link className="studio-task-link no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(activeCreatorId)}`}><strong>Browse works</strong><span>{creatorWorkCount} local records in this creator context.</span></Link>
          <Link className="studio-task-link no-underline" to={`/studio/workspace?section=collections&creatorId=${encodeURIComponent(activeCreatorId)}`}><strong>Organize collections</strong><span>Manage Ubeeq collections, galleries, and series.</span></Link>
          <Link className="studio-task-link no-underline" to={`/studio/workspace?section=integrations&creatorId=${encodeURIComponent(activeCreatorId)}`}><strong>Manage DeviantArt</strong><span>Review connected accounts and catalogue synchronization.</span></Link>
          <Link className="studio-task-link no-underline" to={`/studio/workspace?section=publishing&creatorId=${encodeURIComponent(activeCreatorId)}`}><strong>Prepare publishing</strong><span>Choose work and move it toward an external destination.</span></Link>
        </div>
      </Card>

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
