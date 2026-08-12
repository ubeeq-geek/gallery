import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../../api';
import { Card } from '../components/Card';
import { WorkMetadataView } from './WorkMetadataView';
import type {
  StudioCreator,
  StudioExternalAsset,
  StudioExternalCollection,
  StudioExternalCollectionMapping,
  StudioSpacePublication,
  StudioUbeeqCollection
} from '../types';

type CollectionResponse = {
  ubeeqCollections: StudioUbeeqCollection[];
  externalCollections: StudioExternalCollection[];
  mappings: StudioExternalCollectionMapping[];
  collectionAssetIdsByCollection: Record<string, string[]>;
};

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
  if (workId) return <WorkMetadataView creators={creators} />;
  return <WorksIndex creators={creators} />;
}

function WorksIndex({ creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const requestedCreatorId = new URLSearchParams(location.search).get('creatorId') || '';
  const requestedCollectionId = new URLSearchParams(location.search).get('collectionId') || '';
  const [creatorId, setCreatorId] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [query, setQuery] = useState('');
  const [assets, setAssets] = useState<StudioExternalAsset[]>([]);
  const [collections, setCollections] = useState<CollectionResponse>({ ubeeqCollections: [], externalCollections: [], mappings: [], collectionAssetIdsByCollection: {} });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatingAssetId, setUpdatingAssetId] = useState('');
  const [selectedWorkAssetIds, setSelectedWorkAssetIds] = useState<string[]>([]);
  const [bulkCollectionId, setBulkCollectionId] = useState('');
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [collectionPickerAssetId, setCollectionPickerAssetId] = useState('');
  const [collectionPickerQuery, setCollectionPickerQuery] = useState('');
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
      const [catalogue, nextCollections] = await Promise.all([
        api.studioListDeviantArtCatalogue(nextCreatorId),
        api.studioListDeviantArtCollections(nextCreatorId)
      ]);
      setAssets(((catalogue as { items?: StudioExternalAsset[] }).items || []));
      setCollections(nextCollections as CollectionResponse);
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
      if (!normalizedQuery) return true;
      return [asset.canonicalTitle || '', asset.canonicalDescription || '', ...asset.publications.flatMap((publication) => [publication.externalTitle || '', ...publication.externalTags])]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [assets, collectionId, manuallyAssignedAssetIds, mappedExternalCollectionIds, query]);
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

  return (
    <section className="studio-works-layout">
      <Card title="Works" eyebrow="Creator catalogue">
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
          <label className="studio-works-search">
            <span>Search works</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, description, or tag" />
          </label>
        </div>

        <p className="studio-works-context"><strong>{activeCreator?.name || 'Creator'}</strong>{selectedCollection ? ` · ${selectedCollection.name}` : ' · All works'}</p>
        {!selectedCollection && <p className="studio-works-space-note">Adding a work to a collection also queues a private Ubeeq Space backup when DeviantArt makes a source file available.</p>}
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
            return (
              <article className="studio-work-row" key={asset.assetId}>
                <label className="studio-work-select" aria-label={`Select ${asset.canonicalTitle || 'work'}`}>
                  <input type="checkbox" checked={selectedDisplayedAssetIds.includes(asset.assetId)} onChange={(event) => toggleWorkSelection(asset.assetId, event.target.checked)} />
                </label>
                <WorkThumbnail asset={asset} />
                <div className="studio-work-details">
                  <strong>{asset.canonicalTitle || asset.publications[0]?.externalTitle || 'Untitled work'}</strong>
                  <span>{assetTypeLabel(asset)} · {asset.publications.map((publication) => publication.externalUsername).filter(Boolean).join(', ') || 'Ubeeq'}</span>
                </div>
                <div className="studio-work-actions">
                  <span className="studio-collection-visibility">{asset.visibility}</span>
                  {asset.spacePublication?.published && <span className="studio-work-space-status">{asset.spacePublication.contentSyncStatus === 'hosted' ? 'Stored and available in your Ubeeq Space' : asset.spacePublication.contentSyncStatus === 'failed' ? 'Space backup needs attention' : 'Backing up to Ubeeq Space'}</span>}
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
                    to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}${collectionId ? `&collectionId=${encodeURIComponent(collectionId)}` : ''}&workId=${encodeURIComponent(asset.assetId)}`}
                  >
                    Edit metadata
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
