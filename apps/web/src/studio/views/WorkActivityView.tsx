import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { Card } from '../components/Card';
import type { StudioCreator, StudioExternalAsset, StudioExternalComment, StudioExternalPublication } from '../types';

const relativeDate = (value?: string): string => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Date unavailable';

export function WorkActivityView({ creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const creatorId = params.get('creatorId') || '';
  const workId = params.get('workId') || '';
  const [asset, setAsset] = useState<StudioExternalAsset | null>(null);
  const [publication, setPublication] = useState<StudioExternalPublication | null>(null);
  const [comments, setComments] = useState<StudioExternalComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [replyingTo, setReplyingTo] = useState('');
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  const load = async () => {
    if (!creatorId || !workId) return;
    const catalogue = await api.studioListDeviantArtCatalogue(creatorId) as { items?: StudioExternalAsset[] };
    const nextAsset = catalogue.items?.find((item) => item.assetId === workId) || null;
    const nextPublication = nextAsset?.publications.find((item) => item.platform === 'deviantart' && item.syncStatus === 'active') || null;
    setAsset(nextAsset);
    setPublication(nextPublication);
    setComments(nextPublication ? await api.studioListDeviantArtComments(nextPublication.externalAccountId, nextPublication.externalContentId) as StudioExternalComment[] : []);
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void load().catch((loadError: unknown) => { if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load DeviantArt activity.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [creatorId, workId]);

  const refresh = async () => {
    if (!publication) return;
    setRefreshing(true); setError(''); setMessage('');
    try {
      await api.studioSyncDeviantArtComments(publication.externalAccountId, publication.externalContentId);
      setMessage('Comment refresh queued. Cached activity remains available while DeviantArt synchronizes.');
    } catch (refreshError) { setError(refreshError instanceof Error ? refreshError.message : 'Unable to refresh DeviantArt activity.'); }
    finally { setRefreshing(false); }
  };

  const reply = async (comment: StudioExternalComment) => {
    if (!publication || !draft.trim()) return;
    setPosting(true); setError('');
    try {
      const posted = await api.studioReplyToDeviantArtComment(publication.externalAccountId, publication.externalContentId, comment.externalCommentExternalId, draft.trim()) as StudioExternalComment;
      setComments((current) => [posted, ...current]); setDraft(''); setReplyingTo('');
    } catch (replyError) { setError(replyError instanceof Error ? replyError.message : 'DeviantArt did not accept the reply. Your draft is still here.'); }
    finally { setPosting(false); }
  };

  const back = () => navigate(`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}`);
  if (loading) return <div className="studio-empty-state">Loading work activity…</div>;
  if (!asset) return <div className="studio-empty-state">This work is no longer available.</div>;
  return <div className="studio-work-metadata">
    <div className="studio-work-metadata-topbar"><button type="button" className="auth-secondary-btn" onClick={back}>← Works</button><span>Work activity</span></div>
    <Card title={asset.canonicalTitle || publication?.externalTitle || 'Untitled work'}>
      <p>DeviantArt activity is stored locally and refreshed on demand.</p>
      {publication ? <button type="button" className="auth-secondary-btn" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh DeviantArt comments'}</button> : <p className="small">Publish this work to DeviantArt to receive activity here.</p>}
      {publication?.externalUrl && <a className="auth-secondary-btn no-underline" href={publication.externalUrl} target="_blank" rel="noreferrer">Open on DeviantArt</a>}
    </Card>
    {error && <p className="studio-work-metadata-warning">{error}</p>}
    {message && <p className="studio-work-metadata-success">{message}</p>}
    <Card title="Comments">
      {!comments.length ? <p className="small">No DeviantArt comments have been imported yet.</p> : comments.map((comment) => <article key={comment.externalCommentId} className="studio-work-destination-row">
        <strong>{comment.externalAuthorName ? `@${comment.externalAuthorName}` : 'DeviantArt member'}</strong><small>{relativeDate(comment.createdAtRemote || comment.lastSyncedAt)}</small>
        <p>{comment.body}</p>
        {comment.parentExternalCommentExternalId && <small>Reply in thread</small>}
        <button type="button" className="auth-secondary-btn" onClick={() => { setReplyingTo(comment.externalCommentExternalId); setDraft(''); }}>Reply</button>
        {replyingTo === comment.externalCommentExternalId && <div><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write a DeviantArt reply" /><button type="button" className="auth-primary-btn" disabled={posting || !draft.trim()} onClick={() => void reply(comment)}>{posting ? 'Replying…' : 'Reply'}</button><button type="button" className="auth-secondary-btn" disabled={posting} onClick={() => setReplyingTo('')}>Cancel</button></div>}
      </article>)}</Card>
    <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}&workId=${encodeURIComponent(workId)}`}>Edit work metadata</Link>
  </div>;
}
