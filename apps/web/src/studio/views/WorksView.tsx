import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../../api';
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
  StudioExternalPublication,
  StudioSpacePublication,
  StudioUbeeqCollection
} from '../types';

type CollectionResponse = {
  ubeeqCollections: StudioUbeeqCollection[];
  externalCollections: StudioExternalCollection[];
  mappings: StudioExternalCollectionMapping[];
  collectionAssetIdsByCollection: Record<string, string[]>;
};

type WorkLifecycle = 'draft' | 'ready' | 'published';

const lifecycleFor = (asset: StudioExternalAsset): WorkLifecycle => {
  const destinations = asset.publications.filter((publication) => publication.syncStatus !== 'deleted');
  if (destinations.some((publication) => publication.syncStatus === 'active')) return 'published';
  return destinations.length ? 'ready' : 'draft';
};

const lifecycleLabel = (lifecycle: WorkLifecycle): string => lifecycle[0].toUpperCase() + lifecycle.slice(1);
const engagementNumber = (value: number): string => new Intl.NumberFormat().format(value);

function PlatformIcons({ asset }: { asset: StudioExternalAsset }) {
  const destinations = asset.publications.filter((publication) => publication.syncStatus !== 'deleted');
  return <div className="studio-work-platform-icons" aria-label="Connected platforms">
    <span className="studio-work-platform-icon studio-work-platform-icon-ubeeq" title="Stored in Ubeeq Space" aria-label="Stored in Ubeeq Space">
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="10" cy="10" r="2.5" fill="currentColor" /></svg>
    </span>
    {destinations.map((publication) => {
      const status = publication.syncStatus === 'active' ? 'published' : publication.syncStatus === 'draft' ? 'draft in Sta.sh' : 'targeted';
      return <span key={publication.externalPublicationId} className="studio-work-platform-icon studio-work-platform-icon-deviantart" title={`${sourcePlatformLabel(publication)} · ${status}`} aria-label={`${sourcePlatformLabel(publication)} ${status}`}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16.5 10 10 17.5 3.5 10 10 2.5Z" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M8.2 6.4h3.1l1.7 3.6-1.7 3.6H8.2l1.6-3.6-1.6-3.6Z" fill="currentColor" /></svg>
    </span>;
    })}
  </div>;
}

const sourcePlatformLabel = (publication: StudioExternalAsset['publications'][number]): string => publication.platform === 'deviantart' ? 'DeviantArt' : (publication.platform || 'Integration');

const assetTypeLabel = (asset: StudioExternalAsset): string => {
  if (asset.assetType === 'image') return 'Image';
  if (asset.assetType === 'literature') return 'Literature';
  if (asset.assetType === 'video') return 'Video';
  if (asset.assetType === 'animation') return 'Animation';
  return asset.publications.length ? 'Imported DeviantArt work' : 'Ubeeq work';
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
  const [lifecycle, setLifecycle] = useState<'all' | WorkLifecycle>(requestedStatus === 'draft' || requestedStatus === 'ready' || requestedStatus === 'published' ? requestedStatus : 'all');
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
        api.studioListDeviantArtCatalogue(nextCreatorId),
        api.studioListDeviantArtCollections(nextCreatorId),
        api.studioListDeviantArtAccounts(nextCreatorId)
      ]);
      setAssets(((catalogue as { items?: StudioExternalAsset[] }).items || []));
      setCollections(nextCollections as CollectionResponse);
      const connectedAccounts = ((nextAccounts || []) as StudioDeviantArtAccount[]).filter((account) => account.connectionStatus === 'connected');
      setAccounts(connectedAccounts);
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
      if (lifecycle !== 'all' && lifecycleFor(asset) !== lifecycle) return false;
      if (!normalizedQuery) return true;
      return [asset.canonicalTitle || '', asset.canonicalDescription || '', ...asset.publications.flatMap((publication) => [publication.externalTitle || '', ...publication.externalTags])]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [assets, collectionId, lifecycle, manuallyAssignedAssetIds, mappedExternalCollectionIds, query]);
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
      if (shouldInclude && !asset.spacePublication?.published) {
        const spacePublication = await api.studioUpdateSpacePublication(asset.assetId, {
          published: true,
          hostingMode: 'hosted',
          visibility: 'private'
        }) as StudioSpacePublication;
        setAssets((current) => current.map((item) => item.assetId === asset.assetId ? { ...item, spacePublication } : item));
      }
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
    const selectedAssets = displayedAssets.filter((asset) => selectedDisplayedAssetIds.includes(asset.assetId));
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
      const backups = await Promise.all(selectedAssets
        .filter((asset) => !asset.spacePublication?.published)
        .map(async (asset) => [
          asset.assetId,
          await api.studioUpdateSpacePublication(asset.assetId, { published: true, hostingMode: 'hosted', visibility: 'private' }) as StudioSpacePublication
        ] as const));
      if (backups.length) {
        const backupByAssetId = new Map(backups);
        setAssets((current) => current.map((asset) => ({
          ...asset,
          ...(backupByAssetId.has(asset.assetId) ? { spacePublication: backupByAssetId.get(asset.assetId) } : {})
        })));
      }
      setBulkCollectionId('');
      setSelectedWorkAssetIds([]);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to add the selected works to this collection.');
    } finally {
      setBulkUpdating(false);
    }
  };

  const destinationPublication = (
    result: { publication: Omit<StudioExternalPublication, 'externalUsername' | 'externalCollectionIds' | 'displayOptions'> },
    externalAccountId: string
  ): StudioExternalPublication => {
    const account = accounts.find((item) => item.externalAccountId === externalAccountId);
    return {
      ...result.publication,
      externalUsername: account?.externalUsername || 'connected account',
      externalCollectionIds: [],
      displayOptions: { allowComments: true, isMature: false, isAiGenerated: false, noAi: false }
    };
  };

  const mergeDestinationPublication = (asset: StudioExternalAsset, publication: StudioExternalPublication): StudioExternalAsset => ({
    ...asset,
    titleSyncPolicy: 'mirrored',
    descriptionSyncPolicy: 'mirrored',
    publications: [
      ...asset.publications.filter((existing) => existing.externalPublicationId !== publication.externalPublicationId),
      publication
    ]
  });

  const addDeviantArtDestination = async (asset: StudioExternalAsset, externalAccountId: string, targetStatus: 'draft' | 'published') => {
    if (!externalAccountId) return;
    setDestinationUpdatingAssetId(asset.assetId);
    setError('');
    setDestinationMessageByAsset((current) => ({ ...current, [asset.assetId]: '' }));
    try {
      const result = await api.studioAddDeviantArtWorkDestination(asset.assetId, externalAccountId, targetStatus) as {
        publication: Omit<StudioExternalPublication, 'externalUsername' | 'externalCollectionIds' | 'displayOptions'>;
      };
      const publication = destinationPublication(result, externalAccountId);
      setAssets((current) => current.map((item) => item.assetId === asset.assetId ? mergeDestinationPublication(item, publication) : item));
      setDestinationMessageByAsset((current) => ({ ...current, [asset.assetId]: `DeviantArt targeted as ${targetStatus === 'draft' ? 'a Sta.sh draft' : 'a published deviation'}. Review its metadata, then sync when ready.` }));
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to add DeviantArt as a destination.');
    } finally {
      setDestinationUpdatingAssetId('');
    }
  };

  const addSelectedWorksToDeviantArt = async () => {
    const externalAccountId = bulkDestinationAccountId || (accounts.length === 1 ? accounts[0].externalAccountId : '');
    if (!externalAccountId || !selectedDisplayedAssetIds.length) return;
    setBulkDestinationUpdating(true);
    setBulkDestinationMessage('');
    setError('');
    try {
      const selectedAssets = displayedAssets.filter((asset) => selectedDisplayedAssetIds.includes(asset.assetId));
      const eligibleAssets = selectedAssets.filter((asset) => !(
        bulkDestinationStatus === 'draft'
        && asset.publications.some((publication) => (
          publication.externalAccountId === externalAccountId && publication.syncStatus === 'active'
        ))
      ));
      const skippedPublishedCount = selectedAssets.length - eligibleAssets.length;
      const results = await Promise.all(eligibleAssets.map(async (asset) => {
        const result = await api.studioAddDeviantArtWorkDestination(asset.assetId, externalAccountId, bulkDestinationStatus) as {
          publication: Omit<StudioExternalPublication, 'externalUsername' | 'externalCollectionIds' | 'displayOptions'>;
        };
        return [asset.assetId, destinationPublication(result, externalAccountId)] as const;
      }));
      const publicationsByAssetId = new Map(results);
      setAssets((current) => current.map((asset) => {
        const publication = publicationsByAssetId.get(asset.assetId);
        return publication ? mergeDestinationPublication(asset, publication) : asset;
      }));
      setSelectedWorkAssetIds([]);
      setBulkDestinationMessage([
        results.length ? `${results.length} work${results.length === 1 ? '' : 's'} targeted for ${bulkDestinationStatus === 'draft' ? 'Sta.sh drafts' : 'publication'}.` : '',
        skippedPublishedCount ? `${skippedPublishedCount} already-published work${skippedPublishedCount === 1 ? ' was' : 's were'} left unchanged.` : ''
      ].filter(Boolean).join(' '));
    } catch (destinationError) {
      setError(destinationError instanceof Error ? destinationError.message : 'Unable to update the selected DeviantArt destinations.');
    } finally {
      setBulkDestinationUpdating(false);
    }
  };

  return (
    <section className="studio-works-layout">
      <Card
        title="Works"
        eyebrow="Creator catalogue"
        actions={<Link className="auth-primary-btn no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}&create=1`}>Upload works</Link>}
      >
        <div className="studio-works-controls">
          <label>
            <span>Creator</span>
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
            <span>Status</span>
            <select value={lifecycle} onChange={(event) => setLifecycle(event.target.value as 'all' | WorkLifecycle)}>
              <option value="all">All works</option>
              <option value="draft">Draft</option>
              <option value="ready">Ready</option>
              <option value="published">Published</option>
            </select>
          </label>
          <label className="studio-works-search">
            <span>Search works</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, description, or tag" />
          </label>
        </div>

        <p className="studio-works-context"><strong>{activeCreator?.name || 'Creator'}</strong>{selectedCollection ? ` · ${selectedCollection.name}` : ' · All works'}{lifecycle !== 'all' ? ` · ${lifecycleLabel(lifecycle)}` : ''}</p>
        {!selectedCollection && <p className="studio-works-space-note">Drafts are stored in Ubeeq Space. Choose a destination here or during metadata review, then sync when each work is ready.</p>}
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
          {!!accounts.length && <div className="studio-works-bulk-destination">
            <span>Set selected DeviantArt destination</span>
            {accounts.length > 1 && <select value={bulkDestinationAccountId} onChange={(event) => setBulkDestinationAccountId(event.target.value)}>
              <option value="">Choose an account…</option>
              {accounts.map((account) => <option key={account.externalAccountId} value={account.externalAccountId}>{account.externalUsername}</option>)}
            </select>}
            {accounts.length === 1 && <small>{accounts[0].externalUsername}</small>}
            <select value={bulkDestinationStatus} onChange={(event) => setBulkDestinationStatus(event.target.value as 'draft' | 'published')} aria-label="DeviantArt destination status for selected works">
              <option value="published">Published (default)</option>
              <option value="draft">Draft in Sta.sh</option>
            </select>
            <button type="button" className="auth-secondary-btn" disabled={!selectedDisplayedAssetIds.length || !bulkDestinationAccountId || bulkDestinationUpdating} onClick={() => void addSelectedWorksToDeviantArt()}>
              {bulkDestinationUpdating ? 'Setting…' : 'Set destination'}
            </button>
            {bulkDestinationMessage && <small className="studio-work-destination-message">{bulkDestinationMessage}</small>}
          </div>}
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
            const assetLifecycle = lifecycleFor(asset);
            const deviantArtDestinations = asset.publications.filter((publication) => publication.platform === 'deviantart' && publication.syncStatus !== 'deleted');
            const selectedDestinationAccountId = destinationAccountByAsset[asset.assetId] || (accounts.length === 1 ? accounts[0].externalAccountId : '');
            const selectedDestinationStatus = destinationStatusByAsset[asset.assetId] || 'published';
            const isDestinationUpdating = destinationUpdatingAssetId === asset.assetId;
            return (
              <article className="studio-work-row" key={asset.assetId}>
                <label className="studio-work-select" aria-label={`Select ${asset.canonicalTitle || 'work'}`}>
                  <input type="checkbox" checked={selectedDisplayedAssetIds.includes(asset.assetId)} onChange={(event) => toggleWorkSelection(asset.assetId, event.target.checked)} />
                </label>
                <WorkThumbnail asset={asset} />
                <div className="studio-work-details">
                  <strong>{asset.canonicalTitle || asset.publications[0]?.externalTitle || 'Untitled work'}</strong>
                  <span>{assetTypeLabel(asset)} · {asset.publications.map((publication) => publication.externalUsername).filter(Boolean).join(', ') || 'Ubeeq'}</span>
                  <div className="studio-work-lifecycle"><span className={`studio-work-lifecycle-badge studio-work-lifecycle-${assetLifecycle}`}>{lifecycleLabel(assetLifecycle)}</span><PlatformIcons asset={asset} /></div>
                  {asset.engagement && <div className="studio-work-engagement" title={asset.engagement.capturedAt ? `Updated ${new Date(asset.engagement.capturedAt).toLocaleString()}` : undefined}>
                    <span><strong>{engagementNumber(asset.engagement.views)}</strong> views</span>
                    <span><strong>{engagementNumber(asset.engagement.favourites)}</strong> favourites</span>
                    <span><strong>{engagementNumber(asset.engagement.comments)}</strong> comments</span>
                    <span><strong>{engagementNumber(asset.engagement.downloads)}</strong> downloads</span>
                  </div>}
                  <div className="studio-work-destination-target">
                    <span>DeviantArt destination</span>
                    {deviantArtDestinations.length
                      ? <small>{deviantArtDestinations.map((publication) => `${publication.externalUsername} · ${publication.syncStatus === 'active' ? 'Published' : publication.syncStatus === 'draft' ? 'Draft in Sta.sh' : publication.targetStatus === 'draft' ? 'Will save to Sta.sh' : 'Will publish'}`).join(', ')}</small>
                      : accounts.length
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
                            {isDestinationUpdating ? 'Adding…' : 'Target DeviantArt'}
                          </button>
                        </div>
                        : <div><small>No connected account is available for this creator.</small><Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=integrations&creatorId=${encodeURIComponent(creatorId)}`}>Manage integrations</Link></div>}
                    {destinationMessageByAsset[asset.assetId] && <small className="studio-work-destination-message">{destinationMessageByAsset[asset.assetId]}</small>}
                  </div>
                </div>
                <div className="studio-work-actions">
                  <span className="studio-collection-visibility">{asset.visibility}</span>
                  {asset.spacePublication?.published && <span
                    className="studio-work-space-status"
                    title={asset.spacePublication.contentSyncStatus === 'failed'
                      ? asset.spacePublication.contentSyncError || 'Ubeeq could not copy the remote source file.'
                      : undefined}
                  >
                    {asset.spacePublication.contentSyncStatus === 'hosted'
                      ? asset.spacePublication.sourceCopyQuality === 'display_copy'
                        ? 'Display copy stored; DeviantArt original unavailable'
                        : 'Original stored and available in your Ubeeq Space'
                      : asset.spacePublication.contentSyncStatus === 'not_available'
                        ? 'DeviantArt does not provide a downloadable copy'
                      : asset.spacePublication.contentSyncStatus === 'failed'
                        ? 'Ubeeq copy unavailable'
                        : 'Copying to Ubeeq Space'}
                  </span>}
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
