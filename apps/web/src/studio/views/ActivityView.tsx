import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Card } from '../components/Card';
import type { StudioExternalActivity } from '../types';

const when = (value?: string): string => value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Date unavailable';

const platformName = (platform?: string): string => {
  if (platform === 'deviantart') return 'DeviantArt';
  return platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : 'Connected platform';
};

const activityName = (type: StudioExternalActivity['type']): string => ({
  comment: 'commented',
  reply: 'replied',
  favourite: 'favourited',
  watch: 'watched the account',
  mention: 'mentioned the account',
  activity: 'activity'
})[type];

function ActivityThumbnail({ activity }: { activity: StudioExternalActivity }) {
  const [failed, setFailed] = useState(false);
  const source = activity.work?.thumbnailUrl;
  useEffect(() => setFailed(false), [source]);
  if (activity.work?.assetType !== 'image') return null;
  return <div className="studio-activity-thumbnail" aria-label={`Thumbnail for ${activity.work.title}`}>
    {source && !failed
      ? <img src={source} alt="" onError={() => setFailed(true)} />
      : <span aria-hidden="true">Image</span>}
  </div>;
}

export function ActivityView({ creatorId }: { creatorId: string }) {
  const [items, setItems] = useState<StudioExternalActivity[]>([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    if (!creatorId) return;
    const response = await api.studioListActivity(creatorId) as { items?: StudioExternalActivity[] };
    setItems(response.items || []);
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void load().catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load activity.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [creatorId]);

  const filtered = useMemo(() => filter === 'all' ? items : items.filter((item) => item.type === filter), [filter, items]);
  const refresh = async () => {
    setRefreshing(true);
    setError('');
    setMessage('');
    try {
      await api.studioSyncActivity(creatorId);
      setMessage('Activity refresh queued. This feed will update as connected platforms respond.');
      window.setTimeout(() => { void load().catch(() => undefined); }, 2500);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Unable to refresh activity.');
    } finally {
      setRefreshing(false);
    }
  };

  const setRead = async (activity: StudioExternalActivity, read: boolean) => {
    try {
      const updated = await api.studioSetActivityRead(activity.externalAccountId, activity.remoteActivityId, read) as StudioExternalActivity;
      setItems((current) => current.map((item) => item.externalActivityId === updated.externalActivityId ? { ...item, ...updated } : item));
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'Unable to update activity.');
    }
  };

  return <div className="studio-work-metadata">
    <Card title="Activity inbox" eyebrow="Connected platforms">
      <p>Comments, replies, favourites, mentions, and other activity are stored here and refreshed automatically.</p>
      <button type="button" className="auth-secondary-btn" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh activity'}</button>
      <label>Show <select value={filter} onChange={(event) => setFilter(event.target.value)}>
        <option value="all">All activity</option>
        <option value="comment">Comments</option>
        <option value="reply">Replies</option>
        <option value="favourite">Favourites</option>
        <option value="watch">Watches</option>
        <option value="mention">Mentions</option>
      </select></label>
    </Card>
    {error && <p className="studio-work-metadata-warning">{error}</p>}
    {message && <p className="studio-work-metadata-success">{message}</p>}
    <Card title="Latest">
      {loading ? <p className="small">Loading activity…</p> : !filtered.length ? <p className="small">No matching activity has been imported yet.</p> : <div className="studio-activity-list">
        {filtered.map((activity) => {
          const accountName = activity.account?.externalUsername;
          const workId = activity.work?.assetId || activity.assetId;
          return <article className={`studio-activity-row${activity.work?.assetType === 'image' ? ' studio-activity-row-has-thumbnail' : ''}${activity.readAt ? ' studio-activity-row-read' : ''}`} key={activity.externalActivityId}>
            <ActivityThumbnail activity={activity} />
            <div className="studio-activity-content">
              <div className="studio-activity-headline">
                <strong>{activity.externalActorName ? `@${activity.externalActorName}` : 'Someone'} {activityName(activity.type)}</strong>
                <span className="studio-activity-platform">{platformName(activity.account?.platform || activity.platform)}</span>
              </div>
              <small className="studio-activity-account">Account {accountName ? `@${accountName}` : 'unavailable'}</small>
              {activity.work && <div className="studio-activity-work">
                <span>Work</span>
                {activity.work.externalUrl
                  ? <a href={activity.work.externalUrl} target="_blank" rel="noreferrer">{activity.work.title}</a>
                  : <strong>{activity.work.title}</strong>}
                <small>{activity.work.assetType}</small>
              </div>}
              {activity.body && <p>{activity.body}</p>}
            </div>
            <div className="studio-activity-actions">
              <time dateTime={activity.occurredAt || activity.firstSeenAt}>{when(activity.occurredAt || activity.firstSeenAt)}</time>
              <button type="button" className="auth-secondary-btn" onClick={() => void setRead(activity, !activity.readAt)}>{activity.readAt ? 'Mark unread' : 'Mark read'}</button>
              {workId && <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}&workId=${encodeURIComponent(workId)}&tab=activity`}>Open work activity</Link>}
            </div>
          </article>;
        })}
      </div>}
    </Card>
  </div>;
}
