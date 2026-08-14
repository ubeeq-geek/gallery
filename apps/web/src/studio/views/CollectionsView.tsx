import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../../api';
import { Card } from '../components/Card';
import type {
  StudioCreator,
  StudioExternalCollection,
  StudioExternalCollectionMapping,
  StudioUbeeqCollection
} from '../types';

type CollectionResponse = {
  ubeeqCollections: StudioUbeeqCollection[];
  externalCollections: StudioExternalCollection[];
  mappings: StudioExternalCollectionMapping[];
  collectionAssetIdsByCollection: Record<string, string[]>;
  collectionMembershipSummaryByCollection?: Record<string, { total: number; manual: number; synchronized: number }>;
};

export function CollectionsView({ creators }: { creators: StudioCreator[] }) {
  const location = useLocation();
  const requestedCreatorId = new URLSearchParams(location.search).get('creatorId') || '';
  const [creatorId, setCreatorId] = useState('');
  const [data, setData] = useState<CollectionResponse>({ ubeeqCollections: [], externalCollections: [], mappings: [], collectionAssetIdsByCollection: {} });
  const [collectionName, setCollectionName] = useState('');
  const [collectionType, setCollectionType] = useState<'collection' | 'gallery' | 'series'>('collection');
  const [typeFilter, setTypeFilter] = useState<'all' | 'collection' | 'gallery' | 'series'>('all');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updatingCollectionId, setUpdatingCollectionId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const activeCreator = useMemo(
    () => creators.find((creator) => creator.creatorId === creatorId),
    [creatorId, creators]
  );

  const collectionTypeFor = (collection: StudioUbeeqCollection): 'collection' | 'gallery' | 'series' => {
    if (collection.collectionType) return collection.collectionType;
    return data.mappings.some((mapping) => mapping.ubeeqCollectionId === collection.ubeeqCollectionId) ? 'gallery' : 'collection';
  };

  const visibleCollections = useMemo(
    () => data.ubeeqCollections.filter((collection) => typeFilter === 'all' || collectionTypeFor(collection) === typeFilter),
    [data.ubeeqCollections, data.mappings, typeFilter]
  );

  const load = async (nextCreatorId = creatorId) => {
    if (!nextCreatorId) return;
    setLoading(true);
    setError('');
    try {
      setData(await api.studioListDeviantArtCollections(nextCreatorId) as CollectionResponse);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load this creator’s Ubeeq galleries.');
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

  const createCollection = async () => {
    const name = collectionName.trim();
    if (!creatorId || !name) return;
    setSaving(true);
    setError('');
    try {
      await api.studioCreateIntegrationCollection({ creatorIdentityId: creatorId, name, collectionType });
      setCollectionName('');
      setMessage(`Created “${name}” for ${activeCreator?.name || 'this creator'}.`);
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create the Ubeeq gallery.');
    } finally {
      setSaving(false);
    }
  };

  const updateCollectionVisibility = async (collection: StudioUbeeqCollection, visibility: StudioUbeeqCollection['visibility']) => {
    setUpdatingCollectionId(collection.ubeeqCollectionId);
    setError('');
    try {
      await api.studioUpdateIntegrationCollection(collection.ubeeqCollectionId, { creatorIdentityId: creatorId, visibility });
      setMessage(`${collection.name} is now ${visibility}.`);
      await load();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to update gallery visibility.');
    } finally {
      setUpdatingCollectionId('');
    }
  };

  return (
    <section className="studio-collections-layout">
      <Card title="Ubeeq galleries" eyebrow="Creator collection structure">
        <div className="studio-collection-creator-bar">
          <label>
            <span>Viewing galleries for</span>
            <select value={creatorId} onChange={(event) => setCreatorId(event.target.value)}>
              {creators.map((creator) => <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>)}
            </select>
          </label>
          <p><strong>{activeCreator?.name || 'Choose a creator'}</strong><span>Creator identity</span></p>
        </div>

        <div className="studio-inline-form">
          <input value={collectionName} onChange={(event) => setCollectionName(event.target.value)} placeholder="New Ubeeq Gallery" />
          <select aria-label="New collection type" value={collectionType} onChange={(event) => setCollectionType(event.target.value as typeof collectionType)}>
            <option value="collection">Collection</option>
            <option value="gallery">Gallery</option>
            <option value="series">Series</option>
          </select>
          <button type="button" className="auth-primary-btn" disabled={!collectionName.trim() || saving} onClick={() => void createCollection()}>
            {saving ? 'Creating…' : `Create Ubeeq ${collectionType === 'series' ? 'Series' : collectionType === 'gallery' ? 'Gallery' : 'Collection'}`}
          </button>
        </div>

        <label className="studio-collection-filter">
          <span>Show</span>
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as typeof typeFilter)}>
            <option value="all">All Ubeeq Collections</option>
            <option value="gallery">Galleries</option>
            <option value="series">Series</option>
            <option value="collection">Other Collections</option>
          </select>
        </label>

        {loading && <p className="small">Loading Ubeeq galleries…</p>}
        {message && <p className="studio-integration-message">{message}</p>}
        {error && <p className="error">{error}</p>}

        <div className="studio-collection-list">
          {visibleCollections.map((collection) => {
            const linkedSources = data.mappings
              .filter((mapping) => mapping.ubeeqCollectionId === collection.ubeeqCollectionId)
              .map((mapping) => data.externalCollections.find((source) => source.externalCollectionId === mapping.externalCollectionId))
              .filter((source): source is StudioExternalCollection => Boolean(source));
            const membership = data.collectionMembershipSummaryByCollection?.[collection.ubeeqCollectionId];
            const totalWorkCount = membership?.total ?? (data.collectionAssetIdsByCollection[collection.ubeeqCollectionId] || []).length;
            return (
              <article className="studio-collection-row" key={collection.ubeeqCollectionId}>
                <div>
                  <strong>{collection.name}</strong>
                  <span>{linkedSources.length
                    ? `Mapped from DeviantArt: ${linkedSources.map((source) => source.name).join(', ')}`
                    : `Independent Ubeeq ${collectionTypeFor(collection)}`}{totalWorkCount ? ` · ${totalWorkCount} work${totalWorkCount === 1 ? '' : 's'}${membership?.synchronized ? ` (${membership.synchronized} synchronized, ${membership.manual} manual)` : ''}` : ''}</span>
                </div>
                <div className="studio-collection-actions">
                  <span className="studio-collection-type">{collectionTypeFor(collection)}</span>
                  <select
                    aria-label={`${collection.name} visibility`}
                    value={collection.visibility}
                    disabled={updatingCollectionId === collection.ubeeqCollectionId}
                    onChange={(event) => void updateCollectionVisibility(collection, event.target.value as StudioUbeeqCollection['visibility'])}
                  >
                    <option value="private">Private</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public</option>
                  </select>
                  <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creatorId)}&collectionId=${encodeURIComponent(collection.ubeeqCollectionId)}`}>
                    View works
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
        {!loading && !visibleCollections.length && (
          <div className="studio-empty-state">No Ubeeq Galleries exist for {activeCreator?.name || 'this creator'} yet. Create one here, or create one directly from a DeviantArt gallery in Integrations.</div>
        )}
      </Card>
    </section>
  );
}
