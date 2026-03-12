import type { AiDisclosure, AiFilterPreference, Artist, Gallery, HeavyTopic, Media, UserProfile } from './domain';

export const AI_DISCLOSURE_LEVEL: Record<AiDisclosure, number> = {
  none: 0,
  'ai-assisted': 1,
  'ai-generated': 2
};

export const AI_DISCLOSURE_LABEL: Record<AiDisclosure, string> = {
  none: 'No AI',
  'ai-assisted': 'AI-assisted',
  'ai-generated': 'AI-generated'
};

export const HEAVY_TOPIC_LABEL: Record<HeavyTopic, string> = {
  'politics-public-affairs': 'Politics & Public Affairs',
  'crime-disasters-tragedy': 'Crime, Disasters & Tragedy'
};

const HEAVY_TOPIC_SET = new Set<HeavyTopic>([
  'politics-public-affairs',
  'crime-disasters-tragedy'
]);

export interface ViewerDisclosurePolicy {
  aiFilter: AiFilterPreference;
  hideHeavyTopics: boolean;
  hidePoliticsPublicAffairs: boolean;
  hideCrimeDisastersTragedy: boolean;
}

export const DEFAULT_VIEWER_DISCLOSURE_POLICY: ViewerDisclosurePolicy = {
  aiFilter: 'show-all',
  hideHeavyTopics: false,
  hidePoliticsPublicAffairs: false,
  hideCrimeDisastersTragedy: false
};

export const normalizeAiDisclosure = (value: unknown): AiDisclosure => {
  if (typeof value !== 'string') return 'none';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'ai-assisted') return 'ai-assisted';
  if (normalized === 'ai-generated') return 'ai-generated';
  return 'none';
};

export const parseOptionalAiDisclosure = (value: unknown): AiDisclosure | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  return normalizeAiDisclosure(value);
};

export const normalizeHeavyTopics = (value: unknown): HeavyTopic[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<HeavyTopic>();
  const out: HeavyTopic[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().toLowerCase() as HeavyTopic;
    if (!HEAVY_TOPIC_SET.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

export const parseOptionalHeavyTopics = (value: unknown): HeavyTopic[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return [];
  return normalizeHeavyTopics(value);
};

export const normalizeAiFilterPreference = (value: unknown): AiFilterPreference => {
  if (typeof value !== 'string') return 'show-all';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'hide-ai-generated') return 'hide-ai-generated';
  if (normalized === 'hide-all-ai') return 'hide-all-ai';
  return 'show-all';
};

export const normalizeViewerDisclosurePolicy = (policy: Partial<ViewerDisclosurePolicy>): ViewerDisclosurePolicy => {
  const normalized: ViewerDisclosurePolicy = {
    aiFilter: normalizeAiFilterPreference(policy.aiFilter),
    hideHeavyTopics: Boolean(policy.hideHeavyTopics),
    hidePoliticsPublicAffairs: Boolean(policy.hidePoliticsPublicAffairs),
    hideCrimeDisastersTragedy: Boolean(policy.hideCrimeDisastersTragedy)
  };
  if (normalized.hideHeavyTopics) {
    normalized.hidePoliticsPublicAffairs = true;
    normalized.hideCrimeDisastersTragedy = true;
  }
  return normalized;
};

export const profileDisclosurePolicy = (profile?: UserProfile | null): ViewerDisclosurePolicy => (
  normalizeViewerDisclosurePolicy({
    aiFilter: profile?.aiFilter || 'show-all',
    hideHeavyTopics: Boolean(profile?.hideHeavyTopics),
    hidePoliticsPublicAffairs: Boolean(profile?.hidePoliticsPublicAffairs),
    hideCrimeDisastersTragedy: Boolean(profile?.hideCrimeDisastersTragedy)
  })
);

export const getEffectiveAiDisclosure = (
  media: Pick<Media, 'aiDisclosure' | 'moderatorAiDisclosure'>,
  gallery?: Pick<Gallery, 'defaultAiDisclosure'> | null,
  artist?: Pick<Artist, 'defaultAiDisclosure'> | null
): AiDisclosure => (
  parseOptionalAiDisclosure(media.moderatorAiDisclosure)
  ?? parseOptionalAiDisclosure(media.aiDisclosure)
  ?? parseOptionalAiDisclosure(gallery?.defaultAiDisclosure)
  ?? parseOptionalAiDisclosure(artist?.defaultAiDisclosure)
  ?? 'none'
);

export const getEffectiveHeavyTopics = (
  media: Pick<Media, 'heavyTopics' | 'moderatorHeavyTopics'>,
  gallery?: Pick<Gallery, 'defaultHeavyTopics'> | null,
  artist?: Pick<Artist, 'defaultHeavyTopics'> | null
): HeavyTopic[] => (
  parseOptionalHeavyTopics(media.moderatorHeavyTopics)
  ?? parseOptionalHeavyTopics(media.heavyTopics)
  ?? parseOptionalHeavyTopics(gallery?.defaultHeavyTopics)
  ?? parseOptionalHeavyTopics(artist?.defaultHeavyTopics)
  ?? []
);

export const passesAiFilter = (aiDisclosure: AiDisclosure, aiFilter: AiFilterPreference): boolean => {
  if (aiFilter === 'hide-ai-generated') return aiDisclosure !== 'ai-generated';
  if (aiFilter === 'hide-all-ai') return aiDisclosure === 'none';
  return true;
};

export const passesHeavyTopicFilter = (heavyTopics: HeavyTopic[], policy: ViewerDisclosurePolicy): boolean => {
  const normalized = normalizeViewerDisclosurePolicy(policy);
  if (normalized.hidePoliticsPublicAffairs && heavyTopics.includes('politics-public-affairs')) {
    return false;
  }
  if (normalized.hideCrimeDisastersTragedy && heavyTopics.includes('crime-disasters-tragedy')) {
    return false;
  }
  return true;
};

export const passesDisclosureFilter = (
  aiDisclosure: AiDisclosure,
  heavyTopics: HeavyTopic[],
  policy: ViewerDisclosurePolicy
): boolean => (
  passesAiFilter(aiDisclosure, policy.aiFilter) &&
  passesHeavyTopicFilter(heavyTopics, policy)
);

