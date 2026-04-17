import { useEffect, useState } from 'react';
import { getCurrentUser, getIdToken, signIn, signOut } from './cognitoAuth';

const apiBase = import.meta.env.VITE_SYNDICATION_API_BASE_URL || '';

interface SourceItem {
  sourceId: string;
  name: string;
  creatorUuid: string;
  creatorSlug: string;
  provider: 'openverse';
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

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [name, setName] = useState('Daily Cosmos / NASA');
  const [creatorUuid, setCreatorUuid] = useState('');
  const [creatorSlug, setCreatorSlug] = useState('daily-cosmos');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

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
    if (user) {
      void loadSources();
    }
  }, [user]);

  if (!user) {
    return (
      <main style={{ maxWidth: 420, margin: '40px auto', fontFamily: 'sans-serif' }}>
        <h1>Syndication Source Admin</h1>
        <p>Sign in with an Admin user.</p>
        <form onSubmit={async (event) => {
          event.preventDefault();
          setError('');
          try {
            await signIn(email, password);
            setUser(getCurrentUser());
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Sign in failed');
          }
        }}>
          <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%' }} /></label>
          <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} /></label>
          <button type="submit">Sign in</button>
        </form>
        {error && <p style={{ color: 'crimson' }}>{error}</p>}
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 920, margin: '20px auto', fontFamily: 'sans-serif' }}>
      <h1>Syndication Source Admin</h1>
      <p>Signed in as <strong>{user.username}</strong></p>
      <button onClick={async () => { await signOut(); setUser(null); }}>Sign out</button>

      <section style={{ marginTop: 20 }}>
        <h2>Register source</h2>
        <p style={{ marginTop: 0, color: '#4b5563' }}>
          Openverse-only registration (API sources only for now).
        </p>
        <form onSubmit={async (event) => {
          event.preventDefault();
          setError('');
          try {
            await authFetch('/sources', {
              method: 'POST',
              body: JSON.stringify({ name, creatorUuid, creatorSlug, clientId, clientSecret })
            });
            setClientId('');
            setClientSecret('');
            await loadSources();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save');
          }
        }}>
          <div><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" /></div>
          <div><input value={creatorUuid} onChange={(e) => setCreatorUuid(e.target.value)} placeholder="Creator UUID" /></div>
          <div><input value={creatorSlug} onChange={(e) => setCreatorSlug(e.target.value)} placeholder="Creator slug" /></div>
          <div><input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Openverse client_id" /></div>
          <div><input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Openverse client_secret" /></div>
          <button type="submit">Register source</button>
        </form>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Sources</h2>
        {loading ? <p>Loading…</p> : (
          <ul>
            {sources.map((source) => (
              <li key={source.sourceId} style={{ marginBottom: 12 }}>
                <strong>{source.name}</strong> ({source.provider}) → {source.creatorSlug}
                <div>
                  <button onClick={async () => {
                    setError('');
                    try {
                      await authFetch(`/sources/${source.sourceId}/run`, { method: 'POST' });
                      alert('Weekly run triggered.');
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Run failed');
                    }
                  }}>Run now</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && <p style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{error}</p>}
    </main>
  );
};
