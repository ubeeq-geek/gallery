import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type StudioIntegrationOperation } from '../../api';
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
  publication: 'published a work',
  activity: 'activity'
})[type];

const publicationHeadline = (activity: StudioExternalActivity): string => {
  const platform = platformName(activity.account?.platform || activity.platform);
  if (activity.publicationAction === 'publish_retrying') return `${platform} publication retrying`;
  if (activity.publicationAction === 'publish_failed') return `${platform} publication needs attention`;
  return `${platform} publication completed`;
};

const operationName = (kind: StudioIntegrationOperation['kind']): string => ({
  import: 'Import catalogue',
  sync_content: 'Sync content',
  sync_activity: 'Sync activity',
  publish: 'Publish',
  update_remote: 'Update destination',
  remove_remote: 'Remove from destination',
  other: 'Integration task'
})[kind];

const operationStateLabel = (state: StudioIntegrationOperation['state']): string => ({
  queued: 'Queued',
  in_progress: 'In progress',
  completed: 'Completed',
  retry_scheduled: 'Retry scheduled',
  requires_attention: 'Needs attention',
  failed: 'Failed',
  cancelled: 'Cancelled'
})[state];

const operationSummary = (operation: StudioIntegrationOperation): string => {
  if (operation.state === 'failed' || operation.state === 'requires_attention') {
    return operation.error?.message || 'Review this operation before continuing.';
  }
  if (operation.state === 'retry_scheduled' && operation.nextAttemptAt) {
    return `Will retry ${when(operation.nextAttemptAt)}.`;
  }
  if (operation.progress.discovered > 0 || operation.progress.synchronized > 0 || operation.progress.remaining > 0) {
    const { discovered, synchronized, remaining } = operation.progress;
    return `${synchronized} of ${discovered} synchronized${remaining ? ` · ${remaining} remaining` : ''}.`;
  }
  return operation.state === 'completed' ? 'Completed successfully.' : 'Waiting for the worker.';
};

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
  health?: {
    state?: string;
    recommendedAction?: string;
    sync?: {
      lastAttemptAt?: string;
      lastSuccessfulAt?: string;
    };
    issue?: {
      message: string;
      remediation: string;
    };
  };
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
  const [operations, setOperations] = useState<StudioIntegrationOperation[]>([]);
  const [operationsLoading, setOperationsLoading] = useState(true);
  const [operationFilter, setOperationFilter] = useState<'active' | 'all'>('active');
  const [operationActionId, setOperationActionId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const attentionAccounts = accountSummaries.filter((account) => (
    account.health?.state && account.health.state !== 'connected'
  ));
  const attentionActivities = items.filter((activity) => (
    Boolean(activity.integrationIssue) || activity.publicationAction === 'publish_failed'
  ));
  const attentionCount = attentionAccounts.length + attentionActivities.length;
  const shownOperations = operations.filter((operation) => (
    operationFilter === 'all' || !['completed', 'cancelled'].includes(operation.state)
  ));
  const activeOperationCount = operations.filter((operation) => !['completed', 'cancelled'].includes(operation.state)).length;

  const accountAttentionCopy = (account: ActivityAccountSummary): string => {
    if (account.health?.issue?.message) {
      return `${account.health.issue.message} ${account.health.issue.remediation}`;
    }
    if (account.health?.state === 'authentication_required') return 'Reconnect this account before its next sync or publish attempt.';
    if (account.health?.state === 'rate_limited') return 'This account is temporarily rate limited. Wait before retrying another sync.';
    if (account.health?.state === 'temporarily_unavailable') return 'This account is temporarily unavailable. Try syncing again later.';
    return 'Review this integration before publishing or syncing again.';
  };

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

  const loadOperations = async () => {
    const response = await api.studioListIntegrationOperations();
    setOperations(response.operations || []);
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

  useEffect(() => {
    let active = true;
    setOperationsLoading(true);
    void loadOperations().catch((loadError: unknown) => {
      if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load integration operations.');
    }).finally(() => { if (active) setOperationsLoading(false); });
    return () => { active = false; };
  }, [creatorId]);

  const refresh = async () => {
    setRefreshing(true);
    setError('');
    setMessage('');
    try {
      await api.studioSyncActivity(creatorId);
      setMessage('Activity refresh queued. This feed will update as connected platforms respond.');
      window.setTimeout(() => {
        void Promise.all([load(), loadOperations()]).catch(() => undefined);
      }, 2500);
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

  const retryOperation = async (operation: StudioIntegrationOperation) => {
    setOperationActionId(`retry-${operation.id}`);
    setError('');
    try {
      await api.studioRetryIntegrationOperation(operation.id);
      await loadOperations();
      setMessage(`${operationName(operation.kind)} for ${operation.platformLabel} was queued to retry.`);
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : 'Unable to retry this integration operation.');
    } finally {
      setOperationActionId('');
    }
  };

  const cancelOperation = async (operation: StudioIntegrationOperation) => {
    if (!window.confirm(`Cancel this ${operationName(operation.kind).toLowerCase()} operation? Any linked follow-up work will also be cancelled.`)) return;
    setOperationActionId(`cancel-${operation.id}`);
    setError('');
    try {
      await api.studioCancelIntegrationOperation(operation.id);
      await loadOperations();
      setMessage(`${operationName(operation.kind)} for ${operation.platformLabel} was cancelled.`);
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : 'Unable to cancel this integration operation.');
    } finally {
      setOperationActionId('');
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
        {account.health?.sync?.lastAttemptAt && <small>Integration last checked: {when(account.health.sync.lastAttemptAt)}</small>}
        {account.health?.issue && <small className="studio-work-metadata-warning">
          {account.health.issue.message} {account.health.issue.remediation}
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
        <option value="publication">Publishing</option>
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
    <Card title={`Operations${activeOperationCount ? ` · ${activeOperationCount} active` : ''}`} eyebrow="Publishing & synchronization">
      <div className="studio-operations-header">
        <p>Background imports, publishing, and synchronization are tracked here across every connected platform.</p>
        <label>Show <select value={operationFilter} onChange={(event) => setOperationFilter(event.target.value as typeof operationFilter)}>
          <option value="active">Active and attention needed</option>
          <option value="all">All recent operations</option>
        </select></label>
      </div>
      {operationsLoading ? <p className="small">Loading operations…</p> : !shownOperations.length ? <p className="small">No integration operations need attention right now.</p> : <div className="studio-operations-list">
        {shownOperations.slice(0, 12).map((operation) => <article className={`studio-operation-row studio-operation-${operation.state}`} key={operation.id}>
          <div className="studio-operation-content">
            <div className="studio-operation-headline">
              <strong>{operationName(operation.kind)} · {operation.platformLabel}</strong>
              <span className="studio-operation-state">{operationStateLabel(operation.state)}</span>
            </div>
            <small>Account @{operation.account.label} · Updated {when(operation.updatedAt)}</small>
            <p>{operationSummary(operation)}</p>
          </div>
          <div className="studio-operation-actions">
            {operation.retryable && <button type="button" className="auth-secondary-btn" disabled={Boolean(operationActionId)} onClick={() => void retryOperation(operation)}>
              {operationActionId === `retry-${operation.id}` ? 'Retrying…' : 'Retry'}
            </button>}
            {operation.cancellable && <button type="button" className="auth-secondary-btn" disabled={Boolean(operationActionId)} onClick={() => void cancelOperation(operation)}>
              {operationActionId === `cancel-${operation.id}` ? 'Cancelling…' : 'Cancel'}
            </button>}
            <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=integrations&creatorId=${encodeURIComponent(creatorId)}`}>Open integration</Link>
          </div>
        </article>)}
      </div>}
    </Card>
    {attentionCount > 0 && <Card title={`Needs attention · ${attentionCount}`} eyebrow="Integration alerts">
      <p>Resolve these connection or publication issues before relying on the affected destination.</p>
      <div className="studio-activity-attention-list">
        {attentionAccounts.map((account) => <div className="studio-activity-attention-row" key={`account-${account.externalAccountId}`}>
          <div>
            <strong>{platformName(account.platform)} · @{account.externalUsername}</strong>
            <p>{accountAttentionCopy(account)}</p>
          </div>
          <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=integrations&creatorId=${encodeURIComponent(creatorId)}`}>Review integration</Link>
        </div>)}
        {attentionActivities.map((activity) => {
          const workId = activity.work?.assetId || activity.assetId;
          const platform = platformName(activity.account?.platform || activity.platform);
          const detail = activity.integrationIssue?.remediation
            || 'Review this Work’s destination settings and retry the failed publication.';
          return <div className="studio-activity-attention-row" key={`activity-${activity.externalActivityId}`}>
            <div>
              <strong>{platform} publication needs attention{activity.work ? ` · ${activity.work.title}` : ''}</strong>
              <p>{detail}</p>
            </div>
            {workId
              ? <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}&workId=${encodeURIComponent(workId)}&tab=activity`}>Review Work</Link>
              : <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=integrations&creatorId=${encodeURIComponent(creatorId)}`}>Review integration</Link>}
          </div>;
        })}
      </div>
    </Card>}
    <Card title="Latest">
      {loading ? <p className="small">Loading activity…</p> : !items.length ? <p className="small">No matching activity has been imported yet.</p> : <div className="studio-activity-list">
        <p className="small">Showing {items.length} of {total}</p>
        {items.map((activity) => {
          const accountName = activity.account?.externalUsername;
          const workId = activity.work?.assetId || activity.assetId;
          const integrationIssue = activity.integrationIssue;
          return <article className={`studio-activity-row${activity.work?.assetType === 'image' ? ' studio-activity-row-has-thumbnail' : ''}${activity.readAt ? ' studio-activity-row-read' : ''}`} key={activity.externalActivityId}>
            <ActivityThumbnail activity={activity} />
            <div className="studio-activity-content">
              <div className="studio-activity-headline">
                <strong>{integrationIssue
                  ? `${platformName(activity.account?.platform || activity.platform)} needs attention`
                  : activity.type === 'publication'
                    ? publicationHeadline(activity)
                    : `${activity.externalActorName ? `@${activity.externalActorName}` : 'Someone'} ${activityName(activity.type)}`}</strong>
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
              {integrationIssue
                ? <p>{integrationIssue.remediation}</p>
                : activity.body && <p>{activity.body}</p>}
            </div>
            <div className="studio-activity-actions">
              <time dateTime={activity.occurredAt || activity.firstSeenAt}>{when(activity.occurredAt || activity.firstSeenAt)}</time>
              {activity.remoteDeletedAt && <small>Dismissed from DeviantArt</small>}
              <button type="button" className="auth-secondary-btn" onClick={() => void setRead(activity, !activity.readAt)}>{activity.readAt ? 'Mark unread' : 'Mark read'}</button>
              {integrationIssue && <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=integrations&creatorId=${encodeURIComponent(creatorId)}`}>Review integration</Link>}
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
