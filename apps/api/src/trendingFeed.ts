import type { AppConfig } from './config';
import type { AiDisclosure, Artist, Gallery, GalleryMediaView, HeavyTopic, TrendingFeedItem, TrendingPeriod } from './domain';
import type { DataStore } from './store';
import { getEffectiveContentRating } from './contentRating';
import { getEffectiveAiDisclosure, getEffectiveHeavyTopics } from './disclosures';

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
  effectiveContentRating: TrendingFeedItem['effectiveContentRating'];
  effectiveAiDisclosure: AiDisclosure;
  effectiveHeavyTopics: HeavyTopic[];
  title: string;
  previewKey: string;
  width: number;
  height: number;
  aspectRatio: number;
  createdAt: string;
  createdAtMs: number;
  recencyBoost: number;
}

const hashToUnit = (input: string): number => {
  // Deterministic, fast 32-bit hash -> [0,1)
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
};

const periodSeed = (period: TrendingPeriod, nowMs: number): string => {
  const iso = new Date(nowMs).toISOString();
  return period === 'hourly' ? iso.slice(0, 13) : iso.slice(0, 10);
};

const rotateArray = <T>(items: T[], offset: number): T[] => {
  if (items.length <= 1) return items;
  const normalized = ((offset % items.length) + items.length) % items.length;
  if (normalized === 0) return items;
  return [...items.slice(normalized), ...items.slice(0, normalized)];
};

const rebalanceHeadForVariety = <
  T extends { imageId: string; artistId: string; galleryId: string; score: number }
>(
  items: T[],
  period: TrendingPeriod,
  seed: string,
  headWindowSize: number,
  poolSize: number
): T[] => {
  if (items.length <= 2) return items;
  const effectivePoolSize = Math.min(items.length, Math.max(headWindowSize, poolSize));
  const pool = items.slice(0, effectivePoolSize);
  const targetHeadSize = Math.min(headWindowSize, pool.length);
  if (targetHeadSize <= 2) return items;

  const buckets = new Map<string, T[]>();
  for (const item of pool) {
    const list = buckets.get(item.artistId) || [];
    list.push(item);
    buckets.set(item.artistId, list);
  }
  if (buckets.size <= 2) return items;

  const orderedArtists = Array.from(buckets.keys()).sort((a, b) => {
    const aTop = buckets.get(a)?.[0]?.score || 0;
    const bTop = buckets.get(b)?.[0]?.score || 0;
    return bTop - aTop;
  });
  const offset = Math.floor(hashToUnit(`${period}:${seed}:head-variety-order`) * orderedArtists.length);
  const artistOrder = rotateArray(orderedArtists, offset);

  const rebalancedHead: T[] = [];
  while (rebalancedHead.length < targetHeadSize) {
    let progressed = false;
    for (const artistId of artistOrder) {
      const bucket = buckets.get(artistId);
      if (!bucket || bucket.length === 0) continue;
      const previous = rebalancedHead[rebalancedHead.length - 1];
      let pickIndex = -1;
      if (previous) {
        pickIndex = bucket.findIndex((candidate) => candidate.galleryId !== previous.galleryId);
      }
      if (pickIndex < 0) pickIndex = 0;
      const [picked] = bucket.splice(pickIndex, 1);
      if (!picked) continue;
      rebalancedHead.push(picked);
      progressed = true;
      if (rebalancedHead.length >= targetHeadSize) break;
    }
    if (!progressed) break;
  }

  const used = new Set(rebalancedHead.map((item) => item.imageId));
  const remainingPool = pool.filter((item) => !used.has(item.imageId));
  const tail = items.slice(effectivePoolSize);
  return [...rebalancedHead, ...remainingPool, ...tail];
};

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
      const artist = artistById.get(item.artistId);
      candidates.push({
        imageId: item.mediaId,
        artistId: item.artistId,
        artistName: artistById.get(item.artistId)?.name || 'Artist',
        galleryId: gallery.galleryId,
        gallerySlug: gallery.slug,
        galleryVisibility: gallery.visibility === 'preview' ? 'preview' : 'free',
        discoverSquareCropEnabled,
        effectiveContentRating: getEffectiveContentRating(item),
        effectiveAiDisclosure: getEffectiveAiDisclosure(item, gallery, artist),
        effectiveHeavyTopics: getEffectiveHeavyTopics(item, gallery, artist),
        title: item.title || gallery.title || 'Artwork',
        previewKey,
        width: Number.isFinite(item.width) && item.width > 0 ? Math.round(item.width) : 0,
        height: Number.isFinite(item.height) && item.height > 0 ? Math.round(item.height) : 0,
        aspectRatio: (
          Number.isFinite(item.width) && item.width > 0
          && Number.isFinite(item.height) && item.height > 0
        )
          ? Number((item.width / item.height).toFixed(5))
          : 1,
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

  const seed = periodSeed(period, nowMs);
  const favoriteCounts = await store.getImageFavoriteCounts(sampled.map((item) => item.imageId));
  const scored = sampled.map((item) => {
    const favoriteCount = Math.max(0, Number(favoriteCounts[item.imageId] || 0));
    const discoverSquareCropBonus = item.discoverSquareCropEnabled ? 1.25 : 0;
    const jitter = (hashToUnit(`${period}:${seed}:${item.imageId}`) - 0.5) * 4.4;
    const score = favoriteCount * 2 + item.recencyBoost * 7 + discoverSquareCropBonus + jitter;
    return {
      ...item,
      favoriteCount,
      score,
      jitter
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.createdAtMs - a.createdAtMs;
  });

  const diversified: Array<(typeof scored)[number] & { selectionScore: number }> = [];
  const queue = [...scored];
  const artistUsage = new Map<string, number>();
  const galleryUsage = new Map<string, number>();
  const recentArtists: string[] = [];
  const recentGalleries: string[] = [];
  const diversityArtistCount = Math.max(1, new Set(scored.map((item) => item.artistId)).size);
  const diversityGalleryCount = Math.max(1, new Set(scored.map((item) => item.galleryId)).size);

  while (queue.length > 0 && diversified.length < maxFeedItems) {
    const lastArtistId = diversified.length > 0 ? diversified[diversified.length - 1].artistId : undefined;
    const lastGalleryId = diversified.length > 0 ? diversified[diversified.length - 1].galleryId : undefined;
    const lookahead = Math.min(80, queue.length);
    const lookaheadItems = queue.slice(0, lookahead);
    const rankIndex = diversified.length;
    const earlyDiversity = rankIndex < 36;
    const artistCap = Math.max(1, Math.ceil((rankIndex + 1) / Math.min(diversityArtistCount, 8)));
    const galleryCap = Math.max(1, Math.ceil((rankIndex + 1) / Math.min(diversityGalleryCount, 10)));
    const artistsUnderCap = new Set(
      lookaheadItems
        .filter((item) => (artistUsage.get(item.artistId) || 0) < artistCap)
        .map((item) => item.artistId)
    );
    const galleriesUnderCap = new Set(
      lookaheadItems
        .filter((item) => (galleryUsage.get(item.galleryId) || 0) < galleryCap)
        .map((item) => item.galleryId)
    );
    const recentArtistWindow = recentArtists.slice(0, 3);
    const recentGalleryWindow = recentGalleries.slice(0, 2);
    const hasAltArtistFromLast = Boolean(lastArtistId) && lookaheadItems.some((item) => item.artistId !== lastArtistId);
    const hasAltGalleryFromLast = Boolean(lastGalleryId) && lookaheadItems.some((item) => item.galleryId !== lastGalleryId);
    const hasAltNonRecentArtist = lookaheadItems.some((item) => !recentArtistWindow.includes(item.artistId));
    const hasAltNonRecentGallery = lookaheadItems.some((item) => !recentGalleryWindow.includes(item.galleryId));

    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let pass = 0; pass < 5; pass += 1) {
      bestIndex = -1;
      bestScore = Number.NEGATIVE_INFINITY;

      for (let i = 0; i < lookahead; i += 1) {
        const candidate = queue[i];
        const artistCount = artistUsage.get(candidate.artistId) || 0;
        const galleryCount = galleryUsage.get(candidate.galleryId) || 0;

        const blockByLastArtist = Boolean(lastArtistId && candidate.artistId === lastArtistId && hasAltArtistFromLast);
        const blockByLastGallery = Boolean(lastGalleryId && candidate.galleryId === lastGalleryId && hasAltGalleryFromLast);
        const blockByRecentArtist = recentArtistWindow.includes(candidate.artistId) && hasAltNonRecentArtist;
        const blockByRecentGallery = recentGalleryWindow.includes(candidate.galleryId) && hasAltNonRecentGallery;
        const blockByArtistCap = Boolean(
          earlyDiversity
          && artistsUnderCap.size > 0
          && artistCount >= artistCap
          && !artistsUnderCap.has(candidate.artistId)
        );
        const blockByGalleryCap = Boolean(
          earlyDiversity
          && galleriesUnderCap.size > 0
          && galleryCount >= galleryCap
          && !galleriesUnderCap.has(candidate.galleryId)
        );

        const disqualified =
          (pass <= 3 && blockByLastArtist) ||
          (pass <= 2 && blockByLastGallery) ||
          (pass <= 1 && blockByRecentArtist) ||
          (pass === 0 && blockByRecentGallery) ||
          (pass <= 1 && blockByArtistCap) ||
          (pass === 0 && blockByGalleryCap);
        if (disqualified) continue;

        let selectionScore = candidate.score;
        selectionScore -= artistCount * 3.1;
        selectionScore -= galleryCount * 2.05;

        if (blockByLastArtist) selectionScore -= 8;
        if (blockByLastGallery) selectionScore -= 6;
        if (blockByRecentArtist) selectionScore -= 4;
        if (blockByRecentGallery) selectionScore -= 2.5;

        if (selectionScore > bestScore) {
          bestScore = selectionScore;
          bestIndex = i;
        }
      }

      if (bestIndex >= 0) {
        break;
      }
    }

    if (bestIndex < 0) {
      bestIndex = 0;
      bestScore = queue[0].score;
    }

    const [picked] = queue.splice(bestIndex, 1);
    diversified.push({
      ...picked,
      selectionScore: bestScore
    });
    artistUsage.set(picked.artistId, (artistUsage.get(picked.artistId) || 0) + 1);
    galleryUsage.set(picked.galleryId, (galleryUsage.get(picked.galleryId) || 0) + 1);

    recentArtists.unshift(picked.artistId);
    recentGalleries.unshift(picked.galleryId);
    if (recentArtists.length > 4) recentArtists.pop();
    if (recentGalleries.length > 3) recentGalleries.pop();
  }

  const rebalanced = rebalanceHeadForVariety(
    diversified,
    period,
    seed,
    Math.min(24, maxFeedItems),
    Math.min(80, maxFeedItems)
  );

  const updatedAt = new Date(nowMs).toISOString();
  const items: TrendingFeedItem[] = rebalanced.map((item, index) => ({
    period,
    rank: index + 1,
    imageId: item.imageId,
    artistId: item.artistId,
    artistName: item.artistName,
    galleryId: item.galleryId,
    gallerySlug: item.gallerySlug,
    galleryVisibility: item.galleryVisibility,
    discoverSquareCropEnabled: item.discoverSquareCropEnabled,
    effectiveContentRating: item.effectiveContentRating,
    effectiveAiDisclosure: item.effectiveAiDisclosure,
    effectiveHeavyTopics: item.effectiveHeavyTopics,
    title: item.title,
    previewKey: item.previewKey,
    width: item.width,
    height: item.height,
    aspectRatio: item.aspectRatio,
    favoriteCount: item.favoriteCount,
    createdAt: item.createdAt,
    score: item.selectionScore,
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
