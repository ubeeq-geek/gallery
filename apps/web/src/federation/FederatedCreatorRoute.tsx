import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { FederatedCreatorPage, type FederatedCreatorPageModel } from './FederationViews';

const decodeActorUri = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const actorUri = atob(base64);
    const parsed = new URL(actorUri);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch { return undefined; }
};

export const encodeFederatedActorUri = (actorUri: string): string => btoa(actorUri).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function FederatedCreatorRoute() {
  const actorUri = decodeActorUri(useParams<{ actor: string }>().actor);
  const [model, setModel] = useState<FederatedCreatorPageModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (!actorUri) { setError('This federated creator address is invalid.'); setLoading(false); return () => { active = false; }; }
    setLoading(true); setError('');
    api.getFederatedCreator(actorUri).then((value) => { if (active) setModel(value as FederatedCreatorPageModel); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Federated creator unavailable'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actorUri]);
  if (loading) return <main className="page-shell"><section className="panel"><p>Loading federated creator…</p></section></main>;
  if (error || !model) return <main className="page-shell"><section className="panel"><h1>Federated creator unavailable</h1><p>{error || 'This destination profile is not available.'}</p><Link to="/discover">Return to discovery</Link></section></main>;
  return <FederatedCreatorPage model={model} onHomeLinkConsent={() => api.recordFederatedHomeLinkConsent(model.actorUri).then(() => undefined)} />;
}
