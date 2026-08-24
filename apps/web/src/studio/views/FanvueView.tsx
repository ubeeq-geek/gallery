import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { Card } from '../components/Card';
import { Pill } from '../components/Pill';

type Capability = 'read_posts' | 'publish_posts' | 'manage_mapped_posts' | 'account_health';
type Connection = {
  connectionId: string; mode: string; fanvueUserUuid?: string; scopes: string[]; capabilities: Capability[];
  state: string; verificationStatus: string; lastSyncAt?: string; updatedAt: string;
  accountHealth?: { status: string; moderationFlagCount?: number; postingRestricted?: boolean; checkedAt: string };
};
type Publication = { publicationId: string; workId: string; state: string; remoteUrl?: string; updatedAt: string; access: { type: string } };

const capabilityOptions: Array<{ id: Capability; label: string }> = [
  { id: 'read_posts', label: 'Read post metadata' }, { id: 'publish_posts', label: 'Publish posts' },
  { id: 'manage_mapped_posts', label: 'Manage mapped posts' }, { id: 'account_health', label: 'Private account health' }
];
const toneFor = (state: string): 'default' | 'success' | 'warning' | 'danger' | 'info' =>
  ['CONNECTED', 'PUBLISHED', 'healthy'].includes(state) ? 'success' :
    ['ERROR', 'FAILED', 'FANVUE_RESTRICTED', 'restricted'].includes(state) ? 'danger' :
      ['REAUTH_REQUIRED', 'INSUFFICIENT_SCOPE', 'REMOTE_CHANGED', 'FLAGGED', 'attention'].includes(state) ? 'warning' : 'info';
const display = (value: string) => value.toLowerCase().replace(/_/g, ' ');
const date = (value?: string) => value ? new Date(value).toLocaleString() : 'Not yet';

export function FanvueView({ creatorId, creatorName }: { creatorId: string; creatorName: string }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [publications, setPublications] = useState<Record<string, Publication[]>>({});
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    if (!creatorId) return;
    try {
      const result = await api.fanvueListConnections(creatorId) as { items: Connection[] };
      setConnections(result.items);
      const rows = await Promise.all(result.items.map(async (connection) => [connection.connectionId,
        ((await api.fanvueListPublications(connection.connectionId)) as { items: Publication[] }).items] as const));
      setPublications(Object.fromEntries(rows)); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load Fanvue.'); }
  }, [creatorId]);
  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, action: () => Promise<unknown>, message: string) => {
    setBusy(key); setError(''); setNotice('');
    try { await action(); setNotice(message); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Fanvue request failed.'); }
    finally { setBusy(''); }
  };
  const connect = async () => {
    setBusy('connect'); setError('');
    try { const result = await api.fanvueStartConnection(creatorId) as { authorizeUrl: string }; window.location.assign(result.authorizeUrl); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to start Fanvue authorization.'); setBusy(''); }
  };

  return <Card title="Fanvue publishing" eyebrow="Creator-controlled integration" className="studio-integration-accounts"
    actions={<span className="studio-integration-account-count">{connections.length} connection{connections.length === 1 ? '' : 's'}</span>}>
    <p className="small">Publish selected, rights-cleared Works to Fanvue. Connecting never publishes, imports media bytes, changes remote settings, or exposes fan and payment data.</p>
    <div className="studio-integration-row-actions"><button type="button" className="auth-primary-btn" disabled={!creatorId || busy === 'connect'} onClick={() => void connect()}>{busy === 'connect' ? 'Preparing…' : `Connect Fanvue for ${creatorName}`}</button></div>
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="success" role="status">{notice}</p>}
    {!connections.length && <p className="studio-empty-state">No Fanvue account is connected. Account verification and identity documents remain with Fanvue.</p>}
    {connections.map((connection) => <section className="studio-integration-account" key={connection.connectionId} aria-label="Fanvue connection">
      <div><p className="auth-eyebrow">Fanvue account</p><h3>{connection.fanvueUserUuid || 'Authorization pending'}</h3>
        <p className="small">Verification: {display(connection.verificationStatus)} · Last synchronized: {date(connection.lastSyncAt)}</p>
        <div className="studio-integration-row-actions"><Pill tone={toneFor(connection.state)} label={display(connection.state)} /><Pill tone={connection.verificationStatus === 'verified' ? 'success' : 'warning'} label={`${display(connection.verificationStatus)} account`} /></div>
      </div>
      <div className="studio-integration-toolbar">
        {capabilityOptions.map((option) => <label key={option.id}><span>{option.label}</span><input type="checkbox" checked={connection.capabilities.includes(option.id)} disabled={busy !== '' || connection.state === 'PENDING_OAUTH'} onChange={(event) => {
          const next = event.target.checked ? [...connection.capabilities, option.id] : connection.capabilities.filter((item) => item !== option.id);
          void run(`capabilities:${connection.connectionId}`, () => api.fanvueUpdateCapabilities(connection.connectionId, next), 'Fanvue permissions updated.');
        }} /></label>)}
      </div>
      <p className="small">Granted scopes: {connection.scopes.length ? connection.scopes.join(', ') : 'Awaiting authorization'}</p>
      <div className="studio-integration-row-actions">
        <button type="button" className="auth-secondary-btn" disabled={busy !== '' || !connection.capabilities.includes('read_posts')} onClick={() => void run(`sync:${connection.connectionId}`, () => api.fanvueSync(connection.connectionId), 'Fanvue metadata synchronized.')}>Synchronize metadata</button>
        <button type="button" className="auth-secondary-btn" disabled={busy !== '' || !connection.capabilities.includes('account_health')} onClick={() => void run(`health:${connection.connectionId}`, () => api.fanvueRefreshAccountHealth(connection.connectionId), 'Private account health refreshed.')}>Refresh account health</button>
        <button type="button" className="auth-secondary-btn" disabled={busy !== ''} onClick={() => { if (window.confirm('Disconnect Fanvue? This removes credentials and stops synchronization, but leaves local Works and Assets intact.')) void run(`disconnect:${connection.connectionId}`, () => api.fanvueDisconnect(connection.connectionId), 'Fanvue disconnected.'); }}>Disconnect</button>
      </div>
      {connection.accountHealth && <aside><p className="auth-eyebrow">Private account health</p><div className="studio-integration-row-actions"><Pill tone={toneFor(connection.accountHealth.status)} label={display(connection.accountHealth.status)} /><span className="small">{connection.accountHealth.moderationFlagCount || 0} mapped-media flags · Checked {date(connection.accountHealth.checkedAt)}</span></div></aside>}
      <div><p className="auth-eyebrow">Publication queue</p>
        {(publications[connection.connectionId] || []).length ? (publications[connection.connectionId] || []).map((publication) => <div className="studio-integration-row-actions" key={publication.publicationId}>
          <Pill tone={toneFor(publication.state)} label={display(publication.state)} /><span className="small">Work {publication.workId} · {display(publication.access.type)} · Updated {date(publication.updatedAt)}</span>{publication.remoteUrl && <a href={publication.remoteUrl} target="_blank" rel="noreferrer">Open on Fanvue</a>}
        </div>) : <p className="small">No mapped Fanvue publications. Local Works are not synchronized automatically.</p>}
      </div>
      <p className="small"><strong>Separate facts:</strong> Hosted in Eversally · Published on Fanvue · Available to Fanvue subscribers · not synchronized.</p>
    </section>)}
  </Card>;
}
