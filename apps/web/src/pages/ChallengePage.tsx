import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { brand } from '../brand';

type ChallengeEntry = { submissionId: string; title: string; notes?: string; userId: string; workId?: string; externalUrl?: string; voteCount?: number; entryStatus?: string; submittedAt?: string };
type Challenge = { contextId: string; title: string; slug: string; status: string; description?: string; submissionWindow?: { opensAt?: string; closesAt?: string }; votingWindow?: { opensAt?: string; closesAt?: string }; rules?: { maxEntriesPerUser?: number }; entryConfig?: { allowExistingWorks?: boolean; allowExternalUrls?: boolean; maxEntriesPerCreator?: number }; specificRules?: string; entries?: ChallengeEntry[]; prizes?: Array<{ title: string; description: string; placement: string }>; laurels?: Array<{ name: string; shortDescription: string; guaranteed: boolean }>; metrics?: { submissionCount: number; voteCount: number } };

const dateLabel = (value?: string) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not set';

export default function ChallengePage() {
  const { slug = '' } = useParams();
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [entryTitle, setEntryTitle] = useState('');
  const [entryNotes, setEntryNotes] = useState('');
  const [workId, setWorkId] = useState('');
  const [entryError, setEntryError] = useState('');
  const [entryMessage, setEntryMessage] = useState('');

  const load = async () => {
    setLoading(true);
    try { setChallenge(await api.getChallenge(slug) as Challenge); } catch (err) { setError(err instanceof Error ? err.message : 'Challenge unavailable'); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [slug]);

  const canEnter = useMemo(() => challenge?.status === 'active', [challenge]);
  const submit = async () => {
    if (!challenge) return;
    setEntryError(''); setEntryMessage('');
    try {
      const result = await api.submitChallengeEntry(challenge.contextId, { title: entryTitle, notes: entryNotes, workId: workId || undefined }) as ChallengeEntry;
      setChallenge({ ...challenge, entries: [result, ...(challenge.entries || [])], metrics: { ...(challenge.metrics || { submissionCount: 0, voteCount: 0 }), submissionCount: (challenge.metrics?.submissionCount || 0) + 1 } });
      setEntryTitle(''); setEntryNotes(''); setWorkId(''); setEntryMessage('Your entry was submitted.');
    } catch (err) { setEntryError(err instanceof Error ? err.message : 'Unable to submit entry.'); }
  };
  const vote = async (submissionId: string) => {
    if (!challenge) return;
    try { await api.voteChallengeEntry(challenge.contextId, submissionId); await load(); } catch (err) { setError(err instanceof Error ? err.message : 'Unable to vote.'); }
  };

  if (loading) return <main className="page-shell"><section className="panel"><p>Loading challenge…</p></section></main>;
  if (error || !challenge) return <main className="page-shell"><section className="panel"><h1>Challenge not found</h1><p>{error || 'This challenge is unavailable.'}</p><Link className="auth-secondary-btn" to="/discover">Back to discovery</Link></section></main>;
  return (
    <main className="page-shell challenge-page">
      <section className="challenge-hero panel">
        <p className="eyebrow">EVERSALLY CHALLENGE</p>
        <h1>{challenge.title}</h1>
        <p className="challenge-description">{challenge.description || 'A creative invitation from the Eversally community.'}</p>
        <div className="challenge-status-row"><span className="profile-status-badge">{challenge.status.replace(/_/g, ' ')}</span><span>{challenge.metrics?.submissionCount || 0} entries</span><span>{challenge.metrics?.voteCount || 0} votes</span></div>
        <div className="challenge-dates"><div><strong>Entries</strong><span>{dateLabel(challenge.submissionWindow?.opensAt)} → {dateLabel(challenge.submissionWindow?.closesAt)}</span></div><div><strong>Voting</strong><span>{dateLabel(challenge.votingWindow?.opensAt)} → {dateLabel(challenge.votingWindow?.closesAt)}</span></div></div>
      </section>
      <section className="challenge-layout">
        <div>
          <section className="panel"><div className="section-heading"><div><p className="eyebrow">ENTRIES</p><h2>Community entries</h2></div><span>{challenge.entries?.length || 0} shown</span></div><div className="challenge-entry-grid">{(challenge.entries || []).map((entry) => <article className="challenge-entry-card" key={entry.submissionId}><div className="challenge-entry-placeholder">{entry.title.slice(0, 1).toUpperCase()}</div><h3>{entry.title}</h3><p>{entry.notes || 'An Eversally challenge entry.'}</p><div className="challenge-entry-meta"><span>{entry.voteCount || 0} Fan Love</span>{challenge.status === 'voting_open' && <button type="button" className="auth-secondary-btn" onClick={() => void vote(entry.submissionId)}>Vote</button>}</div></article>)}</div>{!challenge.entries?.length && <p>No entries have been submitted yet.</p>}</section>
        </div>
        <aside className="challenge-sidebar">
          <section className="panel"><p className="eyebrow">ENTER</p><h2>Share your work</h2><p>Submit an existing Work from your {brand.creatorName} catalogue. You can withdraw it before the entry period closes.</p>{canEnter ? <><input value={entryTitle} onChange={(event) => setEntryTitle(event.target.value)} placeholder="Entry title" /><input value={workId} onChange={(event) => setWorkId(event.target.value)} placeholder="Work ID (optional)" /><textarea value={entryNotes} onChange={(event) => setEntryNotes(event.target.value)} placeholder="Tell the judges about this work" rows={4} /><button type="button" className="auth-primary-btn" disabled={!entryTitle.trim()} onClick={() => void submit()}>Submit entry</button></> : <p>Entries are not currently open.</p>}{entryMessage && <p className="success">{entryMessage}</p>}{entryError && <p className="error">{entryError}</p>}</section>
          <section className="panel"><p className="eyebrow">RECOGNITION</p><h2>Laurels & prizes</h2>{(challenge.laurels || []).map((laurel) => <div className="challenge-detail-row" key={laurel.name}><strong>{laurel.name}{laurel.guaranteed ? ' · Guaranteed' : ''}</strong><span>{laurel.shortDescription}</span></div>)}{(challenge.prizes || []).map((prize) => <div className="challenge-detail-row" key={prize.title}><strong>{prize.title}</strong><span>{prize.description}</span></div>)}{!challenge.laurels?.length && !challenge.prizes?.length && <p>Recognition details will be announced with the results.</p>}</section>
          <section className="panel"><p className="eyebrow">RULES</p><h2>How to take part</h2><p>{challenge.specificRules || 'Submit original work that follows the challenge requirements. Keep your entry visible in your Space while judging is underway.'}</p><p>Maximum entries per participant: {challenge.rules?.maxEntriesPerUser || challenge.entryConfig?.maxEntriesPerCreator || 3}</p></section>
        </aside>
      </section>
    </main>
  );
}
