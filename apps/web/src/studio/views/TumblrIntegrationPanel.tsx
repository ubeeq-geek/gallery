import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Card } from '../components/Card';
import { Pill } from '../components/Pill';

type Connector = { id: string; ownership: 'managed' | 'creator_owned'; status: 'pending' | 'connected' | 'expired' | 'revoked' | 'error' | 'disabled'; tumblrUserName?: string; hasCreatorApplication: boolean; hasOAuthGrant: boolean };
type Blog = { id: string; identifier: string; title?: string; url?: string; enabled: boolean; defaults?: { publicationMode?: 'full' | 'selected_assets' | 'announcement'; postState?: 'published' | 'draft' | 'queue' | 'private'; includeSourceLink?: boolean; includeWorkTitle?: boolean; includeDescription?: boolean; includeTags?: boolean; appendDefaultTags?: string[] } };
type Configuration = { managedConfigured: boolean; creatorOwnedConfigured: boolean; redirectUri?: string };

const connectorTone = (status: Connector['status']): 'success' | 'warning' | 'danger' | 'default' => status === 'connected' ? 'success' : status === 'pending' ? 'warning' : status === 'expired' || status === 'error' ? 'danger' : 'default';

export function TumblrIntegrationPanel({ creatorId }: { creatorId: string }) {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [blogs, setBlogs] = useState<Record<string, Blog[]>>({});
  const [mode, setMode] = useState<'managed' | 'creator_owned'>('managed');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    if (!creatorId) return;
    try {
      const [nextConfiguration, nextConnectors] = await Promise.all([api.studioGetTumblrConfiguration(), api.studioListTumblrConnectors(creatorId)]) as [Configuration, Connector[]];
      setConfiguration(nextConfiguration);
      setConnectors(nextConnectors);
      const connected = nextConnectors.filter((item) => item.status === 'connected');
      const entries = await Promise.all(connected.map(async (connector) => [connector.id, await api.studioListTumblrBlogs(connector.id)] as const));
      setBlogs(Object.fromEntries(entries));
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load Tumblr integration.'); }
  };

  useEffect(() => { void load(); }, [creatorId]);
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get('tumblr');
    if (!result) return;
    url.searchParams.delete('tumblr');
    window.history.replaceState({}, '', url);
    setMessage(result === 'connected' ? 'Tumblr connected. Choose the blogs that may receive Works.' : result === 'cancelled' ? 'Tumblr authorization was cancelled.' : 'Tumblr authorization did not complete.');
    void load();
  }, [creatorId]);

  const createConnector = async () => {
    if (!creatorId || !configuration) return;
    setBusy('create'); setError('');
    try {
      const connector = await api.studioCreateTumblrConnector({ creatorId, ownership: mode, ...(mode === 'creator_owned' ? { clientId: clientId.trim(), clientSecret, redirectUri: configuration.redirectUri } : {}) }) as Connector;
      const started = await api.studioStartTumblrOAuth(connector.id) as { authorizationUrl: string };
      window.location.assign(started.authorizationUrl);
    } catch (createError) { setError(createError instanceof Error ? createError.message : 'Unable to connect Tumblr.'); setBusy(''); }
  };

  const authorize = async (id: string) => {
    setBusy(`authorize:${id}`); setError('');
    try { const started = await api.studioStartTumblrOAuth(id) as { authorizationUrl: string }; window.location.assign(started.authorizationUrl); }
    catch (authorizeError) { setError(authorizeError instanceof Error ? authorizeError.message : 'Unable to authorize Tumblr.'); setBusy(''); }
  };

  const remove = async (id: string) => {
    setBusy(`remove:${id}`); setError('');
    try { await api.studioDeleteTumblrConnector(id); await load(); }
    catch (removeError) { setError(removeError instanceof Error ? removeError.message : 'Unable to disconnect Tumblr.'); }
    finally { setBusy(''); }
  };

  const validate = async (id: string, refresh = false) => {
    setBusy(`${refresh ? 'refresh' : 'test'}:${id}`); setError(''); setMessage('');
    try {
      if (refresh) await api.studioRefreshTumblrConnector(id);
      else await api.studioTestTumblrConnector(id);
      setMessage(refresh ? 'Tumblr authorization refreshed.' : 'Tumblr connection test passed.');
      await load();
    } catch (validateError) { setError(validateError instanceof Error ? validateError.message : 'Unable to validate Tumblr.'); }
    finally { setBusy(''); }
  };

  const updateBlog = async (connectorId: string, blog: Blog, patch: { enabled?: boolean; defaults?: Record<string, unknown> }) => {
    setBusy(`blog:${blog.id}`); setError('');
    try { await api.studioUpdateTumblrBlog(connectorId, blog.id, patch); await load(); }
    catch (updateError) { setError(updateError instanceof Error ? updateError.message : 'Unable to update Tumblr blog.'); }
    finally { setBusy(''); }
  };

  return <Card title="Tumblr publishing" eyebrow="Publishing platform" className="studio-integration-accounts">
    <p className="small">Publish complete Works, selected Assets, or announcements to one or more Tumblr blogs. Credentials and OAuth tokens remain server-side.</p>
    {message && <p className="studio-integration-setup-notice">{message}</p>}
    {error && <p className="auth-error">{error}</p>}
    <fieldset className="studio-tumblr-connect-mode">
      <legend>How would you like to connect?</legend>
      <label><input type="radio" checked={mode === 'managed'} onChange={() => setMode('managed')} /> <span><strong>Connect with Ubeeq/Eversally</strong><small> Fastest setup using the managed Tumblr application.</small></span></label>
      <label><input type="radio" checked={mode === 'creator_owned'} onChange={() => setMode('creator_owned')} /> <span><strong>Use my own Tumblr application</strong><small> Isolates application credentials and quota for this Creator.</small></span></label>
    </fieldset>
    {mode === 'creator_owned' && <div className="studio-integration-toolbar">
      <label><span>OAuth client ID</span><input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" /></label>
      <label><span>OAuth client secret</span><input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" /></label>
      <label><span>Register this redirect URI</span><input value={configuration?.redirectUri || ''} readOnly /></label>
    </div>}
    <button type="button" className="auth-primary-btn" disabled={busy === 'create' || !configuration || (mode === 'managed' ? !configuration.managedConfigured : !configuration.creatorOwnedConfigured || !clientId.trim() || !clientSecret)} onClick={() => void createConnector()}>{busy === 'create' ? 'Connecting…' : 'Connect Tumblr'}</button>
    {configuration && mode === 'managed' && !configuration.managedConfigured && <p className="studio-integration-setup-notice">Managed Tumblr publishing is not configured for this deployment. You can use your own Tumblr application if creator-owned connections are enabled.</p>}
    <div className="studio-integration-account-list">
      {connectors.map((connector) => <div key={connector.id} className="studio-integration-account studio-tumblr-account">
        <div><p className="auth-eyebrow">{connector.ownership === 'managed' ? 'Managed connector' : 'Creator-owned connector'}</p><h3>{connector.tumblrUserName || 'Tumblr authorization pending'}</h3><Pill tone={connectorTone(connector.status)} label={connector.status.replace(/_/g, ' ')} /></div>
        <div className="studio-integration-row-actions">{connector.status === 'connected' && <><button type="button" className="auth-secondary-btn" disabled={Boolean(busy)} onClick={() => void validate(connector.id)}>Test connection</button><button type="button" className="auth-secondary-btn" disabled={Boolean(busy)} onClick={() => void validate(connector.id, true)}>Refresh token</button></>}<button type="button" className="auth-secondary-btn" disabled={busy === `authorize:${connector.id}`} onClick={() => void authorize(connector.id)}>{connector.status === 'connected' ? 'Reconnect' : 'Authorize'}</button><button type="button" className="auth-secondary-btn" disabled={busy === `remove:${connector.id}`} onClick={() => void remove(connector.id)}>Disconnect</button></div>
        {(blogs[connector.id] || []).map((blog) => <div key={blog.id} className="studio-tumblr-blog">
          <label className="studio-discord-media-option"><input type="checkbox" checked={blog.enabled} disabled={busy === `blog:${blog.id}`} onChange={(event) => void updateBlog(connector.id, blog, { enabled: event.target.checked })} /><span><strong>{blog.title || blog.identifier}</strong><small>{blog.url || blog.identifier}</small></span></label>
          <div className="studio-integration-toolbar">
            <label><span>Default publication</span><select value={blog.defaults?.publicationMode || 'full'} disabled={!blog.enabled || busy === `blog:${blog.id}`} onChange={(event) => void updateBlog(connector.id, blog, { defaults: { ...blog.defaults, publicationMode: event.target.value } })}><option value="full">Full Work</option><option value="selected_assets">Selected Assets</option><option value="announcement">Announcement only</option></select></label>
            <label><span>Default Tumblr state</span><select value={blog.defaults?.postState || 'published'} disabled={!blog.enabled || busy === `blog:${blog.id}`} onChange={(event) => void updateBlog(connector.id, blog, { defaults: { ...blog.defaults, postState: event.target.value } })}><option value="published">Publish now</option><option value="draft">Draft</option><option value="queue">Queue</option><option value="private">Private</option></select></label>
          </div>
        </div>)}
      </div>)}
    </div>
  </Card>;
}
