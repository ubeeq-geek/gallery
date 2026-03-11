import type { ContentRating, Media } from './domain';

export const CONTENT_RATING_LEVEL: Record<ContentRating, number> = {
  general: 0,
  suggestive: 1,
  mature: 2,
  sexual: 3,
  fetish: 4,
  graphic: 5
};

const CONTENT_RATING_LABEL: Record<ContentRating, string> = {
  general: 'General',
  suggestive: 'Suggestive',
  mature: 'Mature',
  sexual: 'Sexual',
  fetish: 'Fetish',
  graphic: 'Graphic'
};

const DEFAULT_CONTENT_RATING: ContentRating = 'general';

export interface ViewerContentPolicy {
  loggedIn: boolean;
  matureEnabled: boolean;
}

export const normalizeContentRating = (value: unknown): ContentRating => {
  if (typeof value !== 'string') return DEFAULT_CONTENT_RATING;
  const normalized = value.trim().toLowerCase();
  return (normalized in CONTENT_RATING_LEVEL)
    ? normalized as ContentRating
    : DEFAULT_CONTENT_RATING;
};

export const getEffectiveContentRating = (
  value: Pick<Media, 'contentRating' | 'moderatorContentRating'>
): ContentRating => {
  const artistRating = normalizeContentRating(value.contentRating);
  const moderatorRating = value.moderatorContentRating
    ? normalizeContentRating(value.moderatorContentRating)
    : undefined;
  if (!moderatorRating) return artistRating;
  return CONTENT_RATING_LEVEL[moderatorRating] > CONTENT_RATING_LEVEL[artistRating]
    ? moderatorRating
    : artistRating;
};

export const shouldBlurContent = (rating: ContentRating, viewer: ViewerContentPolicy): boolean => {
  if (!viewer.loggedIn) {
    return rating !== 'general';
  }
  if (!viewer.matureEnabled) {
    return CONTENT_RATING_LEVEL[rating] >= CONTENT_RATING_LEVEL.mature;
  }
  return false;
};

export const isRatingAllowed = (rating: ContentRating, maxAllowedRating: ContentRating): boolean => (
  CONTENT_RATING_LEVEL[rating] <= CONTENT_RATING_LEVEL[maxAllowedRating]
);

export const getDisplayedRating = (rating: ContentRating, viewer: ViewerContentPolicy): string => {
  if (!viewer.loggedIn) return rating === 'general' ? CONTENT_RATING_LABEL.general : 'Mature Content';
  if (!viewer.matureEnabled && CONTENT_RATING_LEVEL[rating] >= CONTENT_RATING_LEVEL.mature) {
    return 'Mature Content';
  }
  return CONTENT_RATING_LABEL[rating];
};

export const getPublicFacingRating = (rating: ContentRating, viewer: ViewerContentPolicy): ContentRating => {
  if (!viewer.loggedIn && rating !== 'general') return 'mature';
  if (!viewer.matureEnabled && CONTENT_RATING_LEVEL[rating] >= CONTENT_RATING_LEVEL.mature) return 'mature';
  return rating;
};
