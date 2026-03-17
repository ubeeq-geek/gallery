import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { getCurrentUser } from '../cognitoAuth';
import type { CollectionSummary, ManagedArtist, ManagedFavorite } from '../domainTypes';
import AutoLoadSentinel from '../components/AutoLoadSentinel';

export default function CollectionsPage() {
  const [items, setItems] = useState<CollectionSummary[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [order, setOrder] = useState<'random' | 'latest' | 'popular'>('random');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dailySeed = new Date().toISOString().slice(0, 10);

  const loadMore = async (reset = false) => {
    try {
      setLoading(true);
      setError('');
      const response = await api.getCollections(reset ? undefined : cursor, 24, { order, seed: dailySeed }) as { items: CollectionSummary[]; nextCursor?: string };
      setItems((prev) => reset ? (response.items || []) : [...prev, ...(response.items || [])]);
      setCursor(response.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMore(true);
  }, [order, dailySeed]);

  return (
    <div className="layout">
      <div className="discovery-section-header">
        <h1>All Collections</h1>
        <div className="discovery-trending-filter">
          <button className={order === 'random' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setOrder('random')}>Random</button>
          <button className={order === 'popular' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setOrder('popular')}>Popular</button>
          <button className={order === 'latest' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setOrder('latest')}>Latest</button>
        </div>
      </div>
      <div className="discovery-latest-grid">
        {items.map((item) => (
          <Link key={item.collectionId} to={`/collections/${item.collectionId}`} className="discovery-latest-item no-underline">
            <div className="discovery-stack">
              <div className="discovery-stack-layer discovery-stack-layer-back"><div className="discovery-swatch" /></div>
              <div className="discovery-stack-layer discovery-stack-layer-mid"><div className="discovery-swatch" /></div>
              <div className="discovery-stack-layer discovery-stack-layer-front"><div className="discovery-swatch" /></div>
            </div>
            <div className="discovery-latest-meta">
              <div className="discovery-card-title">{item.title}</div>
              <div className="discovery-card-subtitle">{item.imageCount} images • {item.favoriteCount} favorites</div>
            </div>
          </Link>
        ))}
      </div>
      <AutoLoadSentinel enabled={Boolean(cursor)} loading={loading} onLoadMore={() => loadMore(false)} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function CollectionDetailPage() {
  const { collectionId = '' } = useParams();
  const currentUser = getCurrentUser();
  const [managedArtists, setManagedArtists] = useState<ManagedArtist[]>([]);
  const [favoriteIdentity, setFavoriteIdentity] = useState<string>('user');
  const [isFavorited, setIsFavorited] = useState(false);
  const [collection, setCollection] = useState<(CollectionSummary & { imageIds?: string[] }) | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        setError('');
        const result = await api.getCollection(collectionId) as CollectionSummary & { imageIds?: string[] };
        setCollection(result);
      } catch (e) {
        setError((e as Error).message);
      }
    };
    void load();
  }, [collectionId]);

  useEffect(() => {
    if (!currentUser) {
      setManagedArtists([]);
      setFavoriteIdentity('user');
      return;
    }
    const loadArtists = async () => {
      try {
        const artists = await api.getMyArtists() as ManagedArtist[];
        setManagedArtists(artists);
      } catch {
        setManagedArtists([]);
      }
    };
    void loadArtists();
  }, [currentUser?.username]);

  const favoriteAsProfile = favoriteIdentity.startsWith('artist:')
    ? { ownerProfileType: 'artist' as const, ownerProfileId: favoriteIdentity.slice('artist:'.length) }
    : { ownerProfileType: 'user' as const };

  useEffect(() => {
    const loadFavoriteState = async () => {
      if (!currentUser || !collection) {
        setIsFavorited(false);
        return;
      }
      try {
        const favorites = await api.myFavorites(favoriteAsProfile) as ManagedFavorite[];
        setIsFavorited((favorites || []).some((item) => item.targetType === 'collection' && item.targetId === collection.collectionId));
      } catch {
        setIsFavorited(false);
      }
    };
    void loadFavoriteState();
  }, [currentUser?.username, favoriteIdentity, collection?.collectionId]);

  const toggleCollectionFavorite = async () => {
    if (!collection) return;
    const wasFavorited = isFavorited;
    setIsFavorited(!wasFavorited);
    setCollection((prev) => prev ? { ...prev, favoriteCount: Math.max(0, prev.favoriteCount + (wasFavorited ? -1 : 1)) } : prev);
    try {
      if (wasFavorited) await api.unfavorite('collection', collection.collectionId, favoriteAsProfile);
      else await api.favorite('collection', collection.collectionId, 'public', favoriteAsProfile);
    } catch (e) {
      setIsFavorited(wasFavorited);
      setCollection((prev) => prev ? { ...prev, favoriteCount: Math.max(0, prev.favoriteCount + (wasFavorited ? 1 : -1)) } : prev);
      setError((e as Error).message);
    }
  };

  if (!collection) return <div className="layout">Loading...</div>;

  return (
    <div className="layout">
      <Link to="/collections">Back to collections</Link>
      <h1>{collection.title}</h1>
      <p>{collection.description || 'No description yet.'}</p>
      <p className="small">{collection.imageCount} images • {collection.favoriteCount} favorites</p>
      {currentUser && (
        <div className="inline-form">
          <label className="small">Favorite as</label>
          <select
            className="settings-select"
            value={favoriteIdentity}
            onChange={(e) => setFavoriteIdentity(e.target.value)}
          >
            <option value="user">User Profile</option>
            {managedArtists.map((artist) => (
              <option key={`favorite-${artist.artistId}`} value={`artist:${artist.artistId}`}>
                Artist: {artist.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <button
        onClick={() => void toggleCollectionFavorite()}
      >
        {isFavorited ? 'Unfavorite Collection' : 'Favorite Collection'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

