import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type {
  AiFilterPreference,
  Creator,
  CollectionSummary,
  GroupingSummary,
  ManagedCreator,
  ManagedFavorite,
  TrendingImage
} from '../domainTypes';

export type DiscoveryGrouping = GroupingSummary & {
  creatorName: string;
  creatorSlug: string;
  stackPreviewUrls?: string[];
};

type DiscoveryFilters = {
  aiFilter: AiFilterPreference;
  hideHeavyTopics: boolean;
  hidePoliticsPublicAffairs: boolean;
  hideCrimeDisastersTragedy: boolean;
};

type UseDiscoveryFeedArgs = {
  currentUser: { username?: string } | null | undefined;
  dailySeed: string;
  trendingPeriod: 'hourly' | 'daily';
  trendingReloadNonce: number;
  trendingBaseLimit: number;
  disclosureFilters: DiscoveryFilters;
  favoriteIdentity: string;
};

export default function useDiscoveryFeed({
  currentUser,
  dailySeed,
  trendingPeriod,
  trendingReloadNonce,
  trendingBaseLimit,
  disclosureFilters,
  favoriteIdentity
}: UseDiscoveryFeedArgs) {
  const [creators, setArtists] = useState<Creator[]>([]);
  const [groupings, setGroupings] = useState<DiscoveryGrouping[]>([]);
  const [trendingImages, setTrendingImages] = useState<TrendingImage[]>([]);
  const [trendingCursor, setTrendingCursor] = useState<string | undefined>(undefined);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [managedArtists, setManagedArtists] = useState<ManagedCreator[]>([]);
  const [followedArtistIds, setFollowedArtistIds] = useState<Set<string>>(new Set());
  const [favoriteImageIds, setFavoriteImageIds] = useState<Set<string>>(new Set());
  const [favoriteGroupingIds, setFavoriteGroupingIds] = useState<Set<string>>(new Set());
  const [loadingMoreTrending, setLoadingMoreTrending] = useState(false);
  const [loadingTrending, setLoadingTrending] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [loadingCollections, setLoadingCollections] = useState(false);
  const [deferredSectionsReady, setDeferredSectionsReady] = useState(false);
  const [error, setError] = useState('');

  const favoriteAsProfile = useMemo(() => (
    favoriteIdentity.startsWith('creator:')
      ? { ownerProfileType: 'creator' as const, ownerProfileId: favoriteIdentity.slice('creator:'.length) }
      : { ownerProfileType: 'user' as const }
  ), [favoriteIdentity]);

  useEffect(() => {
    const loadTrending = async () => {
      try {
        setLoadingTrending(true);
        const trendingData = await api.getTrendingImagesFiltered(
          trendingPeriod,
          undefined,
          trendingBaseLimit,
          disclosureFilters
        ) as { items: TrendingImage[]; nextCursor?: string };
        setTrendingImages(trendingData.items || []);
        setTrendingCursor(trendingData.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoadingTrending(false);
      }
    };
    void loadTrending();
  }, [
    trendingPeriod,
    trendingReloadNonce,
    trendingBaseLimit,
    disclosureFilters.aiFilter,
    disclosureFilters.hideHeavyTopics,
    disclosureFilters.hidePoliticsPublicAffairs,
    disclosureFilters.hideCrimeDisastersTragedy
  ]);

  useEffect(() => {
    if (deferredSectionsReady || loadingTrending) return;
    const schedule = (cb: () => void): number => {
      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        return window.requestIdleCallback(cb, { timeout: 1200 }) as unknown as number;
      }
      return window.setTimeout(cb, 0);
    };
    const cancel = (id: number) => {
      if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(id as unknown as any);
      } else {
        window.clearTimeout(id);
      }
    };
    const id = schedule(() => setDeferredSectionsReady(true));
    return () => cancel(id);
  }, [deferredSectionsReady, loadingTrending]);

  useEffect(() => {
    if (!deferredSectionsReady) return;
    const loadLatest = async () => {
      try {
        setLoadingLatest(true);
        const [creator, latestGroupings] = await Promise.all([
          api.getArtists() as Promise<Creator[]>,
          api.getLatestGroupings(12) as Promise<DiscoveryGrouping[]>
        ]);
        setArtists(creator);
        setGroupings(latestGroupings || []);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoadingLatest(false);
      }
    };
    void loadLatest();
  }, [deferredSectionsReady]);

  useEffect(() => {
    if (!deferredSectionsReady) return;
    const loadCollectionData = async () => {
      try {
        setLoadingCollections(true);
        const collectionData = await api.getCollections(undefined, 9, { order: 'popular', seed: dailySeed }) as { items: CollectionSummary[] };
        setCollections(collectionData.items || []);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoadingCollections(false);
      }
    };
    void loadCollectionData();
  }, [dailySeed, deferredSectionsReady]);

  useEffect(() => {
    if (!deferredSectionsReady) return;
    const loadUserContext = async () => {
      if (!currentUser) {
        setFollowedArtistIds(new Set());
        setManagedArtists([]);
        return;
      }
      try {
        const [follows, myArtists] = await Promise.all([
          api.myFollows() as Promise<Array<{ creatorId: string }>>,
          api.getMyCreators() as Promise<ManagedCreator[]>
        ]);
        setFollowedArtistIds(new Set((follows || []).map((item) => item.creatorId)));
        setManagedArtists(myArtists || []);
      } catch {
        setFollowedArtistIds(new Set());
        setManagedArtists([]);
      }
    };
    void loadUserContext();
  }, [currentUser?.username, deferredSectionsReady]);

  useEffect(() => {
    const loadFavorites = async () => {
      if (!deferredSectionsReady) return;
      if (!currentUser) {
        setFavoriteImageIds(new Set());
        setFavoriteGroupingIds(new Set());
        return;
      }
      try {
        const favorites = await api.myFavorites(favoriteAsProfile) as ManagedFavorite[];
        setFavoriteImageIds(new Set(favorites.filter((item) => item.targetType === 'image').map((item) => item.targetId)));
        setFavoriteGroupingIds(new Set(favorites.filter((item) => item.targetType === 'grouping').map((item) => item.targetId)));
      } catch {
        setFavoriteImageIds(new Set());
        setFavoriteGroupingIds(new Set());
      }
    };
    void loadFavorites();
  }, [currentUser?.username, favoriteAsProfile, deferredSectionsReady]);

  const loadMoreTrending = useCallback(async () => {
    if (!trendingCursor) return;
    try {
      setLoadingMoreTrending(true);
      const response = await api.getTrendingImagesFiltered(
        trendingPeriod,
        trendingCursor,
        trendingBaseLimit,
        disclosureFilters
      ) as { items: TrendingImage[]; nextCursor?: string };
      setTrendingImages((prev) => [...prev, ...(response.items || [])]);
      setTrendingCursor(response.nextCursor);
    } catch {
      // no-op
    } finally {
      setLoadingMoreTrending(false);
    }
  }, [trendingCursor, trendingPeriod, trendingBaseLimit, disclosureFilters]);

  const toggleFollow = useCallback(async (creator?: string) => {
    if (!creator) return;
    const isFollowing = followedArtistIds.has(creator);
    setFollowedArtistIds((prev) => {
      const next = new Set(prev);
      if (isFollowing) next.delete(creator);
      else next.add(creator);
      return next;
    });
    try {
      if (isFollowing) {
        await api.unfollowCreator(creator);
      } else {
        await api.followCreator(creator);
      }
    } catch {
      setFollowedArtistIds((prev) => {
        const next = new Set(prev);
        if (isFollowing) next.add(creator);
        else next.delete(creator);
        return next;
      });
    }
  }, [followedArtistIds]);

  const toggleImageFavorite = useCallback(async (imageId: string) => {
    const wasFavorited = favoriteImageIds.has(imageId);
    setFavoriteImageIds((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(imageId);
      else next.add(imageId);
      return next;
    });
    setTrendingImages((prev) => prev.map((item) => (
      item.imageId === imageId
        ? { ...item, favoriteCount: Math.max(0, (item.favoriteCount || 0) + (wasFavorited ? -1 : 1)) }
        : item
    )));
    try {
      if (wasFavorited) {
        await api.unfavorite('image', imageId, favoriteAsProfile);
      } else {
        await api.favorite('image', imageId, 'public', favoriteAsProfile);
      }
    } catch {
      setFavoriteImageIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(imageId);
        else next.delete(imageId);
        return next;
      });
      setTrendingImages((prev) => prev.map((item) => (
        item.imageId === imageId
          ? { ...item, favoriteCount: Math.max(0, (item.favoriteCount || 0) + (wasFavorited ? 1 : -1)) }
          : item
      )));
    }
  }, [favoriteImageIds, favoriteAsProfile]);

  const toggleGroupingFavorite = useCallback(async (groupingId: string) => {
    const wasFavorited = favoriteGroupingIds.has(groupingId);
    setFavoriteGroupingIds((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(groupingId);
      else next.add(groupingId);
      return next;
    });
    try {
      if (wasFavorited) {
        await api.unfavorite('grouping', groupingId, favoriteAsProfile);
      } else {
        await api.favorite('grouping', groupingId, 'public', favoriteAsProfile);
      }
    } catch {
      setFavoriteGroupingIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(groupingId);
        else next.delete(groupingId);
        return next;
      });
    }
  }, [favoriteGroupingIds, favoriteAsProfile]);

  return {
    creators,
    groupings,
    trendingImages,
    trendingCursor,
    collections,
    managedArtists,
    followedArtistIds,
    favoriteImageIds,
    favoriteGroupingIds,
    loadingMoreTrending,
    loadingTrending,
    loadingLatest,
    loadingCollections,
    deferredSectionsReady,
    error,
    setTrendingImages,
    setTrendingCursor,
    setLoadingMoreTrending,
    loadMoreTrending,
    toggleFollow,
    toggleImageFavorite,
    toggleGroupingFavorite
  };
}
