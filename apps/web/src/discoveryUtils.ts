import type { AiDisclosure, AiFilterPreference, ContentRating, HeavyTopic } from './domainTypes';

export const contentRatingOptions: Array<{ value: ContentRating; label: string }> = [
  { value: 'general', label: 'General' },
  { value: 'suggestive', label: 'Suggestive' },
  { value: 'mature', label: 'Mature' },
  { value: 'sexual', label: 'Sexual' },
  { value: 'fetish', label: 'Fetish' },
  { value: 'graphic', label: 'Graphic' }
];

export const aiFilterOptions: Array<{ value: AiFilterPreference; label: string }> = [
  { value: 'show-all', label: 'Show all content' },
  { value: 'hide-ai-generated', label: 'Hide AI-generated content' },
  { value: 'hide-all-ai', label: 'Hide AI-generated and AI-assisted content' }
];

export const heavyTopicLabels: Record<HeavyTopic, string> = {
  'politics-public-affairs': 'Politics & Public Affairs',
  'crime-disasters-tragedy': 'Crime, Disasters & Tragedy'
};

export const formatDisclosureLine = (item: {
  displayedAiDisclosure?: string;
  displayedHeavyTopics?: string[];
}) => {
  const parts: string[] = [];
  if (item.displayedAiDisclosure && item.displayedAiDisclosure !== 'No AI') {
    parts.push(item.displayedAiDisclosure);
  }
  for (const topic of item.displayedHeavyTopics || []) {
    if (topic) parts.push(topic);
  }
  return parts.join(' • ');
};

export const passesAiDisclosureFilter = (aiDisclosure: AiDisclosure | undefined, aiFilter: AiFilterPreference): boolean => {
  const normalized = aiDisclosure || 'none';
  if (aiFilter === 'hide-ai-generated') return normalized !== 'ai-generated';
  if (aiFilter === 'hide-all-ai') return normalized === 'none';
  return true;
};

export const passesHeavyTopicFilter = (
  topics: string[] | undefined,
  options: {
    hideHeavyTopics: boolean;
    hidePoliticsPublicAffairs: boolean;
    hideCrimeDisastersTragedy: boolean;
  }
): boolean => {
  const normalized = topics || [];
  if (options.hideHeavyTopics) {
    return !normalized.includes('politics-public-affairs') && !normalized.includes('crime-disasters-tragedy');
  }
  if (options.hidePoliticsPublicAffairs && normalized.includes('politics-public-affairs')) return false;
  if (options.hideCrimeDisastersTragedy && normalized.includes('crime-disasters-tragedy')) return false;
  return true;
};

export const matchesDiscoverySearch = (needle: string, fields: Array<string | undefined>): boolean => {
  const trimmed = needle.trim().toLowerCase();
  if (!trimmed) return true;
  return fields
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(trimmed);
};

export const isLikelyImageUrl = (url?: string): boolean => {
  if (!url) return false;
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)(\?|#|$)/i.test(url);
};
