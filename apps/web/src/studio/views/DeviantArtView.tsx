import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Card } from '../components/Card';
import { Pill } from '../components/Pill';
import type {
  StudioCreator,
  StudioDeviantArtAccount,
  StudioExternalAsset,
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
  const [creatorId, setCreatorId] = useState('');
  const [configuration, setConfiguration] = useState<{
    configured: boolean;
    callbackUrl?: string;
    requiredConfiguration: string[];
    credential: null | { clientId: string; redirectUri: string; updatedAt: string };
  } | null>(null);
  const [accounts, setAccounts] = useState<StudioDeviantArtAccount[]>([]);
  const [jobsByAccount, setJobsByAccount] = useState<Record<string, StudioExternalSyncJob[]>>({});
  const [assets, setAssets] = useState<StudioExternalAsset[]>([]);
  const [collections, setCollections] = useState<CollectionResponse>({ ubeeqCollections: [], externalCollections: [], mappings: [] });
  const [query, setQuery] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [collectionName, setCollectionName] = useState('');
  const [workingExternalCollectionId, setWorkingExternalCollectionId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [workingAccountId, setWorkingAccountId] = useState('');
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, string[]>>({});
  const [primaryCreatorByAccount, setPrimaryCreatorByAccount] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');

  useEffect(() => {
    if (!creatorId && creators.length) setCreatorId(creators[0].creatorId);
  }, [creatorId, creators]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const connectionState = url.searchParams.get('deviantart');
    const failureReason = url.searchParams.get('reason');
    const failureStage = url.searchParams.get('stage');
    if (!connectionState) return;
    if (connectionState === 'connected_assignment_required') {
      setMessage('DeviantArt account connected. Choose its creator assignments below to start the import.');
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
    url.searchParams.delete('reason');
    url.searchParams.delete('stage');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const load = async (nextCreatorId = creatorId, nextQuery = query) => {
    if (!nextCreatorId) return;
    setLoading(true);
    setError('');
    try {
      const [nextConfiguration, nextAccounts, catalogue, nextCollections] = await Promise.all([
        api.studioGetDeviantArtConfiguration(),
        api.studioListDeviantArtAccounts(),
        api.studioListDeviantArtCatalogue(nextCreatorId, nextQuery),
        api.studioListDeviantArtCollections(nextCreatorId)
      ]);
      const typedAccounts = (nextAccounts || []) as StudioDeviantArtAccount[];
      setConfiguration(nextConfiguration);
      setClientId(nextConfiguration.credential?.clientId || '');
      setAccounts(typedAccounts);
      setAssignmentDrafts(Object.fromEntries(typedAccounts.map((account) => [account.externalAccountId, account.creatorAssignments || []])));
      setPrimaryCreatorByAccount(Object.fromEntries(typedAccounts.map((account) => [
        account.externalAccountId,
        account.primaryCreatorIdentityId || account.creatorIdentityId || account.creatorAssignments?.[0] || ''
      ])));
      setAssets(((catalogue as { items?: StudioExternalAsset[] })?.items || []));
      setCollections(nextCollections as CollectionResponse);
      const nextJobs = await Promise.all(typedAccounts.map(async (account) => [
        account.externalAccountId,
        await api.studioListDeviantArtSyncJobs(account.externalAccountId) as StudioExternalSyncJob[]
      ] as const));
      setJobsByAccount(Object.fromEntries(nextJobs));
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
    const timeout = window.setTimeout(() => void load(creatorId, query), 250);
    return () => window.clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.assetId === selectedAssetId) || assets[0],
    [assets, selectedAssetId]
  );

  useEffect(() => {
    if (!selectedAsset) {
      setSelectedAssetId('');
      setDraftTitle('');
      setDraftDescription('');
      return;
    }
    setSelectedAssetId(selectedAsset.assetId);
    setDraftTitle(selectedAsset.canonicalTitle || '');
    setDraftDescription(selectedAsset.canonicalDescription || '');
  }, [selectedAsset?.assetId]);

  const connect = async () => {
    setError('');
    setConnectionError('');
    try {
      const result = await api.studioStartDeviantArtConnection();
      window.location.assign(result.authorizationUrl);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Unable to begin DeviantArt connection.');
    }
  };

  const saveCredentials = async () => {
    if (!clientId.trim()) return;
    setError('');
    try {
      await api.studioSaveDeviantArtCredentials({ clientId: clientId.trim(), clientSecret: clientSecret || undefined });
      setClientSecret('');
      setMessage('Your DeviantArt application has been saved.');
      await load();
    } catch (credentialError) {
      setError(credentialError instanceof Error ? credentialError.message : 'Unable to save DeviantArt application credentials.');
    }
  };

  const sync = async (externalAccountId: string) => {
    setWorkingAccountId(externalAccountId);
    setError('');
    try {
      await api.studioSyncDeviantArtAccount(externalAccountId);
      setMessage('Synchronization queued. Progress will update as the worker imports this account.');
      await load();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Unable to queue synchronization.');
    } finally {
      setWorkingAccountId('');
    }
  };

  const saveAccountCreators = async (account: StudioDeviantArtAccount) => {
    const creatorIdentityIds = assignmentDrafts[account.externalAccountId] || [];
    setWorkingAccountId(account.externalAccountId);
    setError('');
    try {
      await api.studioAssignDeviantArtAccountCreators(account.externalAccountId, {
        creatorIdentityIds,
        primaryCreatorIdentityId: primaryCreatorByAccount[account.externalAccountId]
      });
      setMessage(creatorIdentityIds.length
        ? 'Creator assignments saved. The initial import is queued for the primary creator.'
        : 'Creator assignments removed. This account will remain connected without importing new work.');
      await load();
    } catch (assignmentError) {
      setError(assignmentError instanceof Error ? assignmentError.message : 'Unable to save creator assignments.');
    } finally {
      setWorkingAccountId('');
    }
  };

  const saveAsset = async () => {
    if (!selectedAsset) return;
    setError('');
    try {
      await api.studioUpdateExternalAsset(selectedAsset.assetId, {
        canonicalTitle: draftTitle,
        canonicalDescription: draftDescription,
        titleSyncPolicy: 'independent',
        descriptionSyncPolicy: 'independent'
      });
      setMessage('Ubeeq metadata saved. Future DeviantArt title and description changes will remain separate.');
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save asset metadata.');
    }
  };

  const setSpaceSelection = async () => {
    if (!selectedAsset) return;
    setError('');
    try {
      const published = !selectedAsset.spacePublication?.published;
      await api.studioUpdateSpacePublication(selectedAsset.assetId, { published, hostingMode: 'linked', visibility: 'private' });
      setMessage(published ? 'Asset selected for Ubeeq Space as linked content.' : 'Asset removed from Ubeeq Space selection.');
      await load();
    } catch (spaceError) {
      setError(spaceError instanceof Error ? spaceError.message : 'Unable to update Ubeeq Space selection.');
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
          <p className="small">{accounts.length} connected account{accounts.length === 1 ? '' : 's'} · {assets.length} works for this creator</p>
        </div>
        <section className="studio-da-setup-wizard" aria-label="Connect DeviantArt tutorial">
            <div className="studio-da-setup-heading">
              <p className="auth-eyebrow">Connection guide</p>
              <h3>Connect one or more DeviantArt accounts</h3>
              <p className="small">The application and connected accounts belong to your Ubeeq account. Assign each account to one or more creator identities after authorization.</p>
            </div>
            <ol>
              <li><strong>Create your own DA OAuth application.</strong><span>Ubeeq does not use a shared DA application; your client credentials remain encrypted at rest.</span></li>
              <li><strong>Add this callback URL to that application.</strong>{configuration?.callbackUrl && <code>{configuration.callbackUrl}</code>}</li>
              <li><strong>Save the client ID and secret below.</strong><span>The secret is encrypted at rest and never returned to your browser.</span></li>
              <li><strong>Connect and assign a DA account.</strong><span>Select every Ubeeq creator that should manage it, then choose the primary creator for imported assets.</span></li>
            </ol>
          </section>
        <div className="studio-integration-credential-form">
          <label>
            <span>DeviantArt client ID</span>
            <input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" />
          </label>
          <label>
            <span>DeviantArt client secret</span>
            <input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder={configuration?.credential ? 'Saved securely; enter only to replace' : ''} autoComplete="new-password" />
          </label>
          <button type="button" className="auth-secondary-btn" disabled={!clientId.trim()} onClick={() => void saveCredentials()}>Save application</button>
          {configuration?.callbackUrl && <p className="small">Callback URL: <code>{configuration.callbackUrl}</code></p>}
        </div>
        <section className="studio-da-connect-step" aria-label="Connect a DeviantArt account">
          <div>
            <p className="auth-eyebrow">Next step</p>
            <h3>{configuration?.configured ? 'Connect a DeviantArt account' : 'Save your DeviantArt application first'}</h3>
            <p className="small">
              {configuration?.configured
                ? 'Sign in to the specific DeviantArt account you want to add. You can repeat this for every account you manage.'
                : 'Enter the client ID and secret above, then save the application to enable authorization.'}
            </p>
          </div>
          <button type="button" className="auth-primary-btn" disabled={!configuration?.configured} onClick={() => void connect()}>
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
        {accounts.length ? (
          <div className="studio-integration-account-list">
            {accounts.map((account) => {
              const job = jobsByAccount[account.externalAccountId]?.[0];
              return (
                <div className="studio-integration-account-row" key={account.externalAccountId}>
                  <div>
                    <strong>{account.externalUsername}</strong>
                    <span>Last successful sync: {formatDate(account.lastSuccessfulSyncAt)}</span>
                    <span>{(assignmentDrafts[account.externalAccountId] || []).length
                      ? `Assigned to ${(assignmentDrafts[account.externalAccountId] || []).map((id) => creators.find((creator) => creator.creatorId === id)?.name || id).join(', ')}`
                      : 'Assign this account before its first import.'}</span>
                    {job?.progress && <span>{job.progress.discovered} deviations discovered · {job.progress.synchronized} synchronized · {job.progress.remaining} remaining</span>}
                    {job?.errorMessage && <span className="error">{job.errorMessage}</span>}
                  </div>
                  <div className="studio-integration-row-actions">
                    <Pill label={account.connectionStatus.replace(/_/g, ' ')} tone={accountTone(account.connectionStatus)} />
                    <button type="button" className="auth-secondary-btn" disabled={workingAccountId === account.externalAccountId || !(assignmentDrafts[account.externalAccountId] || []).length} onClick={() => void sync(account.externalAccountId)}>
                      {workingAccountId === account.externalAccountId ? 'Queueing…' : 'Sync now'}
                    </button>
                  </div>
                  <div className="studio-integration-assignment-form">
                    <span>Creators with this account</span>
                    <div className="studio-integration-assignment-options">
                      {creators.map((creator) => {
                        const selected = (assignmentDrafts[account.externalAccountId] || []).includes(creator.creatorId);
                        return (
                          <label key={creator.creatorId}>
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => setAssignmentDrafts((current) => {
                                const existing = current[account.externalAccountId] || [];
                                const next = selected ? existing.filter((id) => id !== creator.creatorId) : [...existing, creator.creatorId];
                                return { ...current, [account.externalAccountId]: next };
                              })}
                            />
                            {creator.name}
                          </label>
                        );
                      })}
                    </div>
                    {(assignmentDrafts[account.externalAccountId] || []).length > 1 && (
                      <label>
                        <span>Primary creator for imported assets</span>
                        <select value={primaryCreatorByAccount[account.externalAccountId] || ''} onChange={(event) => setPrimaryCreatorByAccount((current) => ({ ...current, [account.externalAccountId]: event.target.value }))}>
                          {(assignmentDrafts[account.externalAccountId] || []).map((id) => <option key={id} value={id}>{creators.find((creator) => creator.creatorId === id)?.name || id}</option>)}
                        </select>
                      </label>
                    )}
                    <button type="button" className="auth-secondary-btn" disabled={workingAccountId === account.externalAccountId} onClick={() => void saveAccountCreators(account)}>Save creator assignments</button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : !loading && <div className="studio-empty-state">Connect an account to import its catalogue, galleries, and engagement history into Ubeeq.</div>}
      </Card>

      <Card title="Local catalogue" eyebrow="Search across connected accounts">
        <div className="studio-integration-search">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, descriptions, tags, or account…" />
        </div>
        <div className="studio-integration-catalogue-list">
          {assets.slice(0, 50).map((asset) => (
            <button
              className={`studio-integration-catalogue-row${selectedAsset?.assetId === asset.assetId ? ' studio-integration-catalogue-row-active' : ''}`}
              key={asset.assetId}
              type="button"
              onClick={() => setSelectedAssetId(asset.assetId)}
            >
              <span>
                <strong>{asset.canonicalTitle || 'Untitled deviation'}</strong>
                <small>{asset.assetType} · {asset.publications.map((publication) => publication.externalUsername).filter(Boolean).join(', ')}</small>
              </span>
              <small>{asset.publications.length} publication{asset.publications.length === 1 ? '' : 's'}</small>
            </button>
          ))}
        </div>
        {!loading && !assets.length && <div className="studio-empty-state">Imported deviations will appear here. Search runs against Ubeeq's local catalogue.</div>}
      </Card>

      <Card title="Asset metadata" eyebrow="Ubeeq presentation values">
        {selectedAsset ? (
          <div className="studio-integration-editor">
            <p className="small">Source: {selectedAsset.publications.map((publication) => publication.externalUsername).filter(Boolean).join(', ') || 'DeviantArt'} · Source changes are retained separately.</p>
            <label>
              <span>Title</span>
              <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
            </label>
            <label>
              <span>Description</span>
              <textarea value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} rows={7} />
            </label>
            <div className="studio-inline-actions">
              <button type="button" className="auth-primary-btn" onClick={() => void saveAsset()}>Save Ubeeq metadata</button>
              <button type="button" className="auth-secondary-btn" onClick={() => void setSpaceSelection()}>{selectedAsset.spacePublication?.published ? 'Remove from Space' : 'Select for Space'}</button>
              <Pill label={`${selectedAsset.titleSyncPolicy.replace(/_/g, ' ')} title`} tone="info" />
            </div>
          </div>
        ) : <div className="studio-empty-state">Select an imported asset to maintain an independent Ubeeq title and description.</div>}
      </Card>

      <Card title="Gallery mapping" eyebrow="Independent Ubeeq collections">
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
