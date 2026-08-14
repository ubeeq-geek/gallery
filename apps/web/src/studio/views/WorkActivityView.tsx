import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { Card } from '../components/Card';
import type {
  StudioCreator,
  StudioExternalActivity,
  StudioExternalAsset,
  StudioExternalComment,
  StudioWorkActivityDestination
} from '../types';

const relativeDate = (value?: string): string => value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Date unavailable';

const metric = (value?: number): string => typeof value === 'number' ? new Intl.NumberFormat().format(value) : '—';

type WorkActivityResponse = { asset: StudioExternalAsset; destinations: StudioWorkActivityDestination[] };

export function WorkActivityView({ creators: _creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const creatorId = params.get('creatorId') || '';
  const workId = params.get('workId') || '';
  const collectionId = params.get('collectionId') || '';
  const [asset, setAsset] = useState<StudioExternalAsset | null>(null);
  const [destinations, setDestinations] = useState<StudioWorkActivityDestination[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [replyingTo, setReplyingTo] = useState('');
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [failedReplyTo, setFailedReplyTo] = useState('');
  const [showRemovedComments, setShowRemovedComments] = useState(false);

  const load = async () => {
    if (!workId) return;
    const response = await api.studioGetWorkActivity(workId) as WorkActivityResponse;
    setAsset(response.asset);
    setDestinations(response.destinations || []);
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void load().catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load activity.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workId]);

  const refresh = async () => {
    if (!workId) return;
    setRefreshing(true);
    setError('');
    setMessage('');
    try {
      await api.studioSyncWorkActivity(workId);
      setMessage('Activity refresh queued. Stored activity remains available while connected platforms synchronize.');
      window.setTimeout(() => { void load().catch(() => undefined); }, 2500);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Unable to refresh activity.');
    } finally {
      setRefreshing(false);
    }
  };

  const reply = async (comment: StudioExternalComment, destination: StudioWorkActivityDestination) => {
    if (!draft.trim()) return;
    setPosting(true);
    setError('');
    try {
      await api.studioReplyToDeviantArtComment(
        destination.publication.externalAccountId,
        destination.publication.externalContentId,
        comment.externalCommentExternalId,
        draft.trim()
      );
      setDraft('');
      setReplyingTo('');
      setFailedReplyTo('');
      await load();
    } catch (replyError) {
      setFailedReplyTo(comment.externalCommentId);
      setError(replyError instanceof Error ? replyError.message : 'DeviantArt did not accept the reply. Your draft is still here.');
    } finally {
      setPosting(false);
    }
  };

  const allComments = destinations.flatMap((destination) => destination.comments.map((comment) => ({ comment, destination })));
  const removedCommentCount = allComments.filter(({ comment }) => Boolean(comment.remoteDeletedAt)).length;
  const comments = allComments
    .filter(({ comment }) => showRemovedComments || !comment.remoteDeletedAt)
    .sort((left, right) => (right.comment.createdAtRemote || right.comment.firstSeenAt).localeCompare(left.comment.createdAtRemote || left.comment.firstSeenAt));
  const activities = destinations.flatMap((destination) => destination.activities.map((activity) => ({ activity, destination })))
    .sort((left, right) => (right.activity.occurredAt || right.activity.firstSeenAt).localeCompare(left.activity.occurredAt || left.activity.firstSeenAt));
  const activeFavourites = destinations.flatMap((destination) => destination.favourites.map((favourite) => ({ favourite, destination })))
    .filter(({ favourite }) => favourite.active)
    .sort((left, right) => (right.favourite.favouritedAtRemote || right.favourite.firstSeenAt).localeCompare(left.favourite.favouritedAtRemote || left.favourite.firstSeenAt));
  const totals = destinations.reduce((current, destination) => ({
    views: current.views + (destination.engagement?.views || 0),
    favourites: current.favourites + (destination.engagement?.favourites || 0),
    comments: current.comments + (destination.engagement?.comments || 0),
    downloads: current.downloads + (destination.engagement?.downloads || 0)
  }), { views: 0, favourites: 0, comments: 0, downloads: 0 });

  const back = () => navigate(`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}${collectionId ? `&collectionId=${encodeURIComponent(collectionId)}` : ''}`);
  if (loading) return <div className="studio-empty-state">Loading work activity…</div>;
  if (!asset) return <div className="studio-empty-state">This work is no longer available.</div>;
  return <div className="studio-work-metadata">
    <div className="studio-work-metadata-topbar"><button type="button" className="auth-secondary-btn" onClick={back}>← Works</button><span>Work activity</span></div>
    <Card title={asset.canonicalTitle || 'Untitled work'}>
      <p>Activity is stored in Ubeeq and refreshed automatically. Manual refresh checks feedback, comments, favourites, and engagement totals.</p>
      {destinations.length
        ? <button type="button" className="auth-secondary-btn" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh activity'}</button>
        : <p className="small">Publish this work to a connected platform to receive activity here.</p>}
    </Card>
    {error && <p className="studio-work-metadata-warning">{error}</p>}
    {message && <p className="studio-work-metadata-success">{message}</p>}
    <Card title="Engagement">
      <div className="studio-work-destination-row"><strong>Views</strong><span>{metric(totals.views)}</span></div>
      <div className="studio-work-destination-row"><strong>Favourites</strong><span>{metric(totals.favourites)}</span></div>
      <div className="studio-work-destination-row"><strong>Comments</strong><span>{metric(totals.comments)}</span></div>
      <div className="studio-work-destination-row"><strong>Downloads</strong><span>{metric(totals.downloads)}</span></div>
      {destinations.map((destination) => <div className="studio-work-destination-row" key={destination.publication.externalPublicationId}>
        <strong>{destination.publication.externalUsername ? `@${destination.publication.externalUsername}` : destination.publication.platform}</strong>
        <small>Updated {relativeDate(destination.engagement?.capturedAt || destination.publication.lastSyncedAt)}</small>
        {destination.publication.externalUrl && <a href={destination.publication.externalUrl} target="_blank" rel="noreferrer">Open on DeviantArt</a>}
      </div>)}
    </Card>
    <Card title="Recent activity">
      {!activities.length ? <p className="small">No platform activity has been imported yet.</p> : activities.slice(0, 50).map(({ activity, destination }) => <ActivityRow key={activity.externalActivityId} activity={activity} destination={destination} />)}
    </Card>
    <Card title="Comments">
      {removedCommentCount > 0 && <label className="studio-work-metadata-option">
        <input type="checkbox" checked={showRemovedComments} onChange={(event) => setShowRemovedComments(event.target.checked)} />
        <span>Show {removedCommentCount} comment{removedCommentCount === 1 ? '' : 's'} removed from DeviantArt</span>
      </label>}
      {destinations.some((destination) => destination.capabilities?.remoteCommentModeration === false) && <p className="small">Replies can be posted from Ubeeq. DeviantArt’s public API does not provide comment hide or delete operations, so moderation links remain on DeviantArt.</p>}
      {!comments.length ? <p className="small">No comments have been imported yet.</p> : comments.map(({ comment, destination }) => <article key={`${destination.publication.externalPublicationId}:${comment.externalCommentId}`} className="studio-work-destination-row">
        <strong>{comment.externalAuthorName ? `@${comment.externalAuthorName}` : 'Platform member'}</strong>
        <small>{relativeDate(comment.createdAtRemote || comment.lastSyncedAt)}</small>
        <p>{comment.body}</p>
        {comment.remoteDeletedAt && <small>Removed from DeviantArt · cached history retained by Ubeeq</small>}
        {comment.parentExternalCommentExternalId && <small>Reply in thread</small>}
        {typeof comment.likeCount === 'number' && <small>{comment.likeCount} likes</small>}
        {!comment.remoteDeletedAt && destination.capabilities?.reply !== false && <button type="button" className="auth-secondary-btn" onClick={() => { setReplyingTo(comment.externalCommentId); setDraft(''); setFailedReplyTo(''); }}>Reply</button>}
        {replyingTo === comment.externalCommentId && <div>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write a DeviantArt reply" />
          {failedReplyTo === comment.externalCommentId && <small>DeviantArt did not confirm this reply. Your draft is retained; retry when ready.</small>}
          <button type="button" className="auth-primary-btn" disabled={posting || !draft.trim()} onClick={() => void reply(comment, destination)}>{posting ? 'Replying…' : failedReplyTo === comment.externalCommentId ? 'Retry reply' : 'Reply'}</button>
          <button type="button" className="auth-secondary-btn" disabled={posting} onClick={() => { setReplyingTo(''); setFailedReplyTo(''); }}>Cancel</button>
          {destination.publication.externalUrl && <a href={destination.publication.externalUrl} target="_blank" rel="noreferrer">Moderate on DeviantArt</a>}
        </div>}
      </article>)}
    </Card>
    <Card title="Recent favourites">
      {!activeFavourites.length ? <p className="small">No current favourites have been imported yet.</p> : activeFavourites.slice(0, 50).map(({ favourite, destination }) => <div className="studio-work-destination-row" key={`${destination.publication.externalPublicationId}:${favourite.externalUserId}`}>
        <strong>@{favourite.externalUsername}</strong><small>{relativeDate(favourite.favouritedAtRemote || favourite.firstSeenAt)}</small>
      </div>)}
    </Card>
    <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}${collectionId ? `&collectionId=${encodeURIComponent(collectionId)}` : ''}&workId=${encodeURIComponent(workId)}`}>Edit work metadata</Link>
  </div>;
}

function ActivityRow({ activity, destination }: { activity: StudioExternalActivity; destination: StudioWorkActivityDestination }) {
  return <article className="studio-work-destination-row">
    <strong>{activity.externalActorName ? `@${activity.externalActorName}` : 'DeviantArt'} · {activity.type}</strong>
    <small>{relativeDate(activity.occurredAt || activity.firstSeenAt)} · @{destination.publication.externalUsername}</small>
    {activity.body && <p>{activity.body}</p>}
  </article>;
}
