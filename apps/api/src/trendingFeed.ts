import type { AppConfig } from './config';
import type { Artist, Gallery, GalleryMediaView, TrendingFeedItem, TrendingPeriod } from './domain';
import type { DataStore } from './store';

const asTime = (value?: string): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const canViewBySchedule = (
  publishAt: string | undefined,
  publicReleaseAt: string | undefined,
  nowMs: number,
  isFollowerOrAdmin: boolean
): boolean => {
  const publishAtMs = asTime(publishAt);
  if (publishAtMs !== null && nowMs < publishAtMs) {
    return false;
  }
  const publicReleaseAtMs = asTime(publicReleaseAt);
  if (publicReleaseAtMs !== null && nowMs < publicReleaseAtMs && !isFollowerOrAdmin) {
    return false;
  }
  return true;
};

const isHiddenByVisibility = (visibility?: 'public' | 'hidden' | 'removed'): boolean => (
  visibility === 'hidden' || visibility === 'removed'
);

interface CandidateItem {
  imageId: string;
  artistId: string;
  artistName: string;
  galleryId: string;
  gallerySlug: string;
  galleryVisibility: 'free' | 'preview';
  discoverSquareCropEnabled: boolean;
  title: string;
  previewKey: string;
  createdAt: string;
  createdAtMs: number;
  recencyBoost: number;
}

const buildCandidates = async (
  store: DataStore,
  activeArtists: Artist[],
  period: TrendingPeriod,
  nowMs: number
): Promise<{ candidates: CandidateItem[]; galleryCount: number }> => {
  const periodMs = period === 'hourly' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const activeArtistIds = new Set(activeArtists.map((artist) => artist.artistId));
  const artistById = new Map(activeArtists.map((artist) => [artist.artistId, artist]));

  const galleries = (await store.listAllGalleries()).filter((gallery) => {
    if (gallery.status !== 'published') return false;
    if (gallery.visibility === 'premium') return false;
    if (!activeArtistIds.has(gallery.artistId)) return false;
    if (isHiddenByVisibility(gallery.releaseVisibility)) return false;
    // Public trending feed is public-only, no follower-specific window.
    return canViewBySchedule(gallery.publishAt, gallery.publicReleaseAt, nowMs, false);
  });

  const mediaRows = await Promise.all(galleries.map(async (gallery) => ({ gallery, media: await store.getMediaByGallery(gallery.galleryId) })));
  const candidates: CandidateItem[] = [];

  for (const { gallery, media } of mediaRows) {
    for (const item of media) {
      const assetType = (item.assetType || 'image');
      if (assetType !== 'image') continue;
      if (isHiddenByVisibility(item.releaseVisibility)) continue;
      if (item.status && item.status !== 'published' && item.status !== 'scheduled') continue;
      if (!canViewBySchedule(item.publishAt || gallery.publishAt, item.publicReleaseAt || gallery.publicReleaseAt, nowMs, false)) {
        continue;
      }
      const previewKey = item.thumbnailKeys?.w640 || item.thumbnailKeys?.w320 || item.previewPosterKey || item.previewKey;
      if (!previewKey) continue;
      const createdAtMs = asTime(item.createdAt) || nowMs;
      const discoverSquareCropEnabled =
        (artistById.get(item.artistId)?.discoverSquareCropEnabled ?? true) &&
        (gallery.discoverSquareCropEnabled ?? true) &&
        (item.discoverSquareCropEnabled ?? true);
      candidates.push({
        imageId: item.mediaId,
        artistId: item.artistId,
        artistName: artistById.get(item.artistId)?.name || 'Artist',
        galleryId: gallery.galleryId,
        gallerySlug: gallery.slug,
        galleryVisibility: gallery.visibility === 'preview' ? 'preview' : 'free',
        discoverSquareCropEnabled,
        title: item.title || gallery.title || 'Artwork',
        previewKey,
        createdAt: item.createdAt,
        createdAtMs,
        recencyBoost: Math.max(0, 1 - Math.min(1, (nowMs - createdAtMs) / periodMs))
      });
    }
  }

  return { candidates, galleryCount: galleries.length };
};

export const buildTrendingFeedForPeriod = async (
  store: DataStore,
  config: AppConfig,
  period: TrendingPeriod,
  nowMs = Date.now()
): Promise<{ items: TrendingFeedItem[]; metrics: { candidateCount: number; scoredCount: number; galleryCount: number } }> => {
  const activeArtists = (await store.listArtists()).filter((artist) => artist.status === 'active');
  const { candidates, galleryCount } = await buildCandidates(store, activeArtists, period, nowMs);
  const candidateLimit = Math.max(120, Math.min(5000, Number(config.trendingCandidateLimit || 1500)));
  const maxFeedItems = Math.max(60, Math.min(5000, Number(config.trendingFeedMaxItems || 600)));
  const sampled = [...candidates]
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, candidateLimit);

  const favoriteCounts = await store.getImageFavoriteCounts(sampled.map((item) => item.imageId));
  const scored = sampled.map((item) => {
    const favoriteCount = Math.max(0, Number(favoriteCounts[item.imageId] || 0));
    const discoverSquareCropBonus = item.discoverSquareCropEnabled ? 1.25 : 0;
    const score = favoriteCount * 2 + item.recencyBoost * 10 + discoverSquareCropBonus;
    return {
      ...item,
      favoriteCount,
      score
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.createdAtMs - a.createdAtMs;
  });

  const diversified: typeof scored = [];
  const queue = [...scored];
  while (queue.length > 0 && diversified.length < maxFeedItems) {
    const lastArtistId = diversified.length > 0 ? diversified[diversified.length - 1].artistId : undefined;
    const nextIndex = queue.findIndex((item) => item.artistId !== lastArtistId);
    diversified.push(queue.splice(nextIndex >= 0 ? nextIndex : 0, 1)[0]);
  }

  const updatedAt = new Date(nowMs).toISOString();
  const items: TrendingFeedItem[] = diversified.map((item, index) => ({
    period,
    rank: index + 1,
    imageId: item.imageId,
    artistId: item.artistId,
    artistName: item.artistName,
    galleryId: item.galleryId,
    gallerySlug: item.gallerySlug,
    galleryVisibility: item.galleryVisibility,
    discoverSquareCropEnabled: item.discoverSquareCropEnabled,
    title: item.title,
    previewKey: item.previewKey,
    favoriteCount: item.favoriteCount,
    createdAt: item.createdAt,
    score: item.score,
    updatedAt
  }));

  return {
    items,
    metrics: {
      candidateCount: candidates.length,
      scoredCount: sampled.length,
      galleryCount
    }
  };
};

export const refreshTrendingFeeds = async (
  store: DataStore,
  config: AppConfig,
  nowMs = Date.now()
): Promise<Record<TrendingPeriod, { written: number; candidateCount: number; scoredCount: number; galleryCount: number }>> => {
  const periods: TrendingPeriod[] = ['hourly', 'daily'];
  const result = {} as Record<TrendingPeriod, { written: number; candidateCount: number; scoredCount: number; galleryCount: number }>;
  for (const period of periods) {
    const built = await buildTrendingFeedForPeriod(store, config, period, nowMs);
    await store.replaceTrendingFeed(period, built.items);
    result[period] = {
      written: built.items.length,
      candidateCount: built.metrics.candidateCount,
      scoredCount: built.metrics.scoredCount,
      galleryCount: built.metrics.galleryCount
    };
  }
  return result;
};
