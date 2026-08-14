import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { brand } from '../../brand';
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
  unwatch: 'stopped watching the account',
  mention: 'mentioned the account',
  activity: 'activity'
})[type];

type ActivityAccountSummary = {
  externalAccountId: string;
  platform: string;
  externalUsername: string;
  watchers?: {
    activeCount?: number;
    added?: number;
    removed?: number;
    truncated?: boolean;
  };
  watchersLastSyncedAt?: string;
  profile?: {
    capturedAt: string;
    profileUrl?: string;
    avatarUrl?: string;
    tagline?: string;
    stats: {
      watchers?: number;
      friends?: number;
      deviations?: number;
      favourites?: number;
      comments?: number;
      profilePageviews?: number;
      profileComments?: number;
    };
  };
};

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
  const [accountSummaries, setAccountSummaries] = useState<ActivityAccountSummary[]>([]);
  const [filter, setFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'read' | 'unread' | 'dismissed'>('all');
  const [accountFilter, setAccountFilter] = useState('');
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [triaging, setTriaging] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async (cursor?: string, append = false) => {
    if (!creatorId) return;
    const response = await api.studioListActivity(creatorId, {
      type: filter,
      status: statusFilter,
      accountId: accountFilter,
      cursor,
      limit: 50
    }) as { items?: StudioExternalActivity[]; accounts?: ActivityAccountSummary[]; nextCursor?: string; total?: number };
    setItems((current) => append ? [...current, ...(response.items || [])] : response.items || []);
    setAccountSummaries(response.accounts || []);
    setNextCursor(response.nextCursor);
    setTotal(response.total || 0);
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void load().catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load activity.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [accountFilter, creatorId, filter, statusFilter]);
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

  const setPageRead = async (read: boolean) => {
    if (!items.length) return;
    setTriaging(true);
    setError('');
    try {
      await api.studioSetActivitiesRead(creatorId, items.map((item) => item.externalActivityId), read);
      setItems((current) => current.map((item) => ({ ...item, readAt: read ? new Date().toISOString() : undefined })));
      setMessage(`${items.length} loaded activit${items.length === 1 ? 'y' : 'ies'} marked ${read ? 'read' : 'unread'}.`);
    } catch (bulkError) {
      setError(bulkError instanceof Error ? bulkError.message : 'Unable to update the loaded activity.');
    } finally {
      setTriaging(false);
    }
  };

  const dismiss = async (activity: StudioExternalActivity) => {
    if (!window.confirm(`Dismiss this notification from DeviantArt? This removes the remote notification but keeps ${brand.productName}’s cached activity record.`)) return;
    setTriaging(true);
    setError('');
    try {
      const updated = await api.studioDismissDeviantArtActivity(activity.externalAccountId, activity.remoteActivityId) as StudioExternalActivity;
      setItems((current) => current.map((item) => item.externalActivityId === activity.externalActivityId ? { ...item, ...updated } : item));
      setMessage(`Notification dismissed from DeviantArt. Its cached ${brand.productName} history was retained.`);
    } catch (dismissError) {
      setError(dismissError instanceof Error ? dismissError.message : 'Unable to dismiss the DeviantArt notification.');
    } finally {
      setTriaging(false);
    }
  };

  return <div className="studio-work-metadata">
    <Card title="Activity inbox" eyebrow="Connected platforms">
      <p>Comments, replies, favourites, mentions, and other activity are stored here and refreshed automatically.</p>
      {accountSummaries.map((account) => <div className="studio-work-destination-row" key={account.externalAccountId}>
        <strong>{account.profile?.profileUrl
          ? <a href={account.profile.profileUrl} target="_blank" rel="noreferrer">{platformName(account.platform)} · @{account.externalUsername}</a>
          : <>{platformName(account.platform)} · @{account.externalUsername}</>}</strong>
        {account.watchers
          ? <span>{Number(account.watchers.activeCount || 0).toLocaleString()} current watchers</span>
          : <span>Watcher reconciliation pending</span>}
        {account.profile && <span>
          {Number(account.profile.stats.profilePageviews || 0).toLocaleString()} profile views · {' '}
          {Number(account.profile.stats.deviations || 0).toLocaleString()} deviations · {' '}
          {Number(account.profile.stats.profileComments || 0).toLocaleString()} profile comments
        </span>}
        {account.profile?.tagline && <small>{account.profile.tagline}</small>}
        {account.watchers && <small>
          Latest refresh: +{account.watchers.added || 0} / −{account.watchers.removed || 0}
          {account.watchers.truncated ? ' · API list limit reached; removals deferred' : ''}
          {account.watchersLastSyncedAt ? ` · ${when(account.watchersLastSyncedAt)}` : ''}
        </small>}
      </div>)}
      <button type="button" className="auth-secondary-btn" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh activity'}</button>
      <label>Type <select value={filter} onChange={(event) => setFilter(event.target.value)}>
        <option value="all">All activity</option>
        <option value="comment">Comments</option>
        <option value="reply">Replies</option>
        <option value="favourite">Favourites</option>
        <option value="watch">Watches</option>
        <option value="unwatch">Unwatches</option>
        <option value="mention">Mentions</option>
      </select></label>
      <label>Status <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
        <option value="all">All statuses</option>
        <option value="unread">Unread</option>
        <option value="read">Read</option>
        <option value="dismissed">Dismissed from DeviantArt</option>
      </select></label>
      <label>Account <select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
        <option value="">All accounts</option>
        {accountSummaries.map((account) => <option value={account.externalAccountId} key={account.externalAccountId}>@{account.externalUsername}</option>)}
      </select></label>
      <div className="studio-inline-actions">
        <button type="button" className="auth-secondary-btn" disabled={triaging || !items.some((item) => !item.readAt)} onClick={() => void setPageRead(true)}>Mark loaded read</button>
        <button type="button" className="auth-secondary-btn" disabled={triaging || !items.some((item) => item.readAt)} onClick={() => void setPageRead(false)}>Mark loaded unread</button>
      </div>
    </Card>
    {error && <p className="studio-work-metadata-warning">{error}</p>}
    {message && <p className="studio-work-metadata-success">{message}</p>}
    <Card title="Latest">
      {loading ? <p className="small">Loading activity…</p> : !items.length ? <p className="small">No matching activity has been imported yet.</p> : <div className="studio-activity-list">
        <p className="small">Showing {items.length} of {total}</p>
        {items.map((activity) => {
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
              {activity.remoteDeletedAt && <small>Dismissed from DeviantArt</small>}
              <button type="button" className="auth-secondary-btn" onClick={() => void setRead(activity, !activity.readAt)}>{activity.readAt ? 'Mark unread' : 'Mark read'}</button>
              {!activity.remoteDeletedAt && activity.remoteMessageId && <button type="button" className="auth-secondary-btn" disabled={triaging} onClick={() => void dismiss(activity)}>Dismiss from DeviantArt</button>}
              {workId && <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}&workId=${encodeURIComponent(workId)}&tab=activity`}>Open work activity</Link>}
            </div>
          </article>;
        })}
        {nextCursor && <button type="button" className="auth-secondary-btn" disabled={loading} onClick={() => void load(nextCursor, true)}>Load more</button>}
      </div>}
    </Card>
  </div>;
}
