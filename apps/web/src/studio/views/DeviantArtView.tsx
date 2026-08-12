import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../../api';
import { Card } from '../components/Card';
import { Pill } from '../components/Pill';
import type {
  StudioCreator,
  StudioDeviantArtAccount,
  StudioExternalCollection,
  StudioExternalCollectionMapping,
  StudioExternalSyncJob,
  StudioUbeeqCollection
} from '../types';

type CollectionResponse = {
  ubeeqCollections: StudioUbeeqCollection[];
  externalCollections: StudioExternalCollection[];
  mappings: StudioExternalCollectionMapping[];
};

const formatDate = (value?: string): string => {
  if (!value) return 'Not yet';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Not yet' : date.toLocaleString();
};

const accountTone = (status: StudioDeviantArtAccount['connectionStatus']): 'success' | 'warning' | 'danger' | 'default' => {
  if (status === 'connected') return 'success';
  if (status === 'authentication_required') return 'danger';
  if (status === 'rate_limited' || status === 'temporarily_unavailable') return 'warning';
  return 'default';
};

export function DeviantArtView({ creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const requestedCreatorId = new URLSearchParams(location.search).get('creatorId') || '';
  const [creatorId, setCreatorId] = useState('');
  const [configuration, setConfiguration] = useState<{
    configured: boolean;
    callbackUrl?: string;
    requiredConfiguration: string[];
    credential: null | { clientId: string; redirectUri: string; updatedAt: string };
    credentials?: Array<{ externalPlatformCredentialId: string; applicationLabel?: string; clientId: string; redirectUri: string; updatedAt: string }>;
  } | null>(null);
  const [accounts, setAccounts] = useState<StudioDeviantArtAccount[]>([]);
  const [jobsByAccount, setJobsByAccount] = useState<Record<string, StudioExternalSyncJob[]>>({});
  const [collections, setCollections] = useState<CollectionResponse>({ ubeeqCollections: [], externalCollections: [], mappings: [] });
  const [collectionName, setCollectionName] = useState('');
  const [workingExternalCollectionId, setWorkingExternalCollectionId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [applicationLabel, setApplicationLabel] = useState('');
  const [activeCredentialId, setActiveCredentialId] = useState('');
  const [editingApplication, setEditingApplication] = useState(false);
  const [creatingApplication, setCreatingApplication] = useState(false);
  const [recentlyConnectedAccountId, setRecentlyConnectedAccountId] = useState('');
  const [includeSourceFilesByAccount, setIncludeSourceFilesByAccount] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [workingAccountId, setWorkingAccountId] = useState('');
  const [queuedSyncAccountId, setQueuedSyncAccountId] = useState('');
  const [destinationCreatorByAccount, setDestinationCreatorByAccount] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');

  useEffect(() => {
    if (creatorId || !creators.length) return;
    setCreatorId(creators.some((creator) => creator.creatorId === requestedCreatorId) ? requestedCreatorId : creators[0].creatorId);
  }, [creatorId, creators, requestedCreatorId]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const connectionState = url.searchParams.get('deviantart');
    const connectedAccountId = url.searchParams.get('account') || '';
    const connectedApplicationId = url.searchParams.get('application') || '';
    const failureReason = url.searchParams.get('reason');
    const failureStage = url.searchParams.get('stage');
    if (!connectionState) return;
    if (connectionState === 'connected_assignment_required') {
      setRecentlyConnectedAccountId(connectedAccountId);
      setActiveCredentialId(connectedApplicationId);
      setMessage('DeviantArt account connected. Choose its creator assignments below to start the import.');
    } else if (connectionState === 'connected_destination_defaulted') {
      setRecentlyConnectedAccountId(connectedAccountId);
      setActiveCredentialId(connectedApplicationId);
      setMessage('DeviantArt account connected. Its destination creator was selected automatically.');
    } else if (connectionState === 'connected') {
      setMessage('DeviantArt account connected and its import has been queued.');
    } else if (connectionState === 'cancelled') {
      setConnectionError('DeviantArt authorization was cancelled.');
    } else if (connectionState === 'failed') {
      if (failureReason === 'authentication_required' && failureStage === 'token_exchange') {
        setConnectionError('DeviantArt rejected this application during token exchange. Verify the saved client ID and client secret, and confirm the application is Confidential with this exact callback URL.');
      } else if (failureReason === 'authentication_required' && failureStage === 'account_lookup') {
        setConnectionError('DeviantArt issued a token but did not allow account verification. Ubeeq has updated the requested permission; connect again to approve it.');
      } else {
        setConnectionError('DeviantArt authorization did not complete. Try connecting the account again.');
      }
    }
    url.searchParams.delete('deviantart');
    url.searchParams.delete('account');
    url.searchParams.delete('application');
    url.searchParams.delete('reason');
    url.searchParams.delete('stage');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const load = async (nextCreatorId = creatorId, nextQueuedSyncAccountId = queuedSyncAccountId) => {
    if (!nextCreatorId) return;
    setLoading(true);
    setError('');
    try {
      const [nextConfiguration, nextAccounts, nextCollections] = await Promise.all([
        api.studioGetDeviantArtConfiguration(),
        api.studioListDeviantArtAccounts(),
        api.studioListDeviantArtCollections(nextCreatorId)
      ]);
      const typedAccounts = (nextAccounts || []) as StudioDeviantArtAccount[];
      setConfiguration(nextConfiguration);
      setAccounts(typedAccounts);
      setIncludeSourceFilesByAccount(Object.fromEntries(typedAccounts.map((account) => [
        account.externalAccountId,
        account.includeSourceFilesOnSync === true
      ])));
      setDestinationCreatorByAccount(Object.fromEntries(typedAccounts.map((account) => [
        account.externalAccountId,
        account.primaryCreatorIdentityId || account.creatorIdentityId || (creators.length === 1 ? creators[0].creatorId : '')
      ])));
      setCollections(nextCollections as CollectionResponse);
      const nextJobs = await Promise.all(typedAccounts.map(async (account) => [
        account.externalAccountId,
        await api.studioListDeviantArtSyncJobs(account.externalAccountId) as StudioExternalSyncJob[]
      ] as const));
      setJobsByAccount(Object.fromEntries(nextJobs));
      if (nextQueuedSyncAccountId) {
        const queuedAccountJobs = nextJobs.find(([externalAccountId]) => externalAccountId === nextQueuedSyncAccountId)?.[1] || [];
        if (queuedAccountJobs.length && !queuedAccountJobs.some((job) => ['queued', 'processing', 'retry_scheduled', 'rate_limited'].includes(job.status))) {
          setQueuedSyncAccountId('');
          setMessage('');
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load DeviantArt management data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatorId]);

  useEffect(() => {
    if (!configuration) return;
    const credentials = configuration?.credentials || [];
    if (!credentials.length) {
      setActiveCredentialId('');
      return;
    }
    setActiveCredentialId((currentCredentialId) => credentials.some((credential) => credential.externalPlatformCredentialId === currentCredentialId)
      ? currentCredentialId
      : credentials[0].externalPlatformCredentialId);
  }, [configuration]);

  const activeCredential = useMemo(
    () => (configuration?.credentials || []).find((credential) => credential.externalPlatformCredentialId === activeCredentialId),
    [configuration, activeCredentialId]
  );

  useEffect(() => {
    if (!activeCredential) return;
    setClientId(activeCredential.clientId);
    setApplicationLabel(activeCredential.applicationLabel || 'DeviantArt application');
    setClientSecret('');
  }, [activeCredential?.externalPlatformCredentialId]);

  const activeAccounts = useMemo(
    () => activeCredentialId
      ? accounts
        .filter((account) => account.externalPlatformCredentialId === activeCredentialId)
        .sort((left, right) => {
          if (left.externalAccountId === recentlyConnectedAccountId) return -1;
          if (right.externalAccountId === recentlyConnectedAccountId) return 1;
          return left.externalUsername.localeCompare(right.externalUsername, undefined, { sensitivity: 'base' });
        })
      : [],
    [accounts, activeCredentialId, recentlyConnectedAccountId]
  );

  const hasActiveSync = useMemo(
    () => Object.values(jobsByAccount).flat().some((job) => ['queued', 'processing', 'retry_scheduled', 'rate_limited'].includes(job.status)),
    [jobsByAccount]
  );

  useEffect(() => {
    if (!hasActiveSync) return;
    const interval = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveSync, creatorId]);

  const connect = async () => {
    setError('');
    setConnectionError('');
    try {
      const result = await api.studioStartDeviantArtConnection(undefined, '/studio/workspace?section=integrations', false, activeCredentialId);
      window.location.assign(result.authorizationUrl);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Unable to begin DeviantArt connection.');
    }
  };

  const saveCredentials = async () => {
    if (!clientId.trim()) return;
    setError('');
    try {
      const saved = await api.studioSaveDeviantArtCredentials({
        externalPlatformCredentialId: creatingApplication ? undefined : activeCredentialId || undefined,
        createNew: creatingApplication || !activeCredentialId,
        applicationLabel,
        clientId: clientId.trim(),
        clientSecret: clientSecret || undefined
      });
      setClientSecret('');
      setActiveCredentialId(saved.externalPlatformCredentialId);
      setCreatingApplication(false);
      setEditingApplication(false);
      setMessage('Your DeviantArt application has been saved.');
      await load();
    } catch (credentialError) {
      setError(credentialError instanceof Error ? credentialError.message : 'Unable to save DeviantArt application credentials.');
    }
  };

  const cancelApplicationEdit = () => {
    setApplicationLabel(activeCredential?.applicationLabel || '');
    setClientId(activeCredential?.clientId || '');
    setClientSecret('');
    setCreatingApplication(false);
    setEditingApplication(false);
    setError('');
  };

  const beginNewApplication = () => {
    setApplicationLabel('');
    setClientId('');
    setClientSecret('');
    setCreatingApplication(true);
    setEditingApplication(true);
    setError('');
  };

  const sync = async (externalAccountId: string) => {
    setWorkingAccountId(externalAccountId);
    setError('');
    try {
      await api.studioSyncDeviantArtAccount(externalAccountId, includeSourceFilesByAccount[externalAccountId] === true);
      setMessage('Synchronization queued. Progress will update as the worker imports this account.');
      setQueuedSyncAccountId(externalAccountId);
      await load(creatorId, externalAccountId);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Unable to queue synchronization.');
    } finally {
      setWorkingAccountId('');
    }
  };

  const saveAccountDestination = async (account: StudioDeviantArtAccount, disconnect = false) => {
    const destinationCreatorId = disconnect ? '' : (destinationCreatorByAccount[account.externalAccountId] || '');
    setWorkingAccountId(account.externalAccountId);
    setError('');
    try {
      await api.studioAssignDeviantArtAccountCreators(account.externalAccountId, {
        creatorIdentityIds: destinationCreatorId ? [destinationCreatorId] : [],
        primaryCreatorIdentityId: destinationCreatorId || undefined
      });
      setMessage(destinationCreatorId
        ? 'Sync destination saved. You can start the first synchronization when you are ready.'
        : 'This creator has been disconnected. The DeviantArt account remains connected, but future synchronization is stopped.');
      await load();
    } catch (assignmentError) {
      setError(assignmentError instanceof Error ? assignmentError.message : 'Unable to save creator assignments.');
    } finally {
      setWorkingAccountId('');
    }
  };

  const removeAccount = async (account: StudioDeviantArtAccount) => {
    const affectedAccountCount = 1;
    if (!window.confirm(`Remove the DeviantArt account “${account.externalUsername}”? ${affectedAccountCount} account will lose its connection and will no longer be able to sync or publish through DeviantArt.`)) return;
    setWorkingAccountId(account.externalAccountId);
    setError('');
    try {
      await api.studioRemoveDeviantArtAccount(account.externalAccountId);
      if (recentlyConnectedAccountId === account.externalAccountId) setRecentlyConnectedAccountId('');
      setMessage(`The DeviantArt account “${account.externalUsername}” has been removed.`);
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Unable to remove this DeviantArt account.');
    } finally {
      setWorkingAccountId('');
    }
  };

  const createCollection = async () => {
    const name = collectionName.trim();
    if (!creatorId || !name) return;
    setError('');
    try {
      await api.studioCreateIntegrationCollection({ creatorIdentityId: creatorId, name });
      setCollectionName('');
      setMessage('Independent Ubeeq collection created.');
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create collection.');
    }
  };

  const saveMapping = async (externalCollection: StudioExternalCollection, ubeeqCollectionId: string) => {
    if (!ubeeqCollectionId) return;
    setError('');
    try {
      await api.studioSaveDeviantArtCollectionMapping(externalCollection.externalCollectionId, {
        externalAccountId: externalCollection.externalAccountId,
        ubeeqCollectionId,
        syncMode: 'manual'
      });
      setMessage('Gallery mapping saved. The source gallery remains separate from Ubeeq organization.');
      await load();
    } catch (mappingError) {
      setError(mappingError instanceof Error ? mappingError.message : 'Unable to save gallery mapping.');
    }
  };

  const createCollectionForGallery = async (externalCollection: StudioExternalCollection) => {
    if (!creatorId) return;
    setWorkingExternalCollectionId(externalCollection.externalCollectionId);
    setError('');
    try {
      const collection = await api.studioCreateIntegrationCollection({
        creatorIdentityId: creatorId,
        name: externalCollection.name,
        collectionType: 'gallery'
      }) as StudioUbeeqCollection;
      await api.studioSaveDeviantArtCollectionMapping(externalCollection.externalCollectionId, {
        externalAccountId: externalCollection.externalAccountId,
        ubeeqCollectionId: collection.ubeeqCollectionId,
        syncMode: 'initial_only'
      });
      setMessage(`Created the Ubeeq collection “${collection.name}” and mapped this DeviantArt gallery to it.`);
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create and map this Ubeeq collection.');
    } finally {
      setWorkingExternalCollectionId('');
    }
  };

  return (
    <section className="studio-integration-grid">
      <Card
        title="DeviantArt integration"
        eyebrow="Your connected publishing accounts"
        className="studio-integration-accounts"
      >
        <div className="studio-integration-toolbar">
          <label>
            <span>Browse creator catalogue</span>
            <select value={creatorId} onChange={(event) => setCreatorId(event.target.value)}>
              {creators.map((creator) => <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>)}
            </select>
          </label>
          <p className="small">{activeAccounts.length} account{activeAccounts.length === 1 ? '' : 's'} using this application</p>
        </div>
        <section className="studio-da-setup-wizard" aria-label="Connect DeviantArt tutorial">
            <div className="studio-da-setup-heading">
              <p className="auth-eyebrow">Connection guide</p>
              <h3>Connect one or more DeviantArt accounts</h3>
              <p className="small">The application and connected accounts belong to your Ubeeq account. Each connected account has one destination creator for now.</p>
            </div>
            <ol>
              <li><strong>Create your own DA OAuth application.</strong><span>Ubeeq does not use a shared DA application; your client credentials remain encrypted at rest.</span></li>
              <li><strong>Add this callback URL to that application.</strong>{configuration?.callbackUrl && <code>{configuration.callbackUrl}</code>}</li>
              <li><strong>Save the application once.</strong><span>Use it to connect any DeviantArt accounts you manage. The secret is encrypted at rest and never returned to your browser.</span></li>
              <li><strong>Connect an account, then choose its destination creator.</strong><span>Only after that choice is saved can you start synchronization.</span></li>
            </ol>
          </section>
        {activeCredential && !editingApplication ? (
          <>
            <div className="studio-da-application-actions">
              {(configuration?.credentials || []).length > 1 && (
                <label><span>DeviantArt applications</span><select value={activeCredentialId} onChange={(event) => setActiveCredentialId(event.target.value)}>{configuration?.credentials?.map((credential) => <option key={credential.externalPlatformCredentialId} value={credential.externalPlatformCredentialId}>{credential.applicationLabel || `DeviantArt app ${credential.clientId}`}</option>)}</select></label>
              )}
              <button type="button" className="auth-secondary-btn" onClick={beginNewApplication}>Add another DA application</button>
            </div>
            <section className="studio-da-application-summary" aria-label="Saved DeviantArt application">
              <div>
                <p className="auth-eyebrow">Selected application</p>
                <h3>{activeCredential.applicationLabel || 'DeviantArt application'}</h3>
                <p className="small">Client ID {activeCredential.clientId} · {activeAccounts.length} connected account{activeAccounts.length === 1 ? '' : 's'}</p>
              </div>
              <div className="studio-inline-actions">
                <button type="button" className="auth-secondary-btn" onClick={() => { setCreatingApplication(false); setEditingApplication(true); }}>Edit application</button>
              </div>
            </section>
          </>
        ) : (
          <div className="studio-integration-credential-form">
            <label><span>Application label</span><input value={applicationLabel} onChange={(event) => setApplicationLabel(event.target.value)} placeholder="My DeviantArt app" autoComplete="off" /></label>
            <label><span>DeviantArt client ID</span><input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" /></label>
            <label><span>DeviantArt client secret</span><input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder={activeCredential && !creatingApplication ? 'Saved securely; enter only to replace' : ''} autoComplete="new-password" /></label>
            <div className="studio-inline-actions">
              <button type="button" className="auth-secondary-btn" disabled={!clientId.trim()} onClick={() => void saveCredentials()}>{editingApplication && activeCredential && !creatingApplication ? 'Save changes' : 'Save application'}</button>
              {editingApplication && <button type="button" className="auth-secondary-btn" onClick={cancelApplicationEdit}>Cancel</button>}
            </div>
            {configuration?.callbackUrl && <p className="small">Callback URL: <code>{configuration.callbackUrl}</code></p>}
          </div>
        )}
        <section className="studio-da-connect-step" aria-label="Connect a DeviantArt account">
          <div>
            <p className="auth-eyebrow">Next step</p>
            <h3>{activeCredential ? `Connect an account with ${activeCredential.applicationLabel || 'this application'}` : 'Save your DeviantArt application first'}</h3>
            <p className="small">
              {configuration?.configured
                ? 'Sign in to the specific DeviantArt account you want to add. You can repeat this for every account you manage.'
                : 'Enter the client ID and secret above, then save the application to enable authorization.'}
            </p>
          </div>
          <button type="button" className="auth-primary-btn" disabled={!activeCredential} onClick={() => void connect()}>
            Connect a DeviantArt account
          </button>
        </section>
        {configuration && !configuration.configured && (
          <p className="error">Connection is not configured. Missing server settings: {configuration.requiredConfiguration.join(', ')}.</p>
        )}
        {loading && <p className="small">Loading integration and creator catalogue…</p>}
        {message && <p className="studio-integration-message">{message}</p>}
        {connectionError && <p className="error">{connectionError}</p>}
        {error && <p className="error">{error}</p>}
        {activeAccounts.length ? (
          <div className="studio-integration-account-list">
            {activeAccounts.map((account) => {
              const catalogueJob = jobsByAccount[account.externalAccountId]
                ?.find((job) => ['account_import', 'full_reconciliation', 'account_scan'].includes(job.type));
              const savedDestinationCreatorId = account.primaryCreatorIdentityId || account.creatorIdentityId || '';
              const destinationCreatorId = destinationCreatorByAccount[account.externalAccountId] || '';
              const destinationCreator = creators.find((creator) => creator.creatorId === savedDestinationCreatorId);
              return (
                <div className="studio-integration-account-row" key={account.externalAccountId}>
                  <div>
                    <strong>{account.externalUsername}</strong>
                    <span>Last successful sync: {formatDate(account.lastSuccessfulSyncAt)}</span>
                    <span className={destinationCreator ? undefined : 'studio-integration-assignment-needed'}>{destinationCreator ? `Sync destination: ${destinationCreator.name}` : 'Creator assignment required before synchronization.'}</span>
                    {catalogueJob?.progress && <span>{catalogueJob.progress.discovered} deviations discovered · {catalogueJob.progress.synchronized} synchronized · {catalogueJob.progress.remaining} remaining</span>}
                    {catalogueJob?.errorMessage && <span className="error">{catalogueJob.errorMessage}</span>}
                  </div>
                  <div className="studio-integration-row-actions">
                    <Pill label={account.connectionStatus.replace(/_/g, ' ')} tone={accountTone(account.connectionStatus)} />
                    {!savedDestinationCreatorId && <Pill label="Needs creator" tone="warning" />}
                    {savedDestinationCreatorId && <button type="button" className="auth-secondary-btn" disabled={workingAccountId === account.externalAccountId} onClick={() => void sync(account.externalAccountId)}>
                      {workingAccountId === account.externalAccountId ? 'Queueing…' : 'Sync now'}
                    </button>}
                    <button type="button" className="auth-secondary-btn" disabled={workingAccountId === account.externalAccountId} onClick={() => void removeAccount(account)}>
                      {workingAccountId === account.externalAccountId ? 'Removing…' : 'Remove this DeviantArt Account'}
                    </button>
                  </div>
                  {savedDestinationCreatorId && <label className="studio-da-account-source-files">
                    <input type="checkbox" checked={includeSourceFilesByAccount[account.externalAccountId] === true} onChange={(event) => setIncludeSourceFilesByAccount((current) => ({ ...current, [account.externalAccountId]: event.target.checked }))} />
                    <span><strong>Include source files in this sync</strong><small>Copies available DeviantArt source files into private Ubeeq Space storage.</small></span>
                  </label>}
                  <div className="studio-integration-assignment-form">
                    <label><span>Destination creator</span><select value={destinationCreatorId} onChange={(event) => setDestinationCreatorByAccount((current) => ({ ...current, [account.externalAccountId]: event.target.value }))}><option value="">Choose a creator…</option>{creators.map((creator) => <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>)}</select></label>
                    <div className="studio-inline-actions">
                      <button type="button" className="auth-secondary-btn" disabled={workingAccountId === account.externalAccountId || !destinationCreatorId} onClick={() => void saveAccountDestination(account)}>Save destination creator</button>
                      {savedDestinationCreatorId && <button type="button" className="auth-secondary-btn" disabled={workingAccountId === account.externalAccountId} onClick={() => void saveAccountDestination(account, true)}>Disconnect creator</button>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : !loading && <div className="studio-empty-state">Connect an account to import its catalogue, galleries, and engagement history into Ubeeq.</div>}
      </Card>

      <Card title="Gallery mapping" eyebrow="Independent Ubeeq collections" className="studio-integration-gallery-mapping">
        <div className="studio-inline-form">
          <input value={collectionName} onChange={(event) => setCollectionName(event.target.value)} placeholder="New Ubeeq collection" />
          <button type="button" className="auth-secondary-btn" onClick={() => void createCollection()}>Create collection</button>
        </div>
        <div className="studio-integration-mapping-list">
          {collections.externalCollections.map((externalCollection) => {
            const mapping = collections.mappings.find((item) => item.externalCollectionId === externalCollection.externalCollectionId);
            return (
              <div className="studio-integration-mapping-row" key={externalCollection.externalCollectionId}>
                <span><strong>{externalCollection.name}</strong><small>{externalCollection.externalUsername || 'DeviantArt'} gallery</small></span>
                <div className="studio-integration-mapping-actions">
                  <select value={mapping?.ubeeqCollectionId || ''} onChange={(event) => void saveMapping(externalCollection, event.target.value)}>
                    <option value="">Map to Ubeeq collection…</option>
                    {collections.ubeeqCollections.map((collection) => <option key={collection.ubeeqCollectionId} value={collection.ubeeqCollectionId}>{collection.name}</option>)}
                  </select>
                  {!mapping && (
                    <button
                      type="button"
                      className="auth-secondary-btn"
                      disabled={workingExternalCollectionId === externalCollection.externalCollectionId}
                      onClick={() => void createCollectionForGallery(externalCollection)}
                    >
                      {workingExternalCollectionId === externalCollection.externalCollectionId ? 'Creating…' : 'Create this Gallery as a Ubeeq Gallery'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {!collections.externalCollections.length && <div className="studio-empty-state">Gallery folders appear after the account's first import. Ubeeq collections remain independent unless you map them here.</div>}
      </Card>
    </section>
  );
}
