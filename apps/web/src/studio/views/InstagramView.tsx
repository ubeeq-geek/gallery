import { useEffect, useState } from 'react';
import type { StudioCreator } from '../types';
import { Card } from '../components/Card';
import { api } from '../../api';

const capabilities = [
  ['metadata_import', 'Media references', 'Import metadata only. Instagram media bytes are never copied into Ubeeq.'],
  ['publish_images', 'Images & carousels', 'Publish only creator-approved public-safe preview derivatives.'],
  ['publish_reels', 'Reels', 'Available only when the connected account and provider adapter support it.'],
  ['publish_stories', 'Stories', 'Available only when the connected account and provider adapter support it.'],
  ['insights', 'Aggregate insights', 'Sync permitted daily totals without audience identities.']
] as const;

export function InstagramView({ creators }: { creators: StudioCreator[] }) {
  const [selectedCreatorId, setSelectedCreatorId] = useState(creators[0]?.creatorId || '');
  const [deployment, setDeployment] = useState<Awaited<ReturnType<typeof api.studioGetInstagramConfiguration>>>();
  const [connectionError, setConnectionError] = useState('');
  const [connections, setConnections] = useState<Awaited<ReturnType<typeof api.studioGetInstagramConnections>>>([]);
  useEffect(() => { void api.studioGetInstagramConfiguration().then(setDeployment).catch(() => setDeployment(undefined)); }, []);
  useEffect(() => { if (selectedCreatorId) void api.studioGetInstagramConnections(selectedCreatorId).then(setConnections).catch(() => setConnections([])); }, [selectedCreatorId]);
  return <div className="studio-stack">
    <Card title="Instagram" eyebrow="Public-safe preview publishing">
      <div className="studio-integration-overview">
        <div>
          <p>Connect an eligible Instagram Creator or Business account. Ubeeq remains your canonical library; Instagram publications are independent destination copies.</p>
          <div className="studio-inline-actions">
            <button className="auth-primary-btn" type="button" disabled={!deployment?.onboardingEnabled || !selectedCreatorId} title={!deployment?.onboardingEnabled ? 'The managed Meta application must be configured and pass App Review before creator onboarding is enabled' : undefined} onClick={() => {
              setConnectionError('');
              void api.studioStartInstagramConnection(selectedCreatorId).then(({ authorizationUrl }) => { window.location.assign(authorizationUrl); }).catch((error: Error) => setConnectionError(error.message));
            }}>Connect Instagram</button>
            <span className="studio-status-pill">{deployment?.state === 'READY' ? 'Pilot ready' : deployment?.state === 'APP_REVIEW_REQUIRED' ? 'App review required' : 'Not configured'}</span>
          </div>
          {connectionError && <p className="studio-integration-message" role="alert">{connectionError}</p>}
        </div>
        <aside className="studio-integration-safety-note">
          <strong>instagram_public_safe</strong>
          <span>Nightframe Adult, mature, sexual, fetish, graphic, held, or rights-unattested media cannot be sent through this managed integration.</span>
        </aside>
      </div>
    </Card>
    <Card title="Connection setup" eyebrow="Professional accounts only">
      <label className="studio-field"><span>Publish for</span><select value={selectedCreatorId} onChange={(event) => setSelectedCreatorId(event.target.value)}>{creators.map((creator) => <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>)}</select></label>
      <p className="small">Connecting never publishes. OAuth exchange, tokens, provider requests, container polling, and webhook verification stay server-side. Personal accounts are not supported.</p>
      {deployment && <p className="small">Provider version <strong>{deployment.apiVersion}</strong> · Policy <strong>{deployment.policyProfile}</strong> · Controlled pilot: images and carousels only.</p>}
      {connections.length > 0 && <div className="studio-capability-list" aria-label="Connected Instagram accounts">{connections.map((connection) => <div className="studio-capability-row" key={connection.id}><span><strong>@{connection.username}</strong><small>{connection.accountType} · {connection.state} · Graph {connection.apiVersion} · policy {connection.policyProfileVersion}</small><small>Instagram reference only — original source is not stored in Ubeeq.</small></span><div className="studio-inline-actions">{deployment?.pilotCapabilities.reelPublish && !connection.capabilities.includes('publish_reels') && <button className="auth-secondary-btn" type="button" onClick={() => void api.studioSetInstagramCapabilities(connection.id, [...connection.capabilities, 'publish_reels']).then(({ capabilities }) => setConnections((current) => current.map((item) => item.id === connection.id ? { ...item, capabilities } : item))).catch((error: Error) => setConnectionError(error.message))}>Enable Reels</button>}{deployment?.pilotCapabilities.storyPublish && !connection.capabilities.includes('publish_stories') && <button className="auth-secondary-btn" type="button" onClick={() => void api.studioSetInstagramCapabilities(connection.id, [...connection.capabilities, 'publish_stories']).then(({ capabilities }) => setConnections((current) => current.map((item) => item.id === connection.id ? { ...item, capabilities } : item))).catch((error: Error) => setConnectionError(error.message))}>Enable Stories</button>}{deployment?.pilotCapabilities.insightsRead && <button className="auth-secondary-btn" type="button" onClick={() => {
        const capabilities = [...new Set([...connection.capabilities, 'insights'])];
        void api.studioSetInstagramCapabilities(connection.id, capabilities).then(() => api.studioGetInstagramInsights(connection.id)).then(({ items }) => setConnectionError(`${items.length} aggregate insight snapshot${items.length === 1 ? '' : 's'} captured. No audience identities were collected.`)).catch((error: Error) => setConnectionError(error.message));
      }}>Refresh insights</button>}{deployment?.pilotCapabilities.mediaRead && <button className="auth-secondary-btn" type="button" onClick={() => {
        const capabilities = [...new Set([...connection.capabilities, 'metadata_import'])];
        setConnectionError('');
        void api.studioSetInstagramCapabilities(connection.id, capabilities).then(() => api.studioSyncInstagramMetadata(connection.id)).then(({ items, remoteChanges }) => setConnectionError(`${items.length} Instagram reference${items.length === 1 ? '' : 's'} added to Drafts. ${remoteChanges.length ? `${remoteChanges.length} remote change${remoteChanges.length === 1 ? '' : 's'} need review. ` : ''}No remote media bytes were stored.`)).catch((error: Error) => setConnectionError(error.message));
      }}>Import references</button>}<button className="auth-secondary-btn" type="button" onClick={() => {
        if (!window.confirm(`Disconnect @${connection.username}? Publishing and sync will stop. Your Ubeeq Works and existing publication history will remain.`)) return;
        void api.studioDisconnectInstagram(connection.id).then(() => setConnections((current) => current.filter((item) => item.id !== connection.id))).catch((error: Error) => setConnectionError(error.message));
      }}>Disconnect</button></div></div>)}</div>}
      <div className="studio-capability-list">
        {capabilities.map(([key, title, description]) => <label key={key} className="studio-capability-row"><input type="checkbox" disabled /><span><strong>{title}</strong><small>{description}</small></span></label>)}
      </div>
    </Card>
    <Card title="How publishing works" eyebrow="Explicit at every step">
      <ol className="studio-integration-steps">
        <li><strong>Choose a Work and derivative.</strong><span>The original private Asset is never exposed automatically.</span></li>
        <li><strong>Review eligibility and preflight.</strong><span>Account capability, provider limits, rights, safety, format, crop, caption, and placement are checked first.</span></li>
        <li><strong>Preview and confirm.</strong><span>A short-lived provider delivery URL is created only after approval.</span></li>
        <li><strong>Publish exactly once.</strong><span>Ambiguous container outcomes reconcile before retry; remote failure never removes canonical content.</span></li>
      </ol>
    </Card>
  </div>;
}
