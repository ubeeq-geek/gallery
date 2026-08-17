import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Card } from '../components/Card';
import type { StudioChallenge } from '../types';

type Entry = { submissionId: string; title: string; userId: string; status: string; workId?: string; voteCount?: number; entryStatus?: string };
const lifecycle = ['draft', 'scheduled', 'active', 'entries_closed', 'voting_open', 'voting_closed', 'awaiting_awards', 'awarded', 'archived', 'cancelled'];

export function ChallengesView({ challenges, onChanged }: { challenges: StudioChallenge[]; onChanged: () => Promise<void> }) {
  const [selectedId, setSelectedId] = useState(challenges[0]?.contextId || '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('draft');
  const [mode, setMode] = useState<'none' | 'fan_love' | 'judged' | 'mixed'>('fan_love');
  const [recurrence, setRecurrence] = useState<'none' | 'daily' | 'weekly' | 'monthly'>('none');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [votingOpensAt, setVotingOpensAt] = useState('');
  const [votingClosesAt, setVotingClosesAt] = useState('');
  const [specificRules, setSpecificRules] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [message, setMessage] = useState('');
  const selected = useMemo(() => challenges.find((challenge) => challenge.contextId === selectedId) || challenges[0], [challenges, selectedId]);

  const create = async () => {
    if (!title.trim()) return;
    await api.studioCreateChallenge({
      title,
      description,
      status,
      recurrence,
      submissionWindow: { opensAt: opensAt || undefined, closesAt: closesAt || undefined },
      votingWindow: { opensAt: votingOpensAt || undefined, closesAt: votingClosesAt || undefined },
      votingConfig: { mode },
      specificRules
    });
    setTitle(''); setDescription(''); setSpecificRules(''); setOpensAt(''); setClosesAt(''); setVotingOpensAt(''); setVotingClosesAt('');
    setMessage('Challenge created.');
    await onChanged();
  };
  const loadEntries = async (contextId: string) => { setSelectedId(contextId); setEntries(await api.studioListChallengeEntries(contextId) as Entry[]); };
  const updateStatus = async (nextStatus: string) => { if (!selected) return; await api.studioUpdateChallenge(selected.contextId, { status: nextStatus }); setMessage('Challenge status updated.'); await onChanged(); };
  const moderate = async (entry: Entry, entryStatus: 'active' | 'withdrawn' | 'removed') => { await api.studioModerateChallengeEntry(entry.submissionId, { entryStatus }); setEntries((current) => current.map((item) => item.submissionId === entry.submissionId ? { ...item, entryStatus } : item)); };

  return <section className="studio-surface-grid">
    <Card title="Challenges" eyebrow="Create, schedule, and award community challenges">
      <div className="studio-form-stack">
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Challenge title" />
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="Description and invitation" />
        <div className="studio-form-row"><label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}>{lifecycle.map((value) => <option key={value} value={value}>{value.replace(/_/g, ' ')}</option>)}</select></label><label>Voting<select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="fan_love">Fan Love voting</option><option value="judged">Judge's Panel</option><option value="mixed">Mixed</option><option value="none">No public voting</option></select></label><label>Recurrence<select value={recurrence} onChange={(event) => setRecurrence(event.target.value as typeof recurrence)}><option value="none">One-time</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label></div>
        <div className="studio-form-row"><label>Entries open<input type="datetime-local" value={opensAt} onChange={(event) => setOpensAt(event.target.value)} /></label><label>Entries close<input type="datetime-local" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} /></label></div>
        <div className="studio-form-row"><label>Voting open<input type="datetime-local" value={votingOpensAt} onChange={(event) => setVotingOpensAt(event.target.value)} /></label><label>Voting close<input type="datetime-local" value={votingClosesAt} onChange={(event) => setVotingClosesAt(event.target.value)} /></label></div>
        <textarea value={specificRules} onChange={(event) => setSpecificRules(event.target.value)} rows={3} placeholder="Specific rules, eligibility, and submission requirements" />
        <button type="button" className="auth-primary-btn" onClick={() => void create()}>Create challenge</button>
        {message && <p className="success">{message}</p>}
      </div>
      <div className="studio-resource-list">{challenges.map((challenge) => <button type="button" className={`studio-resource-row ${selected?.contextId === challenge.contextId ? 'is-selected' : ''}`} key={challenge.contextId} onClick={() => void loadEntries(challenge.contextId)}><strong>{challenge.title}</strong><span>{challenge.status} · <Link to={`/challenges/${challenge.slug}`} onClick={(event) => event.stopPropagation()}>public page</Link></span></button>)}</div>
      {!challenges.length && <p>No challenges yet. Create the first one above.</p>}
    </Card>
    <Card title={selected?.title || 'Challenge detail'} eyebrow="Entries, lifecycle, and moderation">
      {selected ? <><p className="studio-muted">{selected.status} · {selected.slug}</p><div className="studio-form-row"><label>Lifecycle<select value={selected.status} onChange={(event) => void updateStatus(event.target.value)}>{lifecycle.map((value) => <option key={value} value={value}>{value.replace(/_/g, ' ')}</option>)}</select></label><Link className="auth-secondary-btn no-underline" to={`/challenges/${selected.slug}`}>Open public challenge</Link></div><h4>Entries</h4>{entries.length ? entries.map((entry) => <div className="studio-queue-item" key={entry.submissionId}><strong>{entry.title}</strong><span>{entry.status} · {entry.entryStatus || 'active'} · {entry.voteCount || 0} votes · {entry.userId}</span><div className="studio-form-row"><button type="button" className="auth-secondary-btn" onClick={() => void moderate(entry, 'active')}>Keep active</button><button type="button" className="auth-secondary-btn" onClick={() => void moderate(entry, 'removed')}>Remove</button></div></div>) : <p>Select a challenge to load its entries.</p>}</> : <p>Create or select a challenge to manage entries, laurels, and prizes.</p>}
    </Card>
  </section>;
}
