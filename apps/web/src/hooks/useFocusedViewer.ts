import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Grouping, GroupingAsset, TrendingImage } from '../domainTypes';

const toFocusedAsset = (item: TrendingImage): GroupingAsset => ({
  imageId: item.imageId,
  assetType: item.assetType === 'video' ? 'video' : 'image',
  effectiveContentRating: item.effectiveContentRating,
  displayedContentRating: item.displayedContentRating,
  blurred: item.blurred,
  effectiveAiDisclosure: item.effectiveAiDisclosure,
  displayedAiDisclosure: item.displayedAiDisclosure,
  effectiveHeavyTopics: item.effectiveHeavyTopics,
  displayedHeavyTopics: item.displayedHeavyTopics,
  previewUrl: item.previewUrl,
  previewPosterUrl: item.previewPosterUrl,
  favoriteCount: item.favoriteCount || 0
});

export default function useFocusedViewer() {
  const [focusedDiscoveryOpen, setFocusedDiscoveryOpen] = useState(false);
  const [focusedDiscoveryGroupingSlug, setFocusedDiscoveryGroupingSlug] = useState('');
  const [focusedDiscoveryGroupingTitle, setFocusedDiscoveryGroupingTitle] = useState('');
  const [focusedDiscoveryItems, setFocusedDiscoveryItems] = useState<GroupingAsset[]>([]);
  const [focusedDiscoveryIndex, setFocusedDiscoveryIndex] = useState(0);
  const [focusedDiscoveryLoading, setFocusedDiscoveryLoading] = useState(false);
  const [focusedDiscoveryError, setFocusedDiscoveryError] = useState('');
  const [focusedDiscoveryVideoMuted, setFocusedDiscoveryVideoMuted] = useState(true);
  const [focusedDiscoveryVideoVolume, setFocusedDiscoveryVideoVolume] = useState(1);

  const focusedDiscoveryRequestRef = useRef(0);
  const focusedDiscoveryVideoRef = useRef<HTMLVideoElement | null>(null);

  const focusedDiscoveryItem = focusedDiscoveryItems[focusedDiscoveryIndex] || null;
  const focusedDiscoveryHasPrevious = focusedDiscoveryIndex > 0;
  const focusedDiscoveryHasNext = focusedDiscoveryIndex >= 0 && focusedDiscoveryIndex < focusedDiscoveryItems.length - 1;

  const closeFocusedDiscovery = useCallback(() => {
    setFocusedDiscoveryOpen(false);
    setFocusedDiscoveryLoading(false);
    setFocusedDiscoveryError('');
    focusedDiscoveryRequestRef.current += 1;
  }, []);

  const openFocusedDiscovery = useCallback(async (item: TrendingImage) => {
    const fallback = toFocusedAsset(item);
    setFocusedDiscoveryOpen(true);
    setFocusedDiscoveryGroupingSlug(item.groupingSlug || '');
    setFocusedDiscoveryGroupingTitle(item.title || 'Artwork');
    setFocusedDiscoveryItems([fallback]);
    setFocusedDiscoveryIndex(0);
    setFocusedDiscoveryError('');
    if (!item.groupingSlug) {
      setFocusedDiscoveryLoading(false);
      return;
    }
    const requestId = focusedDiscoveryRequestRef.current + 1;
    focusedDiscoveryRequestRef.current = requestId;
    setFocusedDiscoveryLoading(true);
    try {
      const response = await api.getGrouping(item.groupingSlug) as Grouping;
      if (focusedDiscoveryRequestRef.current !== requestId) return;
      const media = (response.media || []).filter((asset) => Boolean(asset.previewUrl));
      const nextItems = media.length > 0 ? media : [fallback];
      const focusedIndex = Math.max(0, nextItems.findIndex((asset) => asset.imageId === item.imageId));
      setFocusedDiscoveryGroupingTitle(response.title || item.title || 'Artwork');
      setFocusedDiscoveryItems(nextItems);
      setFocusedDiscoveryIndex(focusedIndex);
      setFocusedDiscoveryError('');
    } catch (e) {
      if (focusedDiscoveryRequestRef.current !== requestId) return;
      setFocusedDiscoveryError((e as Error).message || 'Could not load grouping media');
    } finally {
      if (focusedDiscoveryRequestRef.current === requestId) {
        setFocusedDiscoveryLoading(false);
      }
    }
  }, []);

  const goPrevious = useCallback(() => {
    setFocusedDiscoveryIndex((index) => Math.max(0, index - 1));
  }, []);

  const goNext = useCallback(() => {
    setFocusedDiscoveryIndex((index) => Math.min(focusedDiscoveryItems.length - 1, index + 1));
  }, [focusedDiscoveryItems.length]);

  const onVideoVolumeChange = useCallback((video: HTMLVideoElement) => {
    setFocusedDiscoveryVideoMuted(video.muted);
    setFocusedDiscoveryVideoVolume(Math.max(0, Math.min(1, video.volume)));
  }, []);

  useEffect(() => {
    const video = focusedDiscoveryVideoRef.current;
    if (!video || focusedDiscoveryItem?.assetType !== 'video') return;
    const clampedVolume = Math.max(0, Math.min(1, focusedDiscoveryVideoVolume));
    if (Math.abs(video.volume - clampedVolume) > 0.001) {
      video.volume = clampedVolume;
    }
    if (video.muted !== focusedDiscoveryVideoMuted) {
      video.muted = focusedDiscoveryVideoMuted;
    }
  }, [focusedDiscoveryItem?.assetType, focusedDiscoveryItem?.imageId, focusedDiscoveryVideoMuted, focusedDiscoveryVideoVolume]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const video = focusedDiscoveryVideoRef.current;
    if (!focusedDiscoveryOpen || !video || focusedDiscoveryItem?.assetType !== 'video') return undefined;
    let disposed = false;
    const safePlay = () => {
      if (disposed) return;
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => undefined);
      }
    };
    const observer = new window.IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
          safePlay();
        } else if (!video.paused) {
          video.pause();
        }
      },
      { threshold: [0.2, 0.6, 0.9] }
    );
    observer.observe(video);
    safePlay();
    return () => {
      disposed = true;
      observer.disconnect();
      if (!video.paused) {
        video.pause();
      }
    };
  }, [focusedDiscoveryOpen, focusedDiscoveryItem?.assetType, focusedDiscoveryItem?.imageId]);

  useEffect(() => {
    if (!focusedDiscoveryOpen || typeof window === 'undefined') return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeFocusedDiscovery();
        return;
      }
      if (event.key === 'ArrowLeft' && focusedDiscoveryHasPrevious) {
        goPrevious();
      }
      if (event.key === 'ArrowRight' && focusedDiscoveryHasNext) {
        goNext();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [
    closeFocusedDiscovery,
    focusedDiscoveryOpen,
    focusedDiscoveryHasPrevious,
    focusedDiscoveryHasNext,
    goNext,
    goPrevious
  ]);

  return {
    focusedDiscoveryOpen,
    focusedDiscoveryGroupingSlug,
    focusedDiscoveryGroupingTitle,
    focusedDiscoveryItems,
    focusedDiscoveryIndex,
    focusedDiscoveryLoading,
    focusedDiscoveryError,
    focusedDiscoveryVideoMuted,
    focusedDiscoveryItem,
    focusedDiscoveryHasPrevious,
    focusedDiscoveryHasNext,
    focusedDiscoveryVideoRef,
    openFocusedDiscovery,
    closeFocusedDiscovery,
    goPrevious,
    goNext,
    onVideoVolumeChange
  };
}
