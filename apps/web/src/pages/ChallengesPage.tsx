import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

type Challenge = { contextId: string; title: string; slug: string; status: string; description?: string; submissionWindow?: { closesAt?: string } };

export default function ChallengesPage() {
  const [items, setItems] = useState<Challenge[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { void api.listChallenges().then((value) => setItems(value as Challenge[])).catch((err) => setError(err instanceof Error ? err.message : 'Unable to load challenges.')); }, []);
  return <main className="page-shell challenge-index"><section className="challenge-index-hero"><p className="eyebrow">EVERSALLY COMMUNITY</p><h1>Challenges for curious creators.</h1><p>Take part in focused prompts, share a Work, and help celebrate the people making something new.</p></section><section className="challenge-index-grid">{items.map((challenge) => <Link className="challenge-index-card" to={`/challenges/${challenge.slug}`} key={challenge.contextId}><span>{challenge.status.replace(/_/g, ' ')}</span><h2>{challenge.title}</h2><p>{challenge.description || 'Open challenge details and entry requirements.'}</p>{challenge.submissionWindow?.closesAt && <small>Entries close {new Date(challenge.submissionWindow.closesAt).toLocaleDateString()}</small>}</Link>)}{!items.length && <section className="panel"><h2>{error || 'No public challenges yet.'}</h2><p>Check back soon for the first Eversally challenge.</p></section>}</section></main>;
}
