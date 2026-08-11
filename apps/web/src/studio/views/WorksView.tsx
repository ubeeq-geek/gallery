import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../../api';
import { Card } from '../components/Card';
import type {
  StudioCreator,
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

export function WorksView({ creators }: { creators: StudioCreator[] }) {
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
    if (requestedCollectionId && collections.ubeeqCollections.some((collection) => collection.ubeeqCollectionId === requestedCollectionId)) {
      setCollectionId(requestedCollectionId);
    } else if (collectionId && !collections.ubeeqCollections.some((collection) => collection.ubeeqCollectionId === collectionId)) {
      setCollectionId('');
    }
  }, [collectionId, collections.ubeeqCollections, requestedCollectionId]);

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

  const addAssetToCollection = async (targetCollectionId: string, assetId: string) => {
    if (!targetCollectionId || !creatorId) return;
    const assetIds = [...new Set([...(collections.collectionAssetIdsByCollection[targetCollectionId] || []), assetId])];
    setUpdatingAssetId(assetId);
    setError('');
    try {
      await api.studioReplaceIntegrationCollectionAssets(targetCollectionId, { creatorIdentityId: creatorId, assetIds });
      setCollections((current) => ({
        ...current,
        collectionAssetIdsByCollection: { ...current.collectionAssetIdsByCollection, [targetCollectionId]: assetIds }
      }));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to add this work to the collection.');
    } finally {
      setUpdatingAssetId('');
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
        {loading && <p className="small">Loading works…</p>}
        {error && <p className="error">{error}</p>}

        <div className="studio-works-list">
          {visibleAssets.map((asset) => {
            const manuallyAssigned = manuallyAssignedAssetIds.has(asset.assetId);
            return (
              <article className="studio-work-row" key={asset.assetId}>
                <div>
                  <strong>{asset.canonicalTitle || asset.publications[0]?.externalTitle || 'Untitled work'}</strong>
                  <span>{asset.assetType} · {asset.publications.map((publication) => publication.externalUsername).filter(Boolean).join(', ') || 'Ubeeq'}</span>
                </div>
                <div className="studio-work-actions">
                  <span className="studio-collection-visibility">{asset.visibility}</span>
                  {selectedCollection && manuallyAssigned && <span className="studio-work-membership">Added to this collection</span>}
                  {!selectedCollection && (
                    <select
                      aria-label={`Add ${asset.canonicalTitle || 'work'} to a collection`}
                      defaultValue=""
                      disabled={updatingAssetId === asset.assetId}
                      onChange={(event) => {
                        const targetCollectionId = event.target.value;
                        event.target.value = '';
                        if (targetCollectionId) void addAssetToCollection(targetCollectionId, asset.assetId);
                      }}
                    >
                      <option value="">Add to collection…</option>
                      {collections.ubeeqCollections.map((collection) => <option key={collection.ubeeqCollectionId} value={collection.ubeeqCollectionId}>{collection.name}</option>)}
                    </select>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        {!loading && !visibleAssets.length && <div className="studio-empty-state">No works match this creator, collection, and search filter.</div>}
      </Card>
    </section>
  );
}
