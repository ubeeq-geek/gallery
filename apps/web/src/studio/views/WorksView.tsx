import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../../api';
import { brand } from '../../brand';
import { Card } from '../components/Card';
import { WorkMetadataView } from './WorkMetadataView';
import { WorkActivityView } from './WorkActivityView';
import { WorkUploadView } from './WorkUploadView';
import type {
  StudioCreator,
  StudioDeviantArtAccount,
  StudioExternalAsset,
  StudioExternalCollection,
  StudioExternalCollectionMapping,
  StudioUbeeqCollection
} from '../types';

type CollectionResponse = {
  ubeeqCollections: StudioUbeeqCollection[];
  externalCollections: StudioExternalCollection[];
  mappings: StudioExternalCollectionMapping[];
  collectionAssetIdsByCollection: Record<string, string[]>;
};

type WorkLifecycle = 'draft' | 'ready' | 'archived';
type PlatformFilter = 'all' | 'published_anywhere' | 'published_nowhere' | 'deviantart_live' | 'eversally_live' | 'out_of_sync' | 'error';

const lifecycleLabel = (lifecycle: WorkLifecycle): string => lifecycle[0].toUpperCase() + lifecycle.slice(1);
const availabilityLabel = (availability: StudioExternalAsset['contentAvailability']): string => ({
  metadata_only: 'Metadata only',
  external_reference: 'External reference only',
  display_copy: 'Display copy stored',
  original_hosted: 'Original backed up'
})[availability];
const destinationStatusLabel = (status: StudioExternalAsset['destinationPublications'][number]['status']): string => ({
  live: 'Published', draft: 'Draft / staged', scheduled: 'Scheduled', queued: 'Queued', publishing: 'Publishing', updating: 'Updating', failed: 'Error', missing: 'Missing remotely', removed: 'Removed', unknown: 'Unknown'
})[status];
const engagementNumber = (value: number): string => new Intl.NumberFormat().format(value);

const sourcePlatformLabel = (publication: StudioExternalAsset['publications'][number]): string => publication.platform === 'deviantart' ? 'DeviantArt' : (publication.platform || 'Integration');

const assetTypeLabel = (asset: StudioExternalAsset): string => {
  if (asset.assetType === 'image') return 'Image';
  if (asset.assetType === 'literature') return 'Literature';
  if (asset.assetType === 'video') return 'Video';
  if (asset.assetType === 'animation') return 'Animation';
  return asset.publications.length ? 'Imported DeviantArt work' : `${brand.productName} work`;
};

function WorkThumbnail({ asset }: { asset: StudioExternalAsset }) {
  const deviantArtThumbnailUrl = asset.publications.find((publication) => publication.previewUrl)?.previewUrl;
  const [url, setUrl] = useState(asset.thumbnailUrl || deviantArtThumbnailUrl);

  useEffect(() => {
    setUrl(asset.thumbnailUrl || deviantArtThumbnailUrl);
  }, [asset.thumbnailUrl, deviantArtThumbnailUrl]);

  const handleLoadError = () => {
    setUrl((currentUrl) => currentUrl === asset.thumbnailUrl ? deviantArtThumbnailUrl : undefined);
  };

  return (
    <div className="studio-work-thumbnail" aria-hidden="true">
      <span>{assetTypeLabel(asset).slice(0, 1)}</span>
      {url && <img src={url} alt="" onError={handleLoadError} />}
    </div>
  );
}

export function WorksView({ creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const workId = new URLSearchParams(location.search).get('workId');
  const workTab = new URLSearchParams(location.search).get('tab');
  const create = new URLSearchParams(location.search).get('create') === '1';
  if (workId && workTab === 'activity') return <WorkActivityView creators={creators} />;
  if (workId) return <WorkMetadataView creators={creators} />;
  if (create) return <WorkUploadView creators={creators} />;
  return <WorksIndex creators={creators} />;
}

function WorksIndex({ creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const requestedCreatorId = new URLSearchParams(location.search).get('creatorId') || '';
  const requestedCollectionId = new URLSearchParams(location.search).get('collectionId') || '';
  const requestedStatus = new URLSearchParams(location.search).get('status');
  const [creatorId, setCreatorId] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [query, setQuery] = useState('');
  const [lifecycle, setLifecycle] = useState<'all' | WorkLifecycle>(requestedStatus === 'draft' || requestedStatus === 'ready' || requestedStatus === 'archived' ? requestedStatus : 'all');
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all');
  const [shownPlatforms, setShownPlatforms] = useState({ eversally: true, deviantart: true });
  const [assets, setAssets] = useState<StudioExternalAsset[]>([]);
  const [accounts, setAccounts] = useState<StudioDeviantArtAccount[]>([]);
  const [collections, setCollections] = useState<CollectionResponse>({ ubeeqCollections: [], externalCollections: [], mappings: [], collectionAssetIdsByCollection: {} });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatingAssetId, setUpdatingAssetId] = useState('');
  const [selectedWorkAssetIds, setSelectedWorkAssetIds] = useState<string[]>([]);
  const [bulkCollectionId, setBulkCollectionId] = useState('');
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [collectionPickerAssetId, setCollectionPickerAssetId] = useState('');
  const [collectionPickerQuery, setCollectionPickerQuery] = useState('');
  const [destinationAccountByAsset, setDestinationAccountByAsset] = useState<Record<string, string>>({});
  const [destinationStatusByAsset, setDestinationStatusByAsset] = useState<Record<string, 'draft' | 'published'>>({});
  const [destinationUpdatingAssetId, setDestinationUpdatingAssetId] = useState('');
  const [destinationMessageByAsset, setDestinationMessageByAsset] = useState<Record<string, string>>({});
  const [bulkDestinationAccountId, setBulkDestinationAccountId] = useState('');
  const [bulkDestinationStatus, setBulkDestinationStatus] = useState<'draft' | 'published'>('published');
  const [bulkSpaceIntent, setBulkSpaceIntent] = useState(false);
  const [bulkDeviantArtIntent, setBulkDeviantArtIntent] = useState(true);
  const [bulkDestinationUpdating, setBulkDestinationUpdating] = useState(false);
  const [bulkDestinationMessage, setBulkDestinationMessage] = useState('');
  const appliedRouteCollectionFilter = useRef('');

  const activeCreator = useMemo(() => creators.find((creator) => creator.creatorId === creatorId), [creatorId, creators]);
  const selectedCollection = useMemo(
    () => collections.ubeeqCollections.find((collection) => collection.ubeeqCollectionId === collectionId),
    [collectionId, collections.ubeeqCollections]
  );

  const load = async (nextCreatorId = creatorId) => {
    if (!nextCreatorId) return;
    setLoading(true);
    setError('');
    try {
      const [catalogue, nextCollections, nextAccounts] = await Promise.all([
        api.studioListWorks(nextCreatorId),
        api.studioListDeviantArtCollections(nextCreatorId),
        api.studioListDeviantArtAccounts(nextCreatorId)
      ]);
      setAssets(((catalogue as { items?: StudioExternalAsset[] }).items || []));
      setCollections(nextCollections as CollectionResponse);
      const connectedAccounts = ((nextAccounts || []) as StudioDeviantArtAccount[]).filter((account) => account.connectionStatus === 'connected');
      setAccounts(connectedAccounts);
      setBulkDeviantArtIntent(connectedAccounts.length > 0);
      setBulkDestinationAccountId((current) => current || (connectedAccounts.length === 1 ? connectedAccounts[0].externalAccountId : ''));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load works for this creator.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (creatorId || !creators.length) return;
    setCreatorId(creators.some((creator) => creator.creatorId === requestedCreatorId) ? requestedCreatorId : creators[0].creatorId);
  }, [creatorId, creators, requestedCreatorId]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatorId]);

  useEffect(() => {
    if (!collections.ubeeqCollections.length) return;
    const routeFilterKey = `${requestedCreatorId}:${requestedCollectionId}`;
    if (appliedRouteCollectionFilter.current === routeFilterKey) return;
    if (requestedCollectionId && collections.ubeeqCollections.some((collection) => collection.ubeeqCollectionId === requestedCollectionId)) {
      setCollectionId(requestedCollectionId);
    } else if (requestedCollectionId) {
      setCollectionId('');
    }
    appliedRouteCollectionFilter.current = routeFilterKey;
  }, [collections.ubeeqCollections, requestedCollectionId, requestedCreatorId]);

  const mappedExternalCollectionIds = useMemo(() => {
    if (!collectionId) return new Set<string>();
    const mappedIds = new Set(
      collections.mappings
        .filter((mapping) => mapping.ubeeqCollectionId === collectionId)
        .map((mapping) => mapping.externalCollectionId)
    );
    return new Set(
      collections.externalCollections
        .filter((collection) => mappedIds.has(collection.externalCollectionId))
        .map((collection) => collection.externalCollectionExternalId)
    );
  }, [collectionId, collections.externalCollections, collections.mappings]);

  const manuallyAssignedAssetIds = useMemo(
    () => new Set(collections.collectionAssetIdsByCollection[collectionId] || []),
    [collectionId, collections.collectionAssetIdsByCollection]
  );

  const visibleAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return assets.filter((asset) => {
      const inCollection = !collectionId || asset.publications.some((publication) => (
        publication.externalCollectionIds.some((externalCollectionId) => mappedExternalCollectionIds.has(externalCollectionId))
      )) || manuallyAssignedAssetIds.has(asset.assetId);
      if (!inCollection) return false;
      if (lifecycle !== 'all' && asset.workStatus !== lifecycle) return false;
      const current = asset.destinationPublications.filter((publication) => publication.status !== 'removed');
      if (platformFilter === 'published_anywhere' && !current.some((publication) => publication.status === 'live')) return false;
      if (platformFilter === 'published_nowhere' && current.some((publication) => publication.status === 'live')) return false;
      if (platformFilter === 'deviantart_live' && !current.some((publication) => publication.destination === 'deviantart' && publication.status === 'live')) return false;
      if (platformFilter === 'eversally_live' && !current.some((publication) => publication.destination === 'eversally' && publication.status === 'live')) return false;
      if (platformFilter === 'out_of_sync' && !current.some((publication) => publication.syncStatus === 'local_newer' || publication.syncStatus === 'remote_newer' || publication.syncStatus === 'conflict')) return false;
      if (platformFilter === 'error' && !current.some((publication) => publication.status === 'failed' || publication.syncStatus === 'error')) return false;
      if (!normalizedQuery) return true;
      return [asset.canonicalTitle || '', asset.canonicalDescription || '', ...asset.publications.flatMap((publication) => [publication.externalTitle || '', ...publication.externalTags])]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [assets, collectionId, lifecycle, manuallyAssignedAssetIds, mappedExternalCollectionIds, platformFilter, query]);
  const displayedAssets = useMemo(() => visibleAssets.slice(0, 100), [visibleAssets]);
  const displayedAssetIds = useMemo(() => new Set(displayedAssets.map((asset) => asset.assetId)), [displayedAssets]);
  const selectedDisplayedAssetIds = useMemo(
    () => selectedWorkAssetIds.filter((assetId) => displayedAssetIds.has(assetId)),
    [displayedAssetIds, selectedWorkAssetIds]
  );

  useEffect(() => {
    setSelectedWorkAssetIds((current) => current.filter((assetId) => displayedAssetIds.has(assetId)));
  }, [displayedAssetIds]);

  const setAssetCollectionMembership = async (asset: StudioExternalAsset, targetCollectionId: string, shouldInclude: boolean) => {
    if (!targetCollectionId || !creatorId) return;
    const assignedAssetIds = new Set(collections.collectionAssetIdsByCollection[targetCollectionId] || []);
    if (shouldInclude) assignedAssetIds.add(asset.assetId);
    else assignedAssetIds.delete(asset.assetId);
    const assetIds = [...assignedAssetIds];
    setUpdatingAssetId(asset.assetId);
    setError('');
    try {
      await api.studioReplaceIntegrationCollectionAssets(targetCollectionId, { creatorIdentityId: creatorId, assetIds });
      setCollections((current) => ({
        ...current,
        collectionAssetIdsByCollection: { ...current.collectionAssetIdsByCollection, [targetCollectionId]: assetIds }
      }));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to update this work’s collections.');
    } finally {
      setUpdatingAssetId('');
    }
  };

  const toggleWorkSelection = (assetId: string, checked: boolean) => {
    setSelectedWorkAssetIds((current) => checked
      ? [...new Set([...current, assetId])]
      : current.filter((item) => item !== assetId));
  };

  const addSelectedWorksToCollection = async () => {
    if (!bulkCollectionId || !creatorId || !selectedDisplayedAssetIds.length) return;
    const assetIds = [...new Set([
      ...(collections.collectionAssetIdsByCollection[bulkCollectionId] || []),
      ...selectedDisplayedAssetIds
    ])];
    setBulkUpdating(true);
    setError('');
    try {
      await api.studioReplaceIntegrationCollectionAssets(bulkCollectionId, { creatorIdentityId: creatorId, assetIds });
      setCollections((current) => ({
        ...current,
        collectionAssetIdsByCollection: { ...current.collectionAssetIdsByCollection, [bulkCollectionId]: assetIds }
      }));
      setBulkCollectionId('');
      setSelectedWorkAssetIds([]);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to add the selected works to this collection.');
    } finally {
      setBulkUpdating(false);
    }
  };

  const addDeviantArtDestination = async (asset: StudioExternalAsset, externalAccountId: string, targetStatus: 'draft' | 'published') => {
    if (!externalAccountId) return;
    setDestinationUpdatingAssetId(asset.assetId);
    setError('');
    setDestinationMessageByAsset((current) => ({ ...current, [asset.assetId]: '' }));
    try {
      const intent = await api.studioSetWorkPublicationIntent(asset.assetId, { destination: 'deviantart', integrationAccountId: externalAccountId, enabled: true, desiredStatus: targetStatus === 'draft' ? 'draft' : 'live' });
      setAssets((current) => current.map((item) => item.assetId === asset.assetId ? { ...item, publicationIntents: [...item.publicationIntents.filter((existing) => !(existing.destination === 'deviantart' && existing.integrationAccountId === externalAccountId)), intent] } : item));
      setDestinationMessageByAsset((current) => ({ ...current, [asset.assetId]: `Publishing intent saved for DeviantArt · ${accounts.find((account) => account.externalAccountId === externalAccountId)?.externalUsername || 'account'}. No remote publication has been created yet.` }));
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to add DeviantArt as a destination.');
    } finally {
      setDestinationUpdatingAssetId('');
    }
  };

  const setSpaceIntent = async (asset: StudioExternalAsset, enabled: boolean) => {
    setDestinationUpdatingAssetId(asset.assetId);
    setError('');
    try {
      const intent = await api.studioSetWorkPublicationIntent(asset.assetId, { destination: 'eversally', enabled, desiredStatus: 'live' });
      setAssets((current) => current.map((item) => item.assetId === asset.assetId ? { ...item, publicationIntents: [...item.publicationIntents.filter((existing) => existing.destination !== 'eversally'), intent] } : item));
      setDestinationMessageByAsset((current) => ({ ...current, [asset.assetId]: enabled
        ? `${brand.workspaceFullName} selected for the next publish operation. The Work remains unpublished until you review and publish it.`
        : `${brand.workspaceFullName} removed from the next publish operation. Current publication state was not changed.` }));
    } catch (intentError) {
      setError(intentError instanceof Error ? intentError.message : 'Unable to save this publishing intent.');
    } finally {
      setDestinationUpdatingAssetId('');
    }
  };

  const addSelectedWorksToDeviantArt = async () => {
    const externalAccountId = bulkDestinationAccountId || (accounts.length === 1 ? accounts[0].externalAccountId : '');
    if (!selectedDisplayedAssetIds.length || (!bulkSpaceIntent && !bulkDeviantArtIntent) || (bulkDeviantArtIntent && !externalAccountId)) return;
    setBulkDestinationUpdating(true);
    setBulkDestinationMessage('');
    setError('');
    try {
      const selectedAssets = displayedAssets.filter((asset) => selectedDisplayedAssetIds.includes(asset.assetId));
      const results = await Promise.all(selectedAssets.map(async (asset) => {
        const intents = await Promise.all([
          ...(bulkSpaceIntent ? [api.studioSetWorkPublicationIntent(asset.assetId, { destination: 'eversally', enabled: true, desiredStatus: 'live' })] : []),
          ...(bulkDeviantArtIntent ? [api.studioSetWorkPublicationIntent(asset.assetId, { destination: 'deviantart', integrationAccountId: externalAccountId, enabled: true, desiredStatus: bulkDestinationStatus === 'draft' ? 'draft' : 'live' })] : [])
        ]);
        return [asset.assetId, intents] as const;
      }));
      const intentsByAssetId = new Map(results);
      setAssets((current) => current.map((asset) => {
        const intents = intentsByAssetId.get(asset.assetId);
        if (!intents) return asset;
        return { ...asset, publicationIntents: [
          ...asset.publicationIntents.filter((existing) => !intents.some((intent) => intent.destination === existing.destination && intent.integrationAccountId === existing.integrationAccountId)),
          ...intents
        ] };
      }));
      setSelectedWorkAssetIds([]);
      setBulkDestinationMessage([
        results.length ? `Publishing intent saved for ${results.length} work${results.length === 1 ? '' : 's'}. No remote publications were created.` : ''
      ].filter(Boolean).join(' '));
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to update the selected publishing destinations.');
    } finally {
      setBulkDestinationUpdating(false);
    }
  };

  return (
    <section className="studio-works-layout">
      <Card
        title="Works"
        eyebrow={`${brand.creatorName} catalogue`}
        actions={<Link className="auth-primary-btn no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}&create=1`}>Upload works</Link>}
      >
        <div className="studio-works-controls">
          <label>
            <span>{brand.creatorName}</span>
            <select value={creatorId} onChange={(event) => { setCreatorId(event.target.value); setCollectionId(''); }}>
              {creators.map((creator) => <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>)}
            </select>
          </label>
          <label>
            <span>Collection</span>
            <select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>
              <option value="">All works</option>
              {collections.ubeeqCollections.map((collection) => <option key={collection.ubeeqCollectionId} value={collection.ubeeqCollectionId}>{collection.name}</option>)}
            </select>
          </label>
          <label>
            <span>Work state</span>
            <select value={lifecycle} onChange={(event) => setLifecycle(event.target.value as 'all' | WorkLifecycle)}>
              <option value="all">All works</option>
              <option value="draft">Draft</option>
              <option value="ready">Ready</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label>
            <span>Platform state</span>
            <select value={platformFilter} onChange={(event) => setPlatformFilter(event.target.value as PlatformFilter)}>
              <option value="all">All platform states</option>
              <option value="published_anywhere">Published anywhere</option>
              <option value="published_nowhere">Published nowhere</option>
              <option value="eversally_live">Published on {brand.workspaceFullName}</option>
              <option value="deviantart_live">Published on DeviantArt</option>
              <option value="out_of_sync">Out of sync</option>
              <option value="error">Errors</option>
            </select>
          </label>
          <label className="studio-works-search">
            <span>Search works</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, description, or tag" />
          </label>
        </div>

        <p className="studio-works-context"><strong>{activeCreator?.name || brand.creatorName}</strong>{selectedCollection ? ` · ${selectedCollection.name}` : ' · All works'}{lifecycle !== 'all' ? ` · ${lifecycleLabel(lifecycle)}` : ''}</p>
        {!selectedCollection && <p className="studio-works-space-note">A Work’s local state is independent from every publishing destination. Selecting a destination records intent; publishing happens during review and sync.</p>}
        <fieldset className="studio-works-platform-view">
          <legend>Platforms shown</legend>
          <label><input type="checkbox" checked={shownPlatforms.eversally} onChange={(event) => setShownPlatforms((current) => ({ ...current, eversally: event.target.checked }))} /> <span>{brand.workspaceFullName}</span></label>
          <label><input type="checkbox" checked={shownPlatforms.deviantart} onChange={(event) => setShownPlatforms((current) => ({ ...current, deviantart: event.target.checked }))} /> <span>DeviantArt</span></label>
        </fieldset>
        {loading && <p className="small">Loading works…</p>}
        {error && <p className="error">{error}</p>}

        {!!displayedAssets.length && <div className="studio-works-bulk-bar">
          <label className="studio-work-select-all">
            <input
              type="checkbox"
              checked={selectedDisplayedAssetIds.length === displayedAssets.length}
              onChange={(event) => setSelectedWorkAssetIds(event.target.checked ? displayedAssets.map((asset) => asset.assetId) : [])}
            />
            <span>Select all {displayedAssets.length}{visibleAssets.length > displayedAssets.length ? ' shown' : ''}</span>
          </label>
          <span className="studio-works-selection-count">{selectedDisplayedAssetIds.length} selected</span>
          <label className="studio-works-bulk-collection">
            <span>Add selected to collection</span>
            <select value={bulkCollectionId} onChange={(event) => setBulkCollectionId(event.target.value)}>
              <option value="">Choose a collection…</option>
              {collections.ubeeqCollections.map((collection) => <option key={collection.ubeeqCollectionId} value={collection.ubeeqCollectionId}>{collection.name}</option>)}
            </select>
          </label>
          <button type="button" className="auth-primary-btn" disabled={!bulkCollectionId || !selectedDisplayedAssetIds.length || bulkUpdating} onClick={() => void addSelectedWorksToCollection()}>
            {bulkUpdating ? 'Adding…' : 'Add selected'}
          </button>
          <div className="studio-works-bulk-destination">
            <span>Publish destinations</span>
            <label><input type="checkbox" checked={bulkSpaceIntent} onChange={(event) => setBulkSpaceIntent(event.target.checked)} /> {brand.workspaceFullName}</label>
            {!!accounts.length && <label><input type="checkbox" checked={bulkDeviantArtIntent} onChange={(event) => setBulkDeviantArtIntent(event.target.checked)} /> DeviantArt</label>}
            {bulkDeviantArtIntent && accounts.length > 1 && <select value={bulkDestinationAccountId} onChange={(event) => setBulkDestinationAccountId(event.target.value)}>
              <option value="">Choose an account…</option>
              {accounts.map((account) => <option key={account.externalAccountId} value={account.externalAccountId}>{account.externalUsername}</option>)}
            </select>}
            {bulkDeviantArtIntent && accounts.length === 1 && <small>{accounts[0].externalUsername}</small>}
            {bulkDeviantArtIntent && <select value={bulkDestinationStatus} onChange={(event) => setBulkDestinationStatus(event.target.value as 'draft' | 'published')} aria-label="DeviantArt destination status for selected works">
              <option value="published">Published (default)</option>
              <option value="draft">Draft in Sta.sh</option>
            </select>}
            <button type="button" className="auth-secondary-btn" disabled={!selectedDisplayedAssetIds.length || (!bulkSpaceIntent && !bulkDeviantArtIntent) || (bulkDeviantArtIntent && !bulkDestinationAccountId) || bulkDestinationUpdating} onClick={() => void addSelectedWorksToDeviantArt()}>
              {bulkDestinationUpdating ? 'Saving…' : 'Save intent'}
            </button>
            {bulkDestinationMessage && <small className="studio-work-destination-message">{bulkDestinationMessage}</small>}
          </div>
        </div>}
        {visibleAssets.length > 100 && <p className="studio-works-limit-note">Showing the first 100 matching works. Refine your search to select others.</p>}

        <div className="studio-works-list">
          {displayedAssets.map((asset) => {
            const manuallyAssigned = manuallyAssignedAssetIds.has(asset.assetId);
            const assignedCollections = collections.ubeeqCollections.filter((collection) => (
              (collections.collectionAssetIdsByCollection[collection.ubeeqCollectionId] || []).includes(asset.assetId)
            ));
            const visiblePickerCollections = collections.ubeeqCollections.filter((collection) => (
              collection.name.toLowerCase().includes(collectionPickerQuery.trim().toLowerCase())
            ));
            const isCollectionPickerOpen = collectionPickerAssetId === asset.assetId;
            const assetLifecycle = asset.workStatus === 'deleted' ? 'archived' : asset.workStatus;
            const deviantArtDestinations = asset.publications.filter((publication) => publication.platform === 'deviantart' && publication.syncStatus !== 'deleted');
            const remoteLifecycleIssues = asset.publications.filter((publication) => (
              publication.platform === 'deviantart'
              && (publication.syncStatus === 'missing' || publication.syncStatus === 'restricted' || publication.syncStatus === 'deleted' || publication.syncStatus === 'error')
            ));
            const selectedDestinationAccountId = destinationAccountByAsset[asset.assetId] || (accounts.length === 1 ? accounts[0].externalAccountId : '');
            const selectedDestinationStatus = destinationStatusByAsset[asset.assetId] || 'published';
            const isDestinationUpdating = destinationUpdatingAssetId === asset.assetId;
            const spaceIntentEnabled = asset.publicationIntents.some((intent) => intent.destination === 'eversally' && intent.enabled);
            const daDestinationCandidates = [
              ...accounts.map((account) => ({ accountId: account.externalAccountId, label: `DeviantArt · ${account.externalUsername}` })),
              ...asset.destinationPublications.filter((publication) => publication.destination === 'deviantart').map((publication) => ({ accountId: publication.integrationAccountId, label: `DeviantArt · ${publication.accountLabel || 'disconnected account'}` })),
              ...asset.publicationIntents.filter((intent) => intent.destination === 'deviantart').map((intent) => ({ accountId: intent.integrationAccountId, label: `DeviantArt · ${accounts.find((account) => account.externalAccountId === intent.integrationAccountId)?.externalUsername || 'disconnected account'}` }))
            ].filter((row, index, rows) => rows.findIndex((candidate) => candidate.accountId === row.accountId) === index);
            const destinationRows = [
              ...(shownPlatforms.eversally ? [{ destination: 'eversally', accountId: undefined, label: brand.workspaceFullName }] : []),
              ...(shownPlatforms.deviantart ? daDestinationCandidates.map((row) => ({ destination: 'deviantart', ...row })) : [])
            ].map((row) => ({
              ...row,
              publication: asset.destinationPublications.find((publication) => publication.destination === row.destination && publication.integrationAccountId === row.accountId && publication.status !== 'removed'),
              intent: asset.publicationIntents.find((intent) => intent.enabled && intent.destination === row.destination && intent.integrationAccountId === row.accountId)
            }));
            const originLabel = asset.origin.type === 'import'
              ? `Imported from ${asset.origin.platform === 'deviantart' ? 'DeviantArt' : asset.origin.platform || 'an integration'}`
              : `Created in ${brand.productName}`;
            return (
              <article className="studio-work-row" key={asset.assetId}>
                <label className="studio-work-select" aria-label={`Select ${asset.canonicalTitle || 'work'}`}>
                  <input type="checkbox" checked={selectedDisplayedAssetIds.includes(asset.assetId)} onChange={(event) => toggleWorkSelection(asset.assetId, event.target.checked)} />
                </label>
                <WorkThumbnail asset={asset} />
                <div className="studio-work-details">
                  <strong>{asset.canonicalTitle || asset.publications[0]?.externalTitle || 'Untitled work'}</strong>
                  <span>{assetTypeLabel(asset)} · {originLabel}</span>
                  <div className="studio-work-local-state">
                    <span>Work in {brand.productName}</span>
                    <strong>{lifecycleLabel(assetLifecycle)} · {availabilityLabel(asset.contentAvailability)}</strong>
                  </div>
                  <div className="studio-work-destination-states">
                    <span>Destinations</span>
                    {destinationRows.map((row) => <div className="studio-work-destination-state" key={`${row.destination}:${row.accountId || 'space'}`}>
                      <strong>{row.label}</strong>
                      <span className={row.publication?.status === 'live' ? 'studio-destination-live' : row.publication?.status === 'failed' ? 'studio-destination-error' : ''}>
                        {row.publication
                          ? row.publication.destination === 'eversally' && row.publication.status === 'live' && row.publication.visibility === 'private'
                            ? 'Private · managers only'
                            : `${destinationStatusLabel(row.publication.status)}${row.publication.destination === 'eversally' ? ` · ${row.publication.visibility}` : ''}`
                          : 'Not published'}
                        {row.publication && row.publication.syncStatus !== 'in_sync' && row.publication.syncStatus !== 'not_applicable' ? ` · ${row.publication.syncStatus.replace(/_/g, ' ')}` : ''}
                      </span>
                      {row.intent && !row.publication && <small>Selected to publish as {row.intent.desiredStatus === 'draft' ? 'draft / staged' : row.intent.desiredStatus}</small>}
                    </div>)}
                  </div>
                  {asset.engagement && <div className="studio-work-engagement" title={asset.engagement.capturedAt ? `Updated ${new Date(asset.engagement.capturedAt).toLocaleString()}` : undefined}>
                    <span><strong>{engagementNumber(asset.engagement.views)}</strong> views</span>
                    <span><strong>{engagementNumber(asset.engagement.favourites)}</strong> favourites</span>
                    <span><strong>{engagementNumber(asset.engagement.comments)}</strong> comments</span>
                    <span><strong>{engagementNumber(asset.engagement.downloads)}</strong> downloads</span>
                  </div>}
                  <div className="studio-work-destination-target">
                    <span>Publishing intent</span>
                    <label className="studio-work-intent-option">
                      <input type="checkbox" checked={spaceIntentEnabled} disabled={isDestinationUpdating} onChange={(event) => void setSpaceIntent(asset, event.target.checked)} />
                      <span>{brand.workspaceFullName}</span>
                    </label>
                    {accounts.length
                        ? <div>
                          {accounts.length > 1 && <select
                            value={selectedDestinationAccountId}
                            disabled={isDestinationUpdating}
                            aria-label={`Choose a DeviantArt destination for ${asset.canonicalTitle || 'this work'}`}
                            onChange={(event) => setDestinationAccountByAsset((current) => ({ ...current, [asset.assetId]: event.target.value }))}
                          >
                            <option value="">Choose an account…</option>
                            {accounts.map((account) => <option key={account.externalAccountId} value={account.externalAccountId}>{account.externalUsername}</option>)}
                          </select>}
                          {accounts.length === 1 && <small>{accounts[0].externalUsername}</small>}
                          <select
                            value={selectedDestinationStatus}
                            disabled={isDestinationUpdating}
                            aria-label={`Choose DeviantArt status for ${asset.canonicalTitle || 'this work'}`}
                            onChange={(event) => setDestinationStatusByAsset((current) => ({ ...current, [asset.assetId]: event.target.value as 'draft' | 'published' }))}
                          >
                            <option value="published">Published (default)</option>
                            <option value="draft">Draft in Sta.sh</option>
                          </select>
                          <button
                            type="button"
                            className="auth-secondary-btn"
                            disabled={isDestinationUpdating || !selectedDestinationAccountId}
                            onClick={() => void addDeviantArtDestination(asset, selectedDestinationAccountId, selectedDestinationStatus)}
                          >
                            {isDestinationUpdating ? 'Saving…' : 'Save DeviantArt intent'}
                          </button>
                        </div>
                        : <div><small>No connected account is available for this creator.</small><Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=integrations&creatorId=${encodeURIComponent(creatorId)}`}>Manage integrations</Link></div>}
                    {destinationMessageByAsset[asset.assetId] && <small className="studio-work-destination-message">{destinationMessageByAsset[asset.assetId]}</small>}
                  </div>
                  {remoteLifecycleIssues.map((publication) => <small className="studio-work-metadata-warning" key={`remote-state:${publication.externalPublicationId}`}>
                    @{publication.externalUsername} · {publication.syncStatus.replace(/_/g, ' ')}{publication.remoteStateReason ? ` — ${publication.remoteStateReason}` : ''}
                  </small>)}
                </div>
                <div className="studio-work-actions">
                  {selectedCollection && manuallyAssigned && <span className="studio-work-membership">Added to this collection</span>}
                  <div className="studio-work-collection-summary">
                    <span>Collections</span>
                    {assignedCollections.length
                      ? <div>{assignedCollections.map((collection) => <span className="studio-work-collection-chip" key={collection.ubeeqCollectionId}>{collection.name}</span>)}</div>
                      : <small>Not in a collection</small>}
                  </div>
                  <button
                    type="button"
                    className="auth-secondary-btn"
                    disabled={updatingAssetId === asset.assetId}
                    onClick={() => {
                      setCollectionPickerAssetId(isCollectionPickerOpen ? '' : asset.assetId);
                      setCollectionPickerQuery('');
                    }}
                  >
                    {isCollectionPickerOpen ? 'Done' : 'Manage collections'}
                  </button>
                  <Link
                    className="auth-secondary-btn no-underline"
                    to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}${collectionId ? `&collectionId=${encodeURIComponent(collectionId)}` : ''}&workId=${encodeURIComponent(asset.assetId)}&tab=activity`}
                  >
                    Activity
                  </Link>
                  <Link
                    className="auth-secondary-btn no-underline"
                    to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}${collectionId ? `&collectionId=${encodeURIComponent(collectionId)}` : ''}&workId=${encodeURIComponent(asset.assetId)}`}
                  >
                    {deviantArtDestinations.some((publication) => publication.syncStatus === 'pending_publish') ? 'Review & sync' : 'Edit metadata'}
                  </Link>
                  {asset.destinationPublications.some((publication) => publication.destination === 'eversally' && publication.status === 'live' && publication.visibility !== 'private') && asset.canonicalSlug && activeCreator?.slug && <Link
                    className="auth-secondary-btn no-underline"
                    to={`/creators/${encodeURIComponent(activeCreator.slug)}/works/${encodeURIComponent(asset.canonicalSlug)}`}
                  >
                    Open public work
                  </Link>}
                </div>
                {isCollectionPickerOpen && <div className="studio-work-collection-picker">
                  <label>
                    <span>Filter collections</span>
                    <input value={collectionPickerQuery} onChange={(event) => setCollectionPickerQuery(event.target.value)} placeholder="Search collections…" autoFocus />
                  </label>
                  <div>
                    {visiblePickerCollections.map((collection) => {
                      const checked = (collections.collectionAssetIdsByCollection[collection.ubeeqCollectionId] || []).includes(asset.assetId);
                      return <label className="studio-work-collection-option" key={collection.ubeeqCollectionId}>
                        <input type="checkbox" checked={checked} disabled={updatingAssetId === asset.assetId} onChange={(event) => void setAssetCollectionMembership(asset, collection.ubeeqCollectionId, event.target.checked)} />
                        <span>{collection.name}</span>
                      </label>;
                    })}
                    {!visiblePickerCollections.length && <p className="small">No collections match this filter.</p>}
                  </div>
                </div>}
              </article>
            );
          })}
        </div>
        {!loading && !visibleAssets.length && <div className="studio-empty-state">No works match this creator, collection, and search filter.</div>}
      </Card>
    </section>
  );
}
