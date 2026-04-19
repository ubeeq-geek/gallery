import type { AppConfig } from './config';
import type { AiDisclosure, Creator, Grouping, GroupingMediaView, HeavyTopic, TrendingFeedItem, TrendingPeriod } from './domain';
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
  surfaceKey: string;
  surfaceType: 'media_surface' | 'post_surface';
  postId?: string;
  imageId: string;
  assetType: 'image' | 'video';
  creatorId: string;
  creatorName: string;
  groupingId: string;
  groupingSlug: string;
  groupingVisibility: 'free' | 'preview';
  discoverSquareCropEnabled: boolean;
  effectiveContentRating: TrendingFeedItem['effectiveContentRating'];
  effectiveAiDisclosure: AiDisclosure;
  effectiveHeavyTopics: HeavyTopic[];
  title: string;
  previewKey: string;
  previewPosterKey?: string;
  width: number;
  height: number;
  aspectRatio: number;
  createdAt: string;
  createdAtMs: number;
  recencyBoost: number;
}

const resolveTrendingPreviewKeys = (
  item: Pick<GroupingMediaView, 'assetType' | 'thumbnailKeys' | 'previewPosterKey' | 'previewKey'>
): { previewKey?: string; previewPosterKey?: string } => {
  const assetType = (item.assetType || 'image') === 'video' ? 'video' : 'image';
  if (assetType === 'video') {
    return {
      previewKey: item.previewKey,
      previewPosterKey: item.previewPosterKey || item.thumbnailKeys?.w640 || item.thumbnailKeys?.w320
    };
  }
  return {
    previewKey: item.thumbnailKeys?.w640 || item.thumbnailKeys?.w320 || item.previewKey,
    previewPosterKey: undefined
  };
};

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
  T extends { surfaceKey: string; creatorId: string; groupingId: string; score: number }
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
    const list = buckets.get(item.creatorId) || [];
    list.push(item);
    buckets.set(item.creatorId, list);
  }
  if (buckets.size <= 2) return items;

  const orderedCreators = Array.from(buckets.keys()).sort((a, b) => {
    const aTop = buckets.get(a)?.[0]?.score || 0;
    const bTop = buckets.get(b)?.[0]?.score || 0;
    return bTop - aTop;
  });
  const offset = Math.floor(hashToUnit(`${period}:${seed}:head-variety-order`) * orderedCreators.length);
  const creatorOrder = rotateArray(orderedCreators, offset);

  const rebalancedHead: T[] = [];
  while (rebalancedHead.length < targetHeadSize) {
    let progressed = false;
    for (const creatorId of creatorOrder) {
      const bucket = buckets.get(creatorId);
      if (!bucket || bucket.length === 0) continue;
      const previous = rebalancedHead[rebalancedHead.length - 1];
      let pickIndex = -1;
      if (previous) {
        pickIndex = bucket.findIndex((candidate) => candidate.groupingId !== previous.groupingId);
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

  const used = new Set(rebalancedHead.map((item) => item.surfaceKey));
  const remainingPool = pool.filter((item) => !used.has(item.surfaceKey));
  const tail = items.slice(effectivePoolSize);
  return [...rebalancedHead, ...remainingPool, ...tail];
};

const buildCandidates = async (
  store: DataStore,
  activeCreators: Creator[],
  period: TrendingPeriod,
  nowMs: number
): Promise<{ candidates: CandidateItem[]; groupingCount: number }> => {
  const periodMs = period === 'hourly' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const activeCreatorIds = new Set(activeCreators.map((creator) => creator.creatorId));
  const creatorById = new Map(activeCreators.map((creator) => [creator.creatorId, creator]));

  const groupings = (await store.listAllGroupings()).filter((grouping) => {
    if (grouping.status !== 'published') return false;
    if (grouping.visibility === 'premium') return false;
    if (!activeCreatorIds.has(grouping.creatorId)) return false;
    if (isHiddenByVisibility(grouping.releaseVisibility)) return false;
    // Public trending feed is public-only, no follower-specific window.
    return canViewBySchedule(grouping.publishAt, grouping.publicReleaseAt, nowMs, false);
  });

  const mediaRows = await Promise.all(groupings.map(async (grouping) => ({ grouping, media: await store.getMediaByGrouping(grouping.groupingId) })));
  const groupingById = new Map(groupings.map((grouping) => [grouping.groupingId, grouping]));
  const candidates: CandidateItem[] = [];

  for (const { grouping, media } of mediaRows) {
    for (const item of media) {
      const assetType = (item.assetType || 'image');
      const normalizedAssetType = assetType === 'video' ? 'video' : assetType === 'image' ? 'image' : null;
      if (!normalizedAssetType) continue;
      if (isHiddenByVisibility(item.releaseVisibility)) continue;
      if (item.status && item.status !== 'published' && item.status !== 'scheduled') continue;
      if (!canViewBySchedule(item.publishAt || grouping.publishAt, item.publicReleaseAt || grouping.publicReleaseAt, nowMs, false)) {
        continue;
      }
      const { previewKey, previewPosterKey } = resolveTrendingPreviewKeys(item);
      if (!previewKey) continue;
      const createdAtMs = asTime(item.createdAt) || nowMs;
      const discoverSquareCropEnabled =
        (creatorById.get(item.creatorId)?.discoverSquareCropEnabled ?? true) &&
        (grouping.discoverSquareCropEnabled ?? true) &&
        (item.discoverSquareCropEnabled ?? true);
      const creatorProfile = creatorById.get(item.creatorId);
      candidates.push({
        surfaceKey: `media:${item.mediaId}`,
        surfaceType: 'media_surface',
        imageId: item.mediaId,
        assetType: normalizedAssetType,
        creatorId: item.creatorId,
        creatorName: creatorProfile?.name || 'Creator',
        groupingId: grouping.groupingId,
        groupingSlug: grouping.slug,
        groupingVisibility: grouping.visibility === 'preview' ? 'preview' : 'free',
        discoverSquareCropEnabled,
        effectiveContentRating: getEffectiveContentRating(item),
        effectiveAiDisclosure: getEffectiveAiDisclosure(item, grouping, creatorProfile),
        effectiveHeavyTopics: getEffectiveHeavyTopics(item, grouping, creatorProfile),
        title: item.title || grouping.title || 'Artwork',
        previewKey,
        previewPosterKey,
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

  const perPostSurfaceLimit = 3;
  for (const creatorProfile of activeCreators) {
    const [posts, creatorMedia] = await Promise.all([
      store.listPostsByCreatorId(creatorProfile.creatorId),
      store.listMediaByCreator(creatorProfile.creatorId)
    ]);
    const mediaById = new Map(creatorMedia.map((item) => [item.mediaId, item]));
    const candidateMediaIds = Array.from(new Set(
      posts
        .filter((post) => post.status === 'published')
        .flatMap((post) => post.media.map((ref) => ref.mediaId))
    ));
    const placementRows = await Promise.all(candidateMediaIds.map(async (mediaId) => ({
      mediaId,
      rows: await store.listMediaGroupingPlacements(mediaId)
    })));
    const placementByMediaId = new Map<string, Array<{ groupingId: string; position: number }>>();
    for (const placement of placementRows) {
      placementByMediaId.set(
        placement.mediaId,
        placement.rows
          .filter((row) => groupingById.has(row.groupingId))
          .sort((a, b) => a.position - b.position)
          .map((row) => ({ groupingId: row.groupingId, position: row.position }))
      );
    }
    for (const post of posts) {
      if (post.status !== 'published') continue;
      const sortedRefs = [...post.media].sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));
      const primaryRef = post.primaryMediaId
        ? sortedRefs.find((ref) => ref.mediaId === post.primaryMediaId)
        : undefined;
      const selectedRefs = sortedRefs.filter((ref) => ref.discoverable !== false);
      const refs = post.discovery.mode === 'all'
        ? sortedRefs
        : (post.discovery.mode === 'selected'
          ? selectedRefs
          : (primaryRef ? [primaryRef] : selectedRefs.slice(0, 1)));
      const limitedRefs = refs.slice(0, perPostSurfaceLimit);
      for (let refIndex = 0; refIndex < limitedRefs.length; refIndex += 1) {
        const ref = limitedRefs[refIndex];
        const item = mediaById.get(ref.mediaId);
        if (!item) continue;
        if (isHiddenByVisibility(item.releaseVisibility)) continue;
        if (item.status && item.status !== 'published' && item.status !== 'scheduled') continue;
        const placements = placementByMediaId.get(item.mediaId) || [];
        const placedGrouping = placements
          .map((row) => groupingById.get(row.groupingId))
          .find((grouping): grouping is Grouping => Boolean(grouping));
        if (!placedGrouping) continue;
        if (!canViewBySchedule(item.publishAt || placedGrouping.publishAt, item.publicReleaseAt || placedGrouping.publicReleaseAt, nowMs, false)) {
          continue;
        }
        const normalizedAssetType = item.assetType === 'video' ? 'video' : item.assetType === 'image' ? 'image' : null;
        if (!normalizedAssetType) continue;
        const { previewKey, previewPosterKey } = resolveTrendingPreviewKeys(item);
        if (!previewKey) continue;
        const createdAtMs = asTime(item.createdAt) || nowMs;
        const discoverSquareCropEnabled =
          (creatorProfile.discoverSquareCropEnabled ?? true) &&
          (placedGrouping.discoverSquareCropEnabled ?? true) &&
          (item.discoverSquareCropEnabled ?? true);
        candidates.push({
          surfaceKey: `post:${post.postId}:${item.mediaId}:${refIndex}`,
          surfaceType: 'post_surface',
          postId: post.postId,
          imageId: item.mediaId,
          assetType: normalizedAssetType,
          creatorId: item.creatorId,
          creatorName: creatorProfile?.name || 'Creator',
          groupingId: placedGrouping.groupingId,
          groupingSlug: placedGrouping.slug,
          groupingVisibility: placedGrouping.visibility === 'preview' ? 'preview' : 'free',
          discoverSquareCropEnabled,
          effectiveContentRating: getEffectiveContentRating(item),
          effectiveAiDisclosure: getEffectiveAiDisclosure(item, placedGrouping, creatorProfile),
          effectiveHeavyTopics: getEffectiveHeavyTopics(item, placedGrouping, creatorProfile),
          title: item.title || post.title || placedGrouping.title || 'Artwork',
          previewKey,
          previewPosterKey,
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
  }

  return { candidates, groupingCount: groupings.length };
};

export const buildTrendingFeedForPeriod = async (
  store: DataStore,
  config: AppConfig,
  period: TrendingPeriod,
  nowMs = Date.now()
): Promise<{ items: TrendingFeedItem[]; metrics: { candidateCount: number; scoredCount: number; groupingCount: number } }> => {
  const activeCreators = (await store.listCreators()).filter((creator) => creator.status === 'active');
  const { candidates, groupingCount } = await buildCandidates(store, activeCreators, period, nowMs);
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
    const jitter = (hashToUnit(`${period}:${seed}:${item.surfaceKey}`) - 0.5) * 4.4;
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
  const creatorUsage = new Map<string, number>();
  const groupingUsage = new Map<string, number>();
  const recentArtists: string[] = [];
  const recentGroupings: string[] = [];
  const diversityArtistCount = Math.max(1, new Set(scored.map((item) => item.creatorId)).size);
  const diversityGroupingCount = Math.max(1, new Set(scored.map((item) => item.groupingId)).size);

  while (queue.length > 0 && diversified.length < maxFeedItems) {
    const lastArtistId = diversified.length > 0 ? diversified[diversified.length - 1].creatorId : undefined;
    const lastGroupingId = diversified.length > 0 ? diversified[diversified.length - 1].groupingId : undefined;
    const lookahead = Math.min(80, queue.length);
    const lookaheadItems = queue.slice(0, lookahead);
    const rankIndex = diversified.length;
    const earlyDiversity = rankIndex < 36;
    const creatorCap = Math.max(1, Math.ceil((rankIndex + 1) / Math.min(diversityArtistCount, 8)));
    const groupingCap = Math.max(1, Math.ceil((rankIndex + 1) / Math.min(diversityGroupingCount, 10)));
    const creators = new Set(
      lookaheadItems
        .filter((item) => (creatorUsage.get(item.creatorId) || 0) < creatorCap)
        .map((item) => item.creatorId)
    );
    const groupingsUnderCap = new Set(
      lookaheadItems
        .filter((item) => (groupingUsage.get(item.groupingId) || 0) < groupingCap)
        .map((item) => item.groupingId)
    );
    const recentArtistWindow = recentArtists.slice(0, 3);
    const recentGroupingWindow = recentGroupings.slice(0, 2);
    const hasAltArtistFromLast = Boolean(lastArtistId) && lookaheadItems.some((item) => item.creatorId !== lastArtistId);
    const hasAltGroupingFromLast = Boolean(lastGroupingId) && lookaheadItems.some((item) => item.groupingId !== lastGroupingId);
    const hasAltNonRecentArtist = lookaheadItems.some((item) => !recentArtistWindow.includes(item.creatorId));
    const hasAltNonRecentGrouping = lookaheadItems.some((item) => !recentGroupingWindow.includes(item.groupingId));

    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let pass = 0; pass < 5; pass += 1) {
      bestIndex = -1;
      bestScore = Number.NEGATIVE_INFINITY;

      for (let i = 0; i < lookahead; i += 1) {
        const candidate = queue[i];
        const creatorCount = creatorUsage.get(candidate.creatorId) || 0;
        const groupingCount = groupingUsage.get(candidate.groupingId) || 0;

        const blockByLastArtist = Boolean(lastArtistId && candidate.creatorId === lastArtistId && hasAltArtistFromLast);
        const blockByLastGrouping = Boolean(lastGroupingId && candidate.groupingId === lastGroupingId && hasAltGroupingFromLast);
        const blockByRecentArtist = recentArtistWindow.includes(candidate.creatorId) && hasAltNonRecentArtist;
        const blockByRecentGrouping = recentGroupingWindow.includes(candidate.groupingId) && hasAltNonRecentGrouping;
        const blockByArtistCap = Boolean(
          earlyDiversity
          && creators.size > 0
          && creatorCount >= creatorCap
          && !creators.has(candidate.creatorId)
        );
        const blockByGroupingCap = Boolean(
          earlyDiversity
          && groupingsUnderCap.size > 0
          && groupingCount >= groupingCap
          && !groupingsUnderCap.has(candidate.groupingId)
        );

        const disqualified =
          (pass <= 3 && blockByLastArtist) ||
          (pass <= 2 && blockByLastGrouping) ||
          (pass <= 1 && blockByRecentArtist) ||
          (pass === 0 && blockByRecentGrouping) ||
          (pass <= 1 && blockByArtistCap) ||
          (pass === 0 && blockByGroupingCap);
        if (disqualified) continue;

        let selectionScore = candidate.score;
        selectionScore -= creatorCount * 3.1;
        selectionScore -= groupingCount * 2.05;

        if (blockByLastArtist) selectionScore -= 8;
        if (blockByLastGrouping) selectionScore -= 6;
        if (blockByRecentArtist) selectionScore -= 4;
        if (blockByRecentGrouping) selectionScore -= 2.5;

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
    creatorUsage.set(picked.creatorId, (creatorUsage.get(picked.creatorId) || 0) + 1);
    groupingUsage.set(picked.groupingId, (groupingUsage.get(picked.groupingId) || 0) + 1);

    recentArtists.unshift(picked.creatorId);
    recentGroupings.unshift(picked.groupingId);
    if (recentArtists.length > 4) recentArtists.pop();
    if (recentGroupings.length > 3) recentGroupings.pop();
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
    surfaceType: item.surfaceType,
    assetType: item.assetType,
    postId: item.postId,
    creatorId: item.creatorId,
    creatorName: item.creatorName,
    groupingId: item.groupingId,
    groupingSlug: item.groupingSlug,
    groupingVisibility: item.groupingVisibility,
    discoverSquareCropEnabled: item.discoverSquareCropEnabled,
    effectiveContentRating: item.effectiveContentRating,
    effectiveAiDisclosure: item.effectiveAiDisclosure,
    effectiveHeavyTopics: item.effectiveHeavyTopics,
    title: item.title,
    previewKey: item.previewKey,
    previewPosterKey: item.previewPosterKey,
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
      groupingCount
    }
  };
};

export const refreshTrendingFeeds = async (
  store: DataStore,
  config: AppConfig,
  nowMs = Date.now()
): Promise<Record<TrendingPeriod, { written: number; candidateCount: number; scoredCount: number; groupingCount: number }>> => {
  const periods: TrendingPeriod[] = ['hourly', 'daily'];
  const result = {} as Record<TrendingPeriod, { written: number; candidateCount: number; scoredCount: number; groupingCount: number }>;
  for (const period of periods) {
    const built = await buildTrendingFeedForPeriod(store, config, period, nowMs);
    await store.replaceTrendingFeed(period, built.items);
    result[period] = {
      written: built.items.length,
      candidateCount: built.metrics.candidateCount,
      scoredCount: built.metrics.scoredCount,
      groupingCount: built.metrics.groupingCount
    };
  }
  return result;
};
