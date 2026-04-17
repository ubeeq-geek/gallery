import { useEffect, useMemo, useState } from 'react';
import { getCurrentUser, getIdToken, signIn, signOut } from './cognitoAuth';

const syndicationApiBase = import.meta.env.VITE_SYNDICATION_API_BASE_URL || '';
const galleryApiBase = import.meta.env.VITE_GALLERY_API_BASE_URL || '';

interface SourceItem {
  sourceId: string;
  name: string;
  creatorUuid: string;
  creatorSlug: string;
  provider: 'openverse';
  createdAt: string;
}

interface CreatorOption {
  artistId: string;
  name: string;
  slug: string;
}

const authFetch = async (baseUrl: string, path: string, init?: RequestInit) => {
  const token = getIdToken();
  if (!token) throw new Error('Not authenticated');
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init?.headers || {})
    }
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with ${response.status}`);
  }
  return response.json();
};

export const App = () => {
  const [user, setUser] = useState(() => getCurrentUser());
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [creators, setCreators] = useState<CreatorOption[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [name, setName] = useState('Daily Cosmos / NASA');
  const [creatorUuid, setCreatorUuid] = useState('');
  const [creatorSlug, setCreatorSlug] = useState('daily-cosmos');

  const isFormValid = useMemo(() => Boolean(name.trim() && creatorUuid.trim() && creatorSlug.trim()), [name, creatorUuid, creatorSlug]);

  const loadSources = async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await authFetch(syndicationApiBase, '/sources');
      setSources(Array.isArray(payload.items) ? payload.items : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sources');
    } finally {
      setLoading(false);
    }
  };

  const loadCreators = async () => {
    if (!galleryApiBase) return;
    try {
      const payload = await authFetch(galleryApiBase, '/artists');
      const items = Array.isArray(payload?.artists) ? payload.artists : Array.isArray(payload) ? payload : [];
      const normalized = items
        .map((item: any) => ({
          artistId: String(item.artistId || '').trim(),
          name: String(item.name || '').trim(),
          slug: String(item.slug || '').trim()
        }))
        .filter((item: CreatorOption) => item.artistId && item.name && item.slug);
      setCreators(normalized);
      if (!creatorUuid && normalized.length > 0) {
        setCreatorUuid(normalized[0].artistId);
        setCreatorSlug(normalized[0].slug);
      }
    } catch (err) {
      setError(err instanceof Error ? `Unable to load creators: ${err.message}` : 'Unable to load creators');
    }
  };

  useEffect(() => {
    if (user) {
      void loadSources();
      void loadCreators();
    }
  }, [user]);

  if (!user) {
    return (
      <main className="page page--auth">
        <section className="card auth-card">
          <h1 className="title">Syndication Source Admin</h1>
          <p className="muted">Sign in with an Admin account.</p>
          <form className="stack" onSubmit={async (event) => {
            event.preventDefault();
            setError('');
            try {
              await signIn(email, password);
              setUser(getCurrentUser());
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Sign in failed');
            }
          }}>
            <label className="field"><span>Email</span><input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="field"><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <button className="btn btn--primary" type="submit">Sign in</button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Content Operations</p>
          <h1 className="title">Syndication Source Admin</h1>
          <p className="muted">Signed in as <strong>{user.username}</strong></p>
        </div>
        <button className="btn btn--ghost" onClick={async () => { await signOut(); setUser(null); }}>Sign out</button>
      </header>

      <section className="card">
        <h2 className="section-title">Register source</h2>
        <p className="muted">Openverse-only registration. Endpoint/auth/content settings are internal defaults.</p>
        <form className="stack" onSubmit={async (event) => {
          event.preventDefault();
          if (!isFormValid) return;
          setSubmitting(true);
          setError('');
          try {
            await authFetch(syndicationApiBase, '/sources', {
              method: 'POST',
              body: JSON.stringify({
                sourceType: 'openverse_api',
                name,
                creatorUuid,
                creatorSlug
              })
            });
            await loadSources();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save');
          } finally {
            setSubmitting(false);
          }
        }}>
          <div className="grid grid--3">
            <label className="field"><span>Source Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="field"><span>Slug</span><input value={creatorSlug} onChange={(e) => setCreatorSlug(e.target.value)} /></label>
            <label className="field">
              <span>Creator UUID</span>
              <select
                value={creatorUuid}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setCreatorUuid(nextId);
                  const creator = creators.find((item) => item.artistId === nextId);
                  if (creator && !creatorSlug) {
                    setCreatorSlug(creator.slug);
                  }
                }}
              >
                <option value="">Select a creator…</option>
                {creators.map((creator) => (
                  <option key={creator.artistId} value={creator.artistId}>{creator.name} ({creator.slug})</option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="fieldset">
            <legend>Source Type</legend>
            <label><input type="radio" checked readOnly /> API (Openverse)</label>
          </fieldset>

          <button className="btn btn--primary" type="submit" disabled={!isFormValid || submitting}>
            {submitting ? 'Registering…' : 'Register source'}
          </button>
        </form>
      </section>

      <section className="card">
        <h2 className="section-title">Sources</h2>
        {loading ? <p className="muted">Loading…</p> : (
          <ul className="source-list">
            {sources.map((source) => (
              <li key={source.sourceId} className="source-row">
                <div>
                  <strong>{source.name}</strong>
                  <p className="muted muted--small">{source.provider} • {source.creatorSlug}</p>
                </div>
                <button className="btn" onClick={async () => {
                  setError('');
                  try {
                    await authFetch(syndicationApiBase, `/sources/${source.sourceId}/run`, { method: 'POST' });
                    alert('Weekly run triggered.');
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Run failed');
                  }
                }}>Run now</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p className="error">{error}</p>}
    </main>
  );
};
