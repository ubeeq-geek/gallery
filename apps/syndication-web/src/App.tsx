import { useEffect, useMemo, useState } from 'react';
import { getCurrentUser, getIdToken, signIn, signOut } from './cognitoAuth';

const apiBase = import.meta.env.VITE_SYNDICATION_API_BASE_URL || '';
const OPENVERSE_API_BASE_URL = 'https://api.openverse.org/v1/images/';
const OPENVERSE_TOKEN_URL = 'https://api.openverse.org/v1/auth_tokens/token/';

interface SourceItem {
  sourceId: string;
  name: string;
  creatorUuid: string;
  creatorSlug: string;
  provider: 'openverse';
  visibility?: 'public' | 'internal';
  createdAt: string;
}

const authFetch = async (path: string, init?: RequestInit) => {
  const token = getIdToken();
  if (!token) throw new Error('Not authenticated');
  const response = await fetch(`${apiBase}${path}`, {
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
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [name, setName] = useState('Daily Cosmos / NASA');
  const [creatorUuid, setCreatorUuid] = useState('');
  const [creatorSlug, setCreatorSlug] = useState('daily-cosmos');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'internal'>('public');

  const isFormValid = useMemo(
    () => Boolean(name.trim() && creatorUuid.trim() && creatorSlug.trim() && clientId.trim() && clientSecret.trim()),
    [name, creatorUuid, creatorSlug, clientId, clientSecret]
  );

  const loadSources = async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await authFetch('/sources');
      setSources(Array.isArray(payload.items) ? payload.items : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sources');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) void loadSources();
  }, [user]);

  if (!user) {
    return (
      <main className="page page--auth">
        <section className="card auth-card">
          <h1 className="title">Syndication Source Admin</h1>
          <p className="muted">Sign in with an Admin account.</p>
          <form
            className="stack"
            onSubmit={async (event) => {
              event.preventDefault();
              setError('');
              try {
                await signIn(email, password);
                setUser(getCurrentUser());
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Sign in failed');
              }
            }}
          >
            <label className="field">
              <span>Email</span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span>Password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
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
        <button
          className="btn btn--ghost"
          onClick={async () => {
            await signOut();
            setUser(null);
          }}
        >
          Sign out
        </button>
      </header>

      <section className="card">
        <h2 className="section-title">Register source</h2>
        <p className="muted">Openverse-only registration (API sources only for now).</p>
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!isFormValid) return;
            setSubmitting(true);
            setError('');
            try {
              await authFetch('/sources', {
                method: 'POST',
                body: JSON.stringify({
                  sourceType: 'openverse_api',
                  endpointUrl: OPENVERSE_API_BASE_URL,
                  tokenUrl: OPENVERSE_TOKEN_URL,
                  name,
                  creatorUuid,
                  creatorSlug,
                  clientId,
                  clientSecret,
                  visibility
                })
              });
              setClientId('');
              setClientSecret('');
              await loadSources();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Failed to save');
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <div className="grid grid--3">
            <label className="field"><span>Source Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="field"><span>Slug</span><input value={creatorSlug} onChange={(e) => setCreatorSlug(e.target.value)} /></label>
            <label className="field"><span>Creator UUID</span><input value={creatorUuid} onChange={(e) => setCreatorUuid(e.target.value)} /></label>
          </div>

          <fieldset className="fieldset">
            <legend>Source Type</legend>
            <label><input type="radio" checked readOnly /> API (Openverse)</label>
            <label><input type="radio" disabled /> RSS</label>
            <label><input type="radio" disabled /> Manual</label>
          </fieldset>

          <div className="grid grid--2">
            <label className="field"><span>Endpoint URL</span><input value={OPENVERSE_API_BASE_URL} readOnly /></label>
            <label className="field"><span>Token URL</span><input value={OPENVERSE_TOKEN_URL} readOnly /></label>
          </div>

          <div className="grid grid--2">
            <label className="field"><span>Openverse Client ID</span><input value={clientId} onChange={(e) => setClientId(e.target.value)} /></label>
            <label className="field"><span>Openverse Client Secret</span><input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></label>
          </div>

          <div className="grid grid--2">
            <label className="field"><span>Sync Frequency</span><input value="Weekly (Saturday 08:00 UTC)" readOnly /></label>
            <fieldset className="fieldset">
              <legend>Visibility</legend>
              <label><input type="radio" checked={visibility === 'public'} onChange={() => setVisibility('public')} /> Public</label>
              <label><input type="radio" checked={visibility === 'internal'} onChange={() => setVisibility('internal')} /> Internal</label>
            </fieldset>
          </div>

          <fieldset className="fieldset">
            <legend>Content Types</legend>
            <label><input type="checkbox" checked readOnly /> Images</label>
            <label><input type="checkbox" disabled /> Video</label>
            <label><input type="checkbox" disabled /> Text</label>
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
                  <p className="muted muted--small">
                    {source.provider} • {source.creatorSlug} • {source.visibility || 'public'}
                  </p>
                </div>
                <button
                  className="btn"
                  onClick={async () => {
                    setError('');
                    try {
                      await authFetch(`/sources/${source.sourceId}/run`, { method: 'POST' });
                      alert('Weekly run triggered.');
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Run failed');
                    }
                  }}
                >
                  Run now
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p className="error">{error}</p>}
    </main>
  );
};
