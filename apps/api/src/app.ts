import express from 'express';
import cors from 'cors';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { AdminUpdateUserAttributesCommand, CognitoIdentityProviderClient, SignUpCommand } from '@aws-sdk/client-cognito-identity-provider';
import { getSignedUrl as getS3SignedUrl } from '@aws-sdk/s3-request-presigner';
import { getSignedUrl as getCloudFrontSignedUrl } from '@aws-sdk/cloudfront-signer';
import { createHash, createPublicKey, randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import jwt from 'jsonwebtoken';
import { createOptionalAuthMiddleware, requireAdmin, requireAuth, resolveRole } from './auth';
import { checkRateLimit } from './rateLimit';
import { issueRememberAccessToken, issueUnlockToken, verifyPassword, verifyUnlockToken } from './unlock';
import type { AppConfig } from './config';
import { brandForConfig } from './brand';
import { createStoreIntegrationPolicyGate, requireIntegrationOperation, type IntegrationOperation, type IntegrationPlatform, type IntegrationPolicyTarget } from './integrationStandard';
import { resolvePublicationReconciliation } from './integrationReconciliation';
import type { DataStore } from './store';
import { hashPassword } from './unlock';
import type {
  AiDisclosure,
  Creator,
  CreatorMember,
  ChallengePrize,
  ChallengeVote,
  ChallengeLaurelDefinition,
  ChallengeLaurelAward,
  Comment,
  ContentRating,
  ContextSubmission,
  ContributionContext,
  Grouping,
  HeavyTopic,
  Media,
  Collection,
  PlatformRole,
  Post,
  PostBlock,
  PostDiscoveryMode,
  SiteSettings,
  SourceFile,
  UserCapabilities,
  UserProfile,
  Asset as ExternalAsset,
  ExternalPublication,
  SpacePublication,
  ExternalAccount,
  ExternalPlatformCredential,
  ExternalCollectionMapping,
  ExternalEngagementCurrent,
  ExternalSyncJob,
  CommunityEventType,
  UbeeqCollection,
  UbeeqCollectionAsset
} from './domain';
import { contentAvailabilityForAssets } from './canonicalDomain';
import type { CanonicalAsset, CreatorCollection as CanonicalCollection, Publication, PublicationIntent, Work } from './canonicalDomain';
import {
  generateCreatorCoverRenditions,
  generateCreatorProfileRenditions,
  generateLocalCreatorCoverRenditions,
  generateLocalCreatorProfileRenditions,
  generateImageRenditions,
  type CoverCropInput,
  type FocalPointInput,
  type SquareCropInput
} from './renditions';
import { refreshTrendingFeeds } from './trendingFeed';
import {
  getDisplayedRating,
  getEffectiveContentRating,
  getPublicFacingRating,
  isRatingAllowed,
  normalizeContentRating,
  shouldBlurContent,
  type ViewerContentPolicy
} from './contentRating';
import {
  AI_DISCLOSURE_LABEL,
  DEFAULT_VIEWER_DISCLOSURE_POLICY,
  HEAVY_TOPIC_LABEL,
  getEffectiveAiDisclosure,
  getEffectiveHeavyTopics,
  normalizeAiDisclosure,
  normalizeAiFilterPreference,
  normalizeHeavyTopics,
  normalizeViewerDisclosurePolicy,
  parseOptionalAiDisclosure,
  parseOptionalHeavyTopics,
  passesDisclosureFilter,
  profileDisclosurePolicy,
  type ViewerDisclosurePolicy
} from './disclosures';
import { capabilitiesForRole, normalizePlatformRoleValue } from './roleHelpers';
import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import {
  createExternalPlatformProvider,
  ExternalProviderError,
  type ExternalJournalPublish,
  type ExternalLiteraturePublish,
  type ExternalStatusPublish
} from './externalPlatformProvider';
import { storeUbeeqWorkImage } from './externalContentStorage';
import { externalOAuthPkce, issueBlueskyOAuthState, issueDiscordOAuthState, issueExternalOAuthState, resolveExternalOAuthReturnUrl, verifyBlueskyOAuthState, verifyDiscordOAuthState, verifyExternalOAuthState } from './externalOAuth';
import { createExternalSyncQueue } from './externalSyncQueue';
import type { ExternalSyncQueue } from './externalSyncQueue';
import { dismissExternalActivity, replyToExternalComment } from './externalSyncWorker';
import { createCommunityDeliveryQueue } from './communityDeliveryQueue';
import type { CommunityDeliveryQueue } from './communityDeliveryQueue';
import { createDiscordAuthorizeUrl, discordConfigured, exchangeDiscordCode, getDiscordGuild, listDiscordChannels, sendDiscordMessage, queueDiscordWorkPublished, queueDiscordWorksPublished } from './discordCommunity';
import { createFanvueRouter } from './fanvueRouter';
import type { FanvueRepository } from './fanvueRepository';
import { registerTumblrRoutes } from './tumblrRoutes';
import { InMemoryTumblrRepository, type TumblrRepository } from './tumblrRepository';
import { createTumblrPublishQueue, type TumblrPublishQueue } from './tumblrPublishQueue';
import { createSupportRouter } from './supportRoutes';
import { SupportSafetyService } from './supportSafety';
import type { SupportSafetyRepository } from './supportSafetyRepository';

interface CreateAppOptions {
  config: AppConfig;
  store: DataStore;
  externalSyncQueue?: ExternalSyncQueue;
  communityDeliveryQueue?: CommunityDeliveryQueue;
  fanvueRepository?: FanvueRepository;
  tumblrRepository?: TumblrRepository;
  tumblrPublishQueue?: TumblrPublishQueue;
  supportSafetyRepository?: SupportSafetyRepository;
}

let hasHandledInvocation = false;

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'item';

/**
 * `brand-name-1.png` -> `Brand Name #1`; `brand-name-1-v1.png` ->
 * `Brand Name #1, v1`. This is intentionally deterministic and is used for
 * new local Works, while a creator can always edit the resulting title.
 */
const titleFromFilename = (filename: string): string => {
  const stem = filename.replace(/\.[^.]+$/, '').trim();
  const tokens = stem.split(/[-_\s]+/).filter(Boolean);
  let version: string | undefined;
  let number: string | undefined;
  if (tokens.length && /^v\d+$/i.test(tokens.at(-1)!)) version = `v${tokens.pop()!.slice(1)}`;
  if (tokens.length && /^\d+$/.test(tokens.at(-1)!)) number = tokens.pop()!;
  const base = tokens
    .flatMap((token) => token.replace(/([a-z])([A-Z])/g, '$1 $2').split(' '))
    .filter(Boolean)
    .map((token) => /^\d+$/.test(token) ? token : `${token.slice(0, 1).toUpperCase()}${token.slice(1).toLowerCase()}`)
    .join(' ');
  return [base || 'Untitled work', number ? `#${number}` : '', version ? `, ${version}` : '']
    .join(' ')
    .replace(/\s+,/g, ',')
    .trim();
};

const defaultDeviantArtPreset = () => ({
  titleFormat: 'filename_title_case' as const,
  defaultTags: [] as string[],
  galleryExternalCollectionIds: [] as string[],
  targetStatus: 'published' as const,
  displayResolution: undefined as number | undefined,
  allowFreeDownload: false,
  addWatermark: false,
  isMature: false,
  matureLevel: 'moderate' as const,
  matureClassification: [] as Array<'nudity' | 'sexual' | 'gore' | 'language' | 'ideology'>,
  isAiGenerated: false,
  noAi: false,
  sourceFileMode: 'original' as const
});

/** The complete enum accepted by DeviantArt's Sta.sh publish endpoint. */
const deviantArtDisplayResolutions = new Set([400, 600, 800, 900, 1024, 1280, 1600, 1920]);
const deviantArtMatureClassifications = new Set(['nudity', 'sexual', 'gore', 'language', 'ideology']);

const parseDeviantArtPreset = (value: unknown) => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const tags = Array.isArray(source.defaultTags)
    ? [...new Set(source.defaultTags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim().replace(/\s+/g, '_').slice(0, 64)).filter(Boolean))].slice(0, 30)
    : [];
  const galleryExternalCollectionIds = Array.isArray(source.galleryExternalCollectionIds)
    ? [...new Set(source.galleryExternalCollectionIds.filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean))]
    : [];
  const displayResolution = typeof source.displayResolution === 'number' && deviantArtDisplayResolutions.has(source.displayResolution)
    ? source.displayResolution
    : undefined;
  const isMature = source.isMature === true;
  const matureClassification = Array.isArray(source.matureClassification)
    ? [...new Set(source.matureClassification.filter((value): value is 'nudity' | 'sexual' | 'gore' | 'language' | 'ideology' => typeof value === 'string' && deviantArtMatureClassifications.has(value)))]
    : [];
  return {
    titleFormat: 'filename_title_case' as const,
    defaultTags: tags,
    galleryExternalCollectionIds,
    targetStatus: source.targetStatus === 'draft' ? 'draft' as const : 'published' as const,
    ...(displayResolution ? { displayResolution } : {}),
    allowFreeDownload: source.allowFreeDownload === true,
    addWatermark: displayResolution ? source.addWatermark === true : false,
    isMature,
    matureLevel: source.matureLevel === 'strict' ? 'strict' as const : 'moderate' as const,
    matureClassification: isMature ? matureClassification : [],
    isAiGenerated: source.isAiGenerated === true,
    noAi: source.noAi === true,
    sourceFileMode: 'original' as const
  };
};

const uniqueSlugs = (slugs: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const slug of slugs) {
    if (!slug) continue;
    const normalized = slugify(slug);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

const creatorMatchesSlug = (creator: Creator, slug: string): boolean => {
  const normalized = slugify(slug);
  if (!normalized) return false;
  if (creator.slug === normalized) return true;
  return (creator.slugHistory || []).some((item) => slugify(item) === normalized);
};

// Display names are public identity labels, not merely decorative metadata.
// Normalizing whitespace and case prevents visually identical identities such
// as “Rex Studio” and “rex   studio” from co-existing.
const normalizeIdentityName = (value: string): string => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

const creatorMatchesName = (creator: Creator, name: string): boolean => (
  normalizeIdentityName(creator.name) === normalizeIdentityName(name)
);

const buildCreatorSlugSuggestions = (creators: Creator[], input: string, excludeCreatorId?: string): string[] => {
  const base = slugify(input);
  const candidates = [
    `${base}-2`,
    `${base}-studio`,
    `${base}-works`,
    `the-${base}`,
    `${base}-creative`
  ].map(slugify);
  return [...new Set(candidates)]
    .filter((candidate) => !creators.some((creator) => creator.creatorId !== excludeCreatorId && creatorMatchesSlug(creator, candidate)))
    .slice(0, 4);
};

type ProfileNameType = 'user' | 'creator';
type ProfileNameExpansionOption = {
  id: string;
  profileType: ProfileNameType;
  value: string;
  kind: 'modifier' | 'suffix' | 'animal' | 'community';
  weight: number;
  enabled: boolean;
  restricted: boolean;
};

const RESTRICTED_PROFILE_NAME_TERMS = [
  'official', 'verified', 'certified', 'government', 'support',
  'admin', 'staff', 'security', 'help', 'billing', 'legal',
  'police', 'authority', 'trust', 'service'
];

// These curated pools intentionally remain distinct: member names emphasize
// participation and community, while Creator names emphasize independent
// making and publishing. Each list has exactly 100 entries, which produces a
// 500-option expansion catalog (five forms per modifier).
const USER_NAME_MODIFIERS = [
  'Curious', 'Friendly', 'Creative', 'Local', 'Global', 'Open', 'Personal', 'Social', 'Quiet', 'Bright',
  'Playful', 'Thoughtful', 'Adventurous', 'Independent', 'New', 'Emerging', 'Everyday', 'Casual', 'Active', 'Engaged',
  'Welcoming', 'Kind', 'Clever', 'Wandering', 'Open-Minded', 'Good-Natured', 'Community-Minded', 'Neighbourly', 'Connected', 'Discovering',
  'Exploring', 'Learning', 'Listening', 'Sharing', 'Participating', 'Gathering', 'Returning', 'Familiar', 'Newcomer', 'Regular',
  'Helpful', 'Supportive', 'Expressive', 'Artistic', 'Musical', 'Bookish', 'Game-Loving', 'Film-Loving', 'Story-Loving', 'Nature-Loving',
  'Travel-Loving', 'Passionate', 'Dedicated', 'Enthusiastic', 'Unscripted', 'Unusual', 'Uncommon', 'Distinctive', 'Unique', 'Vivid',
  'Gentle', 'Bold', 'Restless', 'Reflective', 'Mysterious', 'Whimsical', 'Serious', 'Fun', 'Cheerful', 'Patient',
  'Spirited', 'Free-Range', 'Self-Directed', 'Open-Hearted', 'Warm', 'Culture-Focused', 'Discovery-Focused', 'Conversation-Focused', 'Ever-Curious', 'Ever-Ready',
  'Always-Exploring', 'Northern', 'Central', 'Urban', 'Rural', 'Social-Minded', 'Idea-Driven', 'Interest-Driven', 'Community-Focused', 'People-Powered',
  'Community-Built', 'Friendly-Minded', 'Creative-Minded', 'Conversation-Ready', 'Experience-Seeking', 'Wonder-Filled', 'Curious-Hearted', 'Story-Seeking', 'Joyful', 'Free-Spirited'
] as const;

const CREATOR_NAME_MODIFIERS = [
  'Original', 'Featured', 'Creative', 'Digital', 'Independent', 'Inspired', 'Experimental', 'Emerging', 'Established', 'Modern',
  'Classic', 'Bold', 'Distinctive', 'Curated', 'Signature', 'Premier', 'Artistic', 'Expressive', 'Imaginative', 'Inventive',
  'Playful', 'Thoughtful', 'Ambitious', 'Passionate', 'Dedicated', 'Rising', 'Fresh', 'Authentic', 'Unique', 'Select',
  'Visual', 'Cultural', 'Story-Driven', 'Image-Driven', 'Music-Driven', 'Film-Driven', 'Design-Driven', 'Creator-Led', 'Artist-Led', 'Community-Driven',
  'Creator-Focused', 'Artist-Focused', 'Self-Made', 'Multi-Talented', 'Unscripted', 'Uncharted', 'Unconventional', 'Alternative', 'Contemporary', 'Progressive',
  'Future-Facing', 'New-Wave', 'All-Star', 'First-Class', 'One-of-a-Kind', 'Refined', 'Polished', 'Raw', 'Unfiltered', 'Vibrant',
  'Whimsical', 'Serious', 'Mysterious', 'Secret', 'Hidden', 'Wild', 'Gentle', 'Clever', 'Quiet', 'Loud',
  'Strange', 'Unusual', 'Fantastic', 'Legendary', 'Cosmic', 'Stellar', 'Lunar', 'Solar', 'Electric', 'Magnetic',
  'Golden', 'Silver', 'Scarlet', 'Emerald', 'Midnight', 'Velvet', 'Wandering', 'Restless', 'Bright-Eyed', 'Creator-Owned',
  'Open-Minded', 'Work-in-Progress', 'Detail-Oriented', 'Limited', 'Original-Minded', 'Limitless', 'Everlasting', 'Uncommon', 'Remarkable', 'Adventurous'
] as const;

const USER_NAME_SUFFIXES = [
  'Circle', 'Community', 'Club', 'Commons', 'Corner', 'Group', 'Hub', 'House', 'Network', 'Space',
  'Room', 'Place', 'Forum', 'Exchange', 'Society', 'Guild', 'Gathering', 'Neighbours', 'Connections', 'Collective',
  'Circle Club', 'Circle Commons', 'Circle Corner', 'Circle Group', 'Circle Hub', 'Circle House', 'Circle Network', 'Circle Space', 'Circle Room', 'Circle Place',
  'Community Club', 'Community Commons', 'Community Corner', 'Community Group', 'Community Hub', 'Community House', 'Community Network', 'Community Space', 'Community Room', 'Community Place',
  'Open Circle', 'Open Community', 'Open Club', 'Open Commons', 'Open Corner', 'Open Group', 'Open Hub', 'Open House', 'Open Network', 'Open Space',
  'Friendly Circle', 'Friendly Community', 'Friendly Club', 'Friendly Commons', 'Friendly Corner', 'Friendly Group', 'Friendly Hub', 'Friendly House', 'Friendly Network', 'Friendly Space',
  'Shared Circle', 'Shared Community', 'Shared Club', 'Shared Commons', 'Shared Corner', 'Shared Group', 'Shared Hub', 'Shared House', 'Shared Network', 'Shared Space',
  'Local Circle', 'Local Community', 'Local Club', 'Local Commons', 'Local Corner', 'Local Group', 'Local Hub', 'Local House', 'Local Network', 'Local Space',
  'Creative Circle', 'Creative Community', 'Creative Club', 'Creative Commons', 'Creative Corner', 'Creative Group', 'Creative Hub', 'Creative House', 'Creative Network', 'Creative Space',
  'Shared Room', 'Shared Place', 'Open Forum', 'Open Exchange', 'Friendly Society', 'Friendly Guild', 'Local Gathering', 'Local Neighbours', 'Creative Connections', 'Creative Collective'
] as const;

const CREATOR_NAME_SUFFIXES = [
  'Collective', 'Experience', 'Studios', 'Studio', 'Works', 'Creative', 'Creations', 'Arts', 'Artworks', 'Productions',
  'Projects', 'Media', 'Network', 'House', 'Hub', 'World', 'Space', 'Gallery', 'Showcase', 'Archive',
  'Library', 'Workshop', 'Atelier', 'Laboratory', 'Lab', 'Society', 'Circle', 'Guild', 'Company', 'Exchange',
  'Platform', 'Channel', 'Index', 'Collection', 'Portfolio', 'Press', 'Publishing', 'Books', 'Stories', 'Films',
  'Videos', 'Sounds', 'Records', 'Music', 'Design', 'Illustration', 'Photography', 'Motion', 'Digital Works', 'Creative Works',
  'Creator House', 'Artist House', 'Media House', 'Creator Lab', 'Creative Lab', 'Project Hub', 'Creator Hub', 'Open Studio', 'Story House', 'Story Works',
  'Image House', 'Image Works', 'Video House', 'Sound House', 'Design House', 'Publishing House', 'Creator Space', 'Artist Space', 'Creative Space', 'Creator Network',
  'Artist Network', 'Creative Network', 'Creator Archive', 'Artist Archive', 'Creator Showcase', 'Artist Showcase', 'Creator Portfolio', 'Artist Portfolio', 'Creator Projects', 'Artist Projects',
  'Creator Productions', 'Artist Productions', 'Creator Originals', 'Artist Originals', 'Creator Stories', 'Artist Stories', 'Creator Works', 'Artist Works', 'Creator Arts', 'Artist Arts',
  'Digital Arts', 'Independent Arts', 'Community Arts', 'Creator Media', 'Artist Media', 'Creative Media', 'Creator Publishing', 'Artist Publishing', 'Creator Workshop', 'Artist Workshop'
] as const;

const USER_NAME_ANIMALS = ['Fox', 'Owl', 'Hare', 'Bear', 'Raven', 'Otter', 'Badger', 'Deer', 'Lynx', 'Sparrow', 'Wolf', 'Falcon', 'Panther', 'Wren', 'Heron'];
const CREATOR_NAME_ANIMALS = ['Fox', 'Raven', 'Owl', 'Lynx', 'Wolf', 'Hare', 'Otter', 'Bear', 'Badger', 'Deer', 'Falcon', 'Panther', 'Sparrow', 'Heron', 'Moth'];
const USER_NAME_COMMUNITIES = ['Neighbor', 'Neighbour', 'Friend', 'Explorer', 'Listener', 'Storyteller', 'Gatherer', 'Maker', 'Regular', 'Newcomer'];
const CREATOR_NAME_COMMUNITIES = ['Studio', 'Maker', 'Artist', 'Publisher', 'Storyteller', 'Designer', 'Illustrator', 'Photographer', 'Musician', 'Filmmaker'];

if (USER_NAME_MODIFIERS.length !== 100 || CREATOR_NAME_MODIFIERS.length !== 100 || USER_NAME_SUFFIXES.length !== 100 || CREATOR_NAME_SUFFIXES.length !== 100) {
  throw new Error('Profile name expansion pools must contain 100 curated entries.');
}

const profileNameContainsRestrictedTerm = (candidate: string): boolean => {
  const normalized = candidate.toLocaleLowerCase().replace(/[-_/]+/g, ' ');
  return RESTRICTED_PROFILE_NAME_TERMS.some((term) => new RegExp(`(^|\\s)${term}(?=\\s|$)`, 'i').test(normalized));
};

const insertProfileNameModifier = (name: string, modifier: string): string => {
  const article = name.match(/^(A|An|The)\s+/i);
  return article ? `${article[1]} ${modifier} ${name.slice(article[0].length)}` : `${modifier} ${name}`;
};

const buildProfileNameExpansionPool = (profileType: ProfileNameType, input: string): ProfileNameExpansionOption[] => {
  const baseName = input.trim().replace(/\s+/g, ' ') || (profileType === 'creator' ? 'Creator' : 'Member');
  const modifiers = profileType === 'creator' ? CREATOR_NAME_MODIFIERS : USER_NAME_MODIFIERS;
  const suffixes = profileType === 'creator' ? CREATOR_NAME_SUFFIXES : USER_NAME_SUFFIXES;
  const animals = profileType === 'creator' ? CREATOR_NAME_ANIMALS : USER_NAME_ANIMALS;
  const communities = profileType === 'creator' ? CREATOR_NAME_COMMUNITIES : USER_NAME_COMMUNITIES;
  const options: ProfileNameExpansionOption[] = [];
  modifiers.forEach((modifier, index) => {
    const suffix = suffixes[index];
    const entries: Array<[ProfileNameExpansionOption['kind'], string, number]> = [
      ['modifier', insertProfileNameModifier(baseName, modifier), 90],
      ['suffix', `${insertProfileNameModifier(baseName, modifier)} ${suffix}`, 70],
      ['suffix', `${baseName} ${suffix}`, 100],
      ['animal', `${modifier} ${animals[index % animals.length]}`, 55],
      ['community', `${modifier} ${communities[index % communities.length]}`, 45]
    ];
    entries.forEach(([kind, value, weight], formIndex) => options.push({
      id: `${profileType}-${index}-${formIndex}`,
      profileType,
      value,
      kind,
      weight,
      enabled: true,
      restricted: profileNameContainsRestrictedTerm(value)
    }));
  });
  const seen = new Set<string>();
  return options.filter((option) => {
    const normalized = normalizeIdentityName(option.value);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
};

const buildProfileNameSuggestions = (
  profileType: ProfileNameType,
  input: string,
  isAvailable: (candidate: string) => boolean
): string[] => {
  const pool = buildProfileNameExpansionPool(profileType, input);
  const baseName = input.trim().replace(/\s+/g, ' ') || (profileType === 'creator' ? 'Creator' : 'Member');
  const highPrioritySuffix = profileType === 'creator' ? 'Studio' : 'Circle';
  const preferred = [
    `${baseName} ${highPrioritySuffix}`,
    ...pool.filter((option) => option.kind === 'modifier').map((option) => option.value),
    ...pool.filter((option) => option.kind === 'suffix').map((option) => option.value),
    ...pool.filter((option) => option.kind === 'animal' || option.kind === 'community').map((option) => option.value),
    `${baseName} 2`
  ];
  const seen = new Set<string>();
  const candidates = preferred.filter((candidate) => {
    const normalized = normalizeIdentityName(candidate);
    if (seen.has(normalized) || profileNameContainsRestrictedTerm(candidate) || !isAvailable(candidate)) return false;
    seen.add(normalized);
    return true;
  });
  // Keep the normal UI useful: the full 500-item catalog remains available
  // internally, while the first eight are weighted toward readable choices.
  return candidates.slice(0, 8);
};

const buildCreatorNameSuggestions = (creators: Creator[], input: string, excludeCreatorId?: string): string[] => (
  buildProfileNameSuggestions('creator', input, (candidate) => {
    const candidateSlug = slugify(candidate);
    return !creators.some((creator) => creator.creatorId !== excludeCreatorId && (
      creatorMatchesName(creator, candidate) || creatorMatchesSlug(creator, candidateSlug)
    ));
  })
);

const parseSquareCrop = (input: unknown): SquareCropInput | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const x = Number(obj.x);
  const y = Number(obj.y);
  const size = Number(obj.size);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(size) || size <= 0) {
    return undefined;
  }
  return { x: Math.floor(x), y: Math.floor(y), size: Math.floor(size) };
};

const parseCoverCrop = (input: unknown): CoverCropInput | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const x = Number(obj.x);
  const y = Number(obj.y);
  const width = Number(obj.width);
  const height = Number(obj.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { x: Math.floor(x), y: Math.floor(y), width: Math.floor(width), height: Math.floor(height) };
};

const parseFocalPoint = (input: unknown): FocalPointInput | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const x = Number(obj.x);
  const y = Number(obj.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
};

const OBJECTIONABLE_USERNAME_PARTS = [
  'admin', 'moderator', 'support', 'owner', 'staff', 'root', 'system',
  'fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot', 'rape',
  'porn', 'xxx', 'sex', 'pedo', 'naz', 'hitler', 'suicide'
];
const USERNAME_CHANGE_COOLDOWN_DAYS = 30;

const normalizeUsername = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, '-');
const sanitizeOptional = (value: unknown, maxLen: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
};

const decodeBasicHtmlEntities = (value: string): string => value
  .replace(/&nbsp;/gi, ' ')
  .replace(/&quot;/gi, '"')
  .replace(/&#0*39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&amp;/gi, '&');

const escapeLimitedRichText = (value: string): string => decodeBasicHtmlEntities(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const sanitizeLimitedRichText = (value: unknown, maxTextLength: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const source = value.trim();
  if (!source) return undefined;
  let textLength = 0;
  const sanitized = source.split(/(<[^>]*>)/g).map((token) => {
    if (token.startsWith('<')) {
      if (/^<br\s*\/?\s*>$/i.test(token)) return '<br>';
      if (/^<\/?(?:strong|b)\s*>$/i.test(token)) return token.startsWith('</') ? '</strong>' : '<strong>';
      if (/^<\/?(?:em|i)\s*>$/i.test(token)) return token.startsWith('</') ? '</em>' : '<em>';
      if (/^<\/?u\s*>$/i.test(token)) return token.startsWith('</') ? '</u>' : '<u>';
      if (/^<\/?(?:div|p|li)\b[^>]*>$/i.test(token)) return token.startsWith('</') ? '<br>' : '';
      return '';
    }
    const decoded = decodeBasicHtmlEntities(token);
    const remaining = Math.max(0, maxTextLength - textLength);
    const limited = decoded.slice(0, remaining);
    textLength += limited.length;
    return escapeLimitedRichText(limited);
  }).join('').replace(/(?:<br>){3,}/g, '<br><br>').replace(/(?:<br>)+$/g, '');
  return sanitized || undefined;
};

const limitedRichTextToPlainText = (value: unknown): string => decodeBasicHtmlEntities(String(value || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]*>/g, ''));

const sanitizePublicHttpUrl = (value: unknown, maxLen = 1000): string | undefined => {
  const candidate = sanitizeOptional(value, maxLen);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
};

const externalLinkDomains: Record<string, string[]> = {
  'Instagram': ['instagram.com', 'instagr.am'],
  'TikTok': ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
  'Bluesky': ['bsky.app', 'bsky.social'],
  'X / Twitter': ['x.com', 'twitter.com', 't.co'],
  'Threads': ['threads.net'],
  'Mastodon': ['mastodon.social', 'mastodon.online', 'mastodon.world', 'mastodon.art', 'mastodon.cloud'],
  'Facebook': ['facebook.com', 'fb.me'],
  'Tumblr': ['tumblr.com'],
  'Pinterest': ['pinterest.com', 'pin.it'],
  'LinkedIn': ['linkedin.com', 'lnkd.in'],
  'Reddit': ['reddit.com', 'redd.it'],
  'YouTube': ['youtube.com', 'youtu.be'],
  'Vimeo': ['vimeo.com'],
  'Twitch': ['twitch.tv'],
  'DeviantArt': ['deviantart.com'],
  'Cara': ['cara.app'],
  'Behance': ['behance.net'],
  'ArtStation': ['artstation.com'],
  'Dribbble': ['dribbble.com'],
  'Flickr': ['flickr.com', 'flic.kr'],
  '500px': ['500px.com'],
  'SoundCloud': ['soundcloud.com', 'on.soundcloud.com'],
  'Bandcamp': ['bandcamp.com'],
  'Spotify': ['spotify.com', 'spotify.link'],
  'Apple Music': ['music.apple.com', 'apple.co'],
  'FanVue': ['fanvue.com'],
  'Patreon': ['patreon.com'],
  'Ko-fi': ['ko-fi.com'],
  'Buy Me a Coffee': ['buymeacoffee.com', 'bmc.link'],
  'Etsy': ['etsy.com', 'etsy.me'],
  'Gumroad': ['gumroad.com'],
  'Substack': ['substack.com'],
  'GitHub': ['github.com', 'github.io']
};

const supportedExternalLinkLabels = Object.keys(externalLinkDomains);

const findSupportedExternalLinkLabel = (label: string): string | undefined =>
  supportedExternalLinkLabels.find((candidate) => candidate.toLowerCase() === label.trim().toLowerCase());

const isPlatformUrl = (url: string, allowedDomains: string[]): boolean => {
  const hostname = new URL(url).hostname.toLowerCase();
  return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
};

const parseProfileExternalLinks = (value: unknown, options: { allowCustom: boolean }): Array<{ label: string; url: string }> => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const url = sanitizePublicHttpUrl(record.url);
    if (!url) return [];
    const submittedLabel = sanitizeOptional(record.label, 80) || new URL(url).hostname;
    const supportedLabel = findSupportedExternalLinkLabel(submittedLabel);
    if (supportedLabel && !isPlatformUrl(url, externalLinkDomains[supportedLabel])) return [];
    if (!supportedLabel && !options.allowCustom) return [];
    return [{ label: supportedLabel || submittedLabel, url }];
  });
};

const parseUserExternalLinks = (value: unknown): Array<{ label: string; url: string }> => parseProfileExternalLinks(value, { allowCustom: false });

const parseCreatorExternalLinks = (value: unknown): NonNullable<NonNullable<Creator['space']>['externalLinks']> => parseProfileExternalLinks(value, { allowCustom: true });

const parseCreatorSpaceTheme = (value: unknown): NonNullable<NonNullable<Creator['space']>['theme']> =>
  value === 'ubeeq' || value === 'sand' || value === 'forest' || value === 'slate' ? value : 'default';

const parseCreatorCoverPreset = (value: unknown): string | undefined => {
  const preset = sanitizeOptional(value, 80);
  return preset && /^[a-z0-9][a-z0-9-]*$/.test(preset) ? preset : undefined;
};

const parseCreatorSpaceVisibility = (value: unknown): 'public-discoverable' | 'public-link' | 'private' =>
  value === 'public-discoverable' || value === 'public-link' ? value : 'private';

const parseCreatorShareCode = (value: unknown): string | undefined => {
  const code = sanitizeOptional(value, 120);
  return code && /^[A-Za-z0-9_-]{12,120}$/.test(code) ? code : undefined;
};

const parseOptionalContentRating = (value: unknown): ContentRating | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  return normalizeContentRating(value);
};

const parseOptionalBoolean = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return undefined;
};

const parseOptionalPreviewWidth = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
};

const parseStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

const POST_BLOCK_TYPES = new Set([
  'section',
  'heading',
  'paragraph',
  'image',
  'video',
  'audio',
  'quote',
  'divider',
  'embed',
  'file',
  'link',
  'credit',
  'grouping',
  'carousel',
  'pdf_preview',
  'html_fragment'
]);

const parsePostBlocks = (value: unknown, options: { unbounded?: boolean } = {}): PostBlock[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const type = typeof row.type === 'string' ? row.type.trim() : '';
      if (!POST_BLOCK_TYPES.has(type)) return null;
      const block: PostBlock = {
        blockId: typeof row.blockId === 'string' && row.blockId.trim() ? row.blockId.trim() : `${type}-${index + 1}`,
        type: type as PostBlock['type']
      };
      if (typeof row.text === 'string') block.text = options.unbounded ? row.text : row.text.slice(0, 20000);
      if (typeof row.level === 'number' && Number.isFinite(row.level)) block.level = Math.max(1, Math.min(6, Math.floor(row.level)));
      if (typeof row.mediaId === 'string' && row.mediaId.trim()) block.mediaId = row.mediaId.trim();
      if (typeof row.caption === 'string') block.caption = row.caption.slice(0, 2000);
      if (typeof row.quote === 'string') block.quote = options.unbounded ? row.quote : row.quote.slice(0, 4000);
      if (typeof row.author === 'string') block.author = row.author.slice(0, 200);
      if (typeof row.url === 'string') block.url = row.url.slice(0, 2048);
      if (typeof row.mimeType === 'string') block.mimeType = row.mimeType.slice(0, 255);
      if (typeof row.title === 'string') block.title = row.title.slice(0, 300);
      if (typeof row.label === 'string') block.label = row.label.slice(0, 300);
      if (typeof row.html === 'string') block.html = options.unbounded ? row.html : row.html.slice(0, 50000);
      if (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)) {
        block.payload = row.payload as Record<string, unknown>;
      }
      const childBlocks = parsePostBlocks(row.blocks, options);
      if (childBlocks.length > 0) {
        block.blocks = childBlocks;
      }
      return block;
    })
    .filter((item): item is PostBlock => Boolean(item));
};

const isPublicPostBlock = (block: PostBlock): boolean => {
  if (block.type !== 'section') return true;
  const status = typeof block.payload?.status === 'string' ? block.payload.status : 'published';
  // releaseAt is staged metadata for a future publisher/fan/patron gate; it does not publish by itself.
  return status === 'published';
};

const postBlocksForViewer = (blocks: PostBlock[], includeUnreleased: boolean): PostBlock[] => {
  if (includeUnreleased) return blocks;
  const visibleBlocks: PostBlock[] = [];
  let includedNextUnreleasedSection = false;

  for (const block of blocks) {
    if (!isPublicPostBlock(block)) {
      if (block.type === 'section' && !includedNextUnreleasedSection) {
        visibleBlocks.push({
          ...block,
          payload: {
            ...(block.payload || {}),
            previewOnly: true
          },
          blocks: []
        });
        includedNextUnreleasedSection = true;
      }
      continue;
    }

    visibleBlocks.push(
      block.blocks?.length
        ? {
            ...block,
            blocks: postBlocksForViewer(block.blocks, includeUnreleased)
          }
        : block
    );
  }

  return visibleBlocks;
};

const collectPostBlockMediaIds = (blocks: PostBlock[] = []): Set<string> => {
  const mediaIds = new Set<string>();
  for (const block of blocks) {
    if (block.mediaId) mediaIds.add(block.mediaId);
    const heroMedia = block.type === 'section' && block.payload?.heroMedia && typeof block.payload.heroMedia === 'object'
      ? block.payload.heroMedia as Record<string, unknown>
      : undefined;
    if (typeof heroMedia?.mediaId === 'string' && heroMedia.mediaId.trim()) {
      mediaIds.add(heroMedia.mediaId.trim());
    }
    for (const childMediaId of collectPostBlockMediaIds(block.blocks || [])) {
      mediaIds.add(childMediaId);
    }
  }
  return mediaIds;
};

const firstSectionMediaIdsForStoryPost = (post: Post): Set<string> | null => {
  if ((post.metadata?.postType || '').toLowerCase() !== 'story') return null;
  const sections = post.blocks
    .filter((block) => block.type === 'section')
    .sort((a, b) => {
      const left = Number(a.payload?.sortOrder);
      const right = Number(b.payload?.sortOrder);
      const normalizedLeft = Number.isFinite(left) ? left : Number.MAX_SAFE_INTEGER;
      const normalizedRight = Number.isFinite(right) ? right : Number.MAX_SAFE_INTEGER;
      if (normalizedLeft !== normalizedRight) return normalizedLeft - normalizedRight;
      return (a.blockId || '').localeCompare(b.blockId || '');
    });
  if (sections.length === 0) return null;
  return collectPostBlockMediaIds([sections[0]]);
};

const parsePostMediaRefs = (value: unknown): Post['media'] => {
  if (!Array.isArray(value)) return [];
  const result: Post['media'] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const mediaId = typeof row.mediaId === 'string' ? row.mediaId.trim() : '';
    if (!mediaId) continue;
    const sortOrderRaw = Number(row.sortOrder);
    const creditRaw = row.credit;
    const credit = creditRaw && typeof creditRaw === 'object' && !Array.isArray(creditRaw)
      ? {
          label: typeof (creditRaw as Record<string, unknown>).label === 'string'
            ? String((creditRaw as Record<string, unknown>).label).trim().slice(0, 300)
            : '',
          url: typeof (creditRaw as Record<string, unknown>).url === 'string'
            ? String((creditRaw as Record<string, unknown>).url).trim().slice(0, 2048)
            : undefined
        }
      : undefined;
    const comparisonRaw = row.comparison;
    const comparisonItemRaw = comparisonRaw && typeof comparisonRaw === 'object' && !Array.isArray(comparisonRaw)
      ? (comparisonRaw as Record<string, unknown>).comparisonItem
      : undefined;
    const comparisonItem = comparisonItemRaw && typeof comparisonItemRaw === 'object' && !Array.isArray(comparisonItemRaw)
      ? (() => {
          const rawComparisonItem = comparisonItemRaw as Record<string, unknown>;
          const rawCredit = rawComparisonItem.credit;
          const comparisonCredit = rawCredit && typeof rawCredit === 'object' && !Array.isArray(rawCredit)
            ? {
                label: typeof (rawCredit as Record<string, unknown>).label === 'string'
                  ? String((rawCredit as Record<string, unknown>).label).trim().slice(0, 300)
                  : '',
                url: typeof (rawCredit as Record<string, unknown>).url === 'string'
                  ? String((rawCredit as Record<string, unknown>).url).trim().slice(0, 2048)
                  : undefined
              }
            : undefined;
          return {
            mediaId: typeof rawComparisonItem.mediaId === 'string'
              ? String(rawComparisonItem.mediaId).trim()
              : '',
            role: typeof rawComparisonItem.role === 'string'
              ? String(rawComparisonItem.role).trim().slice(0, 80)
              : undefined,
            order: Number.isFinite(Number(rawComparisonItem.order))
              ? Math.max(0, Math.floor(Number(rawComparisonItem.order)))
              : undefined,
            caption: typeof rawComparisonItem.caption === 'string'
              ? String(rawComparisonItem.caption).trim().slice(0, 2000)
              : undefined,
            credit: comparisonCredit?.label ? comparisonCredit : undefined
          };
        })()
      : undefined;
    const comparison = comparisonRaw && typeof comparisonRaw === 'object' && !Array.isArray(comparisonRaw) && comparisonItem?.mediaId
      ? {
          type: typeof (comparisonRaw as Record<string, unknown>).type === 'string'
            ? String((comparisonRaw as Record<string, unknown>).type).trim().slice(0, 80)
            : undefined,
          role: typeof (comparisonRaw as Record<string, unknown>).role === 'string'
            ? String((comparisonRaw as Record<string, unknown>).role).trim().slice(0, 80)
            : undefined,
          order: Number.isFinite(Number((comparisonRaw as Record<string, unknown>).order))
            ? Math.max(0, Math.floor(Number((comparisonRaw as Record<string, unknown>).order)))
            : undefined,
          comparisonItem
        }
      : undefined;
    result.push({
      mediaId,
      discoverable: row.discoverable === undefined ? true : Boolean(row.discoverable),
      sortOrder: Number.isFinite(sortOrderRaw) ? Math.max(0, Math.floor(sortOrderRaw)) : undefined,
      caption: typeof row.caption === 'string' ? row.caption.slice(0, 2000) : undefined,
      credit: credit?.label ? credit : undefined,
      comparison
    });
  }
  return result;
};

const parsePostDiscoveryMode = (value: unknown): PostDiscoveryMode => {
  if (value === 'all' || value === 'selected') return value;
  return 'primary';
};

const validateUsername = (value: string): { normalized: string; reasons: string[] } => {
  const normalized = normalizeUsername(value);
  const reasons: string[] = [];

  if (!/^[a-z0-9-]{3,30}$/.test(normalized)) {
    reasons.push('Username must be 3-30 chars and use only letters, numbers, and dashes.');
  }
  if (normalized.startsWith('-') || normalized.endsWith('-') || normalized.includes('--')) {
    reasons.push('Username cannot start/end with a dash or include consecutive dashes.');
  }
  if (OBJECTIONABLE_USERNAME_PARTS.some((part) => normalized.includes(part))) {
    reasons.push('Username is not allowed.');
  }
  return { normalized, reasons };
};

const buildUsernameSuggestions = async (
  store: DataStore,
  input: string,
  productBrand: 'ubeeq' | 'eversally'
): Promise<string[]> => {
  // When suggestions are generated from an email address (for example when
  // the registration form is autofilled), use only the recipient/local part.
  // Including the domain makes suggestions noisy ("namegmailcom-ever") and
  // exposes an implementation detail that is not useful as a public handle.
  const trimmedInput = input.trim();
  const atIndex = trimmedInput.indexOf('@');
  const suggestionSeed = atIndex > 0 ? trimmedInput.slice(0, atIndex) : trimmedInput;
  const base = normalizeUsername(suggestionSeed).replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '') || 'user';
  const withPrefix = (prefix: string) => `${prefix}-${base}`.slice(0, 30).replace(/-+$/g, '');
  const withSuffix = (suffix: string) => `${base.slice(0, Math.max(3, 29 - suffix.length))}-${suffix}`;
  const communityTerm = productBrand === 'eversally' ? 'ever' : 'ubeeqer';
  const candidates = new Set<string>();
  // Prefer readable, brand-native alternatives over opaque numeric suffixes.
  // They remain suggestions only: the member can always choose a different
  // handle that fits their identity.
  candidates.add(withSuffix(communityTerm));
  candidates.add(withPrefix(communityTerm));
  candidates.add(withSuffix(productBrand === 'eversally' ? 'space' : 'area'));
  candidates.add(withPrefix('hello'));
  candidates.add(withSuffix('makes'));
  candidates.add(`${base.slice(0, 29)}2`);
  candidates.add(`${base.slice(0, 28)}23`);

  const suggestions: string[] = [];
  for (const candidate of candidates) {
    const { normalized, reasons } = validateUsername(candidate);
    if (reasons.length > 0) continue;
    if (await store.isUsernameAvailable(normalized)) {
      suggestions.push(normalized);
    }
    if (suggestions.length >= 4) break;
  }
  return suggestions;
};

const stableHash = (input: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0);
};

const encodeCursorToken = (payload: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

type ServerTimingEntry = { metric: string; durMs: number; desc?: string };

const addServerTiming = (res: express.Response, metric: string, durMs: number, desc?: string): void => {
  const locals = res.locals as { __serverTimingEntries?: ServerTimingEntry[] };
  if (!locals.__serverTimingEntries) locals.__serverTimingEntries = [];
  locals.__serverTimingEntries.push({ metric, durMs, desc });
};

const decodeCursorToken = (token?: string): Record<string, unknown> | null => {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

const parseOffsetCursor = (token?: string): number => {
  if (!token) return 0;
  const numeric = Number(token);
  if (Number.isFinite(numeric)) return Math.max(0, numeric);
  const parsed = decodeCursorToken(token);
  const offset = Number(parsed?.offset);
  return Number.isFinite(offset) ? Math.max(0, offset) : 0;
};

const encodeOffsetCursor = (offset: number): string =>
  encodeCursorToken({ v: 1, type: 'offset', offset: Math.max(0, offset) });

const parsePassthroughCursor = (token?: string): string | undefined => {
  if (!token) return undefined;
  const parsed = decodeCursorToken(token);
  if (typeof parsed?.value === 'string') return parsed.value;
  return token;
};

const encodePassthroughCursor = (value: string): string =>
  encodeCursorToken({ v: 1, type: 'passthrough', value });

export const createApp = ({
  config,
  store,
  externalSyncQueue: injectedExternalSyncQueue,
  communityDeliveryQueue: injectedCommunityDeliveryQueue,
  fanvueRepository,
  tumblrRepository: injectedTumblrRepository,
  tumblrPublishQueue: injectedTumblrPublishQueue,
  supportSafetyRepository
}: CreateAppOptions) => {
  const brand = brandForConfig(config);
  const app = express();
  const s3Client = new S3Client({ region: config.awsRegion });
  const cognitoClient = new CognitoIdentityProviderClient({ region: config.awsRegion });
  const sesClient = new SESv2Client({ region: config.awsRegion });
  const externalSyncQueue = injectedExternalSyncQueue || createExternalSyncQueue(config);
  const communityDeliveryQueue = injectedCommunityDeliveryQueue || createCommunityDeliveryQueue(config);
  const tumblrRepository = injectedTumblrRepository || new InMemoryTumblrRepository();
  const tumblrPublishQueue = injectedTumblrPublishQueue || createTumblrPublishQueue(config);
  const supportSafetyService = new SupportSafetyService(supportSafetyRepository);
  const mediaCdnDomain = (config.mediaCdnDomain || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/g, '');
  const premiumMediaCdnDomain = (config.premiumMediaCdnDomain || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/g, '');
  const cloudFrontPrivateKey = (config.cloudFrontPrivateKey || '')
    .replace(/\\n/g, '\n')
    .trim();
  const DISCOVERY_CACHE_TTL_MS = 30_000;
  const DISCOVERY_CACHE_STALE_MS = 120_000;
  const DISCOVERY_CACHE_MAX_ENTRIES = 200;
  const TRENDING_RESPONSE_CACHE_TTL_MS = 15_000;
  type DiscoveryCacheEntry = {
    value: unknown;
    expiresAt: number;
    staleUntil: number;
    updatedAt: number;
    refreshPromise?: Promise<void>;
  };
  const discoveryCache = new Map<string, DiscoveryCacheEntry>();
  const trendingResponseCache = new Map<string, { payload: unknown; expiresAt: number }>();
  let trendingWarmupInFlight: Promise<void> | null = null;

  const buildDiscoveryCacheKey = (req: express.Request, scope: string): string | null => {
    // Cache only anonymous responses to avoid cross-user data leakage.
    if (req.authUser) return null;
    const queryEntries = Object.entries(req.query || {})
      .map(([key, value]) => {
        if (Array.isArray(value)) return [key, value.join(',')];
        return [key, String(value ?? '')];
      })
      .sort((a, b) => a[0].localeCompare(b[0]));
    const query = queryEntries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    return query ? `${scope}?${query}` : scope;
  };

  const pruneDiscoveryCache = () => {
    const now = Date.now();
    for (const [key, entry] of discoveryCache.entries()) {
      if (entry.staleUntil <= now && !entry.refreshPromise) {
        discoveryCache.delete(key);
      }
    }
    if (discoveryCache.size <= DISCOVERY_CACHE_MAX_ENTRIES) return;
    const keysByOldest = [...discoveryCache.entries()]
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      .map(([key]) => key);
    const overflow = discoveryCache.size - DISCOVERY_CACHE_MAX_ENTRIES;
    keysByOldest.slice(0, overflow).forEach((key) => discoveryCache.delete(key));
  };

  const putDiscoveryCache = (key: string, value: unknown) => {
    const now = Date.now();
    discoveryCache.set(key, {
      value,
      expiresAt: now + DISCOVERY_CACHE_TTL_MS,
      staleUntil: now + DISCOVERY_CACHE_STALE_MS,
      updatedAt: now
    });
    pruneDiscoveryCache();
  };

  const getDiscoveryCached = async <T>(
    req: express.Request,
    scope: string,
    loader: () => Promise<T>
  ): Promise<{ payload: T; cacheStatus: 'BYPASS' | 'MISS' | 'HIT' | 'STALE' }> => {
    const key = buildDiscoveryCacheKey(req, scope);
    if (!key) {
      const payload = await loader();
      return { payload, cacheStatus: 'BYPASS' };
    }

    const now = Date.now();
    const existing = discoveryCache.get(key);
    if (existing && now < existing.expiresAt) {
      return { payload: existing.value as T, cacheStatus: 'HIT' };
    }

    if (existing && now < existing.staleUntil) {
      if (!existing.refreshPromise) {
        existing.refreshPromise = loader()
          .then((fresh) => {
            putDiscoveryCache(key, fresh);
          })
          .catch(() => undefined)
          .finally(() => {
            const current = discoveryCache.get(key);
            if (current) {
              delete current.refreshPromise;
            }
          });
      }
      return { payload: existing.value as T, cacheStatus: 'STALE' };
    }

    try {
      const payload = await loader();
      putDiscoveryCache(key, payload);
      return { payload, cacheStatus: 'MISS' };
    } catch (error) {
      // If upstream fails, serve stale data when available.
      if (existing && now < existing.staleUntil) {
        return { payload: existing.value as T, cacheStatus: 'STALE' };
      }
      throw error;
    }
  };

  const readTrendingResponseCache = <T>(key: string): T | null => {
    const item = trendingResponseCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      trendingResponseCache.delete(key);
      return null;
    }
    return item.payload as T;
  };

  const writeTrendingResponseCache = (key: string, payload: unknown) => {
    trendingResponseCache.set(key, {
      payload,
      expiresAt: Date.now() + TRENDING_RESPONSE_CACHE_TTL_MS
    });
  };

  const triggerTrendingWarmup = async (): Promise<void> => {
    if (trendingWarmupInFlight) {
      await trendingWarmupInFlight;
      return;
    }
    trendingWarmupInFlight = refreshTrendingFeeds(store, config, Date.now())
      .then(() => undefined)
      .catch((error) => {
        logServerError('trendingWarmup', error);
      })
      .finally(() => {
        trendingWarmupInFlight = null;
      });
    await trendingWarmupInFlight;
  };

  const logServerError = (scope: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(`[api-error] scope=${scope} message=${message}${stack ? `\n${stack}` : ''}`);
  };

  const toExternalAccountResponse = (account: ExternalAccount) => ({
    externalAccountId: account.externalAccountId,
    userId: account.userId,
    creatorIdentityId: account.creatorIdentityId,
    primaryCreatorIdentityId: account.primaryCreatorIdentityId || account.creatorIdentityId,
    externalPlatformCredentialId: account.externalPlatformCredentialId,
    platform: account.platform,
    externalUserId: account.externalUserId,
    externalUsername: account.externalUsername,
    tokenExpiresAt: account.tokenExpiresAt,
    connectionStatus: account.connectionStatus,
    rateLimitedUntil: account.rateLimitedUntil,
    lastSuccessfulSyncAt: account.lastSuccessfulSyncAt,
    lastSyncAttemptAt: account.lastSyncAttemptAt,
    includeSourceFilesOnSync: account.includeSourceFilesOnSync !== false,
    ...(account.platform === 'deviantart' ? { deviantArtPublishingPreset: { ...defaultDeviantArtPreset(), ...account.deviantArtPublishingPreset } } : {}),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  });

  const toExternalPlatformCredentialResponse = (credential: ExternalPlatformCredential) => ({
    externalPlatformCredentialId: credential.externalPlatformCredentialId,
    creatorIdentityId: credential.creatorIdentityId,
    platform: credential.platform,
    applicationLabel: credential.applicationLabel,
    clientId: credential.clientId,
    redirectUri: credential.redirectUri,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt
  });

  const providerForCredential = (credential: ExternalPlatformCredential) => createExternalPlatformProvider(credential.platform, {
    clientId: credential.clientId,
    clientSecret: decryptExternalCredential(credential.clientSecretEncrypted, config.externalTokenEncryptionKey),
    redirectUri: credential.redirectUri,
    minimumRequestIntervalMs: credential.platform === 'youtube'
      ? config.youtubeMinimumRequestIntervalMs
      : config.deviantArtMinimumRequestIntervalMs,
    ...(credential.platform === 'youtube' ? { apiBaseUrl: config.youtubeApiBaseUrl } : {}),
    enabled: credential.platform !== 'soundcloud' || config.soundCloudEnabled
  });

  /** Resolve and refresh a connected DeviantArt account for a one-shot native
   * publication. The background worker has equivalent refresh logic; keeping
   * this small helper here makes direct literature/journal/status publishing
   * safe without exposing encrypted credentials to callers. */
  const withDeviantArtAccess = async <T>(
    account: ExternalAccount,
    callback: (provider: ReturnType<typeof providerForCredential>, accessToken: string, currentAccount: ExternalAccount) => Promise<T>
  ): Promise<T> => {
    const credential = await store.getExternalPlatformCredential(account.externalPlatformCredentialId);
    if (!credential || credential.platform !== 'deviantart' || credential.userId !== account.userId) {
      throw new ExternalProviderError('The DeviantArt application credentials are unavailable.', 'unsupported');
    }
    const provider = providerForCredential(credential);
    let currentAccount = account;
    let accessToken = decryptExternalCredential(account.accessTokenEncrypted, config.externalTokenEncryptionKey);
    const expiresAt = account.tokenExpiresAt ? Date.parse(account.tokenExpiresAt) : NaN;
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000) {
      if (!account.refreshTokenEncrypted) {
        throw new ExternalProviderError('Your DeviantArt connection has expired. Reconnect it before publishing.', 'authentication_required');
      }
      const tokens = await provider.refreshAuthentication(decryptExternalCredential(account.refreshTokenEncrypted, config.externalTokenEncryptionKey));
      currentAccount = {
        ...account,
        accessTokenEncrypted: encryptExternalCredential(tokens.accessToken, config.externalTokenEncryptionKey),
        refreshTokenEncrypted: tokens.refreshToken
          ? encryptExternalCredential(tokens.refreshToken, config.externalTokenEncryptionKey)
          : account.refreshTokenEncrypted,
        tokenExpiresAt: tokens.expiresAt,
        connectionStatus: 'connected',
        updatedAt: new Date().toISOString()
      };
      await store.updateExternalAccount(currentAccount);
      accessToken = tokens.accessToken;
    }
    return callback(provider, accessToken, currentAccount);
  };

  const enqueueExternalSyncJob = async (
    externalAccountId: string,
    type: ExternalSyncJob['type'],
    payload?: Record<string, unknown>
  ): Promise<ExternalSyncJob> => {
    const account = await store.getExternalAccount(externalAccountId);
    const operation: IntegrationOperation = type === 'publish'
      ? 'publish'
      : type === 'remote_update'
        ? 'update_remote'
        : type === 'account_import' || type === 'account_scan' || type === 'full_reconciliation' || type === 'content_sync'
          ? 'import'
        : 'read_engagement';
    if (!account) throw new Error('Connected account not found.');
    requireIntegrationOperation(account.platform, operation);
    const policy = await createStoreIntegrationPolicyGate(store).evaluate({
      operation,
      targets: [
        { type: 'external_account', id: externalAccountId },
        ...(typeof payload?.assetId === 'string' ? [{ type: 'asset' as const, id: payload.assetId }] : []),
        ...(typeof payload?.externalPublicationId === 'string' ? [{ type: 'publication' as const, id: payload.externalPublicationId }] : []),
        ...(account?.primaryCreatorIdentityId || account?.creatorIdentityId ? [{ type: 'creator' as const, id: account.primaryCreatorIdentityId || account.creatorIdentityId! }] : [])
      ]
    });
    if (!policy.allowed) throw new Error(policy.reason || 'This integration operation is blocked by an active safety hold.');
    const now = new Date().toISOString();
    const job: ExternalSyncJob = {
      externalSyncJobId: randomUUID(),
      externalAccountId,
      type,
      status: 'queued',
      payload,
      progress: { discovered: 0, synchronized: 0, remaining: 0 },
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    };
    await store.createExternalSyncJob(job);
    try {
      await externalSyncQueue.enqueue(job.externalSyncJobId);
    } catch (error) {
      await store.updateExternalSyncJob({
        ...job,
        status: 'retry_scheduled',
        nextAttemptAt: new Date(Date.now() + config.externalSyncBaseDelaySeconds * 1000).toISOString(),
        errorCode: 'QUEUE_UNAVAILABLE',
        errorMessage: 'The synchronization queue is unavailable',
        updatedAt: new Date().toISOString()
      });
      throw error;
    }
    return job;
  };

  const integrationAdmissionReason = async (
    platform: IntegrationPlatform,
    operation: IntegrationOperation,
    targets: IntegrationPolicyTarget[]
  ): Promise<string | undefined> => {
    try {
      requireIntegrationOperation(platform, operation);
    } catch (error) {
      return error instanceof Error ? error.message : 'This integration operation is unavailable.';
    }
    const policy = await createStoreIntegrationPolicyGate(store).evaluate({ operation, targets });
    return policy.allowed ? undefined : policy.reason || 'This integration operation is blocked by an active safety hold.';
  };

  const allowedHeaders = [
    'authorization',
    'content-type',
    'if-none-match',
    'cache-control',
    'range',
    'x-grouping-access-token',
    'x-unlock-token',
    'x-idempotency-key'
  ];
  const exposedHeaders = [
    'accept-ranges',
    'content-range',
    'content-length',
    'content-type',
    'content-disposition',
    'etag',
    'server-timing',
    'x-request-id',
    'x-handler-ms',
    'x-runtime-uptime-ms',
    'x-cold-start',
    'x-store-ms',
    'x-media-ms'
  ];

  const encodeS3LikePath = (key: string): string => key.split('/').map((part) => encodeURIComponent(part)).join('/');
  const writeLocalMediaSource = async (key: string, body: Buffer): Promise<void> => {
    if (!config.localMediaDirectory) throw new Error('Local media storage is not configured.');
    const base = resolve(config.localMediaDirectory);
    const target = resolve(base, key);
    if (target !== base && !target.startsWith(`${base}/`)) throw new Error('Invalid local media key.');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  };
  const publicMediaUrl = async (key?: string, localOrigin?: string): Promise<string | undefined> => {
    if (!key) return undefined;
    if (config.localMediaDirectory) {
      const localPublicOrigin = config.appOrigin
        ? `${config.appOrigin.replace(/\/$/, '')}/local-api`
        : (localOrigin || 'http://localhost:4000').replace(/\/$/, '');
      return `${localPublicOrigin}/media/local/${encodeS3LikePath(key)}`;
    }
    if (mediaCdnDomain) {
      return `https://${mediaCdnDomain}/${encodeS3LikePath(key)}`;
    }
    return getS3SignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: config.mediaBucket, Key: key }),
      { expiresIn: config.signedUrlTtlSeconds }
    );
  };

  const publicProfileBranding = async (branding?: Creator['branding'], requestOrigin?: string) => ({
    profileImage: branding?.profileImage ? {
      altText: branding.profileImage.altText,
      updatedAt: branding.profileImage.updatedAt,
      thumbnailUrls: branding.profileImage.thumbnailKeys
        ? Object.fromEntries(
            await Promise.all(
              Object.entries(branding.profileImage.thumbnailKeys)
                .map(async ([name, key]) => [name, await publicMediaUrl(key, requestOrigin)])
            )
          )
        : undefined
    } : undefined,
    coverImage: branding?.coverImage ? {
      altText: branding.coverImage.altText,
      updatedAt: branding.coverImage.updatedAt,
      renditionUrls: branding.coverImage.renditionKeys
        ? Object.fromEntries(
            await Promise.all(
              Object.entries(branding.coverImage.renditionKeys)
                .map(async ([name, key]) => [name, await publicMediaUrl(key, requestOrigin)])
            )
          )
        : undefined
    } : undefined
  });

  const buildPostMediaPayload = async (
    ref: Post['media'][number],
    mediaById: Map<string, Media>
  ) => {
    const source = mediaById.get(ref.mediaId);
    if (!source) return null;
    const comparisonSource = ref.comparison?.comparisonItem?.mediaId
      ? mediaById.get(ref.comparison.comparisonItem.mediaId)
      : undefined;
    const buildThumbnailUrls = async (thumbnailKeys?: Media['thumbnailKeys']) => thumbnailKeys
      ? Object.fromEntries(
          await Promise.all(
            Object.entries(thumbnailKeys).map(async ([name, key]) => [
              name,
              await publicMediaUrl(key)
            ])
          )
        )
      : undefined;
    return {
      mediaId: source.mediaId,
      assetType: (source.assetType || 'image') as 'image' | 'video' | 'audio',
      title: source.title || source.originalFilename || source.mediaId,
      previewUrl: await publicMediaUrl(source.previewKey),
      previewPosterUrl: await publicMediaUrl(source.previewPosterKey),
      thumbnailUrls: await buildThumbnailUrls(source.thumbnailKeys),
      width: source.width,
      height: source.height,
      discoverable: ref.discoverable !== false,
      sortOrder: ref.sortOrder ?? 0,
      caption: ref.caption,
      credit: ref.credit,
      comparison: ref.comparison
        ? {
            type: ref.comparison.type,
            role: ref.comparison.role,
            order: ref.comparison.order,
            comparisonItem: comparisonSource
              ? {
                  mediaId: comparisonSource.mediaId,
                  assetType: (comparisonSource.assetType || 'image') as 'image' | 'video' | 'audio',
                  title: comparisonSource.title || comparisonSource.originalFilename || comparisonSource.mediaId,
                  previewUrl: await publicMediaUrl(comparisonSource.previewKey),
                  previewPosterUrl: await publicMediaUrl(comparisonSource.previewPosterKey),
                  thumbnailUrls: await buildThumbnailUrls(comparisonSource.thumbnailKeys),
                  width: comparisonSource.width,
                  height: comparisonSource.height,
                  role: ref.comparison.comparisonItem?.role,
                  order: ref.comparison.comparisonItem?.order,
                  caption: ref.comparison.comparisonItem?.caption,
                  credit: ref.comparison.comparisonItem?.credit
                }
              : undefined
          }
        : undefined
    };
  };

  const privateMediaUrl = async (key?: string): Promise<string | undefined> => {
    if (!key) return undefined;
    const normalizedKey = key.replace(/^\/+/, '');
    if (premiumMediaCdnDomain && config.cloudFrontKeyPairId && cloudFrontPrivateKey) {
      const dateLessThan = new Date(Date.now() + (config.signedUrlTtlSeconds * 1000)).toISOString();
      return getCloudFrontSignedUrl({
        url: `https://${premiumMediaCdnDomain}/${encodeS3LikePath(normalizedKey)}`,
        keyPairId: config.cloudFrontKeyPairId,
        privateKey: cloudFrontPrivateKey,
        dateLessThan
      });
    }
    return getS3SignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: config.mediaBucket, Key: key }),
      { expiresIn: config.signedUrlTtlSeconds }
    );
  };

  const hasPremiumAccess = async (req: express.Request, groupingId: string): Promise<boolean> => {
    if (req.authUser?.userId && await store.hasGroupingAccess(req.authUser.userId, groupingId)) {
      return true;
    }

    const token = req.headers['x-grouping-access-token'];
    if (typeof token === 'string') {
      try {
        const payload = verifyUnlockToken(token, config.unlockJwtSecret);
        if (payload.groupingId === groupingId && payload.tokenType === 'remember') {
          return true;
        }
      } catch {
        // ignore invalid token
      }
    }
    return false;
  };

  const buildDefaultProfile = (userId: string, authDisplayName: string): UserProfile => {
    const candidate = normalizeUsername(authDisplayName.split('@')[0] || authDisplayName || `user-${userId.slice(0, 8)}`);
    const username = /^[a-z0-9-]{3,30}$/.test(candidate) ? candidate : `user-${userId.slice(0, 8)}`;
    const now = new Date().toISOString();
    return {
      userId,
      username,
      usernameHistory: [username],
      displayName: authDisplayName,
      matureContentEnabled: false,
      maxAllowedContentRating: 'graphic',
      aiFilter: 'show-all',
      hideHeavyTopics: DEFAULT_VIEWER_DISCLOSURE_POLICY.hideHeavyTopics,
      hidePoliticsPublicAffairs: DEFAULT_VIEWER_DISCLOSURE_POLICY.hidePoliticsPublicAffairs,
      hideCrimeDisastersTragedy: DEFAULT_VIEWER_DISCLOSURE_POLICY.hideCrimeDisastersTragedy,
      createdAt: now,
      updatedAt: now
    };
  };

  const ensureUserProfile = async (req: express.Request): Promise<UserProfile> => {
    const userId = req.authUser!.userId;
    const existing = await store.getUserProfile(userId);
    if (existing) return existing;
    const created = buildDefaultProfile(userId, req.authUser!.displayName);
    let resolvedUsername = created.username;
    let attempt = 0;
    while (attempt < 8) {
      const candidate = attempt === 0 ? resolvedUsername : `${resolvedUsername.slice(0, 24)}-${Math.floor(10 + Math.random() * 89)}`;
      if (await store.isUsernameAvailable(candidate)) {
        resolvedUsername = candidate;
        await store.reserveUsername(resolvedUsername, resolvedUsername, req.authUser!.displayName);
        break;
      }
      attempt += 1;
    }
    created.username = resolvedUsername;
    await store.upsertUserProfile(created);
    return created;
  };

  const resolveViewerContentPolicy = async (
    req: express.Request
  ): Promise<ViewerContentPolicy & { maxAllowedContentRating: ContentRating; disclosurePolicy: ViewerDisclosurePolicy }> => {
    const queryMax = typeof req.query.maxAllowedRating === 'string'
      ? normalizeContentRating(req.query.maxAllowedRating)
      : undefined;
    const queryAiFilter = req.query.aiFilter !== undefined
      ? normalizeAiFilterPreference(req.query.aiFilter)
      : undefined;
    const queryHideHeavyTopics = parseOptionalBoolean(req.query.hideHeavyTopics);
    const queryHidePolitics = parseOptionalBoolean(req.query.hidePoliticsPublicAffairs);
    const queryHideCrime = parseOptionalBoolean(req.query.hideCrimeDisastersTragedy);
    if (!req.authUser?.userId) {
      return {
        loggedIn: false,
        matureEnabled: false,
        maxAllowedContentRating: queryMax || 'graphic',
        disclosurePolicy: normalizeViewerDisclosurePolicy({
          aiFilter: queryAiFilter || 'show-all',
          hideHeavyTopics: queryHideHeavyTopics ?? DEFAULT_VIEWER_DISCLOSURE_POLICY.hideHeavyTopics,
          hidePoliticsPublicAffairs: queryHidePolitics ?? DEFAULT_VIEWER_DISCLOSURE_POLICY.hidePoliticsPublicAffairs,
          hideCrimeDisastersTragedy: queryHideCrime ?? DEFAULT_VIEWER_DISCLOSURE_POLICY.hideCrimeDisastersTragedy
        })
      };
    }
    const profile = await store.getUserProfile(req.authUser.userId);
    const profileMax = profile?.maxAllowedContentRating
      ? normalizeContentRating(profile.maxAllowedContentRating)
      : undefined;
    const baseDisclosurePolicy = profileDisclosurePolicy(profile);
    const disclosurePolicy = normalizeViewerDisclosurePolicy({
      aiFilter: queryAiFilter ?? baseDisclosurePolicy.aiFilter,
      hideHeavyTopics: queryHideHeavyTopics ?? baseDisclosurePolicy.hideHeavyTopics,
      hidePoliticsPublicAffairs: queryHidePolitics ?? baseDisclosurePolicy.hidePoliticsPublicAffairs,
      hideCrimeDisastersTragedy: queryHideCrime ?? baseDisclosurePolicy.hideCrimeDisastersTragedy
    });
    return {
      loggedIn: true,
      matureEnabled: Boolean(profile?.matureContentEnabled),
      maxAllowedContentRating: queryMax || profileMax || 'graphic',
      disclosurePolicy
    };
  };

  const projectContentRating = (effectiveContentRating: ContentRating, viewer: ViewerContentPolicy) => ({
    effectiveContentRating: getPublicFacingRating(effectiveContentRating, viewer),
    displayedContentRating: getDisplayedRating(effectiveContentRating, viewer),
    blurred: shouldBlurContent(effectiveContentRating, viewer)
  });

  const projectDisclosures = (
    effectiveAiDisclosure: AiDisclosure,
    effectiveHeavyTopics: HeavyTopic[]
  ) => ({
    effectiveAiDisclosure,
    displayedAiDisclosure: effectiveAiDisclosure === 'none' ? undefined : AI_DISCLOSURE_LABEL[effectiveAiDisclosure],
    effectiveHeavyTopics,
    displayedHeavyTopics: effectiveHeavyTopics.map((topic) => HEAVY_TOPIC_LABEL[topic]).filter((label): label is string => Boolean(label))
  });

  const isAdminRequest = (req: express.Request): boolean => {
    if (!req.authUser) return false;
    return resolveRole(req.authUser) === 'admin';
  };

  const getCreatorMembership = async (creatorId: string, userId: string): Promise<CreatorMember | null> => {
    const members = await store.listCreatorMembers(creatorId);
    return members.find((member) => member.userId === userId) || null;
  };

  const ensureCreatorContentAccess = async (req: express.Request, res: express.Response, creatorId: string): Promise<boolean> => {
    if (!req.authUser) {
      res.status(401).json({ message: 'Authentication required' });
      return false;
    }
    if (!creatorId) {
      res.status(400).json({ message: 'creator is required' });
      return false;
    }
    if (isAdminRequest(req)) return true;
    const allowed = await store.hasCreatorAccess(req.authUser.userId, creatorId);
    if (!allowed) {
      res.status(403).json({ message: 'Creator access required' });
      return false;
    }
    return true;
  };

  const ensureCreatorAccountAccess = async (req: express.Request, res: express.Response, creatorId: string): Promise<boolean> => {
    if (!(await ensureCreatorContentAccess(req, res, creatorId))) return false;
    if (isAdminRequest(req)) return true;
    const membership = await getCreatorMembership(creatorId, req.authUser!.userId);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'manager')) {
      res.status(403).json({ message: 'Owner or manager role required' });
      return false;
    }
    return true;
  };

  type BlueskyConnectionProof = {
    purpose: 'bluesky_studio_connection';
    stateHash: string;
    did: string;
    handle?: string;
  };

  const verifyBlueskyConnectionProof = async (proof: string, state: string): Promise<BlueskyConnectionProof> => {
    const serviceUrl = config.blueskyOAuthServiceUrl?.replace(/\/$/, '');
    const jwksUrl = config.blueskyOAuthServiceJwksUrl;
    if (!serviceUrl || !jwksUrl) throw new Error('Bluesky OAuth is not configured for this deployment.');
    const decoded = jwt.decode(proof, { complete: true });
    const kid = decoded && typeof decoded === 'object' && typeof decoded.header?.kid === 'string'
      ? decoded.header.kid
      : '';
    if (!kid) throw new Error('The Bluesky connection proof has no signing key.');
    const response = await fetch(jwksUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('The Bluesky connection proof could not be verified.');
    const keyset = await response.json() as { keys?: Array<{ kid?: string; kty?: string; crv?: string } & Record<string, unknown>> };
    const jwk = keyset.keys?.find((item) => item.kid === kid && item.kty === 'EC' && item.crv === 'P-256');
    if (!jwk) throw new Error('The Bluesky connection proof uses an unknown signing key.');
    const verified = jwt.verify(proof, createPublicKey({ key: jwk as unknown as import('crypto').JsonWebKey, format: 'jwk' }), {
      algorithms: ['ES256'],
      issuer: `${serviceUrl}/oauth/bluesky/client-metadata.json`,
      audience: 'ubeeq-studio'
    }) as Partial<BlueskyConnectionProof>;
    const expectedStateHash = createHash('sha256').update(state).digest('base64url');
    if (
      verified.purpose !== 'bluesky_studio_connection'
      || verified.stateHash !== expectedStateHash
      || typeof verified.did !== 'string'
      || !/^did:[a-z0-9:%._-]+$/i.test(verified.did)
    ) throw new Error('The Bluesky connection proof is invalid.');
    if (verified.handle !== undefined && (typeof verified.handle !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,252}[a-z0-9]$/i.test(verified.handle))) {
      throw new Error('The Bluesky connection proof is invalid.');
    }
    return verified as BlueskyConnectionProof;
  };

  const auditLog = (
    req: express.Request,
    action: string,
    detail?: Record<string, unknown>
  ) => {
    const event = {
      auditId: randomUUID(),
      time: new Date().toISOString(),
      action,
      actorUserId: req.authUser?.userId || null,
      actorRole: req.authUser ? resolveRole(req.authUser) : 'public',
      ip: req.ip,
      ...detail
    };
    console.info(`[audit] ${JSON.stringify(event)}`);
    void store.appendAuditEvent({
      auditId: event.auditId,
      action: event.action,
      actorUserId: event.actorUserId,
      actorRole: event.actorRole as 'public' | 'user' | 'creator' | 'admin',
      ip: event.ip,
      detail,
      createdAt: event.time
    }).catch(() => undefined);
  };

  const withIdempotency = async (
    req: express.Request,
    operation: () => Promise<{ status: number; body?: unknown }>
  ): Promise<{ status: number; body?: unknown }> => {
    const header = req.header('x-idempotency-key');
    if (!header) return operation();
    const scopeKey = `${req.authUser?.userId || 'anon'}:${req.method}:${req.path}`;
    const cached = await store.getIdempotencyRecord(scopeKey, header);
    if (cached) {
      return { status: cached.status, body: cached.body };
    }
    const result = await operation();
    const nowIso = new Date().toISOString();
    const expiresAtIso = new Date(Date.now() + 10 * 60_000).toISOString();
    await store.putIdempotencyRecord({
      scopeKey,
      idempotencyKey: header,
      status: result.status,
      body: result.body,
      createdAt: nowIso,
      expiresAt: expiresAtIso
    });
    return result;
  };

  const resolveOwnerProfile = async (
    req: express.Request,
    body: unknown
  ): Promise<{ ownerProfileType: 'user' | 'creator'; ownerProfileId: string } | null> => {
    const payload = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
    const requestedType = payload.ownerProfileType === 'creator' ? 'creator' : 'user';
    if (requestedType === 'creator') {
      const creator = typeof payload.ownerProfileId === 'string' ? payload.ownerProfileId : '';
      if (!creator) return null;
      if (!(await store.hasCreatorAccess(req.authUser!.userId, creator)) && !isAdminRequest(req)) {
        return null;
      }
      return { ownerProfileType: 'creator', ownerProfileId: creator };
    }
    return { ownerProfileType: 'user', ownerProfileId: req.authUser!.userId };
  };

  const canManageCollection = async (req: express.Request, collection: { ownerUserId: string; ownerProfileType?: 'user' | 'creator'; ownerProfileId?: string }): Promise<boolean> => {
    if (isAdminRequest(req)) return true;
    const profileType = collection.ownerProfileType || 'user';
    const profileId = collection.ownerProfileId || collection.ownerUserId;
    if (profileType === 'user') {
      return req.authUser!.userId === collection.ownerUserId;
    }
    return store.hasCreatorAccess(req.authUser!.userId, profileId);
  };

  const listVisibleCreators = async (req: express.Request): Promise<Array<Creator & { creatorId: string }>> => {
    const creators = isAdminRequest(req)
      ? await store.listCreators()
      : await store.listCreatorsByUserId(req.authUser!.userId);
    return creators.map((creator) => ({ ...creator, creatorId: creator.creatorId }));
  };

  const listVisibleCreatorIds = async (req: express.Request): Promise<Set<string>> =>
    new Set((await listVisibleCreators(req)).map((creator) => creator.creatorId));

  const listVisibleCreatorFiles = async (req: express.Request): Promise<SourceFile[]> => {
    const files = store.listAllSourceFiles ? await store.listAllSourceFiles() : [];
    if (isAdminRequest(req)) return files;
    const allowedCreatorIds = await listVisibleCreatorIds(req);
    return files.filter((file) => allowedCreatorIds.has(file.creatorId));
  };

  const listVisibleCreatorGroupings = async (req: express.Request): Promise<Grouping[]> => {
    const groupings = await store.listAllGroupings();
    if (isAdminRequest(req)) {
      return groupings.map((grouping) => ({ ...grouping, premiumPasswordHash: undefined }));
    }
    const allowedCreatorIds = await listVisibleCreatorIds(req);
    return groupings
      .filter((grouping) => allowedCreatorIds.has(grouping.creatorId))
      .map((grouping) => ({ ...grouping, premiumPasswordHash: undefined }));
  };

  const listVisibleCreatorPosts = async (req: express.Request, requestedCreatorId?: string): Promise<Post[]> => {
    if (requestedCreatorId) {
      return store.listPostsByCreatorId(requestedCreatorId);
    }
    if (isAdminRequest(req)) {
      return store.listAllPosts();
    }
    const creators = await store.listCreatorsByUserId(req.authUser!.userId);
    const postLists = await Promise.all(creators.map((creator) => store.listPostsByCreatorId(creator.creatorId)));
    return postLists.flat();
  };

  const listCreatorSubmissions = async (req: express.Request): Promise<ContextSubmission[]> => {
    if (!store.listContributionContexts || !store.listContextSubmissions) return [];
    const contexts = await store.listContributionContexts();
    const allSubmissions = (
      await Promise.all(contexts.map((context) => store.listContextSubmissions!(context.contextId)))
    ).flat();
    if (isAdminRequest(req)) return allSubmissions;
    return allSubmissions.filter((submission) => submission.userId === req.authUser!.userId);
  };

  const toPublicComment = (comment: Comment): Omit<Comment, 'userId'> => ({
    commentId: comment.commentId,
    authorProfileType: comment.authorProfileType || 'user',
    authorProfileId: comment.authorProfileId || 'profile',
    displayName: comment.displayName,
    targetType: comment.targetType,
    targetId: comment.targetId,
    body: comment.body,
    hidden: comment.hidden,
    createdAt: comment.createdAt
  });

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

  const isHiddenByVisibility = (visibility?: 'public' | 'hidden' | 'removed'): boolean => {
    return visibility === 'hidden' || visibility === 'removed';
  };

  const resolveTrendingPreviewKeys = (
    item: Pick<Media, 'assetType' | 'thumbnailKeys' | 'previewPosterKey' | 'previewKey'>
  ): { previewKey?: string; previewPosterKey?: string } => {
    const assetType = (item.assetType || 'image') === 'video' ? 'video' : 'image';
    if (assetType === 'video') {
      return {
        // Keep previewKey as media bytes for modal playback.
        previewKey: item.previewKey,
        // Prefer explicit poster, then generated image renditions when available.
        previewPosterKey: item.previewPosterKey || item.thumbnailKeys?.w640 || item.thumbnailKeys?.w320
      };
    }
    return {
      previewKey: item.thumbnailKeys?.w640 || item.thumbnailKeys?.w320 || item.previewKey,
      previewPosterKey: undefined
    };
  };

  const resolveGroupingThumbnail = async (grouping: Grouping): Promise<{ groupingThumbnailUrl?: string; groupingThumbnailMediaId?: string }> => {
    const mediaItems = await store.getMediaByGrouping(grouping.groupingId);
    const cover = mediaItems.find((item) => item.mediaId === grouping.coverImageId) || mediaItems[0];
    if (!cover) return {};
    const key = cover.thumbnailKeys?.square512 || cover.thumbnailKeys?.square256 || cover.previewPosterKey || cover.previewKey;
    const groupingThumbnailUrl = await publicMediaUrl(key);
    return { groupingThumbnailUrl, groupingThumbnailMediaId: cover.mediaId };
  };

  const resolveGroupingStackPreviewUrls = async (grouping: Grouping): Promise<string[]> => {
    const mediaItems = await store.getMediaByGrouping(grouping.groupingId);
    if (!mediaItems.length) return [];
    const sorted = [...mediaItems].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const coverFirst = grouping.coverImageId
      ? [
        ...sorted.filter((item) => item.mediaId === grouping.coverImageId),
        ...sorted.filter((item) => item.mediaId !== grouping.coverImageId)
      ]
      : sorted;
    const keys = coverFirst
      .map((item) => item.thumbnailKeys?.w640 || item.thumbnailKeys?.w320 || item.previewPosterKey || item.previewKey)
      .filter((value): value is string => Boolean(value));
    const uniqueKeys = Array.from(new Set(keys)).slice(0, 3);
    return Promise.all(uniqueKeys.map((key) => publicMediaUrl(key))).then((urls) => urls.filter((url): url is string => Boolean(url)));
  };

  type TrendingImageItem = {
    imageId: string;
    assetType: 'image' | 'video' | 'audio';
    postType?: 'image' | 'video' | 'story' | 'audio';
    postFormat?: 'single' | 'multi' | 'short' | 'long';
    surfaceType?: 'media' | 'post';
    postId?: string;
    postSlug?: string;
    postTitle?: string;
    postSummary?: string;
    creatorId: string;
    creatorName: string;
    groupingId: string;
    groupingSlug: string;
    groupingVisibility: 'free' | 'preview';
    discoverSquareCropEnabled: boolean;
    effectiveContentRating: ContentRating;
    displayedContentRating: string;
    blurred: boolean;
    effectiveAiDisclosure: AiDisclosure;
    displayedAiDisclosure?: string;
    effectiveHeavyTopics: HeavyTopic[];
    displayedHeavyTopics: string[];
    title: string;
    previewUrl: string;
    previewPosterUrl?: string;
    thumbnailUrls?: {
      w320?: string;
      w640?: string;
      w1280?: string;
      w1920?: string;
      square256?: string;
      square512?: string;
      square1024?: string;
    };
    width?: number;
    height?: number;
    aspectRatio?: number;
    favoriteCount: number;
    createdAt: string;
    score: number;
  };

  const hydrateCollectionItems = async (
    collection: Collection,
    imageIds: string[],
    viewerPolicy: ViewerContentPolicy
  ): Promise<Array<Omit<TrendingImageItem, 'score'>>> => {
    const orderedIds = imageIds.filter(Boolean);
    if (!orderedIds.length) return [];

    const wantedIds = new Set(orderedIds);
    const mediaById = new Map<string, Media>();
    const placementById = new Map<string, { groupingId: string }>();

    const creators = await store.listCreators();
    const creatorById = new Map(creators.map((creator) => [creator.creatorId, creator]));
    const creatorIds = collection.ownerProfileType === 'creator' && collection.ownerProfileId
      ? [collection.ownerProfileId]
      : creators.map((creator) => creator.creatorId);

    await Promise.all(creatorIds.map(async (creatorId) => {
      const mediaItems = await store.listMediaByCreator(creatorId);
      for (const item of mediaItems) {
        if (wantedIds.has(item.mediaId)) mediaById.set(item.mediaId, item);
      }
    }));

    await Promise.all(orderedIds.map(async (imageId) => {
      const placements = await store.listMediaGroupingPlacements(imageId);
      const firstPlacement = placements[0];
      if (firstPlacement) placementById.set(imageId, { groupingId: firstPlacement.groupingId });
      if (mediaById.has(imageId) || !firstPlacement) return;
      const groupingMedia = await store.getMediaByGrouping(firstPlacement.groupingId);
      const media = groupingMedia.find((item) => item.mediaId === imageId);
      if (media) mediaById.set(imageId, media);
    }));

    const groupingIds = Array.from(new Set(Array.from(placementById.values()).map((item) => item.groupingId).filter(Boolean)));
    const groupingById = new Map<string, Grouping>();
    if (groupingIds.length) {
      const groupings = await store.listAllGroupings();
      for (const grouping of groupings) {
        if (groupingIds.includes(grouping.groupingId)) groupingById.set(grouping.groupingId, grouping);
      }
    }

    const favoriteCounts = await store.getImageFavoriteCounts(orderedIds);
    const thumbnailUrlsFor = async (thumbnailKeys?: Media['thumbnailKeys']) => thumbnailKeys
      ? Object.fromEntries(
          await Promise.all(
            Object.entries(thumbnailKeys).map(async ([name, key]) => [
              name,
              key ? await publicMediaUrl(key) : undefined
            ])
          )
        )
      : undefined;

    const items: Array<Omit<TrendingImageItem, 'score'> | null> = await Promise.all(orderedIds.map(async (imageId): Promise<Omit<TrendingImageItem, 'score'> | null> => {
      const media = mediaById.get(imageId);
      if (!media) return null;
      const placement = placementById.get(imageId);
      const grouping = placement?.groupingId ? groupingById.get(placement.groupingId) : undefined;
      const creator = creatorById.get(media.creatorId);
      const effectiveContentRating = getEffectiveContentRating(media);
      const contentProjection = projectContentRating(effectiveContentRating, viewerPolicy);
      const disclosureProjection = projectDisclosures(getEffectiveAiDisclosure(media, grouping), getEffectiveHeavyTopics(media, grouping));
      const previewUrl = await publicMediaUrl(media.previewKey);
      if (!previewUrl) return null;
      return {
        imageId: media.mediaId,
        assetType: (media.assetType || 'image') as 'image' | 'video' | 'audio',
        creatorId: media.creatorId,
        creatorName: creator?.name || media.creatorId,
        groupingId: grouping?.groupingId || placement?.groupingId || '',
        groupingSlug: grouping?.slug || '',
        groupingVisibility: grouping?.visibility === 'premium' ? 'preview' : (grouping?.visibility || 'free'),
        discoverSquareCropEnabled: Boolean(media.discoverSquareCropEnabled || grouping?.discoverSquareCropEnabled),
        effectiveContentRating: contentProjection.effectiveContentRating,
        displayedContentRating: contentProjection.displayedContentRating,
        blurred: contentProjection.blurred,
        effectiveAiDisclosure: disclosureProjection.effectiveAiDisclosure,
        displayedAiDisclosure: disclosureProjection.displayedAiDisclosure,
        effectiveHeavyTopics: disclosureProjection.effectiveHeavyTopics,
        displayedHeavyTopics: disclosureProjection.displayedHeavyTopics,
        title: media.title || media.originalFilename || media.mediaId,
        previewUrl,
        previewPosterUrl: await publicMediaUrl(media.previewPosterKey),
        thumbnailUrls: await thumbnailUrlsFor(media.thumbnailKeys),
        width: media.width,
        height: media.height,
        aspectRatio: media.width && media.height ? media.width / media.height : undefined,
        favoriteCount: Math.max(0, Number(favoriteCounts[media.mediaId] || 0)),
        createdAt: media.createdAt
      };
    }));

    return items.filter((item): item is Omit<TrendingImageItem, 'score'> => Boolean(item));
  };

  type DiscoveryItemType = 'image' | 'video' | 'story' | 'audio';
  type DiscoveryItemTypeFilter = {
    image: boolean;
    video: boolean;
    story: boolean;
    audio: boolean;
  };

  const normalizePostType = (post: Pick<Post, 'metadata' | 'blocks' | 'media' | 'primaryMediaId'>, mediaById?: Map<string, Pick<Media, 'mediaId' | 'assetType'>>): DiscoveryItemType => {
    const raw = (post.metadata?.postType || post.metadata?.type || post.metadata?.kind || '').toLowerCase();
    if (raw === 'image' || raw === 'images' || raw === 'photo' || raw === 'photos') return 'image';
    if (raw === 'video' || raw === 'videos' || raw === 'short' || raw === 'shorts' || raw === 'reel' || raw === 'reels') return 'video';
    if (raw === 'audio' || raw === 'track' || raw === 'album') return 'audio';
    if (raw === 'story' || raw === 'stories' || raw === 'blocks' || raw === 'article' || raw === 'reading' || raw === 'fiction') return 'story';

    const primaryId = post.primaryMediaId || post.media[0]?.mediaId;
    const primary = primaryId ? mediaById?.get(primaryId) : undefined;
    if (primary?.assetType === 'video') return 'video';
    if (primary?.assetType === 'audio') return 'audio';
    if (primary?.assetType === 'image' && post.blocks.length <= 2) return 'image';
    if (post.blocks.some((block) => block.type === 'audio')) return 'audio';
    if (post.blocks.some((block) => block.type === 'video')) return 'video';
    return 'story';
  };

  const normalizePostFormat = (
    post: Pick<Post, 'metadata' | 'blocks' | 'media'>,
    postType: DiscoveryItemType
  ): 'single' | 'multi' | 'short' | 'long' => {
    const raw = (post.metadata?.postFormat || post.metadata?.format || '').toLowerCase();
    if ((postType === 'image' || postType === 'audio') && (raw === 'single' || raw === 'multi' || raw === 'album')) {
      return raw === 'album' ? 'multi' : raw;
    }
    if ((postType === 'video' || postType === 'story') && (raw === 'short' || raw === 'long')) return raw;
    if (postType === 'story') return post.blocks.filter((block) => block.type === 'paragraph').length >= 6 ? 'long' : 'short';
    if (postType === 'video') return post.metadata?.videoFormat === 'short' || post.metadata?.layout === 'short' ? 'short' : 'long';
    if (postType === 'audio') return post.media.length > 1 ? 'multi' : 'single';
    return post.media.length > 1 ? 'multi' : 'single';
  };

  const getYouTubeEmbedInfo = (url?: string): { videoId: string; thumbnailUrl: string; isShort: boolean } | null => {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
      let videoId = '';
      let isShort = false;
      if (hostname === 'youtu.be') {
        videoId = parsed.pathname.split('/').filter(Boolean)[0] || '';
      } else if (hostname === 'youtube.com' || hostname === 'm.youtube.com' || hostname === 'youtube-nocookie.com') {
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts[0] === 'shorts') {
          videoId = parts[1] || '';
          isShort = true;
        } else if (parts[0] === 'embed') {
          videoId = parts[1] || '';
        } else {
          videoId = parsed.searchParams.get('v') || '';
        }
      }
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return null;
      return {
        videoId,
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        isShort
      };
    } catch {
      return null;
    }
  };

  const findYouTubeEmbedInfo = (blocks: Post['blocks']): { videoId: string; thumbnailUrl: string; isShort: boolean } | null => {
    for (const block of blocks) {
      if (block.type === 'embed') {
        const provider = typeof block.payload?.provider === 'string' ? block.payload.provider.toLowerCase() : '';
        const info = provider === 'youtube' || provider === 'youtube-shorts' || !provider
          ? getYouTubeEmbedInfo(block.url)
          : null;
        if (info) {
          return {
            ...info,
            isShort: info.isShort || block.payload?.format === 'short' || block.payload?.layout === 'short'
          };
        }
      }
      if (block.blocks?.length) {
        const child = findYouTubeEmbedInfo(block.blocks);
        if (child) return child;
      }
    }
    return null;
  };

  const normalizeDiscoveryItemType = (value: string): DiscoveryItemType | null => {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === 'image' || normalized === 'images') return 'image';
    if (normalized === 'video' || normalized === 'videos') return 'video';
    if (normalized === 'story' || normalized === 'stories' || normalized === 'post' || normalized === 'posts') return 'story';
    if (normalized === 'audio' || normalized === 'audios' || normalized === 'track' || normalized === 'tracks') return 'audio';
    return null;
  };

  const parseDiscoveryItemTypes = (req: express.Request): DiscoveryItemTypeFilter => {
    const values: string[] = [];
    const fromItemTypes = req.query.itemTypes;
    const fromTypes = req.query.types;
    if (typeof fromItemTypes === 'string') values.push(fromItemTypes);
    else if (Array.isArray(fromItemTypes)) values.push(...fromItemTypes.map((entry) => String(entry)));
    if (typeof fromTypes === 'string') values.push(fromTypes);
    else if (Array.isArray(fromTypes)) values.push(...fromTypes.map((entry) => String(entry)));

    const tokens = values
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean);

    if (tokens.length === 0) {
      return { image: true, video: true, story: true, audio: true };
    }

    const selected = new Set<DiscoveryItemType>();
    for (const token of tokens) {
      const normalized = normalizeDiscoveryItemType(token);
      if (normalized) selected.add(normalized);
    }

    if (selected.size === 0) {
      return { image: true, video: true, story: true, audio: true };
    }

    return {
      image: selected.has('image'),
      video: selected.has('video'),
      story: selected.has('story'),
      audio: selected.has('audio')
    };
  };

  const sanitizePostMetadata = (value: unknown): Record<string, string> => (
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([key, item]) => typeof key === 'string' && typeof item === 'string')
            .map(([key, item]) => [key.slice(0, 120), String(item).slice(0, 1000)])
        )
      : {}
  );

  const metadataWithPostType = (body: unknown, existing?: Record<string, string>): Record<string, string> => {
    const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const metadata = raw.metadata !== undefined ? sanitizePostMetadata(raw.metadata) : { ...(existing || {}) };
    const postType = typeof raw.postType === 'string' ? normalizeDiscoveryItemType(raw.postType) : null;
    if (postType) metadata.postType = postType;
    const postFormat = typeof raw.postFormat === 'string' ? raw.postFormat.trim().toLowerCase() : '';
    if (postFormat === 'single' || postFormat === 'multi' || postFormat === 'short' || postFormat === 'long' || postFormat === 'album') {
      metadata.postFormat = postFormat === 'album' ? 'multi' : postFormat;
    }
    return metadata;
  };

  const computeTrendingImages = async (
    _req: express.Request,
    opts?: {
      period?: 'hourly' | 'daily';
      cursor?: string;
      limit?: number;
      creatorId?: string;
      source?: 'media' | 'post' | 'combined';
      itemTypes?: DiscoveryItemTypeFilter;
    }
  ): Promise<{
    period: 'hourly' | 'daily';
    items: Omit<TrendingImageItem, 'score'>[];
    nextCursor?: string;
    metrics: { candidateCount: number; scoredCount: number; groupingCount: number };
  }> => {
    const period = opts?.period === 'hourly' ? 'hourly' : 'daily';
    const source: 'media' | 'post' | 'combined' = opts?.source === 'media' || opts?.source === 'post' || opts?.source === 'combined'
      ? opts.source
      : 'post';
    const itemTypes = opts?.itemTypes || { image: true, video: true, story: true, audio: true };
    const limit = Math.max(1, Math.min(60, Number(opts?.limit || 24)));
    const candidateLimit = Math.max(
      120,
      Math.min(
        800,
        Math.min(
          Math.max(120, Number(config.trendingCandidateLimit || 1500)),
          limit * 12
        )
      )
    );
    const offset = parseOffsetCursor(opts?.cursor);
    const nowMs = Date.now();
    const periodMs = period === 'hourly' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const viewerPolicy = await resolveViewerContentPolicy(_req);

    let allCreators: Creator[] = [];
    try {
      allCreators = await store.listCreators();
    } catch (error) {
      logServerError('computeTrendingImages:listCreators', error);
      return { period, items: [], metrics: { candidateCount: 0, scoredCount: 0, groupingCount: 0 } };
    }
    const creatorById = new Map(allCreators.map((creator) => [creator.creatorId, creator]));
    const activeCreatorIds = new Set(allCreators.filter((creator) => creator.status === 'active').map((creator) => creator.creatorId));

    const allGalleries = (await store.listAllGroupings()).filter((grouping) => {
      if (opts?.creatorId && grouping.creatorId !== opts.creatorId) return false;
      if (grouping.status !== 'published') return false;
      if (grouping.visibility === 'premium') return false;
      if (!activeCreatorIds.has(grouping.creatorId)) return false;
      if (isHiddenByVisibility(grouping.releaseVisibility)) return false;
      // Public discovery feed intentionally ignores follower/admin early-access windows.
      return canViewBySchedule(grouping.publishAt, grouping.publicReleaseAt, nowMs, false);
    });
    const groupingById = new Map(allGalleries.map((grouping) => [grouping.groupingId, grouping]));
    const groupingByCreatorId = new Map<string, Grouping>();
    for (const grouping of allGalleries) {
      if (!groupingByCreatorId.has(grouping.creatorId)) groupingByCreatorId.set(grouping.creatorId, grouping);
    }
    const candidates: Array<{
      imageId: string;
      assetType: 'image' | 'video' | 'audio';
      postType?: DiscoveryItemType;
      postFormat?: 'single' | 'multi' | 'short' | 'long';
      surfaceType: 'media' | 'post';
      creatorId: string;
      groupingId: string;
      groupingSlug: string;
      groupingVisibility: 'free' | 'preview';
      postId?: string;
      postSlug?: string;
      postTitle?: string;
      postSummary?: string;
      relatedPostIds: string[];
      isPrimaryPostSurface: boolean;
      discoverSquareCropEnabled: boolean;
      effectiveContentRating: ContentRating;
      effectiveAiDisclosure: AiDisclosure;
      effectiveHeavyTopics: HeavyTopic[];
      title: string;
      thumbnailKeys?: Media['thumbnailKeys'];
      createdAt: string;
      createdAtMs: number;
      recencyBoost: number;
      previewKey?: string;
      previewPosterKey?: string;
      externalPreviewUrl?: string;
      externalPreviewPosterUrl?: string;
      width: number;
      height: number;
      aspectRatio: number;
    }> = [];
    const mediaPostLinks = new Map<string, Set<string>>();
    if (source !== 'media') {
      const targetCreators = opts?.creatorId
        ? allCreators.filter((creator) => creator.creatorId === opts.creatorId && creator.status === 'active')
        : allCreators.filter((creator) => creator.status === 'active');
      const perPostSurfaceLimit = 1;
      for (const creatorProfile of targetCreators) {
        const [posts, creatorMedia] = await Promise.all([
          store.listPostsByCreatorId(creatorProfile.creatorId),
          store.listMediaByCreator(creatorProfile.creatorId)
        ]);
      const mediaById = new Map(creatorMedia.map((item) => [item.mediaId, item]));
        const placementByMediaId = new Map<string, Array<{ groupingId: string; position: number }>>();
        const candidateMediaIds = Array.from(new Set(
          posts
            .filter((post) => post.status === 'published')
            .flatMap((post) => post.media.map((ref) => ref.mediaId))
        ));
        const placementRows = await Promise.all(candidateMediaIds.map(async (mediaId) => ({
          mediaId,
          rows: await store.listMediaGroupingPlacements(mediaId)
        })));
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
          const postType = normalizePostType(post, mediaById);
          const postFormat = normalizePostFormat(post, postType);
          if (!itemTypes[postType]) continue;
          const sortedRefs = [...post.media].sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));
          for (const ref of sortedRefs) {
            if (!ref?.mediaId) continue;
            const linked = mediaPostLinks.get(ref.mediaId) || new Set<string>();
            linked.add(post.postId);
            mediaPostLinks.set(ref.mediaId, linked);
          }
          const primaryRef = post.primaryMediaId
            ? sortedRefs.find((ref) => ref.mediaId === post.primaryMediaId)
            : undefined;
          const selectedRefs = sortedRefs.filter((ref) => ref.discoverable !== false);
          const refs = primaryRef ? [primaryRef] : selectedRefs.slice(0, 1);
          const limitedRefs = refs.slice(0, perPostSurfaceLimit);
          if (limitedRefs.length === 0 && postType === 'video') {
            const youtube = findYouTubeEmbedInfo(post.blocks);
            const placedGrouping = groupingByCreatorId.get(creatorProfile.creatorId);
            if (youtube && placedGrouping) {
              const createdAtMs = asTime(post.publishedAt || post.createdAt) || nowMs;
              candidates.push({
                imageId: `youtube:${youtube.videoId}`,
                assetType: 'video',
                postType,
                postFormat: youtube.isShort ? 'short' : postFormat,
                surfaceType: 'post',
                creatorId: creatorProfile.creatorId,
                groupingId: placedGrouping.groupingId,
                groupingSlug: placedGrouping.slug,
                groupingVisibility: placedGrouping.visibility === 'preview' ? 'preview' : 'free',
                postId: post.postId,
                postSlug: post.slug,
                postTitle: post.title,
                postSummary: post.summary,
                relatedPostIds: [post.postId],
                isPrimaryPostSurface: true,
                discoverSquareCropEnabled: false,
                effectiveContentRating: 'general',
                effectiveAiDisclosure: creatorProfile.defaultAiDisclosure || 'none',
                effectiveHeavyTopics: creatorProfile.defaultHeavyTopics || [],
                title: post.title || 'Video post',
                thumbnailKeys: undefined,
                createdAt: post.publishedAt || post.createdAt,
                createdAtMs,
                recencyBoost: Math.max(0, 1 - Math.min(1, (nowMs - createdAtMs) / periodMs)),
                previewKey: undefined,
                previewPosterKey: undefined,
                externalPreviewUrl: youtube.thumbnailUrl,
                externalPreviewPosterUrl: youtube.thumbnailUrl,
                width: youtube.isShort ? 1080 : 1280,
                height: youtube.isShort ? 1920 : 720,
                aspectRatio: youtube.isShort ? 0.5625 : 1.77778
              });
            }
          }
          for (let refIndex = 0; refIndex < limitedRefs.length; refIndex += 1) {
            const ref = limitedRefs[refIndex];
            const item = mediaById.get(ref.mediaId);
            if (!item) continue;
            if (item.appearsInFeed === false) continue;
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
            const assetType = item.assetType === 'video' ? 'video' : item.assetType === 'audio' ? 'audio' : 'image';
            const createdAtMs = asTime(item.createdAt) || nowMs;
            const discoverSquareCropEnabled =
              (creatorProfile.discoverSquareCropEnabled ?? true) &&
              (placedGrouping.discoverSquareCropEnabled ?? true) &&
              (item.discoverSquareCropEnabled ?? true);
            const effectiveContentRating = getEffectiveContentRating(item);
            const effectiveAiDisclosure = getEffectiveAiDisclosure(item, placedGrouping, creatorProfile);
            const effectiveHeavyTopics = getEffectiveHeavyTopics(item, placedGrouping, creatorProfile);
            if (!isRatingAllowed(effectiveContentRating, viewerPolicy.maxAllowedContentRating)) continue;
            if (!passesDisclosureFilter(effectiveAiDisclosure, effectiveHeavyTopics, viewerPolicy.disclosurePolicy)) continue;
            candidates.push({
              imageId: item.mediaId,
              assetType,
              postType,
              postFormat,
              surfaceType: 'post',
              creatorId: item.creatorId,
              groupingId: placedGrouping.groupingId,
              groupingSlug: placedGrouping.slug,
              groupingVisibility: placedGrouping.visibility === 'preview' ? 'preview' : 'free',
              postId: post.postId,
              postSlug: post.slug,
              postTitle: post.title,
              postSummary: post.summary,
              relatedPostIds: [post.postId],
              isPrimaryPostSurface: Boolean(post.primaryMediaId && ref.mediaId === post.primaryMediaId),
              discoverSquareCropEnabled,
              effectiveContentRating,
              effectiveAiDisclosure,
              effectiveHeavyTopics,
              title: item.title || post.title || placedGrouping.title || 'Artwork',
              thumbnailKeys: item.thumbnailKeys,
              createdAt: item.createdAt,
              createdAtMs,
              recencyBoost: Math.max(0, 1 - Math.min(1, (nowMs - createdAtMs) / periodMs)),
              ...resolveTrendingPreviewKeys(item),
              width: Number.isFinite(item.width) && item.width > 0 ? Math.round(item.width) : 0,
              height: Number.isFinite(item.height) && item.height > 0 ? Math.round(item.height) : 0,
              aspectRatio: (
                Number.isFinite(item.width) && item.width > 0
                && Number.isFinite(item.height) && item.height > 0
              )
                ? Number((item.width / item.height).toFixed(5))
                : 1
            });
          }
        }
      }
    }
    const postSurfaceMediaIds = new Set(
      candidates
        .filter((item) => item.surfaceType === 'post')
        .map((item) => item.imageId)
    );
    const filteredCandidates = candidates
      .filter((item) => !(item.surfaceType === 'media' && postSurfaceMediaIds.has(item.imageId)))
      .map((item) => ({
        ...item,
        relatedPostIds: item.surfaceType === 'post'
          ? item.relatedPostIds
          : Array.from(mediaPostLinks.get(item.imageId) || [])
      }));

    filteredCandidates.sort((a, b) => b.createdAtMs - a.createdAtMs);
    const sampled = filteredCandidates.slice(0, candidateLimit);
    const favoriteCounts = await store.getImageFavoriteCounts(sampled.map((item) => item.imageId));
    const postCounts = new Map<string, number>();
    for (const item of sampled) {
      if (!item.postId) continue;
      postCounts.set(item.postId, (postCounts.get(item.postId) || 0) + 1);
    }
    const flat = await Promise.all(sampled.map(async (item) => {
      const favoriteCount = Math.max(0, Number(favoriteCounts[item.imageId] || 0));
      const discoverSquareCropBonus = item.discoverSquareCropEnabled ? 1.25 : 0;
      const overpostPenalty = item.postId ? Math.max(0, (postCounts.get(item.postId) || 1) - 1) * 1.8 : 0;
      const postLinkedMediaPenalty = item.surfaceType === 'media' && item.relatedPostIds.length > 0 ? 0.7 : 0;
      const postSurfaceBoost = item.surfaceType === 'post' ? 0.35 : 0;
      const score = favoriteCount * 2 + item.recencyBoost * 10 + discoverSquareCropBonus + postSurfaceBoost - postLinkedMediaPenalty - overpostPenalty;
      const contentProjection = projectContentRating(item.effectiveContentRating, viewerPolicy);
      const disclosureProjection = projectDisclosures(item.effectiveAiDisclosure, item.effectiveHeavyTopics);
      return {
        imageId: item.imageId,
        assetType: item.assetType,
        postType: item.postType,
        postFormat: item.postFormat,
        surfaceType: item.surfaceType,
        postId: item.postId,
        postSlug: item.postSlug,
        postTitle: item.postTitle,
        postSummary: item.postSummary,
        creatorId: item.creatorId,
        creatorName: creatorById.get(item.creatorId)?.name || 'Creator',
        groupingId: item.groupingId,
        groupingSlug: item.groupingSlug,
        groupingVisibility: item.groupingVisibility,
        discoverSquareCropEnabled: item.discoverSquareCropEnabled,
        effectiveContentRating: contentProjection.effectiveContentRating,
        displayedContentRating: contentProjection.displayedContentRating,
        blurred: contentProjection.blurred,
        effectiveAiDisclosure: disclosureProjection.effectiveAiDisclosure,
        displayedAiDisclosure: disclosureProjection.displayedAiDisclosure,
        effectiveHeavyTopics: disclosureProjection.effectiveHeavyTopics,
        displayedHeavyTopics: disclosureProjection.displayedHeavyTopics,
        title: item.title,
        previewUrl: item.externalPreviewUrl || await publicMediaUrl(item.previewKey) || '',
        previewPosterUrl: item.externalPreviewPosterUrl || await publicMediaUrl(item.previewPosterKey),
        thumbnailUrls: item.thumbnailKeys
          ? Object.fromEntries(
              await Promise.all(
                Object.entries(item.thumbnailKeys).map(async ([name, key]) => [
                  name,
                  await publicMediaUrl(key)
                ])
              )
            )
          : undefined,
        width: item.width,
        height: item.height,
        aspectRatio: item.aspectRatio,
        favoriteCount,
        createdAt: item.createdAt,
        score,
        relatedPostIds: item.relatedPostIds
      };
    }));
    flat.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    const oneSurfacePerImage = new Map<string, (typeof flat)[number]>();
    for (const candidate of flat) {
      const existing = oneSurfacePerImage.get(candidate.imageId);
      if (!existing) {
        oneSurfacePerImage.set(candidate.imageId, candidate);
        continue;
      }
      if (candidate.surfaceType === 'post' && existing.surfaceType !== 'post') {
        oneSurfacePerImage.set(candidate.imageId, candidate);
      }
    }
    const uniqueFlat = Array.from(oneSurfacePerImage.values()).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    const diversified: Array<TrendingImageItem & { relatedPostIds: string[] }> = [];
    const queue = [...uniqueFlat];
    const surfacedPostIds = new Set<string>();
    const selectedImageIds = new Set<string>();
    while (queue.length > 0) {
      const lastArtistId = diversified.length > 0 ? diversified[diversified.length - 1].creatorId : undefined;
      const lastPostId = diversified.length > 0 ? diversified[diversified.length - 1].postId : undefined;
      const enforcePostDiversity = source !== 'media';
      const hasAltImageNotSelected = queue.some((item) => !selectedImageIds.has(item.imageId));
      let bestIndex = -1;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < queue.length; i += 1) {
        const item = queue[i];
        const blockByArtist = Boolean(lastArtistId && item.creatorId === lastArtistId && queue.some((candidate) => candidate.creatorId !== lastArtistId));
        const blockByPost = Boolean(enforcePostDiversity && lastPostId && item.postId === lastPostId && queue.some((candidate) => candidate.postId !== lastPostId));
        const blockByImage = Boolean(selectedImageIds.has(item.imageId) && hasAltImageNotSelected);
        if (blockByArtist || blockByPost || blockByImage) continue;

        let selectionScore = item.score;
        if (item.surfaceType === 'media' && surfacedPostIds.size > 0) {
          const overlaps = item.relatedPostIds.filter((postId) => surfacedPostIds.has(postId)).length;
          if (overlaps > 0) selectionScore -= overlaps * 6;
        }
        if (item.surfaceType === 'post' && item.postId && surfacedPostIds.has(item.postId)) {
          selectionScore -= 4.5;
        }
        if (selectionScore > bestScore) {
          bestScore = selectionScore;
          bestIndex = i;
        }
      }
      const picked = queue.splice(bestIndex >= 0 ? bestIndex : 0, 1)[0];
      diversified.push(picked);
      selectedImageIds.add(picked.imageId);
      if (picked.surfaceType === 'post' && picked.postId) {
        surfacedPostIds.add(picked.postId);
      }
    }

    const page = diversified.slice(offset, offset + limit);
    const nextCursor = offset + page.length < diversified.length ? encodeOffsetCursor(offset + page.length) : undefined;
    const items = page.map(({ score: _score, relatedPostIds: _relatedPostIds, ...item }) => item);
    return {
      period,
      items,
      nextCursor,
      metrics: {
        candidateCount: filteredCandidates.length,
        scoredCount: sampled.length,
        groupingCount: allGalleries.length
      }
    };
  };

  app.use((req, res, next) => {
    const requestStartedAt = process.hrtime.bigint();
    const requestId = (req.headers['x-request-id'] as string | undefined)?.trim() || randomUUID();
    const coldStart = !hasHandledInvocation;
    if (coldStart) hasHandledInvocation = true;

    res.setHeader('x-request-id', requestId);
    res.setHeader('x-cold-start', coldStart ? '1' : '0');
    res.setHeader('x-runtime-uptime-ms', String(Math.round(process.uptime() * 1000)));

    const originalEnd = res.end.bind(res);
    res.end = ((...args: any[]) => {
      const elapsedMs = Number(process.hrtime.bigint() - requestStartedAt) / 1_000_000;
      const locals = res.locals as { __serverTimingEntries?: ServerTimingEntry[] };
      const entries = locals.__serverTimingEntries || [];
      const parts = entries
        .filter((entry) => Number.isFinite(entry.durMs) && entry.durMs >= 0)
        .map((entry) => `${entry.metric};dur=${entry.durMs.toFixed(1)}${entry.desc ? `;desc="${entry.desc.replace(/"/g, "'")}"` : ''}`);
      parts.push(`app;dur=${elapsedMs.toFixed(1)};desc="total handler"`);
      if (!res.headersSent) {
        res.setHeader('Server-Timing', parts.join(', '));
        res.setHeader('x-handler-ms', elapsedMs.toFixed(1));
      }
      // Never place OAuth authorization codes, state tokens, or other query
      // values in routine request logs. The route path is sufficient for timing
      // diagnostics; callback handlers log their own token-safe stages below.
      console.info(`[api-timing] id=${requestId} method=${req.method} path=${req.path} status=${res.statusCode} cold=${coldStart ? 1 : 0} handlerMs=${elapsedMs.toFixed(1)}`);
      return originalEnd(...args);
    }) as typeof res.end;

    return next();
  });

  const allowedOrigins = new Set([
    ...(config.appOrigin ? [config.appOrigin.replace(/\/$/, '')] : []),
    ...(config.localAuthUserId ? ['http://localhost:5173', 'https://fanadmin.top:5174', 'https://fanadmin.top:5175'] : [])
  ]);
  app.use((req, res, next) => {
    if (req.method !== 'OPTIONS') return next();
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.replace(/\/$/, '') : '';
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ message: 'Origin is not allowed.' });
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(','));
    res.setHeader('Access-Control-Expose-Headers', exposedHeaders.join(','));
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).send();
  });
  app.use(cors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin.replace(/\/$/, ''))),
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders,
    exposedHeaders
  }));
  // Writing Works use structured block documents and should not be constrained
  // by the small default JSON parser limit. External destinations still apply
  // their own limits when publishing.
  app.use(express.json({ limit: '10mb', verify: (req, _res, buffer) => {
    const request = req as express.Request;
    if (request.originalUrl.startsWith('/webhooks/fanvue')) request.rawBody = Buffer.from(buffer);
  } }));
  app.use(createOptionalAuthMiddleware(config));
  app.use(createFanvueRouter(config, fanvueRepository, async (userId, ownerId) => {
    const identity = await store.getUserIdentity?.(userId);
    return identity?.role === 'admin' || store.hasCreatorAccess(userId, ownerId);
  }, async (workId) => {
    const work = await store.getWork(config.tenantId, workId);
    if (!work) return null;
    const assets = await store.listCanonicalAssetsByWork(config.tenantId, workId);
    return { work, assets, activeSafetyHold: assets.some((asset) => asset.metadata?.fanvueSafetyHold === true) };
  }, async (userId) => {
    const identity = await store.getUserIdentity?.(userId);
    return identity?.role === 'admin';
  }, async (asset) => {
    if (!asset.storage.objectKey) throw new Error('The selected Asset is not hosted.');
    if (config.localMediaDirectory) {
      const root = resolve(config.localMediaDirectory);
      const path = resolve(root, asset.storage.objectKey);
      if (path !== root && !path.startsWith(`${root}/`)) throw new Error('The selected Asset path is invalid.');
      return readFile(path);
    }
    const result = await s3Client.send(new GetObjectCommand({ Bucket: config.mediaBucket, Key: asset.storage.objectKey }));
    if (!result.Body) throw new Error('The selected Asset body is unavailable.');
    return Buffer.from(await result.Body.transformToByteArray());
  }));
  registerTumblrRoutes({
    app, config, repository: tumblrRepository,
    hasCreatorAccess: (userId, creatorId) => store.hasCreatorAccess(userId, creatorId),
    getWork: (tenantId, workId) => store.getWork(tenantId, workId),
    listAssets: (tenantId, workId) => store.listCanonicalAssetsByWork(tenantId, workId),
    resolveAssetUrl: (asset, req) => asset.storage.externalUrl
      ? Promise.resolve(asset.storage.externalUrl)
      : publicMediaUrl(asset.storage.objectKey, `${req.protocol}://${req.get('host')}`),
    publishQueue: tumblrPublishQueue,
    audit: auditLog
  });
  app.use('/support', createSupportRouter(supportSafetyService));
  if (config.localMediaDirectory) app.use('/media/local', express.static(config.localMediaDirectory));

  const resolvePlatformRole = async (userId: string): Promise<PlatformRole> => {
    if (store.getUserIdentity) {
      const identity = await store.getUserIdentity(userId);
      if (identity) return normalizePlatformRoleValue(identity.role);
    }
    return 'user';
  };

  const resolveCapabilities = (role: PlatformRole): UserCapabilities => capabilitiesForRole(role);

  const promoteToContributor = async (userId: string): Promise<void> => {
    if (!store.setUserRole) return;
    const currentRole = await resolvePlatformRole(userId);
    if (currentRole === 'user') {
      const promoted = await store.setUserRole(userId, 'contributor');
      if (store.upsertUserIdentity) {
        await store.upsertUserIdentity({ ...promoted, isBeeker: true, updatedAt: new Date().toISOString() });
      }
      return;
    }
    if (store.upsertUserIdentity) {
      const existing = await store.getUserIdentity?.(userId);
      if (existing && !existing.isBeeker) {
        await store.upsertUserIdentity({ ...existing, isBeeker: true, updatedAt: new Date().toISOString() });
      }
    }
  };

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // AT Protocol OAuth clients are identified by this publicly fetchable HTTPS
  // document. It deliberately contains only public metadata and public JWKs;
  // the confidential signing key stays in managed secret storage.
  app.get('/oauth/bluesky/client-metadata.json', (_req, res) => {
    const clientId = config.blueskyOAuthClientMetadataUrl;
    const callback = config.blueskyOAuthCallbackUrl;
    if (!clientId || !callback || !config.blueskyOAuthJwksJson) {
      return res.status(503).json({ message: 'Bluesky OAuth is not configured for this deployment.' });
    }
    let jwks: { keys?: unknown[] };
    try {
      jwks = JSON.parse(config.blueskyOAuthJwksJson) as { keys?: unknown[] };
    } catch {
      return res.status(503).json({ message: 'Bluesky OAuth public JWKS is invalid.' });
    }
    if (!Array.isArray(jwks.keys) || !jwks.keys.length) {
      return res.status(503).json({ message: 'Bluesky OAuth public JWKS is missing keys.' });
    }
    const jwksUri = new URL('/oauth/bluesky/jwks.json', clientId).toString();
    return res.type('application/json').json({
      client_id: clientId,
      client_name: brandForConfig(config).productName,
      client_uri: config.appOrigin || new URL(clientId).origin,
      redirect_uris: [callback],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
      scope: 'atproto transition:generic',
      dpop_bound_access_tokens: true,
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'ES256',
      jwks_uri: jwksUri
    });
  });

  app.get('/oauth/bluesky/jwks.json', (_req, res) => {
    if (!config.blueskyOAuthJwksJson) return res.status(503).json({ message: 'Bluesky OAuth is not configured for this deployment.' });
    try {
      const jwks = JSON.parse(config.blueskyOAuthJwksJson) as { keys?: unknown[] };
      if (!Array.isArray(jwks.keys) || !jwks.keys.length) throw new Error('missing keys');
      return res.type('application/json').json(jwks);
    } catch {
      return res.status(503).json({ message: 'Bluesky OAuth public JWKS is invalid.' });
    }
  });

  app.get('/auth/username/check', async (req, res) => {
    const requested = typeof req.query.username === 'string' ? req.query.username : '';
    const { normalized, reasons } = validateUsername(requested);
    if (reasons.length > 0) {
      return res.json({ username: normalized, available: false, reasons, suggestions: await buildUsernameSuggestions(store, requested, brand.id) });
    }
    const available = await store.isUsernameAvailable(normalized);
    return res.json({
      username: normalized,
      available,
      reasons: available ? [] : ['Username is already taken.'],
      suggestions: available ? [] : await buildUsernameSuggestions(store, requested, brand.id)
    });
  });

  app.post('/auth/register', async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const usernameInput = typeof req.body?.username === 'string' ? req.body.username : '';

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }
    if (!config.cognitoClientId) {
      return res.status(503).json({ message: 'Registration is not configured.' });
    }

    const generatedUsername = `ubeeqer-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const { normalized, reasons } = validateUsername(usernameInput.trim() || generatedUsername);
    if (reasons.length > 0) {
      return res.status(400).json({ message: reasons[0], reasons, suggestions: await buildUsernameSuggestions(store, usernameInput, brand.id) });
    }

    const available = await store.isUsernameAvailable(normalized);
    if (!available) {
      return res.status(409).json({
        message: 'Username is already taken.',
        suggestions: await buildUsernameSuggestions(store, normalized, brand.id)
      });
    }

    try {
      await store.reserveUsername(normalized, normalized, email);
    } catch {
      return res.status(409).json({
        message: 'Username is already taken.',
        suggestions: await buildUsernameSuggestions(store, normalized, brand.id)
      });
    }

    try {
      await cognitoClient.send(
        new SignUpCommand({
          ClientId: config.cognitoClientId,
          Username: email,
          Password: password,
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'preferred_username', Value: normalized }
          ]
        })
      );
      return res.status(201).json({ ok: true, username: normalized });
    } catch (error) {
      await store.releaseUsername(normalized);
      const message = (error as Error).message || 'Registration failed';
      return res.status(400).json({ message });
    }
  });

  app.post('/integration-requests', requireAuth, async (req, res) => {
    const platform = typeof req.body?.platform === 'string' ? req.body.platform.trim().replace(/\s+/g, ' ') : '';
    const details = typeof req.body?.details === 'string' ? req.body.details.trim() : '';
    if (!platform) return res.status(400).json({ message: 'Tell us which platform you would like to use.' });
    if (platform.length > 100) return res.status(400).json({ message: 'Platform name must be 100 characters or fewer.' });
    if (details.length > 2_000) return res.status(400).json({ message: 'Your request details must be 2,000 characters or fewer.' });
    if (!config.sesFromAddress || !config.integrationRequestToAddress) {
      return res.status(503).json({ message: 'Integration requests are not configured for this deployment yet.' });
    }

    const sender = req.authUser!;
    const recipient = config.integrationRequestToAddress;
    const subject = `[${brand.productName}] Integration request: ${platform}`;
    const body = [
      `${brand.productName} integration request`,
      '',
      `Requested platform: ${platform}`,
      `From: ${sender.displayName}${sender.email ? ` <${sender.email}>` : ''}`,
      `User ID: ${sender.userId}`,
      '',
      'Request details:',
      details || '(No additional details provided.)'
    ].join('\n');

    try {
      await sesClient.send(new SendEmailCommand({
        FromEmailAddress: config.sesFromAddress,
        Destination: { ToAddresses: [recipient] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: { Text: { Data: body, Charset: 'UTF-8' } }
          }
        },
        ...(sender.email ? { ReplyToAddresses: [sender.email] } : {})
      }));
      console.info(JSON.stringify({ event: 'integration_request_sent', brand: brand.id, platform, recipient, userId: sender.userId }));
      return res.status(202).json({ ok: true });
    } catch (cause) {
      console.error(JSON.stringify({
        event: 'integration_request_failed',
        brand: brand.id,
        platform,
        userId: sender.userId,
        message: cause instanceof Error ? cause.message : 'Unknown email delivery error'
      }));
      return res.status(502).json({ message: 'We could not send your integration request. Please try again shortly.' });
    }
  });

  const resolveCreatorFromSlug = async (requestedSlug: string): Promise<Creator | null> => {
    const creators = await store.listCreators();
    return creators.find((item) => item.slug === requestedSlug || (item.slugHistory || []).includes(requestedSlug)) || null;
  };

  const isLocalCreatorPreview = (req: express.Request): boolean => {
    const previewRequested = String(req.query.preview || '') === '1';
    const previewAllowed = config.deploymentStage === 'development'
      || config.deploymentStage === 'dev'
      || Boolean(config.localAuthUserId);
    return previewRequested && previewAllowed;
  };

  const creatorSafetyTargets = async (creatorId: string) => {
    const [members, externalAccounts] = await Promise.all([
      store.listCreatorMembers(creatorId),
      store.listExternalAccountsByCreatorIdentity(creatorId)
    ]);
    return [
      { type: 'creator' as const, id: creatorId },
      ...members.flatMap((member) => [
        { type: 'user' as const, id: member.userId },
        { type: 'account' as const, id: member.userId }
      ]),
      ...externalAccounts.map((account) => ({ type: 'account' as const, id: account.externalAccountId }))
    ];
  };

  const canAccessCreatorSpace = async (req: express.Request, creator: Creator): Promise<boolean> => {
    const holdDecision = await supportSafetyService.accessPolicy(await creatorSafetyTargets(creator.creatorId));
    if (!holdDecision.public) return false;
    const visibility = creator.space?.visibility || 'public-discoverable';
    if (visibility !== 'private') return true;
    if (req.authUser?.userId && await store.hasCreatorAccess(req.authUser.userId, creator.creatorId)) return true;
    // Studio's local/dev "View public profile" link is an owner preview. It
    // must be able to render a newly-created private Space without weakening
    // production privacy or accepting the preview flag on a hosted service.
    if (isLocalCreatorPreview(req)) return true;
    const shareCode = creator.space?.shareCode;
    return Boolean(shareCode) && String(req.query.access || '') === shareCode;
  };

  const workIsPubliclyAvailable = async (work: Work): Promise<boolean> => {
    const assets = await store.listCanonicalAssetsByWork(work.tenantId, work.workId);
    const decision = await supportSafetyService.accessPolicy([
      ...await creatorSafetyTargets(work.creatorId),
      { type: 'work', id: work.workId },
      ...assets.map((asset) => ({ type: 'asset' as const, id: asset.assetId }))
    ]);
    return decision.public;
  };

  const ensureWorkPublicationAllowed = async (work: Work, res: express.Response): Promise<boolean> => {
    if (await workIsPubliclyAvailable(work)) return true;
    res.status(423).json({ message: 'Publishing is unavailable while a review hold is active.' });
    return false;
  };

  app.get('/creators', async (req, res) => {
    // Do not let intermediary caches preserve creator pages after an immediate
    // creator/account safety hold.
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const result = await getDiscoveryCached(req, 'discovery:creators', async () => {
        const creators = await store.listCreators();
        const eligible = creators.filter((creator) => creator.status === 'active' && (creator.space?.visibility || 'public-discoverable') === 'public-discoverable');
        const active = (await Promise.all(eligible.map(async (creator) => ({
          creator,
          available: (await supportSafetyService.accessPolicy(await creatorSafetyTargets(creator.creatorId))).public
        })))).filter(({ available }) => available).map(({ creator }) => creator)
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        return Promise.all(active.map(async (creator) => {
          const creatorGroupings = (await store.listGroupingsByCreatorSlug(creator.slug))
            .filter((grouping) => grouping.status === 'published')
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
          const recent = creatorGroupings[0];
          const followerCount = await store.countFollowersByCreator(creator.creatorId);
          if (!recent) return { ...creator, followerCount, groupingCount: creatorGroupings.length };
          const thumb = await resolveGroupingThumbnail(recent);
          return {
            ...creator,
            latestGroupingId: recent.groupingId,
            creatorThumbnailUrl: await publicMediaUrl(
              creator.branding?.profileImage?.thumbnailKeys?.square512
              || creator.branding?.profileImage?.thumbnailKeys?.square256
            ) || thumb.groupingThumbnailUrl,
            followerCount,
            groupingCount: creatorGroupings.length
          };
        }));
      });
      res.setHeader('x-discovery-cache', result.cacheStatus);
      // Holds must take effect immediately even when discovery data was built
      // before the hold. Re-check every cached creator at response time.
      const cachedPayload = Array.isArray(result.payload) ? result.payload as Creator[] : [];
      const payload = (await Promise.all(cachedPayload.map(async (creator) => ({
        creator,
        available: (await supportSafetyService.accessPolicy(await creatorSafetyTargets(creator.creatorId))).public
      })))).filter(({ available }) => available).map(({ creator }) => creator);
      res.json(payload);
    } catch (error) {
      logServerError('GET /creators', error);
      res.setHeader('x-discovery-cache', 'BYPASS');
      res.setHeader('x-api-fallback', 'creators-empty');
      res.json([]);
    }
  });

  const publicCanonicalCreator = async (creator: Creator, requestOrigin?: string) => ({
    creatorId: creator.creatorId,
    name: creator.name,
    slug: creator.slug,
    bio: creator.space?.bio,
    externalLinks: creator.space?.externalLinks || [],
    theme: creator.space?.theme || 'default',
    announcement: creator.space?.announcement,
    coverPreset: creator.space?.coverPreset,
    visibility: creator.space?.visibility || 'public-discoverable',
    profileImageUrl: await publicMediaUrl(
      creator.branding?.profileImage?.thumbnailKeys?.square1024
        || creator.branding?.profileImage?.thumbnailKeys?.square512
        || creator.branding?.profileImage?.thumbnailKeys?.square256,
      requestOrigin
    ),
    coverImageUrl: await publicMediaUrl(
      creator.branding?.coverImage?.renditionKeys?.desktop
        || creator.branding?.coverImage?.renditionKeys?.tablet
        || creator.branding?.coverImage?.renditionKeys?.mobile,
      requestOrigin
    )
  });

  const legacySpacePublicationForWork = async (work: Work, assets?: Array<{ assetId: string }>) => {
    // Imported canonical assets use a `:remote` suffix so the canonical asset
    // can coexist with the older external asset record.  SpacePublication
    // rows written before that split are keyed by the unsuffixed asset ID, so
    // include both forms when recovering an already-hosted copy.
    const candidateIds = [
      work.workId,
      work.primaryAssetId,
      work.origin?.remoteId,
      ...(assets || []).flatMap((asset) => [
        asset.assetId,
        asset.assetId.endsWith(':remote') ? asset.assetId.slice(0, -':remote'.length) : ''
      ])
    ]
      .filter((assetId, index, all) => assetId && all.indexOf(assetId) === index);
    const rows = await Promise.all(candidateIds
      .filter((assetId): assetId is string => Boolean(assetId))
      .map((assetId) => store.getSpacePublication(assetId)));
    return rows.find(Boolean) || null;
  };

  // Some imported Works predate the generic Publication row and keep their
  // Eversally state in SpacePublication. Project that legacy row into the
  // generic shape anywhere public visibility or publication metadata is read.
  const legacySpaceAsPublication = (work: Work, legacy: Awaited<ReturnType<typeof legacySpacePublicationForWork>>): Publication | undefined => {
    if (!legacy || !legacy.published) return undefined;
    const updatedAt = legacy.updatedAt || legacy.publishedAt || work.updatedAt;
    return {
      publicationId: `space:${legacy.assetId}`,
      tenantId: work.tenantId,
      creatorId: work.creatorId,
      workId: work.workId,
      destination: 'eversally',
      status: 'live',
      visibility: legacy.visibility,
      metadataOverrides: {
        title: legacy.ubeeqTitleOverride,
        description: legacy.ubeeqDescriptionOverride
      },
      sync: {
        status: 'not_applicable',
        localRevision: work.revision,
        lastSuccessfulAt: legacy.lastContentSyncAt || updatedAt
      },
      createdAt: updatedAt,
      updatedAt,
      publishedAt: legacy.publishedAt || updatedAt
    };
  };

  const eversallyPublicationForWork = async (work: Work, assets?: Array<{ assetId: string }>): Promise<Publication | undefined> => {
    const publications = await store.listPublicationsByWork(work.tenantId, work.workId);
    const generic = publications.find((publication) => publication.destination === 'eversally');
    if (generic) return generic;
    return legacySpaceAsPublication(work, await legacySpacePublicationForWork(work, assets));
  };

  // A publication can outlive a Creator reassignment. Keep public Spaces
  // discoverable from the destination owner even when an older canonical Work
  // row still carries its original creatorId.
  const listWorksForPublicCreator = async (creatorId: string): Promise<Work[]> => {
    const direct = await store.listWorksByCreator(config.tenantId, creatorId);
    const destinationPublications = await store.listPublicationsByDestination(config.tenantId, 'eversally');
    const reassigned = await Promise.all(destinationPublications
      .filter((publication) => publication.creatorId === creatorId && publication.status === 'live' && publication.visibility === 'public')
      .map((publication) => store.getWork(config.tenantId, publication.workId)));
    const byId = new Map<string, Work>();
    [...direct, ...reassigned].forEach((work) => {
      if (work && work.status !== 'deleted') byId.set(work.workId, work);
    });
    return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  const publicCanonicalWork = async (work: Work, requestOrigin: string) => {
    const assets = await store.listCanonicalAssetsByWork(work.tenantId, work.workId);
    const [publications, discovery, legacySpace] = await Promise.all([
      store.listPublicationsByWork(work.tenantId, work.workId),
      store.getWorkDiscoveryParticipation(work.tenantId, work.workId),
      legacySpacePublicationForWork(work, assets)
    ]);
    const space = publications.find((publication) => publication.destination === 'eversally')
      || legacySpaceAsPublication(work, legacySpace);
    const primary = assets.find((asset) => asset.assetId === work.primaryAssetId) || assets.find((asset) => asset.attachment.role === 'primary') || assets[0];
    // Imported works created before the canonical publication model may still
    // have their hosted copy recorded in the legacy SpacePublication row.
    // Prefer that durable copy over a remote DA URL so disconnecting DA does
    // not make an already-hosted Eversally work point back at DA.
    const hostedObjectKey = primary?.storage.objectKey || legacySpace?.hostedObjectKey;
    const hostedThumbnailObjectKey = primary?.storage.thumbnailObjectKey || legacySpace?.hostedThumbnailObjectKey || hostedObjectKey;
    return {
      workId: work.workId,
      creatorId: work.creatorId,
      kind: work.kind,
      title: space?.metadataOverrides?.title || work.title,
      slug: work.slug,
      description: space?.metadataOverrides?.description || work.description,
      tags: work.tags,
      body: work.body,
      contentRating: work.contentRating,
      aiDisclosure: work.aiDisclosure,
      heavyTopics: work.heavyTopics,
      publishedAt: space?.publishedAt,
      updatedAt: work.updatedAt,
      visibility: space?.visibility,
      discovery: discovery?.state || 'none',
      contentAvailability: contentAvailabilityForAssets(assets),
      origin: work.origin,
      primaryAsset: primary ? {
        assetId: primary.assetId,
        kind: primary.kind,
        mimeType: primary.mimeType,
        width: primary.width,
        height: primary.height,
        durationSeconds: primary.durationSeconds,
        altText: primary.attachment.altText,
        hostingMode: hostedObjectKey ? 'hosted' : primary.storage.mode,
        sourceCopyQuality: primary.metadata?.sourceCopyQuality,
        url: hostedObjectKey ? await publicMediaUrl(hostedObjectKey, requestOrigin) : primary.storage.externalUrl,
        thumbnailUrl: hostedThumbnailObjectKey ? await publicMediaUrl(hostedThumbnailObjectKey, requestOrigin) : undefined
      } : undefined,
      assets: await Promise.all(assets.map(async (asset, index) => {
        // Older imported Works keep their hosted copy in SpacePublication rather
        // than on the canonical Asset. Treat the primary asset the same way as
        // the card preview so public work pages remain independent of DA.
        const isPrimary = asset.assetId === work.primaryAssetId || asset.attachment.role === 'primary' || index === 0;
        const objectKey = asset.storage.objectKey || (isPrimary ? legacySpace?.hostedObjectKey : undefined);
        const thumbnailObjectKey = asset.storage.thumbnailObjectKey || (isPrimary ? (legacySpace?.hostedThumbnailObjectKey || legacySpace?.hostedObjectKey) : undefined);
        return {
          assetId: asset.assetId,
          kind: asset.kind,
          mimeType: asset.mimeType,
          role: asset.attachment.role,
          position: asset.attachment.position,
          caption: asset.attachment.caption,
          altText: asset.attachment.altText,
          hostingMode: objectKey ? 'hosted' : asset.storage.mode,
          sourceCopyQuality: asset.metadata?.sourceCopyQuality,
          url: objectKey ? await publicMediaUrl(objectKey, requestOrigin) : asset.storage.externalUrl,
          thumbnailUrl: thumbnailObjectKey ? await publicMediaUrl(thumbnailObjectKey, requestOrigin) : undefined
        };
      })),
      destinations: publications
        .filter((publication) => publication.status === 'live' && publication.remoteUrl)
        .map((publication) => ({ destination: publication.destination, url: publication.remoteUrl }))
    };
  };

  app.get('/creators/:slug/works', async (req, res) => {
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    const creator = await resolveCreatorFromSlug(requestedSlug);
    if (!creator || creator.status !== 'active' || !(await canAccessCreatorSpace(req, creator))) return res.status(404).json({ message: 'Creator not found' });
    if (creator.slug !== requestedSlug) return res.redirect(302, `/creators/${creator.slug}/works`);
    const works = await listWorksForPublicCreator(creator.creatorId);
    const visible = (await Promise.all(works.map(async (work) => ({
      work,
      space: await eversallyPublicationForWork(work),
      holdAvailable: await workIsPubliclyAvailable(work)
    })))).filter(({ work, space, holdAvailable }) => holdAvailable && work.status !== 'archived' && work.status !== 'deleted' && space?.status === 'live' && space.visibility === 'public');
    const origin = `${req.protocol}://${req.get('host')}`;
    return res.json({ creator: await publicCanonicalCreator(creator, origin), items: await Promise.all(visible.map(({ work }) => publicCanonicalWork(work, origin))) });
  });

  app.get('/creators/:slug/works/:workSlug', async (req, res) => {
    const creator = await resolveCreatorFromSlug(String(req.params.slug || '').trim().toLowerCase());
    if (!creator || creator.status !== 'active' || !(await canAccessCreatorSpace(req, creator))) return res.status(404).json({ message: 'Creator not found' });
    const workSlug = String(req.params.workSlug || '').trim().toLowerCase();
    const work = (await listWorksForPublicCreator(creator.creatorId)).find((item) => item.slug === workSlug || item.slugHistory.includes(workSlug));
    if (!work || work.status === 'deleted') return res.status(404).json({ message: 'Work not found' });
    if (!(await workIsPubliclyAvailable(work))) return res.status(404).json({ message: 'Work not found' });
    const canManage = isLocalCreatorPreview(req)
      || (req.authUser?.userId ? await store.hasCreatorAccess(req.authUser.userId, creator.creatorId) : false);
    if (!canManage && work.status === 'archived') return res.status(404).json({ message: 'Work not found' });
    const space = await eversallyPublicationForWork(work);
    if (!canManage && (!space || space.status !== 'live' || space.visibility === 'private')) return res.status(404).json({ message: 'Work not found' });
    if (work.slug !== workSlug) return res.redirect(302, `/creators/${creator.slug}/works/${work.slug}`);
    const origin = `${req.protocol}://${req.get('host')}`;
    return res.json({ creator: await publicCanonicalCreator(creator, origin), work: await publicCanonicalWork(work, origin) });
  });

  app.get('/creators/:slug/collections', async (req, res) => {
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    const creator = await resolveCreatorFromSlug(requestedSlug);
    if (!creator || creator.status !== 'active' || !(await canAccessCreatorSpace(req, creator))) return res.status(404).json({ message: 'Creator not found' });
    if (creator.slug !== requestedSlug) return res.redirect(302, `/creators/${creator.slug}/collections`);
    const collections = (await store.listCreatorCollections(config.tenantId, creator.creatorId))
      .filter((collection) => collection.status === 'published' && collection.visibility === 'public');
    const origin = `${req.protocol}://${req.get('host')}`;
    return res.json({ creator: await publicCanonicalCreator(creator, origin), items: await Promise.all(collections.map(async (collection) => ({
      ...collection,
      workCount: (await store.listCollectionWorks(config.tenantId, collection.collectionId)).length
    }))) });
  });

  app.get('/creators/:slug/collections/:collectionSlug', async (req, res) => {
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    const creator = await resolveCreatorFromSlug(requestedSlug);
    if (!creator || creator.status !== 'active' || !(await canAccessCreatorSpace(req, creator))) return res.status(404).json({ message: 'Creator not found' });
    const collectionSlug = String(req.params.collectionSlug || '').trim().toLowerCase();
    const collection = (await store.listCreatorCollections(config.tenantId, creator.creatorId)).find((item) => item.slug === collectionSlug || item.slugHistory.includes(collectionSlug));
    if (!collection || collection.status === 'deleted') return res.status(404).json({ message: 'Collection not found' });
    const canManage = req.authUser?.userId ? await store.hasCreatorAccess(req.authUser.userId, creator.creatorId) : false;
    if (!canManage && (collection.status !== 'published' || collection.visibility === 'private')) return res.status(404).json({ message: 'Collection not found' });
    if (creator.slug !== requestedSlug || collection.slug !== collectionSlug) {
      return res.redirect(302, `/creators/${creator.slug}/collections/${collection.slug}`);
    }
    const memberships = await store.listCollectionWorks(config.tenantId, collection.collectionId);
    const works = (await Promise.all(memberships.map((membership) => store.getWork(config.tenantId, membership.workId))))
      .filter((work): work is Work => Boolean(work));
    const origin = `${req.protocol}://${req.get('host')}`;
    const holdFilteredWorks = (await Promise.all(works.map(async (work) => ({ work, available: await workIsPubliclyAvailable(work) })))).filter(({ available }) => available).map(({ work }) => work);
    const visibleWorks = canManage ? holdFilteredWorks : (await Promise.all(holdFilteredWorks.map(async (work) => ({
      work,
      space: await eversallyPublicationForWork(work)
    })))).filter(({ work, space }) => work.status !== 'archived' && work.status !== 'deleted' && space?.status === 'live' && space.visibility === 'public').map(({ work }) => work);
    return res.json({ creator: await publicCanonicalCreator(creator, origin), collection, works: await Promise.all(visibleWorks.map((work) => publicCanonicalWork(work, origin))) });
  });

  const xmlEscape = (value: unknown): string => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const listPublicSpaceWorks = async (creator: Creator): Promise<Work[]> => {
    const works = await listWorksForPublicCreator(creator.creatorId);
    const visible = await Promise.all(works.map(async (work) => ({
      work,
      publication: await eversallyPublicationForWork(work),
      holdAvailable: await workIsPubliclyAvailable(work)
    })));
    return visible
      .filter(({ work, publication, holdAvailable }) => holdAvailable
        && work.status !== 'archived'
        && work.status !== 'deleted'
        && publication?.status === 'live'
        && publication.visibility === 'public')
      .sort((a, b) => (b.publication?.publishedAt || b.work.updatedAt).localeCompare(a.publication?.publishedAt || a.work.updatedAt))
      .map(({ work }) => work);
  };

  const canonicalSpaceBaseUrl = (creator: Creator): string =>
    `${(config.appOrigin || brand.siteUrl).replace(/\/$/, '')}/creators/${encodeURIComponent(creator.slug)}`;

  app.get('/creators/:slug/rss.xml', async (req, res) => {
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    const creator = await resolveCreatorFromSlug(requestedSlug);
    if (!creator || creator.status !== 'active' || !(await canAccessCreatorSpace(req, creator))) return res.status(404).type('text/plain').send('Creator not found');
    if (creator.slug !== requestedSlug) return res.redirect(302, `/creators/${creator.slug}/rss.xml`);
    const baseUrl = canonicalSpaceBaseUrl(creator);
    const feedUrl = `${baseUrl}/rss.xml`;
    const works = await listPublicSpaceWorks(creator);
    const origin = `${req.protocol}://${req.get('host')}`;
    const items = await Promise.all(works.map((work) => publicCanonicalWork(work, origin)));
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">\n<channel>\n<title>${xmlEscape(creator.name)}</title>\n<link>${xmlEscape(`${baseUrl}/works`)}</link>\n<description>${xmlEscape(limitedRichTextToPlainText(creator.space?.bio) || `${creator.name} works`)}</description>\n<atom:link href="${xmlEscape(feedUrl)}" rel="self" type="application/rss+xml" />\n${items.map((work) => {
      const url = `${baseUrl}/works/${encodeURIComponent(work.slug)}`;
      const preview = work.primaryAsset?.thumbnailUrl || (work.primaryAsset?.kind === 'image' ? work.primaryAsset.url : undefined);
      const summary = work.description || (work.body || []).map((block) => block.text || block.quote || '').filter(Boolean).join('\n\n');
      return `<item>\n<title>${xmlEscape(work.title)}</title>\n<link>${xmlEscape(url)}</link>\n<guid isPermaLink="false">urn:ubeeq:work:${xmlEscape(work.workId)}</guid>\n<pubDate>${new Date(work.publishedAt || work.updatedAt).toUTCString()}</pubDate>\n<description>${xmlEscape(summary)}</description>${preview ? `\n<media:content url="${xmlEscape(preview)}" medium="image" />` : ''}\n</item>`;
    }).join('\n')}\n</channel>\n</rss>`;
    res.setHeader('Cache-Control', 'private, no-store');
    return res.type('application/rss+xml').send(xml);
  });

  app.get('/creators/:slug/atom.xml', async (req, res) => {
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    const creator = await resolveCreatorFromSlug(requestedSlug);
    if (!creator || creator.status !== 'active' || !(await canAccessCreatorSpace(req, creator))) return res.status(404).type('text/plain').send('Creator not found');
    if (creator.slug !== requestedSlug) return res.redirect(302, `/creators/${creator.slug}/atom.xml`);
    const baseUrl = canonicalSpaceBaseUrl(creator);
    const feedUrl = `${baseUrl}/atom.xml`;
    const works = await listPublicSpaceWorks(creator);
    const origin = `${req.protocol}://${req.get('host')}`;
    const items = await Promise.all(works.map((work) => publicCanonicalWork(work, origin)));
    const updated = items[0]?.updatedAt || creator.createdAt;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n<title>${xmlEscape(creator.name)}</title>\n<id>${xmlEscape(`${baseUrl}/works`)}</id>\n<link href="${xmlEscape(`${baseUrl}/works`)}" />\n<link href="${xmlEscape(feedUrl)}" rel="self" type="application/atom+xml" />\n<updated>${xmlEscape(new Date(updated).toISOString())}</updated>\n${items.map((work) => {
      const url = `${baseUrl}/works/${encodeURIComponent(work.slug)}`;
      const summary = work.description || (work.body || []).map((block) => block.text || block.quote || '').filter(Boolean).join('\n\n');
      return `<entry>\n<title>${xmlEscape(work.title)}</title>\n<id>urn:ubeeq:work:${xmlEscape(work.workId)}</id>\n<link href="${xmlEscape(url)}" />\n<published>${xmlEscape(new Date(work.publishedAt || work.updatedAt).toISOString())}</published>\n<updated>${xmlEscape(new Date(work.updatedAt).toISOString())}</updated>\n<summary type="text">${xmlEscape(summary)}</summary>\n</entry>`;
    }).join('\n')}\n</feed>`;
    res.setHeader('Cache-Control', 'private, no-store');
    return res.type('application/atom+xml').send(xml);
  });

  app.get('/creators/:slug/feed', async (req, res) => {
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    const creator = await resolveCreatorFromSlug(requestedSlug);
    if (!creator || creator.status !== 'active' || !(await canAccessCreatorSpace(req, creator))) {
      return res.status(404).json({ message: 'Creator not found' });
    }
    if (creator.slug !== requestedSlug) {
      return res.redirect(302, `/creators/${creator.slug}/feed`);
    }

    const nowMs = Date.now();
    const limitRaw = Number(req.query.limit || 24);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(60, limitRaw)) : 24;
    const offset = parseOffsetCursor(typeof req.query.cursor === 'string' ? req.query.cursor : undefined);
    const isFollower = req.authUser?.userId ? await store.isFollowingCreator(req.authUser.userId, creator.creatorId) : false;
    const isFollowerOrAdmin = isAdminRequest(req) || isFollower;
    const viewerPolicy = await resolveViewerContentPolicy(req);

    const sectionedStoryMediaIds = new Set<string>();
    const firstSectionStoryMediaIds = new Set<string>();
    const creatorPosts = await store.listPostsByCreatorSlug(creator.slug);
    for (const post of creatorPosts) {
      if (post.status !== 'published') continue;
      const visiblePost = {
        ...post,
        blocks: postBlocksForViewer(post.blocks || [], isFollowerOrAdmin)
      };
      const firstSectionMediaIds = firstSectionMediaIdsForStoryPost(visiblePost);
      if (!firstSectionMediaIds) continue;
      for (const ref of post.media || []) {
        sectionedStoryMediaIds.add(ref.mediaId);
      }
      for (const mediaId of firstSectionMediaIds) {
        firstSectionStoryMediaIds.add(mediaId);
      }
    }

    const media = (await store.listMediaByCreator(creator.creatorId))
      .filter((item) => item.appearsInFeed !== false)
      .filter((item) => !sectionedStoryMediaIds.has(item.mediaId) || firstSectionStoryMediaIds.has(item.mediaId))
      .filter((item) => !isHiddenByVisibility(item.releaseVisibility))
      .filter((item) => {
        if (item.status && item.status !== 'published' && item.status !== 'scheduled') return false;
        return canViewBySchedule(item.publishAt, item.publicReleaseAt, nowMs, isFollowerOrAdmin);
      })
      .filter((item) => {
        const effectiveRating = getEffectiveContentRating(item);
        if (!isRatingAllowed(effectiveRating, viewerPolicy.maxAllowedContentRating)) return false;
        const effectiveAiDisclosure = getEffectiveAiDisclosure(item);
        const effectiveHeavyTopics = getEffectiveHeavyTopics(item);
        return passesDisclosureFilter(effectiveAiDisclosure, effectiveHeavyTopics, viewerPolicy.disclosurePolicy);
      })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    const pageItems = media.slice(offset, offset + limit);
    const nextCursor = offset + pageItems.length < media.length ? encodeOffsetCursor(offset + pageItems.length) : undefined;
    const allGalleries = await store.listAllGroupings();
    const groupingById = new Map(allGalleries.map((item) => [item.groupingId, item]));
    const favoriteCounts = await store.getImageFavoriteCounts(pageItems.map((item) => item.mediaId));
    const payload = await Promise.all(pageItems.map(async (item) => {
      const placements = await store.listMediaGroupingPlacements(item.mediaId);
      const groupingRefs = placements
        .map((placement) => groupingById.get(placement.groupingId))
        .filter((grouping): grouping is Grouping => Boolean(grouping))
        .filter((grouping) => grouping.status === 'published')
        .filter((grouping) => !isHiddenByVisibility(grouping.releaseVisibility))
        .filter((grouping) => canViewBySchedule(grouping.publishAt, grouping.publicReleaseAt, nowMs, isFollowerOrAdmin))
        .map((grouping) => ({
          groupingId: grouping.groupingId,
          groupingSlug: grouping.slug,
          groupingTitle: grouping.title,
          groupingVisibility: grouping.visibility
        }));
      const primaryGrouping = groupingRefs[0];
      const effectiveRating = getEffectiveContentRating(item);
      const contentProjection = projectContentRating(effectiveRating, viewerPolicy);
      const effectiveAiDisclosure = getEffectiveAiDisclosure(item);
      const effectiveHeavyTopics = getEffectiveHeavyTopics(item);
      const disclosureProjection = projectDisclosures(effectiveAiDisclosure, effectiveHeavyTopics);
      return {
        imageId: item.mediaId,
        title: item.title || item.originalFilename?.replace(/\.[^.]+$/, '') || item.mediaId,
        assetType: (item.assetType || 'image') as 'image' | 'video',
        createdAt: item.createdAt,
        previewUrl: await publicMediaUrl(item.previewKey),
        previewPosterUrl: await publicMediaUrl(item.previewPosterKey),
        thumbnailUrls: item.thumbnailKeys
          ? Object.fromEntries(
              await Promise.all(
                Object.entries(item.thumbnailKeys).map(async ([name, key]) => {
                  if (!key) return [name, undefined];
                  return [name, await publicMediaUrl(key)];
                })
              )
            )
          : undefined,
        width: item.width,
        height: item.height,
        aspectRatio: item.width > 0 && item.height > 0 ? Number((item.width / item.height).toFixed(5)) : undefined,
        effectiveContentRating: contentProjection.effectiveContentRating,
        displayedContentRating: contentProjection.displayedContentRating,
        blurred: contentProjection.blurred,
        effectiveAiDisclosure: disclosureProjection.effectiveAiDisclosure,
        displayedAiDisclosure: disclosureProjection.displayedAiDisclosure,
        effectiveHeavyTopics: disclosureProjection.effectiveHeavyTopics,
        displayedHeavyTopics: disclosureProjection.displayedHeavyTopics,
        discoverSquareCropEnabled: item.discoverSquareCropEnabled !== false,
        appearsInFeed: item.appearsInFeed !== false,
        favoriteCount: favoriteCounts[item.mediaId] || 0,
        primaryGrouping,
        groupingRefs
      };
    }));

    const canonicalItems = (await Promise.all((await store.listWorksByCreator(config.tenantId, creator.creatorId)).map(async (work) => {
      if (work.status === 'archived' || work.status === 'deleted') return undefined;
      const space = await eversallyPublicationForWork(work);
      if (!space || space.status !== 'live' || space.visibility !== 'public') return undefined;
      const view = await publicCanonicalWork(work, `${req.protocol}://${req.get('host')}`);
      const contentProjection = projectContentRating(work.contentRating, viewerPolicy);
      const disclosureProjection = projectDisclosures(work.aiDisclosure, work.heavyTopics);
      return {
        imageId: `canonical:${work.workId}`,
        canonicalWorkSlug: work.slug,
        title: view.title,
        assetType: (work.kind === 'video' ? 'video' : work.kind === 'audio' ? 'audio' : 'image') as 'image' | 'video' | 'audio',
        createdAt: work.updatedAt,
        previewUrl: view.primaryAsset?.thumbnailUrl || view.primaryAsset?.url || '',
        previewPosterUrl: view.primaryAsset?.thumbnailUrl,
        effectiveContentRating: contentProjection.effectiveContentRating,
        displayedContentRating: contentProjection.displayedContentRating,
        blurred: contentProjection.blurred,
        effectiveAiDisclosure: disclosureProjection.effectiveAiDisclosure,
        displayedAiDisclosure: disclosureProjection.displayedAiDisclosure,
        effectiveHeavyTopics: disclosureProjection.effectiveHeavyTopics,
        displayedHeavyTopics: disclosureProjection.displayedHeavyTopics,
        discoverSquareCropEnabled: true,
        appearsInFeed: true,
        favoriteCount: 0,
        primaryGrouping: undefined,
        groupingRefs: []
      };
    }))).filter((item): item is NonNullable<typeof item> => Boolean(item));
    const combinedPayload = [...payload, ...canonicalItems]
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, limit);

    return res.json({
      creatorId: creator.creatorId,
      creatorSlug: creator.slug,
      items: combinedPayload,
      nextCursor
    });
  });

  app.get('/creators/:slug/featured', async (req, res) => {
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    const creator = await resolveCreatorFromSlug(requestedSlug);
    if (!creator || creator.status !== 'active') {
      return res.status(404).json({ message: 'Creator not found' });
    }
    if (creator.slug !== requestedSlug) {
      return res.redirect(302, `/creators/${creator.slug}/featured`);
    }
    const featuredItemIds = creator.featuredItemIds || [];
    const featuredGroupingIds = creator.featuredGroupingIds || [];
    if (featuredItemIds.length === 0 && featuredGroupingIds.length === 0) {
      return res.json({ creatorId: creator.creatorId, creatorSlug: creator.slug, items: [], groupings: [] });
    }

    const nowMs = Date.now();
    const isFollower = req.authUser?.userId ? await store.isFollowingCreator(req.authUser.userId, creator.creatorId) : false;
    const isFollowerOrAdmin = isAdminRequest(req) || isFollower;
    const viewerPolicy = await resolveViewerContentPolicy(req);
    const [media, groupings] = await Promise.all([
      store.listMediaByCreator(creator.creatorId),
      store.listAllGroupings()
    ]);
    const mediaById = new Map(media.map((item) => [item.mediaId, item]));
    const groupingsById = new Map(
      groupings
        .filter((item) => item.creatorId === creator.creatorId && item.status === 'published' && !isHiddenByVisibility(item.releaseVisibility))
        .map((item) => [item.groupingId, item])
    );

    const featuredItems = await Promise.all(featuredItemIds.map(async (mediaId) => {
      const item = mediaById.get(mediaId);
      if (!item) return null;
      if (isHiddenByVisibility(item.releaseVisibility)) return null;
      if (!canViewBySchedule(item.publishAt, item.publicReleaseAt, nowMs, isFollowerOrAdmin)) return null;
      const effectiveRating = getEffectiveContentRating(item);
      if (!isRatingAllowed(effectiveRating, viewerPolicy.maxAllowedContentRating)) return null;
      const effectiveAiDisclosure = getEffectiveAiDisclosure(item);
      const effectiveHeavyTopics = getEffectiveHeavyTopics(item);
      if (!passesDisclosureFilter(effectiveAiDisclosure, effectiveHeavyTopics, viewerPolicy.disclosurePolicy)) return null;
      return {
        imageId: item.mediaId,
        title: item.title || item.originalFilename?.replace(/\.[^.]+$/, '') || item.mediaId,
        assetType: (item.assetType || 'image') as 'image' | 'video',
        createdAt: item.createdAt,
        previewUrl: await publicMediaUrl(item.previewKey),
        previewPosterUrl: await publicMediaUrl(item.previewPosterKey)
      };
    }));

    const featuredGroupings = await Promise.all(featuredGroupingIds.map(async (groupingId) => {
      const grouping = groupingsById.get(groupingId);
      if (!grouping) return null;
      if (!canViewBySchedule(grouping.publishAt, grouping.publicReleaseAt, nowMs, isFollowerOrAdmin)) return null;
      const thumb = await resolveGroupingThumbnail(grouping);
      return {
        groupingId: grouping.groupingId,
        groupingSlug: grouping.slug,
        title: grouping.title,
        visibility: grouping.visibility,
        groupingThumbnailUrl: thumb.groupingThumbnailUrl
      };
    }));

    return res.json({
      creatorId: creator.creatorId,
      creatorSlug: creator.slug,
      items: featuredItems.filter((item): item is NonNullable<typeof item> => Boolean(item)),
      groupings: featuredGroupings.filter((item): item is NonNullable<typeof item> => Boolean(item))
    });
  });

  app.get('/creators/:slug/posts', async (req, res) => {
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    const creator = await resolveCreatorFromSlug(requestedSlug);
    if (!creator || creator.status !== 'active' || !(await canAccessCreatorSpace(req, creator))) {
      return res.status(404).json({ message: 'Creator not found' });
    }
    if (creator.slug !== requestedSlug) {
      return res.redirect(302, `/creators/${creator.slug}/posts`);
    }

    const includeDrafts = req.authUser?.userId
      ? (isAdminRequest(req) || await store.hasCreatorAccess(req.authUser.userId, creator.creatorId))
      : false;
    const mediaById = new Map((await store.listMediaByCreator(creator.creatorId)).map((item) => [item.mediaId, item]));
    const posts = (await store.listPostsByCreatorSlug(creator.slug))
      .filter((post) => includeDrafts ? post.status !== 'archived' : post.status === 'published')
      .sort((a, b) => (b.publishedAt || b.updatedAt || b.createdAt).localeCompare(a.publishedAt || a.updatedAt || a.createdAt));

    const payload = await Promise.all(posts.map(async (post) => {
      const visibleBlocks = postBlocksForViewer(post.blocks, includeDrafts);
      const sortedMediaRefs = [...post.media].sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));
      const selectedRefs = sortedMediaRefs.filter((item) => item.discoverable !== false);
      const discoveryRefs = post.discovery.mode === 'all'
        ? sortedMediaRefs
        : (post.discovery.mode === 'selected' ? selectedRefs : []);
      const primaryMedia = post.primaryMediaId ? mediaById.get(post.primaryMediaId) : undefined;
      const primaryRef = post.media.find((item) => item.mediaId === post.primaryMediaId) || post.media.find((item) => item.discoverable !== false);
      const resolvedPrimary = primaryMedia || (primaryRef ? mediaById.get(primaryRef.mediaId) : undefined);
      const discoveryMediaIds = post.discovery.mode === 'primary'
        ? [resolvedPrimary?.mediaId].filter((item): item is string => Boolean(item))
        : discoveryRefs.map((item) => item.mediaId);
      const discoveryMedia = await Promise.all(
        discoveryMediaIds.map(async (mediaId) => {
          const source = mediaById.get(mediaId);
          if (!source) return null;
          const ref = post.media.find((item) => item.mediaId === mediaId) || { mediaId };
          return buildPostMediaPayload(ref, mediaById);
        })
      );
      return {
        postId: post.postId,
        creator: post.creatorId,
        title: post.title,
        slug: post.slug,
        slugHistory: post.slugHistory || [],
        summary: post.summary,
        status: post.status,
        discovery: post.discovery,
        metadata: post.metadata || {},
        destination: post.destination || null,
        primaryMediaId: post.primaryMediaId || primaryRef?.mediaId,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
        publishedAt: post.publishedAt,
        mediaCount: post.media.length,
        blockCount: visibleBlocks.length,
        discoveryMediaIds,
        discoveryMedia: discoveryMedia.filter((item): item is NonNullable<typeof item> => Boolean(item)),
        primaryMedia: resolvedPrimary
          ? {
              mediaId: resolvedPrimary.mediaId,
              assetType: (resolvedPrimary.assetType || 'image') as 'image' | 'video',
              previewUrl: await publicMediaUrl(resolvedPrimary.previewKey),
              previewPosterUrl: await publicMediaUrl(resolvedPrimary.previewPosterKey),
              width: resolvedPrimary.width,
              height: resolvedPrimary.height
            }
          : null
      };
    }));

    return res.json({
      creatorId: creator.creatorId,
      creatorSlug: creator.slug,
      items: payload
    });
  });

  app.get('/posts/:slug', async (req, res) => {
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    const post = await store.getPostBySlug(requestedSlug);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    if (post.slug !== requestedSlug) {
      return res.redirect(302, `/posts/${post.slug}`);
    }

    const creator = (await store.listCreators()).find((item) => item.creatorId === post.creatorId);
    if (!creator || creator.status !== 'active' || !(await canAccessCreatorSpace(req, creator))) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const canViewDraft = req.authUser?.userId
      ? (isAdminRequest(req) || await store.hasCreatorAccess(req.authUser.userId, post.creatorId))
      : false;
    if (post.status !== 'published' && !canViewDraft) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const mediaById = new Map((await store.listMediaByCreator(post.creatorId)).map((item) => [item.mediaId, item]));
    const media = await Promise.all(post.media.map((ref) => buildPostMediaPayload(ref, mediaById)));

    const visibleBlocks = postBlocksForViewer(post.blocks, canViewDraft);

    return res.json({
      ...post,
      blocks: visibleBlocks,
      slugHistory: post.slugHistory || [],
      creator: {
        creatorId: creator.creatorId,
        name: creator.name,
        slug: creator.slug
      },
      media: media.filter((item): item is NonNullable<typeof item> => Boolean(item))
    });
  });

  app.get('/posts/by-id/:postId', async (req, res) => {
    const requestedId = String(req.params.postId || '').trim();
    if (!requestedId) {
      return res.status(400).json({ message: 'Post ID is required' });
    }
    const post = await store.getPostById(requestedId);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const creator = (await store.listCreators()).find((item) => item.creatorId === post.creatorId);
    if (!creator || creator.status !== 'active') {
      return res.status(404).json({ message: 'Post not found' });
    }

    const canViewDraft = req.authUser?.userId
      ? (isAdminRequest(req) || await store.hasCreatorAccess(req.authUser.userId, post.creatorId))
      : false;
    if (post.status !== 'published' && !canViewDraft) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const mediaById = new Map((await store.listMediaByCreator(post.creatorId)).map((item) => [item.mediaId, item]));
    const media = await Promise.all(post.media.map((ref) => buildPostMediaPayload(ref, mediaById)));

    const visibleBlocks = postBlocksForViewer(post.blocks, canViewDraft);

    return res.json({
      ...post,
      blocks: visibleBlocks,
      slugHistory: post.slugHistory || [],
      creator: {
        creatorId: creator.creatorId,
        name: creator.name,
        slug: creator.slug
      },
      media: media.filter((item): item is NonNullable<typeof item> => Boolean(item))
    });
  });

  app.get('/site-settings', async (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    const settingsStartedAt = process.hrtime.bigint();
    const settings = await store.getSiteSettings();
    const settingsMs = Number(process.hrtime.bigint() - settingsStartedAt) / 1_000_000;
    addServerTiming(res, 'store', settingsMs, 'getSiteSettings');
    res.setHeader('x-store-ms', settingsMs.toFixed(1));

    const logoStartedAt = process.hrtime.bigint();
    const logoUrl = await publicMediaUrl(settings.logoKey);
    const logoMs = Number(process.hrtime.bigint() - logoStartedAt) / 1_000_000;
    addServerTiming(res, 'media', logoMs, 'resolveLogoUrl');
    res.setHeader('x-media-ms', logoMs.toFixed(1));

    return res.json({
      ...settings,
      siteName: settings.siteName === 'Ubeeq' ? brand.productName : settings.siteName,
      productBrand: brand.id,
      siteUrl: brand.siteUrl,
      creatorBaseUrl: brand.creatorBaseUrl,
      logoUrl
    });
  });

  app.get('/discovery/trending-content', async (req, res) => {
    const startedAt = Date.now();
    const period: 'hourly' | 'daily' = req.query.period === 'hourly' ? 'hourly' : 'daily';
    const requestedSource = typeof req.query.source === 'string' ? req.query.source : '';
    const source: 'media' | 'post' | 'combined' =
      requestedSource === 'media' || requestedSource === 'post' || requestedSource === 'combined'
        ? requestedSource
        : 'combined';
    const itemTypes = parseDiscoveryItemTypes(req);
    const limit = Math.max(1, Math.min(60, Number(req.query.limit || 24)));
    const cursorToken = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const decodedCursor = parsePassthroughCursor(cursorToken);
    const viewerPolicy = await resolveViewerContentPolicy(req);
    const disclosureKey = [
      `ai:${viewerPolicy.disclosurePolicy.aiFilter}`,
      `h:${viewerPolicy.disclosurePolicy.hideHeavyTopics ? 1 : 0}`,
      `p:${viewerPolicy.disclosurePolicy.hidePoliticsPublicAffairs ? 1 : 0}`,
      `c:${viewerPolicy.disclosurePolicy.hideCrimeDisastersTragedy ? 1 : 0}`
    ].join(',');
    const cacheKey = `viewer=${viewerPolicy.loggedIn ? 'auth' : 'anon'}:${viewerPolicy.matureEnabled ? 'm1' : 'm0'}:${viewerPolicy.maxAllowedContentRating}|${disclosureKey}|period=${period}|source=${source}|types=i${itemTypes.image ? 1 : 0}v${itemTypes.video ? 1 : 0}s${itemTypes.story ? 1 : 0}a${itemTypes.audio ? 1 : 0}|limit=${limit}|cursor=${decodedCursor || ''}`;
    const cached = readTrendingResponseCache<{
      body: { period: 'hourly' | 'daily'; items: Omit<TrendingImageItem, 'score'>[]; nextCursor?: string };
      source: 'materialized' | 'fallback';
      candidates: number;
      scored: number;
      groupings: number;
    }>(cacheKey);
    if (cached) {
      res.setHeader('x-trending-source', cached.source);
      res.setHeader('x-trending-cache', 'HIT');
      res.setHeader('x-trending-ms', String(Date.now() - startedAt));
      res.setHeader('x-trending-candidates', String(cached.candidates));
      res.setHeader('x-trending-scored', String(cached.scored));
      res.setHeader('x-trending-groupings', String(cached.groupings));
      return res.json(cached.body);
    }
    try {
      let feedPage: { items: Awaited<ReturnType<typeof store.listTrendingFeed>>['items']; nextCursor?: string } = {
        items: []
      };
      feedPage = await store.listTrendingFeed(period, limit, decodedCursor, { source, itemTypes });
      if (!feedPage.items.length && !decodedCursor) {
        // Warm feed on demand so first request after deploy can still switch to materialized quickly.
        await triggerTrendingWarmup();
        feedPage = await store.listTrendingFeed(period, limit, decodedCursor, { source, itemTypes });
      }
      if (feedPage.items.length > 0) {
        const filtered = feedPage.items.filter((item) => {
          const isPostSurface = item.surfaceType === 'post_surface' || Boolean(item.postId);
          if (source === 'post' && !isPostSurface) return false;
          if (source === 'media' && isPostSurface) return false;
          const effective = normalizeContentRating(item.effectiveContentRating);
          const effectiveAi = normalizeAiDisclosure(item.effectiveAiDisclosure);
          const effectiveHeavyTopics = normalizeHeavyTopics(item.effectiveHeavyTopics);
          return isRatingAllowed(effective, viewerPolicy.maxAllowedContentRating)
            && passesDisclosureFilter(effectiveAi, effectiveHeavyTopics, viewerPolicy.disclosurePolicy);
        });
        const postIds = Array.from(new Set(
          filtered
            .map((item) => item.postId)
            .filter((value): value is string => Boolean(value))
        ));
        const postsById = new Map<string, Awaited<ReturnType<typeof store.getPostById>>>();
        await Promise.all(postIds.map(async (postId) => {
          try {
            const post = await store.getPostById(postId);
            if (post) postsById.set(postId, post);
          } catch {
            // Best-effort enrichment only.
          }
        }));
        const typedFiltered = filtered.filter((item) => {
          const post = item.postId ? postsById.get(item.postId) : undefined;
          const itemType = post
            ? normalizePostType(post)
            : item.postType || (item.assetType === 'video' ? 'video' : item.assetType === 'audio' ? 'audio' : 'image');
          return itemTypes[itemType];
        });
        const items = await Promise.all(typedFiltered.map(async (item) => {
          const post = item.postId ? postsById.get(item.postId) : undefined;
          const postType = post ? normalizePostType(post) : item.postType;
          const postFormat = post && postType ? normalizePostFormat(post, postType) : item.postFormat;
          const effective = normalizeContentRating(item.effectiveContentRating);
          const contentProjection = projectContentRating(effective, viewerPolicy);
          const effectiveAi = normalizeAiDisclosure(item.effectiveAiDisclosure);
          const effectiveHeavyTopics = normalizeHeavyTopics(item.effectiveHeavyTopics);
          const disclosureProjection = projectDisclosures(effectiveAi, effectiveHeavyTopics);
          return {
            imageId: item.imageId,
            assetType: item.assetType === 'video' ? 'video' : item.assetType === 'audio' ? 'audio' : 'image',
            postType,
            postFormat,
            surfaceType: 'post',
            postId: item.postId,
            postSlug: post?.slug,
            postTitle: post?.title,
            postSummary: post?.summary,
            creatorId: item.creatorId,
            creatorName: item.creatorName,
            groupingId: item.groupingId,
            groupingSlug: item.groupingSlug,
            groupingVisibility: item.groupingVisibility,
            discoverSquareCropEnabled: item.discoverSquareCropEnabled !== false,
            effectiveContentRating: contentProjection.effectiveContentRating,
            displayedContentRating: contentProjection.displayedContentRating,
            blurred: contentProjection.blurred,
            effectiveAiDisclosure: disclosureProjection.effectiveAiDisclosure,
            displayedAiDisclosure: disclosureProjection.displayedAiDisclosure,
            effectiveHeavyTopics: disclosureProjection.effectiveHeavyTopics,
            displayedHeavyTopics: disclosureProjection.displayedHeavyTopics,
            title: post?.title || item.title,
            previewUrl: item.externalPreviewUrl || await publicMediaUrl(item.previewKey) || '',
            previewPosterUrl: item.externalPreviewPosterUrl || await publicMediaUrl(item.previewPosterKey),
            thumbnailUrls: item.thumbnailKeys
              ? Object.fromEntries(
                  await Promise.all(
                    Object.entries(item.thumbnailKeys).map(async ([name, key]) => [
                      name,
                      await publicMediaUrl(key)
                    ])
                  )
                )
              : undefined,
            width: item.width,
            height: item.height,
            aspectRatio: item.aspectRatio,
            favoriteCount: item.favoriteCount,
            createdAt: item.createdAt
          };
        }));
        const body = {
          period,
          items,
          nextCursor: feedPage.nextCursor ? encodePassthroughCursor(feedPage.nextCursor) : undefined
        };
        writeTrendingResponseCache(cacheKey, {
          body,
          source: 'materialized',
          candidates: feedPage.items.length,
          scored: feedPage.items.length,
          groupings: 0
        });
        res.setHeader('x-trending-source', 'materialized');
        res.setHeader('x-trending-mode', source);
        res.setHeader('x-trending-cache', 'MISS');
        res.setHeader('x-trending-ms', String(Date.now() - startedAt));
        res.setHeader('x-trending-candidates', String(feedPage.items.length));
        res.setHeader('x-trending-scored', String(typedFiltered.length));
        res.setHeader('x-trending-groupings', '0');
        return res.json(body);
      }
      const fallback = await computeTrendingImages(req, {
        period,
        cursor: cursorToken,
        limit,
        source,
        itemTypes
      });
      const payload = fallback as Awaited<ReturnType<typeof computeTrendingImages>>;
      const body = { period: payload.period, items: payload.items, nextCursor: payload.nextCursor };
      writeTrendingResponseCache(cacheKey, {
        body,
        source: 'fallback',
        candidates: payload.metrics.candidateCount,
        scored: payload.metrics.scoredCount,
        groupings: payload.metrics.groupingCount
      });
      res.setHeader('x-trending-source', 'fallback');
      res.setHeader('x-trending-mode', source);
      res.setHeader('x-trending-cache', 'MISS');
      res.setHeader('x-trending-ms', String(Date.now() - startedAt));
      res.setHeader('x-trending-candidates', String(payload.metrics.candidateCount));
      res.setHeader('x-trending-scored', String(payload.metrics.scoredCount));
      res.setHeader('x-trending-groupings', String(payload.metrics.groupingCount));
      return res.json(body);
    } catch (error) {
      logServerError('GET /discovery/trending-content', error);
      res.setHeader('x-trending-source', 'error');
      res.setHeader('x-trending-mode', source);
      res.setHeader('x-trending-cache', 'MISS');
      res.setHeader('x-api-fallback', 'trending-empty');
      res.setHeader('x-trending-ms', String(Date.now() - startedAt));
      res.setHeader('x-trending-candidates', '0');
      res.setHeader('x-trending-scored', '0');
      res.setHeader('x-trending-groupings', '0');
      return res.json({ period: req.query.period === 'hourly' ? 'hourly' : 'daily', items: [] });
    }
  });

  app.get('/creators/:slug/trending-content', async (req, res) => {
    const startedAt = Date.now();
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    let creators: Creator[] = [];
    try {
      creators = await store.listCreators();
    } catch (error) {
      logServerError('GET /creators/:slug/trending-content:listCreators', error);
      res.setHeader('x-discovery-cache', 'BYPASS');
      res.setHeader('x-api-fallback', 'trending-empty');
      res.setHeader('x-trending-ms', String(Date.now() - startedAt));
      res.setHeader('x-trending-candidates', '0');
      res.setHeader('x-trending-scored', '0');
      res.setHeader('x-trending-groupings', '0');
      return res.json({ period: req.query.period === 'hourly' ? 'hourly' : 'daily', items: [] });
    }
    const creator = creators.find((item) => item.slug === requestedSlug || (item.slugHistory || []).includes(requestedSlug));
    if (!creator || creator.status !== 'active') {
      return res.status(404).json({ message: 'Creator not found' });
    }
    const requestedSource = typeof req.query.source === 'string' ? req.query.source : '';
    const source: 'media' | 'post' | 'combined' =
      requestedSource === 'media' || requestedSource === 'post' || requestedSource === 'combined'
        ? requestedSource
        : 'combined';
    const itemTypes = parseDiscoveryItemTypes(req);
    const result = await getDiscoveryCached(
      req,
      `discovery:creator-trending:${creator.creatorId}:source=${source}:types=i${itemTypes.image ? 1 : 0}v${itemTypes.video ? 1 : 0}s${itemTypes.story ? 1 : 0}a${itemTypes.audio ? 1 : 0}`,
      () => computeTrendingImages(req, {
      period: req.query.period === 'hourly' ? 'hourly' : 'daily',
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit: Number(req.query.limit || 24),
      creatorId: creator.creatorId,
      source,
      itemTypes
      })
    );
    res.setHeader('x-discovery-cache', result.cacheStatus);
    res.setHeader('x-trending-mode', source);
    const payload = result.payload as Awaited<ReturnType<typeof computeTrendingImages>>;
    res.setHeader('x-trending-ms', String(Date.now() - startedAt));
    res.setHeader('x-trending-candidates', String(payload.metrics.candidateCount));
    res.setHeader('x-trending-scored', String(payload.metrics.scoredCount));
    res.setHeader('x-trending-groupings', String(payload.metrics.groupingCount));
    return res.json({ period: payload.period, items: payload.items, nextCursor: payload.nextCursor });
  });

  app.get('/u/:slug', async (req, res) => {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    if (!slug) {
      return res.status(400).json({ message: 'Invalid profile slug' });
    }
    const profile = await store.getUserProfileBySlug(slug);
    if (!profile || profile.status === 'inactive') {
      return res.status(404).json({ message: 'Profile not found' });
    }
    if (profile.username !== slug) {
      return res.redirect(302, `/u/${profile.username}`);
    }
    const [publicCollections, publicFavorites, managedCreators, branding] = await Promise.all([
      store.listPublicCollectionsByProfile('user', profile.userId, 12),
      store.listPublicFavoritesByProfile('user', profile.userId),
      store.listCreatorsByUserId(profile.userId),
      publicProfileBranding(profile.branding, `${req.protocol}://${req.get('host')}`)
    ]);
    const publicCreators = (await Promise.all(
      managedCreators
        .filter((creator) => creator.status === 'active' && creator.space?.showOnMemberProfile === true && (creator.space?.visibility || 'public-discoverable') !== 'private')
        .map(async (creator) => ({
          creator,
          isOwner: (await store.listCreatorMembers(creator.creatorId)).some((member) => member.userId === profile.userId && member.role === 'owner')
        }))
    )).filter(({ isOwner }) => isOwner).map(({ creator }) => creator);
    return res.json({
      username: profile.username,
      displayName: profile.displayName || profile.username,
      bio: profile.bio,
      externalLinks: profile.externalLinks || [],
      location: profile.location,
      website: profile.website,
      coverPreset: profile.coverPreset,
      createdAt: profile.createdAt,
      branding,
      publicCollectionCount: publicCollections.length,
      publicFavoriteCount: publicFavorites.length,
      publicCollections: publicCollections.map((collection) => ({
        collectionId: collection.collectionId,
        title: collection.title,
        description: collection.description,
        imageCount: collection.imageCount || 0,
        updatedDate: collection.updatedDate
      })),
      creators: publicCreators
        .map((creator) => ({ creatorId: creator.creatorId, name: creator.name, slug: creator.slug }))
    });
  });

  app.get('/creators/:slug/groupings', async (req, res) => {
    const groupings = await store.listGroupingsByCreatorSlug(req.params.slug);
    const nowMs = Date.now();
    const followerArtistIds = new Set<string>();
    if (req.authUser?.userId) {
      const follows = await store.listFollowsByUser(req.authUser.userId);
      follows.forEach((follow) => followerArtistIds.add(follow.creatorId));
    }
    const filtered = groupings.filter((grouping) => {
      if (grouping.status !== 'published') return false;
      if (isHiddenByVisibility(grouping.releaseVisibility)) return false;
      const isFollowerOrAdmin = isAdminRequest(req) || followerArtistIds.has(grouping.creatorId);
      return canViewBySchedule(grouping.publishAt, grouping.publicReleaseAt, nowMs, isFollowerOrAdmin);
    });
    const shouldHideDefaultStreamTitle = filtered.length === 1 && filtered[0]?.isDefaultStream === true;
    const displayGroupingTitle = (grouping: Grouping): string => {
      if (grouping.isDefaultStream) {
        if (shouldHideDefaultStreamTitle) return '';
        return grouping.title?.trim() || 'Original Series';
      }
      return grouping.title;
    };
    const byId = new Map(filtered.map((grouping) => [grouping.groupingId, grouping]));
    const payload: Array<Grouping & { premiumPasswordHash?: undefined; hasAccess: boolean }> = [];
    const seen = new Set<string>();

    for (const grouping of filtered) {
      if (seen.has(grouping.groupingId)) continue;
      if (grouping.visibility === 'free') {
        const thumb = await resolveGroupingThumbnail(grouping);
        payload.push({ ...grouping, title: displayGroupingTitle(grouping), ...thumb, premiumPasswordHash: undefined, hasAccess: true });
        seen.add(grouping.groupingId);
        continue;
      }

      if (grouping.visibility === 'premium') {
        const hasAccess = await hasPremiumAccess(req, grouping.groupingId);
        const previews = filtered.filter((item) => item.visibility === 'preview' && item.pairedPremiumGroupingId === grouping.groupingId);
        if (hasAccess || previews.length === 0) {
          const thumb = await resolveGroupingThumbnail(grouping);
          payload.push({ ...grouping, title: displayGroupingTitle(grouping), ...thumb, premiumPasswordHash: undefined, hasAccess: true });
          seen.add(grouping.groupingId);
          previews.forEach((item) => seen.add(item.groupingId));
        } else {
          for (const preview of previews) {
            if (seen.has(preview.groupingId)) continue;
            const thumb = await resolveGroupingThumbnail(preview);
            payload.push({ ...preview, title: displayGroupingTitle(preview), ...thumb, premiumPasswordHash: undefined, hasAccess: false });
            seen.add(preview.groupingId);
          }
          seen.add(grouping.groupingId);
        }
        continue;
      }

      if (grouping.visibility === 'preview') {
        const premium = grouping.pairedPremiumGroupingId ? byId.get(grouping.pairedPremiumGroupingId) : undefined;
        if (premium) {
          const hasAccess = await hasPremiumAccess(req, premium.groupingId);
          if (hasAccess) {
            if (!seen.has(premium.groupingId)) {
              const thumb = await resolveGroupingThumbnail(premium);
              payload.push({ ...premium, title: displayGroupingTitle(premium), ...thumb, premiumPasswordHash: undefined, hasAccess: true });
              seen.add(premium.groupingId);
            }
          } else {
            const thumb = await resolveGroupingThumbnail(grouping);
            payload.push({ ...grouping, title: displayGroupingTitle(grouping), ...thumb, premiumPasswordHash: undefined, hasAccess: false });
            seen.add(grouping.groupingId);
          }
        } else {
          const thumb = await resolveGroupingThumbnail(grouping);
          payload.push({ ...grouping, title: displayGroupingTitle(grouping), ...thumb, premiumPasswordHash: undefined, hasAccess: false });
          seen.add(grouping.groupingId);
        }
      }
    }
    res.json(payload);
  });

  app.get('/discovery/latest-groupings', async (req, res) => {
    try {
      const result = await getDiscoveryCached(req, 'discovery:latest-groupings', async () => {
        const nowMs = Date.now();
        const limitRaw = Number(req.query.limit || 12);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(24, limitRaw)) : 12;
        const creators = await store.listCreators();
        const creatorById = new Map(creators.map((creator) => [creator.creatorId, creator]));
        const groupings = (await store.listAllGroupings())
          .filter((grouping) => grouping.status === 'published' && !isHiddenByVisibility(grouping.releaseVisibility))
          .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        const followerArtistIds = new Set<string>();
        if (req.authUser?.userId) {
          const follows = await store.listFollowsByUser(req.authUser.userId);
          follows.forEach((follow) => followerArtistIds.add(follow.creatorId));
        }
        const canViewGroupingBySchedule = (grouping: Grouping): boolean => {
          const isFollowerOrAdmin = isAdminRequest(req) || followerArtistIds.has(grouping.creatorId);
          return canViewBySchedule(grouping.publishAt, grouping.publicReleaseAt, nowMs, isFollowerOrAdmin);
        };
        const visibleGalleries = groupings.filter(canViewGroupingBySchedule);
        const visibleById = new Map(visibleGalleries.map((grouping) => [grouping.groupingId, grouping]));
        const previewsByPremiumId = new Map<string, Grouping[]>();
        for (const grouping of visibleGalleries) {
          if (grouping.visibility === 'preview' && grouping.pairedPremiumGroupingId) {
            const existing = previewsByPremiumId.get(grouping.pairedPremiumGroupingId) || [];
            existing.push(grouping);
            previewsByPremiumId.set(grouping.pairedPremiumGroupingId, existing);
          }
        }
        const payload: Array<Grouping & {
          premiumPasswordHash?: undefined;
          hasAccess: boolean;
          creatorName: string;
          creatorSlug: string;
          stackPreviewUrls: string[];
        }> = [];
        const seen = new Set<string>();
        const premiumAccessByGroupingId = new Map<string, boolean>();
        const readPremiumAccess = async (groupingId: string): Promise<boolean> => {
          const cached = premiumAccessByGroupingId.get(groupingId);
          if (cached !== undefined) return cached;
          const hasAccess = await hasPremiumAccess(req, groupingId);
          premiumAccessByGroupingId.set(groupingId, hasAccess);
          return hasAccess;
        };
        const pushGrouping = async (grouping: Grouping, hasAccess: boolean, creatorName: string, creatorSlug: string) => {
          if (payload.length >= limit) return;
          if (seen.has(grouping.groupingId)) return;
          const [thumb, stackPreviewUrls] = await Promise.all([
            resolveGroupingThumbnail(grouping),
            resolveGroupingStackPreviewUrls(grouping)
          ]);
          payload.push({
            ...grouping,
            ...thumb,
            stackPreviewUrls,
            premiumPasswordHash: undefined,
            hasAccess,
            creatorName,
            creatorSlug
          });
          seen.add(grouping.groupingId);
        };

        for (const grouping of visibleGalleries) {
          if (payload.length >= limit) break;
          if (seen.has(grouping.groupingId)) continue;
          const creatorProfile = creatorById.get(grouping.creatorId);
          const creatorName = creatorProfile?.name || 'Creator';
          const creatorSlug = creatorProfile?.slug || '';

          if (grouping.visibility === 'free') {
            await pushGrouping(grouping, true, creatorName, creatorSlug);
            continue;
          }

          if (grouping.visibility === 'premium') {
            const hasAccess = await readPremiumAccess(grouping.groupingId);
            const previews = previewsByPremiumId.get(grouping.groupingId) || [];
            if (hasAccess || previews.length === 0) {
              await pushGrouping(grouping, true, creatorName, creatorSlug);
              previews.forEach((item) => seen.add(item.groupingId));
            } else {
              for (const preview of previews) {
                if (payload.length >= limit) break;
                const previewCreator = creatorById.get(preview.creatorId);
                await pushGrouping(preview, false, previewCreator?.name || creatorName, previewCreator?.slug || creatorSlug);
              }
              seen.add(grouping.groupingId);
            }
            continue;
          }

          if (grouping.visibility === 'preview') {
            const premium = grouping.pairedPremiumGroupingId ? visibleById.get(grouping.pairedPremiumGroupingId) : undefined;
            if (premium) {
              const hasAccess = await readPremiumAccess(premium.groupingId);
              if (hasAccess) {
                const premiumCreator = creatorById.get(premium.creatorId);
                await pushGrouping(premium, true, premiumCreator?.name || creatorName, premiumCreator?.slug || creatorSlug);
              } else {
                await pushGrouping(grouping, false, creatorName, creatorSlug);
              }
            } else {
              await pushGrouping(grouping, false, creatorName, creatorSlug);
            }
          }
        }

        return payload;
      });
      res.setHeader('x-discovery-cache', result.cacheStatus);
      res.json(result.payload);
    } catch (error) {
      logServerError('GET /discovery/latest-groupings', error);
      res.setHeader('x-discovery-cache', 'BYPASS');
      res.setHeader('x-api-fallback', 'latest-groupings-empty');
      res.json([]);
    }
  });

  app.get('/creators/:slug/profile', async (req, res) => {
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    const creator = await resolveCreatorFromSlug(requestedSlug);
    if (!creator || creator.status !== 'active') {
      return res.status(404).json({ message: 'Creator not found' });
    }
    const canManageSpace = Boolean(req.authUser?.userId && await store.hasCreatorAccess(req.authUser.userId, creator.creatorId))
      || isLocalCreatorPreview(req);
    const spaceVisibility = creator.space?.visibility || 'public-discoverable';
    const submittedCode = String(req.query.access || '');
    const shareCode = creator.space?.shareCode;
    const hasShareCode = spaceVisibility === 'private' && Boolean(shareCode) && submittedCode === shareCode;
    if (spaceVisibility === 'private' && !canManageSpace && !hasShareCode) {
      return res.status(404).json({ message: 'Creator not found' });
    }
    if (creator.slug !== requestedSlug) {
      return res.redirect(302, `/creators/${creator.slug}/profile`);
    }
    const allGalleries = (await store.listAllGroupings())
      .filter((item) => item.creatorId === creator.creatorId && item.status === 'published' && !isHiddenByVisibility(item.releaseVisibility))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const nowMs = Date.now();
    const isFollower = req.authUser?.userId ? await store.isFollowingCreator(req.authUser.userId, creator.creatorId) : false;
    const isFollowerOrAdmin = isAdminRequest(req) || isFollower;
    const viewerPolicy = await resolveViewerContentPolicy(req);
    const visibleGalleries = allGalleries.filter((item) => canViewBySchedule(item.publishAt, item.publicReleaseAt, nowMs, isFollowerOrAdmin));
    const shouldHideDefaultStreamTitle = visibleGalleries.length === 1 && visibleGalleries[0]?.isDefaultStream === true;
    const displayGroupingTitle = (grouping: Grouping): string => {
      if (grouping.isDefaultStream) {
        if (shouldHideDefaultStreamTitle) return '';
        return grouping.title?.trim() || 'Original Series';
      }
      return grouping.title;
    };
    const imageCount = (await Promise.all(visibleGalleries.map((grouping) => store.getMediaByGrouping(grouping.groupingId)))).flat().filter((item) => (item.assetType || 'image') === 'image').length;
    const followerCount = await store.countFollowersByCreator(creator.creatorId);
    const groupings = await Promise.all(visibleGalleries.slice(0, 12).map(async (grouping) => {
      const thumb = await resolveGroupingThumbnail(grouping);
      const favoriteCount = await store.countFavorites('grouping', grouping.groupingId);
      return {
        groupingId: grouping.groupingId,
        title: displayGroupingTitle(grouping),
        slug: grouping.slug,
        visibility: grouping.visibility,
        createdAt: grouping.createdAt,
        imageCount: (await store.getMediaByGrouping(grouping.groupingId)).filter((item) => (item.assetType || 'image') === 'image').length,
        favoriteCount,
        groupingThumbnailUrl: thumb.groupingThumbnailUrl
      };
    }));
    const trending = await computeTrendingImages(req, { period: 'daily', limit: 18, creatorId: creator.creatorId });
    const publicFavorites = await store.listPublicFavoritesByProfile('creator', creator.creatorId);
    const publicCollections = await store.listPublicCollectionsByProfile('creator', creator.creatorId, 6);
    const feedAll = (await store.listMediaByCreator(creator.creatorId))
      .filter((item) => item.appearsInFeed !== false)
      .filter((item) => !isHiddenByVisibility(item.releaseVisibility))
      .filter((item) => canViewBySchedule(item.publishAt, item.publicReleaseAt, nowMs, isFollowerOrAdmin))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const canonicalWorks = await listWorksForPublicCreator(creator.creatorId);
    const canonicalFeed = (await Promise.all(canonicalWorks.map(async (work) => {
      if (work.status === 'archived' || work.status === 'deleted') return undefined;
      const space = await eversallyPublicationForWork(work);
      if (!space || space.status !== 'live' || space.visibility !== 'public') return undefined;
      const view = await publicCanonicalWork(work, `${req.protocol}://${req.get('host')}`);
      const contentProjection = projectContentRating(work.contentRating, viewerPolicy);
      const disclosureProjection = projectDisclosures(work.aiDisclosure, work.heavyTopics);
      return {
        imageId: `canonical:${work.workId}`,
        canonicalWorkSlug: work.slug,
        title: view.title,
        assetType: (work.kind === 'video' ? 'video' : work.kind === 'audio' ? 'audio' : 'image') as 'image' | 'video' | 'audio',
        createdAt: work.updatedAt,
        previewUrl: view.primaryAsset?.thumbnailUrl || view.primaryAsset?.url || '',
        previewPosterUrl: view.primaryAsset?.thumbnailUrl,
        effectiveContentRating: contentProjection.effectiveContentRating,
        displayedContentRating: contentProjection.displayedContentRating,
        blurred: contentProjection.blurred,
        effectiveAiDisclosure: disclosureProjection.effectiveAiDisclosure,
        displayedAiDisclosure: disclosureProjection.displayedAiDisclosure,
        effectiveHeavyTopics: disclosureProjection.effectiveHeavyTopics,
        displayedHeavyTopics: disclosureProjection.displayedHeavyTopics,
        favoriteCount: 0
      };
    }))).filter((item): item is NonNullable<typeof item> => Boolean(item));
    const feedPreview = [...feedAll.map((item) => ({ kind: 'legacy' as const, item })), ...canonicalFeed.map((item) => ({ kind: 'canonical' as const, item }))]
      .sort((a, b) => (b.item.createdAt || '').localeCompare(a.item.createdAt || ''))
      .slice(0, 18);
    const canonicalImageCount = canonicalFeed.length;
    const featuredItemIds = creator.featuredItemIds || [];
    const featuredGroupingIds = creator.featuredGroupingIds || [];
    const feedFavoriteCounts = await store.getImageFavoriteCounts(
      feedPreview
        .filter((entry): entry is { kind: 'legacy'; item: Media } => entry.kind === 'legacy')
        .map((entry) => entry.item.mediaId)
    );
    const featuredFeedItems = featuredItemIds
      .map((itemId) => feedAll.find((item) => item.mediaId === itemId))
      .filter((item): item is Media => Boolean(item));
    const featuredGroupings = visibleGalleries.filter((grouping) => featuredGroupingIds.includes(grouping.groupingId));
    const groupingById = new Map(visibleGalleries.map((item) => [item.groupingId, item]));
    const mediaRows = await Promise.all(visibleGalleries.map((item) => store.getMediaByGrouping(item.groupingId)));
    const mediaById = new Map(mediaRows.flat().map((item) => [item.mediaId, item]));
    const toPublicImageFavorite = async (item: { targetId: string; createdAt: string }) => {
      const media = mediaById.get(item.targetId);
      if (!media) return { targetId: item.targetId, createdAt: item.createdAt };
      const previewKey = media.thumbnailKeys?.w640 || media.thumbnailKeys?.w320 || media.previewPosterKey || media.previewKey;
      const previewUrl = await publicMediaUrl(previewKey);
      return {
        targetId: item.targetId,
        createdAt: item.createdAt,
        title: media.title || 'Image',
        previewUrl: previewUrl || ''
      };
    };
    const toPublicGroupingFavorite = async (item: { targetId: string; createdAt: string }) => {
      const grouping = groupingById.get(item.targetId);
      if (!grouping) return { targetId: item.targetId, createdAt: item.createdAt };
      const thumb = await resolveGroupingThumbnail(grouping);
      return {
        targetId: item.targetId,
        createdAt: item.createdAt,
        title: displayGroupingTitle(grouping),
        slug: grouping.slug,
        groupingThumbnailUrl: thumb.groupingThumbnailUrl
      };
    };
    const toPublicCollectionFavorite = async (item: { targetId: string; createdAt: string }) => {
      const collection = await store.getCollectionById(item.targetId);
      if (!collection || collection.visibility !== 'public') return { targetId: item.targetId, createdAt: item.createdAt };
      return {
        targetId: item.targetId,
        createdAt: item.createdAt,
        title: collection.title
      };
    };
    return res.json({
      creatorId: creator.creatorId,
      name: creator.name,
      slug: creator.slug,
      status: creator.status,
      isFollowing: isFollower,
      isOwner: canManageSpace,
      space: {
        bio: creator.space?.bio,
        externalLinks: creator.space?.externalLinks || [],
        theme: creator.space?.theme || 'default',
        announcement: creator.space?.announcement,
        coverPreset: creator.space?.coverPreset,
        visibility: spaceVisibility
      },
      defaultProfileTab: creator.defaultProfileTab === 'groupings' ? 'groupings' : 'feed',
      branding: {
        profileImage: creator.branding?.profileImage ? {
          ...creator.branding.profileImage,
          thumbnailUrls: creator.branding.profileImage.thumbnailKeys
            ? Object.fromEntries(
                await Promise.all(
                  Object.entries(creator.branding.profileImage.thumbnailKeys).map(async ([name, key]) => [name, await publicMediaUrl(key)])
                )
              )
            : undefined
        } : undefined,
        coverImage: creator.branding?.coverImage ? {
          ...creator.branding.coverImage,
          renditionUrls: creator.branding.coverImage.renditionKeys
            ? Object.fromEntries(
                await Promise.all(
                  Object.entries(creator.branding.coverImage.renditionKeys).map(async ([name, key]) => [name, await publicMediaUrl(key)])
                )
              )
            : undefined
        } : undefined
      },
      followerCount,
      imageCount: imageCount + canonicalImageCount,
      groupingCount: visibleGalleries.length,
      feedItems: await Promise.all(feedPreview.map(async (entry) => {
        if (entry.kind === 'canonical') return entry.item;
        const item = entry.item;
        const contentProjection = projectContentRating(getEffectiveContentRating(item), viewerPolicy);
        const disclosureProjection = projectDisclosures(getEffectiveAiDisclosure(item), getEffectiveHeavyTopics(item));
        return {
          imageId: item.mediaId,
          title: item.title || item.originalFilename?.replace(/\.[^.]+$/, '') || item.mediaId,
          assetType: (item.assetType || 'image') as 'image' | 'video',
          createdAt: item.createdAt,
          previewUrl: await publicMediaUrl(item.previewKey),
          previewPosterUrl: await publicMediaUrl(item.previewPosterKey),
          effectiveContentRating: contentProjection.effectiveContentRating,
          displayedContentRating: contentProjection.displayedContentRating,
          blurred: contentProjection.blurred,
          effectiveAiDisclosure: disclosureProjection.effectiveAiDisclosure,
          displayedAiDisclosure: disclosureProjection.displayedAiDisclosure,
          effectiveHeavyTopics: disclosureProjection.effectiveHeavyTopics,
          displayedHeavyTopics: disclosureProjection.displayedHeavyTopics,
          favoriteCount: feedFavoriteCounts[item.mediaId] || 0
        };
      })),
      featured: {
        items: await Promise.all(featuredFeedItems.map(async (item) => ({
          imageId: item.mediaId,
          title: item.title || item.originalFilename?.replace(/\.[^.]+$/, '') || item.mediaId,
          previewUrl: await publicMediaUrl(item.previewKey),
          previewPosterUrl: await publicMediaUrl(item.previewPosterKey)
        }))),
        groupings: await Promise.all(featuredGroupings.map(async (grouping) => {
          const thumb = await resolveGroupingThumbnail(grouping);
          return {
            groupingId: grouping.groupingId,
            title: displayGroupingTitle(grouping),
            slug: grouping.slug,
            visibility: grouping.visibility,
            groupingThumbnailUrl: thumb.groupingThumbnailUrl
          };
        }))
      },
      trendingImages: trending.items,
      groupings,
      publicFavoritesByType: {
        images: await Promise.all(publicFavorites.filter((item) => item.targetType === 'image').map(toPublicImageFavorite)),
        groupings: await Promise.all(publicFavorites.filter((item) => item.targetType === 'grouping').map(toPublicGroupingFavorite)),
        collections: await Promise.all(publicFavorites.filter((item) => item.targetType === 'collection').map(toPublicCollectionFavorite))
      },
      publicCollections: publicCollections.map((item) => ({
        collectionId: item.collectionId,
        title: item.title,
        description: item.description,
        visibility: item.visibility,
        insertedDate: item.insertedDate,
        updatedDate: item.updatedDate,
        imageCount: item.imageCount,
        favoriteCount: item.favoriteCount,
        coverImageId: item.coverImageId
      }))
    });
  });

  app.get('/groupings/:slug', async (req, res) => {
    const grouping = await store.getGroupingBySlug(req.params.slug);
    if (!grouping || grouping.status !== 'published' || isHiddenByVisibility(grouping.releaseVisibility)) {
      return res.status(404).json({ message: 'Grouping not found' });
    }
    const isFollower = req.authUser?.userId ? await store.isFollowingCreator(req.authUser.userId, grouping.creatorId) : false;
    const isFollowerOrAdmin = isAdminRequest(req) || isFollower;
    const viewerPolicy = await resolveViewerContentPolicy(req);
    if (!canViewBySchedule(grouping.publishAt, grouping.publicReleaseAt, Date.now(), isFollowerOrAdmin)) {
      return res.status(404).json({ message: 'Grouping not found' });
    }

    const groupingHasAccess = grouping.visibility === 'free'
      ? true
      : (grouping.visibility === 'preview' && grouping.pairedPremiumGroupingId
        ? await hasPremiumAccess(req, grouping.pairedPremiumGroupingId)
        : await hasPremiumAccess(req, grouping.groupingId));
    let resolvedGrouping = grouping;
    if (grouping.visibility === 'preview' && groupingHasAccess && grouping.pairedPremiumGroupingId) {
      const premiumGrouping = (await store.listAllGroupings()).find((item) => item.groupingId === grouping.pairedPremiumGroupingId);
      if (premiumGrouping) {
        resolvedGrouping = premiumGrouping;
      }
    }
    const resolvedArtist = (await store.listCreators()).find((item) => item.creatorId === resolvedGrouping.creatorId);
    const resolvedArtistName = resolvedArtist?.name || '';
    const resolvedArtistSlug = resolvedArtist?.slug || resolvedGrouping.creatorId || '';
    const allMediaItems = (await store.getMediaByGrouping(resolvedGrouping.groupingId)).filter((item) => {
      if (isHiddenByVisibility(item.releaseVisibility)) return false;
      if (item.status && item.status !== 'published' && item.status !== 'scheduled') return false;
      const effectiveContentRating = getEffectiveContentRating(item);
      if (!isRatingAllowed(effectiveContentRating, viewerPolicy.maxAllowedContentRating)) return false;
      return canViewBySchedule(item.publishAt || resolvedGrouping.publishAt, item.publicReleaseAt || resolvedGrouping.publicReleaseAt, Date.now(), isFollowerOrAdmin);
    });
    let mediaItems = allMediaItems;
    if (resolvedGrouping.visibility === 'premium' && !groupingHasAccess) {
      const previewItems = allMediaItems.filter((item) => item.isPreview);
      mediaItems = previewItems.length > 0 ? previewItems : [];
    }
    const coverPool = mediaItems.length > 0 ? mediaItems : allMediaItems;
    const coverMedia = coverPool.find((item) => item.mediaId === grouping.coverImageId) || coverPool[0];
    let coverPreviewUrl = coverMedia
      ? await publicMediaUrl(coverMedia.previewPosterKey || coverMedia.previewKey)
      : undefined;
    let coverBlur = (grouping.visibility === 'premium' || grouping.visibility === 'preview') && !groupingHasAccess;
    if (coverMedia) {
      const effectiveCoverRating = getEffectiveContentRating(coverMedia);
      coverBlur = coverBlur || shouldBlurContent(effectiveCoverRating, viewerPolicy);
    }
    // For premium groupings without an explicit cover, prefer paired preview cover.
    if (grouping.visibility === 'premium' && !grouping.coverImageId) {
      const previewGrouping = (await store.listAllGroupings()).find((item) =>
        item.status === 'published' &&
        item.visibility === 'preview' &&
        item.pairedPremiumGroupingId === grouping.groupingId
      );
      if (previewGrouping) {
        const previewMedia = await store.getMediaByGrouping(previewGrouping.groupingId);
        const previewCover = previewMedia.find((item) => item.mediaId === previewGrouping.coverImageId) || previewMedia[0];
        if (previewCover) {
          coverPreviewUrl = await publicMediaUrl(previewCover.previewPosterKey || previewCover.previewKey);
          coverBlur = shouldBlurContent(getEffectiveContentRating(previewCover), viewerPolicy);
        }
      }
    }
    const mediaPayload = await Promise.all(mediaItems.map(async (item) => {
      const effectiveContentRating = getEffectiveContentRating(item);
      const effectiveAiDisclosure = getEffectiveAiDisclosure(item, resolvedGrouping);
      const effectiveHeavyTopics = getEffectiveHeavyTopics(item, resolvedGrouping);
      const contentProjection = projectContentRating(effectiveContentRating, viewerPolicy);
      const disclosureProjection = projectDisclosures(effectiveAiDisclosure, effectiveHeavyTopics);
      return {
        ...item,
        imageId: item.mediaId,
        sortOrder: item.position,
        isPreview: item.isPreview,
        previewMaxWidth: item.previewMaxWidth ?? resolvedGrouping.defaultPreviewMaxWidth,
        assetType: item.assetType || 'image',
        contentRating: contentProjection.effectiveContentRating,
        moderatorContentRating: undefined,
        premiumKey: undefined,
        effectiveContentRating: contentProjection.effectiveContentRating,
        displayedContentRating: contentProjection.displayedContentRating,
        blurred: contentProjection.blurred,
        effectiveAiDisclosure: disclosureProjection.effectiveAiDisclosure,
        displayedAiDisclosure: disclosureProjection.displayedAiDisclosure,
        effectiveHeavyTopics: disclosureProjection.effectiveHeavyTopics,
        displayedHeavyTopics: disclosureProjection.displayedHeavyTopics,
        previewUrl: await publicMediaUrl(item.previewKey),
        previewPosterUrl: await publicMediaUrl(item.previewPosterKey),
        thumbnailUrls: item.thumbnailKeys
          ? Object.fromEntries(
              await Promise.all(
                Object.entries(item.thumbnailKeys).map(async ([name, key]) => {
                  if (!key) return [name, undefined];
                  const url = await publicMediaUrl(key);
                  return [name, url];
                })
              )
            )
          : undefined,
        favoriteCount: await store.countFavorites('image', item.mediaId)
      };
    }));

    let premiumTeaserMedia: Array<{
      imageId: string;
      assetType: 'image' | 'video';
      effectiveContentRating: ContentRating;
      displayedContentRating: string;
      blurred: boolean;
      effectiveAiDisclosure: AiDisclosure;
      displayedAiDisclosure?: string;
      effectiveHeavyTopics: HeavyTopic[];
      displayedHeavyTopics: string[];
      previewUrl: string;
      previewPosterUrl?: string;
    }> = [];
    if (grouping.visibility === 'preview' && grouping.pairedPremiumGroupingId && !groupingHasAccess) {
      const premiumMediaRaw = (await store.getMediaByGrouping(grouping.pairedPremiumGroupingId))
        .filter((item) => isRatingAllowed(getEffectiveContentRating(item), viewerPolicy.maxAllowedContentRating));
      const premiumMediaPreviewOnly = premiumMediaRaw.filter((item) => item.isPreview);
      const premiumMedia = premiumMediaPreviewOnly.length > 0 ? premiumMediaPreviewOnly : premiumMediaRaw;
      premiumTeaserMedia = await Promise.all(premiumMedia.map(async (item) => ({
        ...(projectDisclosures(getEffectiveAiDisclosure(item), getEffectiveHeavyTopics(item))),
        imageId: item.mediaId,
        title: item.title || item.mediaId,
        assetType: (item.assetType || 'image') as 'image' | 'video',
        ...projectContentRating(getEffectiveContentRating(item), viewerPolicy),
        previewUrl: (await publicMediaUrl(item.previewKey)) || '',
        previewPosterUrl: await publicMediaUrl(item.previewPosterKey)
      })));
    }

    return res.json({
      ...resolvedGrouping,
      creatorName: resolvedArtistName,
      creatorSlug: resolvedArtistSlug,
      sourceGroupingId: grouping.groupingId,
      premiumPasswordHash: undefined,
      hasAccess: groupingHasAccess,
      coverMediaId: coverMedia?.mediaId,
      coverPreviewUrl,
      coverBlur,
      premiumTeaserMedia,
      favoriteCount: await store.countFavorites('grouping', resolvedGrouping.groupingId),
      media: mediaPayload,
      images: mediaPayload.filter((asset) => asset.assetType === 'image'),
      videos: mediaPayload.filter((asset) => asset.assetType === 'video')
    });
  });

  app.post('/groupings/:slug/unlock', async (req, res) => {
    const grouping = await store.getGroupingBySlug(req.params.slug);
    if (!grouping || grouping.status !== 'published') {
      return res.status(404).json({ message: 'Grouping not found' });
    }
    if (grouping.visibility !== 'premium') {
      return res.status(400).json({ message: 'Grouping is not premium' });
    }

    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`unlock:${grouping.groupingId}:${ip}`, 60_000, 10)) {
      return res.status(429).json({ message: 'Too many unlock attempts, try again later' });
    }

    const password = String(req.body?.password || '');
    if (!grouping.premiumPasswordHash || !(await verifyPassword(password, grouping.premiumPasswordHash))) {
      auditLog(req, 'grouping.unlock.failed', { groupingId: grouping.groupingId, reason: 'invalid-password' });
      return res.status(401).json({ message: 'Invalid password' });
    }

    if (req.authUser?.userId) {
      await store.grantGroupingAccess(req.authUser.userId, grouping.groupingId);
    }
    const unlockToken = issueUnlockToken({ groupingId: grouping.groupingId, userId: req.authUser?.userId }, config.unlockJwtSecret, config.unlockTokenTtlSeconds);
    const rememberToken = issueRememberAccessToken(
      { groupingId: grouping.groupingId, userId: req.authUser?.userId },
      config.unlockJwtSecret,
      config.rememberGroupingAccessTtlSeconds
    );
    auditLog(req, 'grouping.unlock.success', { groupingId: grouping.groupingId });
    return res.json({
      unlockToken,
      expiresInSeconds: config.unlockTokenTtlSeconds,
      rememberToken,
      rememberExpiresInSeconds: config.rememberGroupingAccessTtlSeconds
    });
  });

  app.get('/groupings/:slug/premium-images', async (req, res) => {
    const grouping = await store.getGroupingBySlug(req.params.slug);
    if (!grouping || grouping.status !== 'published') {
      return res.status(404).json({ message: 'Grouping not found' });
    }

    const hasUserAccess = req.authUser?.userId ? await store.hasGroupingAccess(req.authUser.userId, grouping.groupingId) : false;
    const unlockToken = req.headers['x-unlock-token'];
    const rememberToken = req.headers['x-grouping-access-token'];
    if (!hasUserAccess && typeof unlockToken !== 'string' && typeof rememberToken !== 'string') {
      return res.status(401).json({ message: 'Unlock token required' });
    }

    if (!hasUserAccess) {
      const scopedToken = typeof unlockToken === 'string' ? unlockToken : String(rememberToken);
      try {
        const payload = verifyUnlockToken(scopedToken, config.unlockJwtSecret);
        if (payload.groupingId !== grouping.groupingId) {
          return res.status(403).json({ message: 'Invalid unlock token scope' });
        }
        if (typeof unlockToken === 'string' && payload.tokenType !== 'unlock') {
          return res.status(401).json({ message: 'Invalid unlock token type' });
        }
        if (typeof rememberToken === 'string' && payload.tokenType !== 'remember') {
          return res.status(401).json({ message: 'Invalid grouping access token type' });
        }
      } catch {
        return res.status(401).json({ message: 'Invalid unlock token' });
      }
    }

    const viewerPolicy = await resolveViewerContentPolicy(req);
    const mediaItems = await store.getMediaByGrouping(grouping.groupingId);
    const premiumMedia = await Promise.all(mediaItems
      .filter((item) => Boolean(item.premiumKey))
      .map(async (item) => {
        const effectiveRating = getEffectiveContentRating(item);
        const effectiveAiDisclosure = getEffectiveAiDisclosure(item, grouping);
        const effectiveHeavyTopics = getEffectiveHeavyTopics(item, grouping);
        const contentProjection = projectContentRating(effectiveRating, viewerPolicy);
        const disclosureProjection = projectDisclosures(effectiveAiDisclosure, effectiveHeavyTopics);
        if (contentProjection.blurred) {
          return {
            imageId: item.mediaId,
            title: item.title || item.mediaId,
            assetType: item.assetType || 'image',
            ...contentProjection,
            ...disclosureProjection,
            premiumUrl: (await publicMediaUrl(item.previewKey)) || '',
            premiumPosterUrl: await publicMediaUrl(item.previewPosterKey)
          };
        }
        return {
          imageId: item.mediaId,
          title: item.title || item.mediaId,
          assetType: item.assetType || 'image',
          ...contentProjection,
          ...disclosureProjection,
          premiumUrl: (await privateMediaUrl(item.premiumKey!)) || '',
          premiumPosterUrl: await privateMediaUrl(item.premiumPosterKey)
        };
      }));

    return res.json(premiumMedia);
  });

  app.get('/groupings/:slug/comments', async (req, res) => {
    const grouping = await store.getGroupingBySlug(req.params.slug);
    if (!grouping) {
      return res.status(404).json({ message: 'Grouping not found' });
    }
    const comments = await store.listComments('grouping', grouping.groupingId);
    return res.json(comments.map(toPublicComment));
  });

  app.post('/groupings/:slug/comments', requireAuth, async (req, res) => {
    const grouping = await store.getGroupingBySlug(req.params.slug);
    if (!grouping) {
      return res.status(404).json({ message: 'Grouping not found' });
    }
    if (await store.isUserBlocked(req.authUser!.userId)) {
      return res.status(403).json({ message: 'User blocked' });
    }

    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`comment:${ip}`, 60_000, 20)) {
      return res.status(429).json({ message: 'Too many comments, try again later' });
    }

    const body = String(req.body?.body || '').trim();
    if (!body) {
      return res.status(400).json({ message: 'Comment body is required' });
    }

    const requestedProfileType = req.body?.authorProfileType === 'creator' ? 'creator' : 'user';
    let authorProfileType: 'user' | 'creator' = 'user';
    let authorProfileId = 'profile';
    let displayName = req.authUser!.displayName;
    if (requestedProfileType === 'creator') {
      const requestedArtistId = typeof req.body?.authorProfileId === 'string' ? req.body.authorProfileId : '';
      const creators = await store.listCreators();
      const creator = creators.find((item) => item.creatorId === requestedArtistId);
      if (!creator) {
        return res.status(400).json({ message: 'Creator profile not found' });
      }
      if (!(await ensureCreatorContentAccess(req, res, creator.creatorId))) {
        return;
      }
      authorProfileType = 'creator';
      authorProfileId = creator.slug;
      displayName = creator.name;
    } else {
      const profile = await ensureUserProfile(req);
      authorProfileType = 'user';
      authorProfileId = profile.username;
      displayName = profile.displayName || profile.username || req.authUser!.displayName;
    }

    const comment = {
      commentId: randomUUID(),
      userId: req.authUser!.userId,
      authorProfileType,
      authorProfileId,
      displayName,
      targetType: 'grouping' as const,
      targetId: grouping.groupingId,
      body,
      hidden: false,
      createdAt: new Date().toISOString()
    };

    await store.createComment(comment);
    return res.status(201).json(toPublicComment(comment));
  });

  app.get('/images/:imageId/comments', async (req, res) => {
    const comments = await store.listComments('image', req.params.imageId);
    return res.json(comments.map(toPublicComment));
  });

  app.post('/images/:imageId/comments', requireAuth, async (req, res) => {
    if (await store.isUserBlocked(req.authUser!.userId)) {
      return res.status(403).json({ message: 'User blocked' });
    }

    const body = String(req.body?.body || '').trim();
    if (!body) {
      return res.status(400).json({ message: 'Comment body is required' });
    }

    const requestedProfileType = req.body?.authorProfileType === 'creator' ? 'creator' : 'user';
    let authorProfileType: 'user' | 'creator' = 'user';
    let authorProfileId = 'profile';
    let displayName = req.authUser!.displayName;
    if (requestedProfileType === 'creator') {
      const requestedArtistId = typeof req.body?.authorProfileId === 'string' ? req.body.authorProfileId : '';
      const creators = await store.listCreators();
      const creator = creators.find((item) => item.creatorId === requestedArtistId);
      if (!creator) {
        return res.status(400).json({ message: 'Creator profile not found' });
      }
      if (!(await ensureCreatorContentAccess(req, res, creator.creatorId))) {
        return;
      }
      authorProfileType = 'creator';
      authorProfileId = creator.slug;
      displayName = creator.name;
    } else {
      const profile = await ensureUserProfile(req);
      authorProfileType = 'user';
      authorProfileId = profile.username;
      displayName = profile.displayName || profile.username || req.authUser!.displayName;
    }

    const comment = {
      commentId: randomUUID(),
      userId: req.authUser!.userId,
      authorProfileType,
      authorProfileId,
      displayName,
      targetType: 'image' as const,
      targetId: req.params.imageId,
      body,
      hidden: false,
      createdAt: new Date().toISOString()
    };

    await store.createComment(comment);
    return res.status(201).json(toPublicComment(comment));
  });

  app.get('/me/favorites', requireAuth, async (req, res) => {
    const ownerProfile = await resolveOwnerProfile(req, {
      ownerProfileType: req.query.ownerProfileType,
      ownerProfileId: req.query.ownerProfileId
    });
    if (!ownerProfile) {
      return res.status(403).json({ message: 'Creator access required for creator profile actions' });
    }
    const favorites = await store.listFavoritesByProfile(ownerProfile.ownerProfileType, ownerProfile.ownerProfileId);
    const limit = Number(req.query.limit);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    if (Number.isFinite(limit) || cursor) {
      const normalizedLimit = Math.max(1, Math.min(100, Number.isFinite(limit) ? Number(limit) : 24));
      const offset = parseOffsetCursor(cursor);
      const items = favorites.slice(offset, offset + normalizedLimit);
      const nextCursor = offset + items.length < favorites.length ? encodeOffsetCursor(offset + items.length) : undefined;
      return res.json({ items, nextCursor });
    }
    return res.json(favorites);
  });

  app.get('/me/follows', requireAuth, async (req, res) => {
    const follows = await store.listFollowsByUser(req.authUser!.userId);
    return res.json(follows);
  });

  app.get('/me', requireAuth, async (req, res) => {
    const profile = await ensureUserProfile(req);
    return res.json({
      userId: req.authUser!.userId,
      displayName: profile.displayName || profile.username || req.authUser!.displayName,
      username: profile.username,
      role: resolveRole(req.authUser!),
      groups: req.authUser!.groups
    });
  });

  app.get('/me/profile', requireAuth, async (req, res) => {
    const profile = await ensureUserProfile(req);
    const normalizedDisclosurePolicy = profileDisclosurePolicy(profile);
    return res.json({
      ...profile,
      branding: await publicProfileBranding(profile.branding, `${req.protocol}://${req.get('host')}`),
      matureContentEnabled: Boolean(profile.matureContentEnabled),
      maxAllowedContentRating: normalizeContentRating(profile.maxAllowedContentRating || 'graphic'),
      aiFilter: normalizedDisclosurePolicy.aiFilter,
      hideHeavyTopics: normalizedDisclosurePolicy.hideHeavyTopics,
      hidePoliticsPublicAffairs: normalizedDisclosurePolicy.hidePoliticsPublicAffairs,
      hideCrimeDisastersTragedy: normalizedDisclosurePolicy.hideCrimeDisastersTragedy
    });
  });

  app.get('/me/creators', requireAuth, async (req, res) => {
    try {
      const creators = isAdminRequest(req)
        ? await store.listCreators()
        : await store.listCreatorsByUserId(req.authUser!.userId);
      const requestOrigin = `${req.protocol}://${req.get('host')}`;
      const withResolvedBranding = async (creator: Creator, memberRole: string) => {
        const branding = await publicProfileBranding(creator.branding, requestOrigin);
        return {
          ...creator,
          // Retain the legacy identifier while the remaining public UI is migrated
          // from Artist terminology to the canonical Creator model.
          artistId: creator.creatorId,
          branding,
          creatorThumbnailUrl: branding.profileImage?.thumbnailUrls?.square256
            || branding.profileImage?.thumbnailUrls?.square512,
          memberRole
        };
      };
      if (isAdminRequest(req)) {
        return res.json(await Promise.all(creators.map((creator) => withResolvedBranding(creator, 'admin'))));
      }
      const memberships = await Promise.all(
        creators.map(async (creator) => {
          const member = await getCreatorMembership(creator.creatorId, req.authUser!.userId);
          return withResolvedBranding(creator, member?.role || 'editor');
        })
      );
      return res.json(memberships);
    } catch (error) {
      logServerError('GET /me/creators', error);
      res.setHeader('x-api-fallback', 'me-creators-empty');
      return res.json([]);
    }
  });

  app.put('/me/profile', requireAuth, async (req, res) => {
    const existing = await ensureUserProfile(req);
    const requestedDisplayName = sanitizeOptional(req.body?.displayName, 80) || existing.displayName || existing.username;
    const matureContentEnabled = typeof req.body?.matureContentEnabled === 'boolean'
      ? req.body.matureContentEnabled
      : Boolean(existing.matureContentEnabled);
    const maxAllowedContentRating = req.body?.maxAllowedContentRating !== undefined
      ? normalizeContentRating(req.body.maxAllowedContentRating)
      : normalizeContentRating(existing.maxAllowedContentRating || 'graphic');
    const existingDisclosurePolicy = profileDisclosurePolicy(existing);
    const disclosurePolicy = normalizeViewerDisclosurePolicy({
      aiFilter: req.body?.aiFilter !== undefined
        ? normalizeAiFilterPreference(req.body.aiFilter)
        : existingDisclosurePolicy.aiFilter,
      hideHeavyTopics: req.body?.hideHeavyTopics !== undefined
        ? Boolean(req.body.hideHeavyTopics)
        : existingDisclosurePolicy.hideHeavyTopics,
      hidePoliticsPublicAffairs: req.body?.hidePoliticsPublicAffairs !== undefined
        ? Boolean(req.body.hidePoliticsPublicAffairs)
        : existingDisclosurePolicy.hidePoliticsPublicAffairs,
      hideCrimeDisastersTragedy: req.body?.hideCrimeDisastersTragedy !== undefined
        ? Boolean(req.body.hideCrimeDisastersTragedy)
        : existingDisclosurePolicy.hideCrimeDisastersTragedy
    });
    const updated: UserProfile = {
      ...existing,
      displayName: requestedDisplayName,
      bio: sanitizeLimitedRichText(req.body?.bio, 600),
      externalLinks: req.body?.externalLinks !== undefined
        ? parseUserExternalLinks(req.body.externalLinks)
        : (existing.externalLinks || []),
      location: sanitizeOptional(req.body?.location, 120),
      website: sanitizeOptional(req.body?.website, 220),
      coverPreset: req.body?.coverPreset !== undefined ? parseCreatorCoverPreset(req.body.coverPreset) : existing.coverPreset,
      matureContentEnabled,
      maxAllowedContentRating,
      aiFilter: disclosurePolicy.aiFilter,
      hideHeavyTopics: disclosurePolicy.hideHeavyTopics,
      hidePoliticsPublicAffairs: disclosurePolicy.hidePoliticsPublicAffairs,
      hideCrimeDisastersTragedy: disclosurePolicy.hideCrimeDisastersTragedy,
      updatedAt: new Date().toISOString()
    };
    await store.upsertUserProfile(updated);
    return res.json({
      ...updated,
      branding: await publicProfileBranding(updated.branding, `${req.protocol}://${req.get('host')}`)
    });
  });

  app.post('/me/profile/deactivate', requireAuth, async (req, res) => {
    const existing = await ensureUserProfile(req);
    await store.upsertUserProfile({ ...existing, status: 'inactive', updatedAt: new Date().toISOString() });
    return res.json({ ok: true });
  });

  app.post('/me/profile/branding/upload-url', requireAuth, async (req, res) => {
    const profile = await ensureUserProfile(req);
    const contentType = req.body?.contentType ? String(req.body.contentType) : 'image/jpeg';
    if (!contentType.startsWith('image/')) return res.status(400).json({ message: 'Profile media must be an image.' });
    const extension = contentType.includes('png') ? 'png' : (contentType.includes('webp') ? 'webp' : 'jpg');
    const kind = req.body?.kind === 'cover' ? 'cover' : 'profile';
    const key = `${profile.userId}/profile-branding/${kind}/source.${extension}`;
    if (config.localMediaDirectory) {
      return res.status(201).json({
        key,
        uploadUrl: `${req.protocol}://${req.get('host')}/me/profile/branding/local-upload?kind=${kind}`,
        contentType,
        requiresAuth: true
      });
    }
    const uploadUrl = await getS3SignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: config.mediaBucket,
        Key: key,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable'
      }),
      { expiresIn: 300 }
    );
    return res.status(201).json({ key, uploadUrl, contentType, requiresAuth: false });
  });

  app.put('/me/profile/branding/local-upload', requireAuth, express.raw({ type: 'image/*', limit: '25mb' }), async (req, res) => {
    if (!config.localMediaDirectory) return res.status(404).json({ message: 'Local media storage is not enabled.' });
    const profile = await ensureUserProfile(req);
    const contentType = req.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/') || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ message: 'An image body is required.' });
    }
    const extension = contentType.includes('png') ? 'png' : (contentType.includes('webp') ? 'webp' : 'jpg');
    const kind = req.query.kind === 'cover' ? 'cover' : 'profile';
    const key = `${profile.userId}/profile-branding/${kind}/source.${extension}`;
    await writeLocalMediaSource(key, req.body);
    return res.status(201).json({ key });
  });

  app.post('/me/profile/branding/profile-image', requireAuth, async (req, res) => {
    const profile = await ensureUserProfile(req);
    const sourceKey = sanitizeOptional(req.body?.sourceKey, 1024);
    if (!sourceKey) return res.status(400).json({ message: 'sourceKey is required' });
    const generated = config.localMediaDirectory
      ? await generateLocalCreatorProfileRenditions({
          root: config.localMediaDirectory,
          sourceKey,
          targetPrefix: `${profile.userId}/profile-branding/profile`,
          squareCrop: parseSquareCrop(req.body?.squareCrop)
        })
      : await generateCreatorProfileRenditions({
          s3: s3Client,
          bucket: config.mediaBucket,
          sourceKey,
          targetPrefix: `${profile.userId}/profile-branding/profile`,
          squareCrop: parseSquareCrop(req.body?.squareCrop)
        });
    const updated: UserProfile = {
      ...profile,
      branding: {
        ...(profile.branding || {}),
        profileImage: {
          sourceKey: generated.sourceKey,
          thumbnailKeys: generated.thumbnailKeys,
          squareCrop: generated.squareCrop,
          altText: sanitizeOptional(req.body?.altText, 200),
          updatedAt: new Date().toISOString()
        }
      },
      updatedAt: new Date().toISOString()
    };
    await store.upsertUserProfile(updated);
    return res.status(201).json(updated);
  });

  app.post('/me/profile/branding/cover-image', requireAuth, async (req, res) => {
    const profile = await ensureUserProfile(req);
    const sourceKey = sanitizeOptional(req.body?.sourceKey, 1024);
    if (!sourceKey) return res.status(400).json({ message: 'sourceKey is required' });
    const coverOptions = {
      sourceKey,
      targetPrefix: `${profile.userId}/profile-branding/cover`,
      focalPoint: parseFocalPoint(req.body?.focalPoint),
      crops: {
        desktop: parseCoverCrop(req.body?.crops?.desktop),
        tablet: parseCoverCrop(req.body?.crops?.tablet),
        mobile: parseCoverCrop(req.body?.crops?.mobile)
      }
    };
    const generated = config.localMediaDirectory
      ? await generateLocalCreatorCoverRenditions({ root: config.localMediaDirectory, ...coverOptions })
      : await generateCreatorCoverRenditions({ s3: s3Client, bucket: config.mediaBucket, ...coverOptions });
    const updated: UserProfile = {
      ...profile,
      branding: {
        ...(profile.branding || {}),
        coverImage: {
          sourceKey: generated.sourceKey,
          renditionKeys: generated.renditionKeys,
          crops: generated.crops,
          focalPoint: generated.focalPoint,
          altText: sanitizeOptional(req.body?.altText, 200),
          updatedAt: new Date().toISOString()
        }
      },
      updatedAt: new Date().toISOString()
    };
    await store.upsertUserProfile(updated);
    return res.status(201).json(updated);
  });

  app.delete('/me/profile/branding/:kind', requireAuth, async (req, res) => {
    const profile = await ensureUserProfile(req);
    const kind = req.params.kind;
    if (kind !== 'profile-image' && kind !== 'cover-image') {
      return res.status(400).json({ message: 'Unknown profile branding kind.' });
    }
    const updated: UserProfile = {
      ...profile,
      branding: {
        ...(profile.branding || {}),
        ...(kind === 'profile-image' ? { profileImage: undefined } : { coverImage: undefined })
      },
      updatedAt: new Date().toISOString()
    };
    await store.upsertUserProfile(updated);
    return res.status(204).send();
  });

  app.patch('/me/username', requireAuth, async (req, res) => {
    const requested = typeof req.body?.username === 'string' ? req.body.username : '';
    const { normalized, reasons } = validateUsername(requested);
    if (reasons.length > 0) {
      return res.status(400).json({ message: reasons[0], reasons, suggestions: await buildUsernameSuggestions(store, requested, brand.id) });
    }

    const profile = await ensureUserProfile(req);
    if (profile.username === normalized) {
      return res.json(profile);
    }

    if (profile.lastUsernameChangeAt) {
      const lastChanged = new Date(profile.lastUsernameChangeAt).getTime();
      const nextAllowedAtMs = lastChanged + USERNAME_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      if (Date.now() < nextAllowedAtMs) {
        return res.status(429).json({
          message: `Username can be changed once every ${USERNAME_CHANGE_COOLDOWN_DAYS} days.`,
          nextAllowedAt: new Date(nextAllowedAtMs).toISOString()
        });
      }
    }

    const available = await store.isUsernameAvailable(normalized);
    if (!available) {
      return res.status(409).json({ message: 'Username is already taken.', suggestions: await buildUsernameSuggestions(store, normalized, brand.id) });
    }

    if (!config.cognitoUserPoolId || !req.authUser?.email) {
      return res.status(500).json({ message: 'Username sync is not configured for Cognito.' });
    }

    await store.reserveUsername(normalized, normalized, req.authUser!.displayName);
    try {
      await cognitoClient.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: config.cognitoUserPoolId,
          Username: req.authUser.email,
          UserAttributes: [{ Name: 'preferred_username', Value: normalized }]
        })
      );
    } catch (error) {
      await store.releaseUsername(normalized);
      return res.status(500).json({
        message: `Failed to update Cognito username: ${(error as Error).message || 'unknown error'}`
      });
    }

    const updated: UserProfile = {
      ...profile,
      username: normalized,
      usernameHistory: uniqueSlugs([...(profile.usernameHistory || [profile.username]), normalized]),
      updatedAt: new Date().toISOString(),
      lastUsernameChangeAt: new Date().toISOString()
    };
    await store.upsertUserProfile(updated);
    return res.json(updated);
  });

  app.post('/favorites', requireAuth, async (req, res) => {
    const targetType = req.body?.targetType;
    const targetId = req.body?.targetId;
    const visibility: 'public' | 'private' = req.body?.visibility === 'private' ? 'private' : 'public';
    if ((targetType !== 'grouping' && targetType !== 'image' && targetType !== 'collection') || !targetId) {
      return res.status(400).json({ message: 'targetType and targetId are required' });
    }

    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`favorite:add:${req.authUser!.userId}:${ip}`, 60_000, 90)) {
      return res.status(429).json({ message: 'Too many favorite requests, try again later' });
    }

    const ownerProfile = await resolveOwnerProfile(req, req.body);
    if (!ownerProfile) {
      return res.status(403).json({ message: 'Creator access required for creator profile actions' });
    }

    const favorite = {
      userId: req.authUser!.userId,
      ownerProfileType: ownerProfile.ownerProfileType,
      ownerProfileId: ownerProfile.ownerProfileId,
      targetType,
      targetId,
      visibility,
      createdAt: new Date().toISOString()
    };
    const result = await withIdempotency(req, async () => {
      await store.addFavorite(favorite);
      auditLog(req, 'favorite.add', {
        ownerProfileType: favorite.ownerProfileType,
        ownerProfileId: favorite.ownerProfileId,
        targetType: favorite.targetType,
        targetId: favorite.targetId,
        visibility: favorite.visibility
      });
      return { status: 201, body: favorite };
    });
    return res.status(result.status).json(result.body);
  });

  app.delete('/favorites', requireAuth, async (req, res) => {
    const targetType = req.body?.targetType;
    const targetId = req.body?.targetId;
    if ((targetType !== 'grouping' && targetType !== 'image' && targetType !== 'collection') || !targetId) {
      return res.status(400).json({ message: 'targetType and targetId are required' });
    }

    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`favorite:remove:${req.authUser!.userId}:${ip}`, 60_000, 90)) {
      return res.status(429).json({ message: 'Too many favorite requests, try again later' });
    }

    const ownerProfile = await resolveOwnerProfile(req, req.body);
    if (!ownerProfile) {
      return res.status(403).json({ message: 'Creator access required for creator profile actions' });
    }

    const result = await withIdempotency(req, async () => {
      await store.removeFavorite(req.authUser!.userId, targetType, targetId, ownerProfile.ownerProfileType, ownerProfile.ownerProfileId);
      auditLog(req, 'favorite.remove', {
        ownerProfileType: ownerProfile.ownerProfileType,
        ownerProfileId: ownerProfile.ownerProfileId,
        targetType,
        targetId
      });
      return { status: 204 };
    });
    return res.status(result.status).send();
  });

  app.post('/creators/:creatorId/follow', requireAuth, async (req, res) => {
    const creators = await store.listCreators();
    const creator = creators.find((item) => item.creatorId === req.params.creatorId);
    if (!creator || creator.status !== 'active') {
      return res.status(404).json({ message: 'Creator not found' });
    }
    const follow = {
      followId: randomUUID(),
      followerUserId: req.authUser!.userId,
      creatorId: creator.creatorId,
      notificationsEnabled: Boolean(req.body?.notificationsEnabled),
      insertedDate: new Date().toISOString()
    };
    await store.followCreator(follow);
    auditLog(req, 'follow.add', { creator: follow.creatorId });
    return res.status(201).json(follow);
  });

  app.delete('/creators/:creatorId/follow', requireAuth, async (req, res) => {
    await store.unfollowCreator(req.authUser!.userId, req.params.creatorId);
    auditLog(req, 'follow.remove', { creator: req.params.creatorId });
    return res.status(204).send();
  });

  app.get('/collections', async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');
    const limit = Math.max(1, Math.min(60, Number(req.query.limit || 24)));
    const order = req.query.order === 'latest' ? 'latest' : (req.query.order === 'popular' ? 'popular' : 'random');
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const seed = typeof req.query.seed === 'string'
      ? req.query.seed
      : new Date().toISOString().slice(0, 10);

    let itemsForPage: Array<Awaited<ReturnType<typeof store.listPublicCollections>>['items'][number]> = [];
    let nextCursor: string | undefined;

    if (order === 'latest') {
      const latest = await store.listPublicCollections(limit, parsePassthroughCursor(cursor));
      itemsForPage = latest.items;
      nextCursor = latest.nextCursor ? encodePassthroughCursor(latest.nextCursor) : undefined;
    } else {
      const all: typeof itemsForPage = [];
      let pageCursor: string | undefined = undefined;
      let guard = 0;
      while (guard < 100) {
        const page = await store.listPublicCollections(100, pageCursor);
        all.push(...page.items);
        pageCursor = page.nextCursor;
        guard += 1;
        if (!pageCursor) break;
      }
      if (order === 'random') {
        all.sort((a, b) => stableHash(`${seed}:${a.collectionId}`) - stableHash(`${seed}:${b.collectionId}`));
      } else {
        const popular = await Promise.all(all.map(async (item) => ({
          item,
          favoriteCount: await store.countFavorites('collection', item.collectionId)
        })));
        popular.sort((a, b) => {
          if (b.favoriteCount !== a.favoriteCount) return b.favoriteCount - a.favoriteCount;
          return b.item.updatedDate.localeCompare(a.item.updatedDate);
        });
        all.splice(0, all.length, ...popular.map((row) => row.item));
      }
      const offset = parseOffsetCursor(cursor);
      itemsForPage = all.slice(offset, offset + limit);
      nextCursor = offset + itemsForPage.length < all.length ? encodeOffsetCursor(offset + itemsForPage.length) : undefined;
    }

    const hydrated = await Promise.all(itemsForPage.map(async (collection) => ({
      ...collection,
      favoriteCount: await store.countFavorites('collection', collection.collectionId)
    })));
    return res.json({ items: hydrated, nextCursor, order, seed });
  });

  app.get('/collections/:collectionId', async (req, res) => {
    const collection = await store.getCollectionById(req.params.collectionId);
    if (!collection) {
      return res.status(404).json({ message: 'Collection not found' });
    }
    const isOwner = Boolean(req.authUser && await canManageCollection(req, collection));
    if (collection.visibility === 'private' && !isOwner && !isAdminRequest(req)) {
      return res.status(404).json({ message: 'Collection not found' });
    }
    const imageIds = await store.listCollectionImageIds(collection.collectionId);
    const viewerPolicy = await resolveViewerContentPolicy(req);
    const items = await hydrateCollectionItems(collection, imageIds, viewerPolicy);
    return res.json({
      ...collection,
      imageIds,
      items,
      favoriteCount: await store.countFavorites('collection', collection.collectionId)
    });
  });

  app.get('/me/collections', requireAuth, async (req, res) => {
    const ownerProfile = await resolveOwnerProfile(req, {
      ownerProfileType: req.query.ownerProfileType,
      ownerProfileId: req.query.ownerProfileId
    });
    if (!ownerProfile) {
      return res.status(403).json({ message: 'Creator access required for creator profile actions' });
    }
    const collections = await store.listCollectionsByProfile(ownerProfile.ownerProfileType, ownerProfile.ownerProfileId);
    const limit = Number(req.query.limit);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    if (Number.isFinite(limit) || cursor) {
      const normalizedLimit = Math.max(1, Math.min(100, Number.isFinite(limit) ? Number(limit) : 24));
      const offset = parseOffsetCursor(cursor);
      const items = collections.slice(offset, offset + normalizedLimit);
      const nextCursor = offset + items.length < collections.length ? encodeOffsetCursor(offset + items.length) : undefined;
      return res.json({ items, nextCursor });
    }
    return res.json(collections);
  });

  app.post('/me/collections', requireAuth, async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`collection:create:${req.authUser!.userId}:${ip}`, 60_000, 30)) {
      return res.status(429).json({ message: 'Too many collection requests, try again later' });
    }
    const title = String(req.body?.title || '').trim();
    if (!title) {
      return res.status(400).json({ message: 'title is required' });
    }
    const ownerProfile = await resolveOwnerProfile(req, req.body);
    if (!ownerProfile) {
      return res.status(403).json({ message: 'Creator access required for creator profile actions' });
    }
    const now = new Date().toISOString();
    const visibility: 'public' | 'private' = req.body?.visibility === 'private' ? 'private' : 'public';
    const collection: Collection = {
      collectionId: randomUUID(),
      ownerUserId: req.authUser!.userId,
      ownerProfileType: ownerProfile.ownerProfileType,
      ownerProfileId: ownerProfile.ownerProfileId,
      title,
      description: sanitizeOptional(req.body?.description, 400),
      coverImageId: sanitizeOptional(req.body?.coverImageId, 120),
      visibility,
      insertedDate: now,
      updatedDate: now,
      imageCount: 0,
      favoriteCount: 0
    };
    const result = await withIdempotency(req, async () => {
      await store.createCollection(collection);
      auditLog(req, 'collection.create', {
        collectionId: collection.collectionId,
        ownerProfileType: collection.ownerProfileType,
        ownerProfileId: collection.ownerProfileId,
        visibility: collection.visibility
      });
      return { status: 201, body: collection };
    });
    return res.status(result.status).json(result.body);
  });

  app.patch('/me/collections/:collectionId', requireAuth, async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`collection:update:${req.authUser!.userId}:${ip}`, 60_000, 60)) {
      return res.status(429).json({ message: 'Too many collection requests, try again later' });
    }
    const existing = await store.getCollectionById(req.params.collectionId);
    if (!existing || !(await canManageCollection(req, existing))) {
      return res.status(404).json({ message: 'Collection not found' });
    }
    const updated = {
      ...existing,
      title: req.body?.title ? String(req.body.title).trim() : existing.title,
      description: req.body?.description !== undefined ? sanitizeOptional(req.body?.description, 400) : existing.description,
      coverImageId: req.body?.coverImageId !== undefined ? sanitizeOptional(req.body?.coverImageId, 120) : existing.coverImageId,
      visibility: req.body?.visibility === 'private' ? 'private' : (req.body?.visibility === 'public' ? 'public' : existing.visibility),
      updatedDate: new Date().toISOString()
    };
    const result = await withIdempotency(req, async () => {
      await store.updateCollection(updated);
      auditLog(req, 'collection.update', { collectionId: updated.collectionId, visibility: updated.visibility });
      return { status: 200, body: updated };
    });
    return res.status(result.status).json(result.body);
  });

  app.delete('/me/collections/:collectionId', requireAuth, async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`collection:delete:${req.authUser!.userId}:${ip}`, 60_000, 30)) {
      return res.status(429).json({ message: 'Too many collection requests, try again later' });
    }
    const existing = await store.getCollectionById(req.params.collectionId);
    if (!existing || !(await canManageCollection(req, existing))) {
      return res.status(404).json({ message: 'Collection not found' });
    }
    const result = await withIdempotency(req, async () => {
      await store.deleteCollection(existing.collectionId);
      auditLog(req, 'collection.delete', { collectionId: existing.collectionId });
      return { status: 204 };
    });
    return res.status(result.status).send();
  });

  app.post('/me/collections/:collectionId/images', requireAuth, async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`collection:image:add:${req.authUser!.userId}:${ip}`, 60_000, 90)) {
      return res.status(429).json({ message: 'Too many collection requests, try again later' });
    }
    const existing = await store.getCollectionById(req.params.collectionId);
    if (!existing || !(await canManageCollection(req, existing))) {
      return res.status(404).json({ message: 'Collection not found' });
    }
    const imageId = String(req.body?.imageId || '').trim();
    if (!imageId) {
      return res.status(400).json({ message: 'imageId is required' });
    }
    const currentIds = await store.listCollectionImageIds(existing.collectionId);
    const sortOrder = Number.isFinite(Number(req.body?.sortOrder)) ? Number(req.body.sortOrder) : currentIds.length;
    const result = await withIdempotency(req, async () => {
      await store.addImageToCollection(existing.collectionId, imageId, sortOrder);
      const nextIds = await store.listCollectionImageIds(existing.collectionId);
      const updated = { ...existing, imageCount: nextIds.length, updatedDate: new Date().toISOString() };
      await store.updateCollection(updated);
      auditLog(req, 'collection.image.add', { collectionId: existing.collectionId, imageId });
      return { status: 201, body: updated };
    });
    return res.status(result.status).json(result.body);
  });

  app.delete('/me/collections/:collectionId/images/:imageId', requireAuth, async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`collection:image:remove:${req.authUser!.userId}:${ip}`, 60_000, 90)) {
      return res.status(429).json({ message: 'Too many collection requests, try again later' });
    }
    const existing = await store.getCollectionById(req.params.collectionId);
    if (!existing || !(await canManageCollection(req, existing))) {
      return res.status(404).json({ message: 'Collection not found' });
    }
    const result = await withIdempotency(req, async () => {
      await store.removeImageFromCollection(existing.collectionId, req.params.imageId);
      const nextIds = await store.listCollectionImageIds(existing.collectionId);
      const updated = { ...existing, imageCount: nextIds.length, updatedDate: new Date().toISOString() };
      await store.updateCollection(updated);
      auditLog(req, 'collection.image.remove', { collectionId: existing.collectionId, imageId: req.params.imageId });
      return { status: 204 };
    });
    return res.status(result.status).send();
  });

  app.get('/me/identity', requireAuth, async (req, res) => {
    const stored = await store.getUserIdentity?.(req.authUser!.userId);
    const role = normalizePlatformRoleValue(stored?.role ?? (resolveRole(req.authUser!) === 'admin' ? 'admin' : 'user'));
    const capabilities = stored?.capabilities || resolveCapabilities(role);
    return res.json({
      userId: req.authUser!.userId,
      role,
      isBeeker: Boolean(stored?.isBeeker),
      capabilities
    });
  });

  app.get('/contribution-contexts', async (_req, res) => {
    if (!store.listContributionContexts) return res.json([]);
    const contexts = await store.listContributionContexts();
    return res.json(contexts.filter((item) => item.status !== 'draft'));
  });

  app.get('/contribution-contexts/:slug', async (req, res) => {
    if (!store.getContributionContextBySlug) return res.status(404).json({ message: 'Context not found' });
    const context = await store.getContributionContextBySlug(req.params.slug);
    if (!context || context.status === 'draft') return res.status(404).json({ message: 'Context not found' });
    const submissions = await store.listContextSubmissions?.(context.contextId) || [];
    const votes = await store.listChallengeVotes?.(context.contextId) || [];
    const approvedSubmissions = submissions.filter((item) => item.status === 'approved' && item.entryStatus !== 'withdrawn' && item.entryStatus !== 'removed').length;
    const thresholds = await store.listContextUnlockThresholds?.(context.contextId) || [];
    const prizes = await store.listChallengePrizes?.(context.contextId) || [];
    return res.json({
      ...context,
      metrics: {
        submissionCount: submissions.length,
        approvedSubmissionCount: approvedSubmissions,
        voteCount: votes.length
      },
      unlockThresholds: thresholds,
      prizes,
      laurels: await store.listChallengeLaurels?.(context.contextId) || [],
      awards: await store.listChallengeLaurelAwards?.(context.contextId) || [],
      entries: submissions.filter((entry) => entry.status !== 'rejected' && entry.entryStatus !== 'withdrawn' && entry.entryStatus !== 'removed').map((entry) => ({ ...entry, voteCount: votes.filter((vote) => vote.submissionId === entry.submissionId).length }))
    });
  });

  app.get('/challenges', async (_req, res) => {
    const contexts = await store.listContributionContexts?.() || [];
    return res.json(contexts.filter((item) => item.type === 'challenge' && item.status !== 'draft' && item.status !== 'archived' && item.status !== 'cancelled'));
  });

  app.get('/challenges/:slug', async (req, res) => {
    const context = await store.getContributionContextBySlug?.(req.params.slug);
    if (!context || context.type !== 'challenge' || context.status === 'draft' || context.status === 'archived' || context.status === 'cancelled') return res.status(404).json({ message: 'Challenge not found' });
    const submissions = await store.listContextSubmissions?.(context.contextId) || [];
    const votes = await store.listChallengeVotes?.(context.contextId) || [];
    const visibleSubmissions = submissions.filter((entry) => entry.status !== 'rejected' && entry.entryStatus !== 'withdrawn' && entry.entryStatus !== 'removed');
    return res.json({ ...context, entries: visibleSubmissions.map((entry) => ({ ...entry, voteCount: votes.filter((vote) => vote.submissionId === entry.submissionId).length })), prizes: await store.listChallengePrizes?.(context.contextId) || [], laurels: await store.listChallengeLaurels?.(context.contextId) || [], awards: await store.listChallengeLaurelAwards?.(context.contextId) || [], metrics: { submissionCount: visibleSubmissions.length, voteCount: votes.length } });
  });

  app.post('/contribution-contexts/:contextId/submissions', requireAuth, async (req, res) => {
    if (!store.getContributionContextById || !store.createContextSubmission) {
      return res.status(503).json({ message: 'Submission service unavailable' });
    }
    const context = await store.getContributionContextById(req.params.contextId);
    if (!context || context.status !== 'active') {
      return res.status(404).json({ message: 'Active context not found' });
    }
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) return res.status(400).json({ message: 'title is required' });
    const role = await resolvePlatformRole(req.authUser!.userId);
    const canSubmit = resolveCapabilities(role).canSubmitToContexts || role === 'user';
    if (!canSubmit) return res.status(403).json({ message: 'Contributor permissions required' });
    const mediaIds = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds.filter((id: unknown) => typeof id === 'string' && id.trim()) : [];
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds.filter((id: unknown) => typeof id === 'string' && id.trim()) : [];
    const workId = typeof req.body?.workId === 'string' && req.body.workId.trim() ? req.body.workId.trim() : undefined;
    if (!workId && !mediaIds.length && !fileIds.length && !req.body?.externalUrl) return res.status(400).json({ message: 'Choose a Work, media, file, or external URL.' });
    if (workId) {
      const work = await store.getWork?.(config.tenantId, workId);
      if (!work || (!(await store.hasCreatorAccess(req.authUser!.userId, work.creatorId)) && work.creatorId !== 'community')) return res.status(404).json({ message: 'Work not found' });
    }
    const existingEntries = await store.listContextSubmissions?.(context.contextId) || [];
    const maxEntries = context.entryConfig?.maxEntriesPerCreator || context.rules.maxEntriesPerUser || 3;
    if (existingEntries.filter((entry) => entry.userId === req.authUser!.userId && entry.entryStatus !== 'withdrawn' && entry.entryStatus !== 'removed').length >= maxEntries) return res.status(409).json({ message: `This challenge allows at most ${maxEntries} entries per participant.` });
    const submission: ContextSubmission = {
      submissionId: randomUUID(),
      contextId: context.contextId,
      userId: req.authUser!.userId,
      status: 'pending',
      title,
      notes: sanitizeOptional(req.body?.notes, 4000),
      mediaIds,
      fileIds,
      workId,
      externalUrl: sanitizeOptional(req.body?.externalUrl, 2000),
      entryStatus: 'active',
      voteCount: 0,
      submittedAt: new Date().toISOString()
    };
    await store.createContextSubmission(submission);
    return res.status(201).json(submission);
  });

  app.post('/contribution-contexts/:contextId/submissions/:submissionId/withdraw', requireAuth, async (req, res) => {
    const submission = await store.getContextSubmissionById?.(req.params.submissionId);
    if (!submission || submission.contextId !== req.params.contextId) return res.status(404).json({ message: 'Entry not found' });
    if (submission.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this entry.' });
    const updated = { ...submission, entryStatus: 'withdrawn' as const };
    await store.updateContextSubmission?.(updated);
    return res.json(updated);
  });

  app.post('/contribution-contexts/:contextId/submissions/:submissionId/vote', requireAuth, async (req, res) => {
    const context = await store.getContributionContextById?.(req.params.contextId);
    const submission = await store.getContextSubmissionById?.(req.params.submissionId);
    if (!context || !submission || submission.contextId !== context.contextId) return res.status(404).json({ message: 'Entry not found' });
    if (!context.votingConfig || context.votingConfig.mode === 'none' || !['active', 'voting_open'].includes(context.status)) return res.status(409).json({ message: 'Voting is not open for this challenge.' });
    if (submission.userId === req.authUser!.userId) return res.status(400).json({ message: 'You cannot vote for your own entry.' });
    const existing = await store.getChallengeVote?.(context.contextId, submission.submissionId, req.authUser!.userId);
    if (existing) return res.status(409).json({ message: 'You have already voted for this entry.', vote: existing });
    const vote: ChallengeVote = { voteId: randomUUID(), contextId: context.contextId, submissionId: submission.submissionId, userId: req.authUser!.userId, createdAt: new Date().toISOString() };
    await store.createChallengeVote?.(vote);
    const count = (await store.listChallengeVotes?.(context.contextId) || []).filter((item) => item.submissionId === submission.submissionId).length;
    await store.updateContextSubmission?.({ ...submission, voteCount: count });
    return res.status(201).json({ vote, voteCount: count });
  });

  app.get('/studio/contribution-contexts', requireAdmin, async (_req, res) => {
    if (!store.listContributionContexts) return res.json([]);
    return res.json(await store.listContributionContexts());
  });

  app.post('/studio/contribution-contexts', requireAdmin, async (req, res) => {
    if (!store.createContributionContext) return res.status(503).json({ message: 'Context service unavailable' });
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) return res.status(400).json({ message: 'title is required' });
    const now = new Date().toISOString();
    const allowedStatuses: ContributionContext['status'][] = ['draft', 'scheduled', 'active', 'entries_closed', 'voting_open', 'voting_closed', 'awaiting_awards', 'awarded', 'closed', 'archived', 'cancelled'];
    const requestedStatus = req.body?.status;
    const context: ContributionContext = {
      contextId: randomUUID(),
      type: req.body?.type === 'event' ? 'event' : 'challenge',
      title,
      slug: slugify(typeof req.body?.slug === 'string' && req.body.slug.trim() ? req.body.slug : title),
      status: allowedStatuses.includes(requestedStatus) ? requestedStatus : 'draft',
      description: sanitizeOptional(req.body?.description, 5000),
      rules: {
        maxEntriesPerUser: Number.isFinite(Number(req.body?.rules?.maxEntriesPerUser)) ? Math.max(1, Math.floor(Number(req.body.rules.maxEntriesPerUser))) : 3,
        requiresOtp: req.body?.rules?.requiresOtp !== false
      },
      submissionWindow: {
        opensAt: sanitizeOptional(req.body?.submissionWindow?.opensAt, 64),
        closesAt: sanitizeOptional(req.body?.submissionWindow?.closesAt, 64)
      },
      votingWindow: {
        opensAt: sanitizeOptional(req.body?.votingWindow?.opensAt, 64),
        closesAt: sanitizeOptional(req.body?.votingWindow?.closesAt, 64)
      },
      recurrence: req.body?.recurrence === 'daily' || req.body?.recurrence === 'weekly' || req.body?.recurrence === 'monthly' ? req.body.recurrence : 'none',
      entryConfig: {
        allowExistingWorks: req.body?.entryConfig?.allowExistingWorks !== false,
        allowExternalUrls: req.body?.entryConfig?.allowExternalUrls === true,
        maxEntriesPerCreator: Number.isFinite(Number(req.body?.entryConfig?.maxEntriesPerCreator)) ? Math.max(1, Math.floor(Number(req.body.entryConfig.maxEntriesPerCreator))) : 3,
        allowedKinds: Array.isArray(req.body?.entryConfig?.allowedKinds) ? req.body.entryConfig.allowedKinds.filter((kind: unknown) => typeof kind === 'string') : ['image', 'video', 'audio', 'literature', 'article', 'animation', 'mixed']
      },
      votingConfig: {
        mode: req.body?.votingConfig?.mode === 'judged' || req.body?.votingConfig?.mode === 'mixed' || req.body?.votingConfig?.mode === 'fan_love' ? req.body.votingConfig.mode : 'none',
        oneVotePerEntry: true
      },
      standardRulesVersion: sanitizeOptional(req.body?.standardRulesVersion, 64) || 'v1',
      specificRules: sanitizeOptional(req.body?.specificRules, 10000),
      laurelConfig: { guaranteed: [], possible: [] },
      rewardConfig: { manual: true },
      createdByUserId: req.authUser!.userId,
      createdAt: now,
      updatedAt: now
    };
    await store.createContributionContext(context);
    if (context.type === 'challenge' && store.createChallengeLaurel) {
      const standardLaurels: Array<Pick<ChallengeLaurelDefinition, 'name' | 'shortDescription' | 'category'>> = [
        { name: 'Fan Love', shortDescription: 'Most valid community votes.', category: 'fan_love' },
        { name: "Judge's Panel", shortDescription: 'Selected by the challenge judging panel.', category: 'judges_panel' },
        { name: "Curator's Choice", shortDescription: 'Selected by the Eversally curator.', category: 'curators_choice' }
      ];
      await Promise.all(standardLaurels.map((item) => store.createChallengeLaurel!({ laurelId: randomUUID(), contextId: context.contextId, ...item, guaranteed: false, active: true, createdAt: now, updatedAt: now })));
    }
    return res.status(201).json(context);
  });

  app.patch('/studio/challenges/:contextId', requireAdmin, async (req, res) => {
    const existing = await store.getContributionContextById?.(req.params.contextId);
    if (!existing || existing.type !== 'challenge') return res.status(404).json({ message: 'Challenge not found' });
    const allowedStatuses: ContributionContext['status'][] = ['draft', 'scheduled', 'active', 'entries_closed', 'voting_open', 'voting_closed', 'awaiting_awards', 'awarded', 'closed', 'archived', 'cancelled'];
    const updated: ContributionContext = {
      ...existing,
      title: typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : existing.title,
      description: req.body?.description === undefined ? existing.description : sanitizeOptional(req.body.description, 5000),
      status: allowedStatuses.includes(req.body?.status) ? req.body.status : existing.status,
      submissionWindow: req.body?.submissionWindow ? { opensAt: sanitizeOptional(req.body.submissionWindow.opensAt, 64), closesAt: sanitizeOptional(req.body.submissionWindow.closesAt, 64) } : existing.submissionWindow,
      votingWindow: req.body?.votingWindow ? { opensAt: sanitizeOptional(req.body.votingWindow.opensAt, 64), closesAt: sanitizeOptional(req.body.votingWindow.closesAt, 64) } : existing.votingWindow,
      specificRules: req.body?.specificRules === undefined ? existing.specificRules : sanitizeOptional(req.body.specificRules, 10000),
      updatedAt: new Date().toISOString()
    };
    await store.updateContributionContext?.(updated);
    return res.json(updated);
  });

  app.get('/studio/contribution-contexts/:contextId/submissions', requireAdmin, async (req, res) => {
    if (!store.listContextSubmissions) return res.json([]);
    return res.json(await store.listContextSubmissions(req.params.contextId));
  });

  app.patch('/studio/entries/:submissionId', requireAdmin, async (req, res) => {
    if (!store.getContextSubmissionById || !store.updateContextSubmission) {
      return res.status(503).json({ message: 'Submission moderation unavailable' });
    }
    const submission = await store.getContextSubmissionById(req.params.submissionId);
    if (!submission) return res.status(404).json({ message: 'Submission not found' });
    const nextStatus = req.body?.status === 'approved' || req.body?.status === 'rejected' ? req.body.status : undefined;
    const nextEntryStatus = req.body?.entryStatus === 'active' || req.body?.entryStatus === 'withdrawn' || req.body?.entryStatus === 'removed' ? req.body.entryStatus : undefined;
    if (!nextStatus && !nextEntryStatus) return res.status(400).json({ message: 'status or entryStatus is required' });
    const now = new Date().toISOString();
    const updated: ContextSubmission = {
      ...submission,
      ...(nextStatus ? { status: nextStatus, reviewedAt: now, reviewedByUserId: req.authUser!.userId } : {}),
      ...(nextEntryStatus ? { entryStatus: nextEntryStatus } : {})
    };

    if (nextStatus === 'approved' && !submission.convertedPostId && nextEntryStatus !== 'removed') {
      const mediaRef = (submission.mediaIds || []).slice(0, 8).map((mediaId, index) => ({ mediaId, discoverable: true, sortOrder: index }));
      const post: Post = {
        postId: randomUUID(),
        creatorId: 'community',
        authorId: submission.userId,
        title: submission.title,
        slug: slugify(`${submission.title}-${submission.submissionId.slice(0, 8)}`),
        slugHistory: [],
        summary: sanitizeOptional(submission.notes, 2000),
        status: 'published',
        blocks: [],
        media: mediaRef,
        primaryMediaId: mediaRef[0]?.mediaId,
        discovery: { mode: 'selected' },
        createdAt: now,
        updatedAt: now,
        publishedAt: now
      };
      await store.createPost(post);
      updated.convertedPostId = post.postId;
      await promoteToContributor(submission.userId);
    }

    await store.updateContextSubmission(updated);
    return res.json(updated);
  });

  app.get('/studio/challenges/:contextId/prizes', requireAdmin, async (req, res) => {
    if (!store.listChallengePrizes) return res.json([]);
    return res.json(await store.listChallengePrizes(req.params.contextId));
  });

  app.post('/studio/challenges/:contextId/prizes', requireAdmin, async (req, res) => {
    if (!store.createChallengePrize) return res.status(503).json({ message: 'Prize service unavailable' });
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    if (!title || !description) return res.status(400).json({ message: 'title and description are required' });
    const now = new Date().toISOString();
    const prize: ChallengePrize = {
      prizeId: randomUUID(),
      contextId: req.params.contextId,
      title,
      description,
      category: req.body?.category === 'digital' || req.body?.category === 'physical' || req.body?.category === 'signal' || req.body?.category === 'custom' || req.body?.category === 'draw' ? req.body.category : 'platform',
      visibility: req.body?.visibility === 'hidden' ? 'hidden' : 'visible',
      signal: req.body?.signal && typeof req.body.signal === 'object' ? { provider: sanitizeOptional(req.body.signal.provider, 120), amount: Number.isFinite(Number(req.body.signal.amount)) ? Number(req.body.signal.amount) : undefined, unit: sanitizeOptional(req.body.signal.unit, 64) } : undefined,
      placement: req.body?.placement === 'runner_up' || req.body?.placement === 'top_n' || req.body?.placement === 'random_supporter' ? req.body.placement : 'winner',
      quantity: Number.isFinite(Number(req.body?.quantity)) ? Math.max(1, Math.floor(Number(req.body.quantity))) : 1,
      status: req.body?.status === 'active' || req.body?.status === 'awarded' ? req.body.status : 'draft',
      createdAt: now,
      updatedAt: now
    };
    await store.createChallengePrize(prize);
    return res.status(201).json(prize);
  });

  app.get('/studio/challenges/:contextId/laurels', requireAdmin, async (req, res) => {
    return res.json(await store.listChallengeLaurels?.(req.params.contextId) || []);
  });

  app.post('/studio/challenges/:contextId/laurels', requireAdmin, async (req, res) => {
    if (!store.createChallengeLaurel) return res.status(503).json({ message: 'Laurel service unavailable' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const shortDescription = typeof req.body?.shortDescription === 'string' ? req.body.shortDescription.trim() : '';
    if (!name || !shortDescription) return res.status(400).json({ message: 'name and shortDescription are required' });
    const now = new Date().toISOString();
    const laurel: ChallengeLaurelDefinition = { laurelId: randomUUID(), contextId: req.params.contextId, name, shortDescription, category: req.body?.category === 'judges_panel' || req.body?.category === 'curators_choice' || req.body?.category === 'custom' ? req.body.category : 'fan_love', placement: Number.isFinite(Number(req.body?.placement)) ? Math.max(1, Math.min(10, Math.floor(Number(req.body.placement)))) : undefined, guaranteed: req.body?.guaranteed !== false, artworkUrl: sanitizeOptional(req.body?.artworkUrl, 2000), active: req.body?.active !== false, createdAt: now, updatedAt: now };
    await store.createChallengeLaurel(laurel);
    return res.status(201).json(laurel);
  });

  app.post('/studio/challenges/:contextId/awards', requireAdmin, async (req, res) => {
    if (!store.createChallengeLaurelAward) return res.status(503).json({ message: 'Award service unavailable' });
    const laurelId = typeof req.body?.laurelId === 'string' ? req.body.laurelId.trim() : '';
    const submissionId = typeof req.body?.submissionId === 'string' ? req.body.submissionId.trim() : '';
    if (!laurelId || !submissionId) return res.status(400).json({ message: 'laurelId and submissionId are required' });
    const submission = await store.getContextSubmissionById?.(submissionId);
    if (!submission || submission.contextId !== req.params.contextId) return res.status(404).json({ message: 'Entry not found' });
    const award: ChallengeLaurelAward = { awardId: randomUUID(), contextId: req.params.contextId, laurelId, submissionId, placement: Number.isFinite(Number(req.body?.placement)) ? Math.max(1, Math.min(10, Math.floor(Number(req.body.placement)))) : undefined, awardedAt: new Date().toISOString(), awardedByUserId: req.authUser!.userId };
    await store.createChallengeLaurelAward(award);
    return res.status(201).json(award);
  });

  app.get('/studio/metrics', requireAuth, async (req, res) => {
    const creators = await listVisibleCreators(req);
    const groupings = await listVisibleCreatorGroupings(req);
    const posts = await listVisibleCreatorPosts(req);
    const submissions = await listCreatorSubmissions(req);
    const sourceFiles = await listVisibleCreatorFiles(req);
    const profileCount = isAdminRequest(req)
      ? ((store.listUserProfiles ? await store.listUserProfiles() : []).length)
      : 1;
    const contributorCount = (store.listUserIdentities ? await store.listUserIdentities() : [])
      .filter((item) => item.role === 'contributor')
      .length;
    const mediaItems = (
      await Promise.all(groupings.map((grouping) => store.getMediaByGrouping(grouping.groupingId)))
    ).reduce((total, items) => total + items.length, 0);
    return res.json({
      totalUsers: profileCount,
      creators: creators.length,
      groupings: groupings.length,
      posts: posts.length,
      files: sourceFiles.length,
      mediaItems,
      pendingEntries: submissions.filter((item) => item.status === 'pending').length,
      reviewItems: submissions.filter((item) => item.status === 'pending').length,
      contributors: contributorCount
    });
  });

  app.get('/studio/creators', requireAuth, async (req, res) => {
    const creators = await listVisibleCreators(req);
    const requestOrigin = `${req.protocol}://${req.get('host')}`;
    return res.json(await Promise.all(creators.map(async (creator) => {
      const resolvedBranding = await publicProfileBranding(creator.branding, requestOrigin);
      return {
        ...creator,
        branding: creator.branding ? {
          ...creator.branding,
          profileImage: creator.branding.profileImage ? {
            ...creator.branding.profileImage,
            ...resolvedBranding.profileImage
          } : undefined,
          coverImage: creator.branding.coverImage ? {
            ...creator.branding.coverImage,
            ...resolvedBranding.coverImage
          } : undefined
        } : undefined
      };
    })));
  });

  app.get('/studio/integrations/bluesky/configuration', requireAuth, async (_req, res) => {
    const serviceUrl = config.blueskyOAuthServiceUrl?.replace(/\/$/, '');
    return res.json({
      platform: 'bluesky',
      configured: Boolean(serviceUrl && config.blueskyOAuthServiceJwksUrl && config.externalTokenEncryptionKey),
      authorizationUrl: serviceUrl ? `${serviceUrl}/oauth/bluesky/authorize` : undefined,
      requiredConfiguration: [
        ...(serviceUrl ? [] : ['BLUESKY_OAUTH_SERVICE_URL']),
        ...(config.blueskyOAuthServiceJwksUrl ? [] : ['BLUESKY_OAUTH_SERVICE_JWKS_URL']),
        ...(config.externalTokenEncryptionKey ? [] : ['EXTERNAL_TOKEN_ENCRYPTION_KEY'])
      ]
    });
  });

  app.post('/studio/integrations/bluesky/connect', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    const handle = typeof req.body?.handle === 'string' ? req.body.handle.trim().toLowerCase() : '';
    if (!(await ensureCreatorAccountAccess(req, res, creatorIdentityId))) return;
    requireIntegrationOperation('bluesky', 'connect');
    const policy = await createStoreIntegrationPolicyGate(store).evaluate({
      operation: 'connect', targets: [{ type: 'creator', id: creatorIdentityId }]
    });
    if (!policy.allowed) return res.status(409).json({ message: policy.reason });
    if (!config.externalTokenEncryptionKey || !config.blueskyOAuthServiceUrl || !config.blueskyOAuthServiceJwksUrl) {
      return res.status(503).json({ message: 'Bluesky OAuth is not configured for this deployment.' });
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,252}[a-z0-9]$/i.test(handle)) {
      return res.status(400).json({ message: 'Enter a valid Bluesky handle, such as creator.bsky.social.' });
    }
    const requestedReturnPath = typeof req.body?.returnPath === 'string' ? req.body.returnPath : '';
    const returnPath = requestedReturnPath.startsWith('/studio/')
      ? requestedReturnPath
      : '/studio/workspace?section=integrations';
    const issued = issueBlueskyOAuthState(config, {
      userId: req.authUser!.userId,
      creatorIdentityId,
      platform: 'bluesky',
      returnPath
    });
    const authorizeUrl = new URL('/oauth/bluesky/authorize', config.blueskyOAuthServiceUrl);
    authorizeUrl.searchParams.set('handle', handle);
    authorizeUrl.searchParams.set('state', issued.state);
    return res.json({ authorizationUrl: authorizeUrl.toString() });
  });

  app.post('/studio/integrations/bluesky/complete', requireAuth, async (req, res) => {
    const stateValue = typeof req.body?.state === 'string' ? req.body.state : '';
    const proof = typeof req.body?.proof === 'string' ? req.body.proof : '';
    if (!stateValue || !proof) return res.status(400).json({ message: 'The Bluesky connection response is incomplete.' });
    let state: ReturnType<typeof verifyBlueskyOAuthState>;
    let connection: BlueskyConnectionProof;
    try {
      state = verifyBlueskyOAuthState(config, stateValue);
      connection = await verifyBlueskyConnectionProof(proof, stateValue);
    } catch (error) {
      return res.status(400).json({ message: error instanceof Error ? error.message : 'The Bluesky connection could not be verified.' });
    }
    if (state.userId !== req.authUser!.userId || !(await ensureCreatorAccountAccess(req, res, state.creatorIdentityId))) {
      return res.status(403).json({ message: 'This Bluesky connection is no longer authorized for the selected creator.' });
    }
    requireIntegrationOperation('bluesky', 'connect');
    const policy = await createStoreIntegrationPolicyGate(store).evaluate({
      operation: 'connect', targets: [{ type: 'creator', id: state.creatorIdentityId }]
    });
    if (!policy.allowed) return res.status(409).json({ message: policy.reason });
    const now = new Date().toISOString();
    const existing = (await store.listExternalAccountsByUser(state.userId)).find((account) => (
      account.platform === 'bluesky' && account.externalUserId === connection.did
    ));
    const account: ExternalAccount = {
      externalAccountId: existing?.externalAccountId || randomUUID(),
      userId: state.userId,
      creatorIdentityId: state.creatorIdentityId,
      primaryCreatorIdentityId: state.creatorIdentityId,
      // The DPoP session remains in the dedicated OAuth service. This stable
      // reference deliberately is not a client secret or a token.
      externalPlatformCredentialId: 'bluesky-oauth-service',
      platform: 'bluesky',
      externalUserId: connection.did,
      externalUsername: connection.handle || connection.did,
      accessTokenEncrypted: encryptExternalCredential('managed-by-bluesky-oauth-service', config.externalTokenEncryptionKey),
      connectionStatus: 'connected',
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (existing) await store.updateExternalAccount(account);
    else await store.createExternalAccount(account);
    await store.replaceExternalAccountCreatorAssignments(account.externalAccountId, [{
      externalAccountId: account.externalAccountId,
      creatorIdentityId: state.creatorIdentityId,
      userId: state.userId,
      createdAt: now,
      updatedAt: now
    }]);
    auditLog(req, 'bluesky.account.connected', {
      externalAccountId: account.externalAccountId,
      creatorIdentityId: state.creatorIdentityId,
      did: account.externalUserId
    });
    return res.json(toExternalAccountResponse(account));
  });

  app.get('/studio/integrations/bluesky/accounts', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';
    if (creatorIdentityId && !(await ensureCreatorContentAccess(req, res, creatorIdentityId))) return;
    const accounts = creatorIdentityId
      ? await store.listExternalAccountsByCreatorIdentity(creatorIdentityId)
      : await store.listExternalAccountsByUser(req.authUser!.userId);
    return res.json(accounts
      .filter((account) => account.platform === 'bluesky' && account.connectionStatus !== 'disabled')
      .map(toExternalAccountResponse));
  });

  // Discord is a native community delivery integration.  It deliberately does
  // not create ExternalPublication records: a message announcement is not a
  // second copy of a Work and cannot become its canonical publication state.
  app.get('/studio/integrations/discord/configuration', requireAuth, async (_req, res) => {
    return res.json({
      platform: 'discord',
      configured: discordConfigured(config),
      requiredConfiguration: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_OAUTH_REDIRECT_URI'],
      installations: await store.listCommunityInstallationsByUser(_req.authUser!.userId)
    });
  });

  app.post('/studio/integrations/discord/connect', requireAuth, async (req, res) => {
    const admissionReason = await integrationAdmissionReason('discord', 'connect', []);
    if (admissionReason) return res.status(409).json({ message: admissionReason });
    if (!discordConfigured(config)) {
      return res.status(503).json({ message: 'Discord is not yet configured for this deployment.' });
    }
    const requestedReturnPath = typeof req.body?.returnPath === 'string' ? req.body.returnPath : '';
    const returnPath = requestedReturnPath.startsWith('/studio/')
      ? requestedReturnPath
      : '/studio/workspace?section=integrations';
    const issued = issueDiscordOAuthState(config, { userId: req.authUser!.userId, platform: 'discord', returnPath });
    return res.json({ authorizationUrl: createDiscordAuthorizeUrl(config, issued.state) });
  });

  app.get('/integrations/discord/callback', async (req, res) => {
    const stateValue = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    try {
      if (!stateValue || !code) throw new Error('Discord did not return a complete connection response.');
      const state = verifyDiscordOAuthState(config, stateValue);
      const token = await exchangeDiscordCode(config, code);
      const guildId = typeof req.query.guild_id === 'string'
        ? req.query.guild_id
        : (typeof token.guild_id === 'string' ? token.guild_id : token.guild?.id);
      if (!guildId) throw new Error('Choose a Discord server when installing the Eversally bot, then try again.');
      const guild = await getDiscordGuild(config, guildId);
      const existing = (await store.listCommunityInstallationsByUser(state.userId))
        .find((item) => item.provider === 'discord' && item.remoteInstallationId === guild.id);
      const now = new Date().toISOString();
      await store.upsertCommunityInstallation({
        communityInstallationId: existing?.communityInstallationId || randomUUID(),
        userId: state.userId,
        provider: 'discord',
        remoteInstallationId: guild.id,
        displayName: guild.name,
        iconUrl: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png` : undefined,
        status: 'connected',
        lastCheckedAt: now,
        lastError: undefined,
        createdAt: existing?.createdAt || now,
        updatedAt: now
      });
      return res.redirect(302, resolveExternalOAuthReturnUrl(config, state.returnPath, { discord: 'connected' }));
    } catch (error) {
      const returnPath = (() => {
        try { return stateValue ? verifyDiscordOAuthState(config, stateValue).returnPath : '/studio/workspace?section=integrations'; }
        catch { return '/studio/workspace?section=integrations'; }
      })();
      return res.redirect(302, resolveExternalOAuthReturnUrl(config, returnPath, {
        discord: 'error',
        message: error instanceof Error ? error.message.slice(0, 200) : 'Discord connection could not be completed.'
      }));
    }
  });

  app.get('/studio/integrations/discord/destinations', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';
    if (!creatorIdentityId || !(await ensureCreatorContentAccess(req, res, creatorIdentityId))) return;
    const destinations = await store.listCommunityDestinationsByCreator(creatorIdentityId);
    const installedByUser = new Set((await store.listCommunityInstallationsByUser(req.authUser!.userId)).map((item) => item.communityInstallationId));
    const owned = destinations.filter((item) => item.provider === 'discord' && installedByUser.has(item.communityInstallationId));
    const deliveries = await store.listCommunityDeliveriesByCreator(creatorIdentityId, 100);
    return res.json(await Promise.all(owned.map(async (destination) => ({
      ...destination,
      installation: await store.getCommunityInstallation(destination.communityInstallationId),
      deliveries: deliveries.filter((delivery) => delivery.communityDestinationId === destination.communityDestinationId).slice(0, 10)
    }))));
  });

  app.get('/studio/integrations/discord/installations/:installationId/channels', requireAuth, async (req, res) => {
    const installation = await store.getCommunityInstallation(req.params.installationId);
    if (!installation || installation.userId !== req.authUser!.userId || installation.provider !== 'discord') {
      return res.status(404).json({ message: 'Discord server not found.' });
    }
    try {
      const channels = await listDiscordChannels(config, installation.remoteInstallationId);
      await store.upsertCommunityInstallation({ ...installation, status: 'connected', lastCheckedAt: new Date().toISOString(), lastError: undefined, updatedAt: new Date().toISOString() });
      return res.json({ installation, channels });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Discord channels could not be loaded.';
      await store.upsertCommunityInstallation({ ...installation, status: 'needs_attention', lastError: message, updatedAt: new Date().toISOString() });
      return res.status(502).json({ message });
    }
  });

  app.post('/studio/integrations/discord/destinations', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    const installationId = typeof req.body?.installationId === 'string' ? req.body.installationId.trim() : '';
    const channelId = typeof req.body?.channelId === 'string' ? req.body.channelId.trim() : '';
    if (!(await ensureCreatorAccountAccess(req, res, creatorIdentityId))) return;
    const installation = await store.getCommunityInstallation(installationId);
    if (!installation || installation.userId !== req.authUser!.userId || installation.provider !== 'discord') {
      return res.status(400).json({ message: 'Choose a Discord server from this account.' });
    }
    const channels = await listDiscordChannels(config, installation.remoteInstallationId);
    const channel = channels.find((item) => item.id === channelId);
    if (!channel) return res.status(400).json({ message: 'Choose a text or announcement channel from the selected Discord server.' });
    const existing = (await store.listCommunityDestinationsByCreator(creatorIdentityId))
      .find((item) => item.provider === 'discord' && item.communityInstallationId === installationId && item.remoteChannelId === channelId);
    const now = new Date().toISOString();
    const destination = {
      communityDestinationId: existing?.communityDestinationId || randomUUID(),
      userId: req.authUser!.userId,
      creatorIdentityId,
      provider: 'discord' as const,
      communityInstallationId: installationId,
      remoteChannelId: channel.id,
      displayName: `#${channel.name}`,
      status: 'active' as const,
      eventTypes: ['work_published', 'works_published'] as CommunityEventType[],
      defaultAnnouncementPreset: ['recommended', 'image_showcase', 'writing_release', 'video_premiere', 'audio_release', 'compact_link', 'text_only', 'collection_digest', 'series_digest'].includes(req.body?.defaultAnnouncementPreset)
        ? req.body.defaultAnnouncementPreset
        : 'recommended',
      defaultIncludePrimaryMedia: req.body?.defaultIncludePrimaryMedia !== false,
      template: sanitizeOptional(req.body?.template, 2000),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    await store.upsertCommunityDestination(destination);
    auditLog(req, 'discord.destination.created', { creatorIdentityId, communityDestinationId: destination.communityDestinationId, installationId, channelId });
    return res.status(existing ? 200 : 201).json(destination);
  });

  app.patch('/studio/integrations/discord/destinations/:destinationId', requireAuth, async (req, res) => {
    const destination = await store.getCommunityDestination(req.params.destinationId);
    if (!destination || destination.userId !== req.authUser!.userId || destination.provider !== 'discord') return res.status(404).json({ message: 'Discord destination not found.' });
    if (!(await ensureCreatorAccountAccess(req, res, destination.creatorIdentityId))) return;
    const status = ['active', 'needs_attention', 'disabled'].includes(req.body?.status) ? req.body.status as 'active' | 'needs_attention' | 'disabled' : destination.status;
    const eventTypes: CommunityEventType[] = Array.isArray(req.body?.eventTypes) && req.body.eventTypes.includes('work_published') ? ['work_published', 'works_published'] : destination.eventTypes;
    const preset = ['recommended', 'image_showcase', 'writing_release', 'video_premiere', 'audio_release', 'compact_link', 'text_only', 'collection_digest', 'series_digest'].includes(req.body?.defaultAnnouncementPreset)
      ? req.body.defaultAnnouncementPreset
      : destination.defaultAnnouncementPreset;
    const updated = { ...destination, status, eventTypes, defaultAnnouncementPreset: preset, defaultIncludePrimaryMedia: typeof req.body?.defaultIncludePrimaryMedia === 'boolean' ? req.body.defaultIncludePrimaryMedia : destination.defaultIncludePrimaryMedia, template: req.body?.template === undefined ? destination.template : sanitizeOptional(req.body.template, 2000), updatedAt: new Date().toISOString() };
    await store.upsertCommunityDestination(updated);
    return res.json(updated);
  });

  app.delete('/studio/integrations/discord/destinations/:destinationId', requireAuth, async (req, res) => {
    const destination = await store.getCommunityDestination(req.params.destinationId);
    if (!destination || destination.userId !== req.authUser!.userId || destination.provider !== 'discord') return res.status(404).json({ message: 'Discord destination not found.' });
    if (!(await ensureCreatorAccountAccess(req, res, destination.creatorIdentityId))) return;
    await store.deleteCommunityDestination(destination.communityDestinationId);
    auditLog(req, 'discord.destination.deleted', { creatorIdentityId: destination.creatorIdentityId, communityDestinationId: destination.communityDestinationId });
    return res.status(204).end();
  });

  app.post('/studio/integrations/discord/announcements/bulk', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    const workIds: string[] = Array.isArray(req.body?.workIds) ? req.body.workIds.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0) : [];
    if (!(await ensureCreatorContentAccess(req, res, creatorIdentityId))) return;
    if (!workIds.length) return res.status(400).json({ message: 'Choose one or more Works to announce.' });
    const creator = (await store.listCreators()).find((item) => item.creatorId === creatorIdentityId);
    if (!creator) return res.status(404).json({ message: 'Creator not found.' });
    const works = (await Promise.all(workIds.map((workId: string) => store.getWork(config.tenantId, workId))))
      .filter((work): work is Work => Boolean(work && work.creatorId === creatorIdentityId));
    if (!works.length) return res.status(400).json({ message: 'No selected Works belong to this Creator.' });
    const publicWorks = await Promise.all(works.map(async (work) => {
      const publication = (await store.listPublicationsByWork(config.tenantId, work.workId)).find((item) => item.destination === 'eversally');
      if (!publication || publication.status !== 'live' || publication.visibility !== 'public') return undefined;
      return { workId: work.workId, title: publication.metadataOverrides?.title || work.title, description: publication.metadataOverrides?.description || work.description, url: `${canonicalSpaceBaseUrl(creator)}/works/${encodeURIComponent(work.slug)}` };
    }));
    const items = publicWorks.filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (!items.length) return res.status(409).json({ message: 'Only public Space Works can be announced.' });
    const preset = ['recommended', 'collection_digest', 'series_digest', 'compact_link', 'text_only'].includes(req.body?.preset) ? req.body.preset : 'collection_digest';
    await queueDiscordWorksPublished(store, config, {
      userId: req.authUser!.userId, creatorIdentityId, creatorName: creator.name, works: items,
      preset, includePrimaryMedia: req.body?.includePrimaryMedia !== false,
      idempotencyKey: `discord:space-bulk:${creatorIdentityId}:${items.map((item) => item.workId).sort().join(':')}`
    }, communityDeliveryQueue.enqueue.bind(communityDeliveryQueue));
    return res.status(202).json({ queued: true, workCount: items.length });
  });

  app.post('/studio/integrations/discord/destinations/:destinationId/test', requireAuth, async (req, res) => {
    const destination = await store.getCommunityDestination(req.params.destinationId);
    if (!destination || destination.userId !== req.authUser!.userId || destination.provider !== 'discord') return res.status(404).json({ message: 'Discord destination not found.' });
    if (!(await ensureCreatorAccountAccess(req, res, destination.creatorIdentityId))) return;
    try {
      const sent = await sendDiscordMessage(config, destination.remoteChannelId, 'This is a test announcement from Ubeeq.', { title: 'Discord connection verified' });
      return res.json({ ok: true, messageId: sent.id });
    } catch (error) {
      return res.status(502).json({ message: error instanceof Error ? error.message : 'Discord test message could not be sent.' });
    }
  });

  app.delete('/studio/integrations/discord/installations/:installationId', requireAuth, async (req, res) => {
    const installation = await store.getCommunityInstallation(req.params.installationId);
    if (!installation || installation.userId !== req.authUser!.userId || installation.provider !== 'discord') return res.status(404).json({ message: 'Discord server not found.' });
    await store.deleteCommunityInstallation(installation.communityInstallationId);
    auditLog(req, 'discord.installation.deleted', { communityInstallationId: installation.communityInstallationId });
    return res.status(204).end();
  });

  const youtubeConfigurationReady = () => Boolean(
    config.externalTokenEncryptionKey
    && config.youtubeOAuthClientId
    && config.youtubeOAuthClientSecret
    && config.youtubeOAuthRedirectUri
  );

  const youtubeCredentialForUser = async (userId: string): Promise<ExternalPlatformCredential | null> => {
    const credentials = await store.listExternalPlatformCredentialsByUser(userId);
    return credentials.find((credential) => credential.platform === 'youtube') || null;
  };

  const ensureYoutubeCredential = async (userId: string): Promise<ExternalPlatformCredential> => {
    const existing = await youtubeCredentialForUser(userId);
    if (existing) return existing;
    if (!youtubeConfigurationReady()) throw new Error('YouTube OAuth is not configured');
    const now = new Date().toISOString();
    const credential: ExternalPlatformCredential = {
      externalPlatformCredentialId: randomUUID(),
      userId,
      platform: 'youtube',
      applicationLabel: 'YouTube OAuth',
      clientId: config.youtubeOAuthClientId!,
      clientSecretEncrypted: encryptExternalCredential(config.youtubeOAuthClientSecret!, config.externalTokenEncryptionKey),
      redirectUri: config.youtubeOAuthRedirectUri!,
      createdAt: now,
      updatedAt: now
    };
    await store.createExternalPlatformCredential(credential);
    return credential;
  };

  app.get('/studio/integrations/youtube/configuration', requireAuth, async (_req, res) => {
    return res.json({
      platform: 'youtube',
      configured: youtubeConfigurationReady(),
      callbackUrl: config.youtubeOAuthRedirectUri,
      scope: 'https://www.googleapis.com/auth/youtube.readonly',
      quotaGuidance: 'YouTube imports use a lightweight channel/video scan and are paced to protect your daily API quota. Standard YouTube projects begin with 10,000 quota units per day.',
      requiredConfiguration: [
        ...(config.externalTokenEncryptionKey ? [] : ['EXTERNAL_TOKEN_ENCRYPTION_KEY']),
        ...(config.youtubeOAuthClientId ? [] : ['YOUTUBE_OAUTH_CLIENT_ID']),
        ...(config.youtubeOAuthClientSecret ? [] : ['YOUTUBE_OAUTH_CLIENT_SECRET']),
        ...(config.youtubeOAuthRedirectUri ? [] : ['YOUTUBE_OAUTH_REDIRECT_URI'])
      ],
      credential: await youtubeCredentialForUser(_req.authUser!.userId).then((credential) => credential ? toExternalPlatformCredentialResponse(credential) : null)
    });
  });

  app.post('/studio/integrations/youtube/connect', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    if (creatorIdentityId && !(await ensureCreatorAccountAccess(req, res, creatorIdentityId))) return;
    const admissionReason = await integrationAdmissionReason('youtube', 'connect', creatorIdentityId ? [{ type: 'creator', id: creatorIdentityId }] : []);
    if (admissionReason) return res.status(409).json({ message: admissionReason });
    if (!youtubeConfigurationReady()) {
      return res.status(409).json({ message: 'YouTube is not yet configured for this deployment.' });
    }
    const requestedReturnPath = typeof req.body?.returnPath === 'string' ? req.body.returnPath : '';
    const returnPath = requestedReturnPath.startsWith('/studio/')
      ? requestedReturnPath
      : '/studio/workspace?section=integrations';
    try {
      const credential = await ensureYoutubeCredential(req.authUser!.userId);
      const provider = providerForCredential(credential);
      const issuedState = issueExternalOAuthState(config, {
        userId: req.authUser!.userId,
        ...(creatorIdentityId ? { creatorIdentityId } : {}),
        externalPlatformCredentialId: credential.externalPlatformCredentialId,
        platform: 'youtube',
        returnPath
      });
      return res.json({ authorizationUrl: provider.createAuthorizationUrl(issuedState.state, externalOAuthPkce(config, issuedState.nonce)) });
    } catch (error) {
      logServerError('youtube.connect', error);
      return res.status(503).json({ message: 'YouTube connection could not be started.' });
    }
  });

  app.get('/integrations/youtube/callback', async (req, res) => {
    const requestId = String(res.getHeader('x-request-id') || 'unknown');
    const traceCallback = (stage: string, outcome?: string) => console.info(JSON.stringify({
      event: 'youtube_oauth_callback',
      requestId,
      stage,
      ...(outcome ? { outcome } : {})
    }));
    traceCallback('received');
    const stateValue = typeof req.query.state === 'string' ? req.query.state : '';
    let state: ReturnType<typeof verifyExternalOAuthState>;
    try {
      state = verifyExternalOAuthState(config, stateValue);
      if (state.platform !== 'youtube') throw new Error('Incorrect OAuth platform');
    } catch {
      traceCallback('state_validation', 'failed');
      return res.status(400).json({ message: 'The YouTube connection request is invalid or has expired.' });
    }
    traceCallback('state_validation', 'complete');
    const redirect = (params: Record<string, string>) => {
      try {
        const location = resolveExternalOAuthReturnUrl(config, state.returnPath, params);
        traceCallback('redirect', params.youtube || 'complete');
        return res.redirect(302, location);
      } catch {
        traceCallback('redirect', 'failed');
        return res.status(400).json({ message: 'The YouTube connection return URL is invalid.' });
      }
    };
    if (typeof req.query.error === 'string') {
      const reason = req.query.error.trim().slice(0, 120);
      return redirect({ youtube: reason === 'access_denied' ? 'cancelled' : 'failed', reason });
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return redirect({ youtube: 'failed', reason: 'missing_authorization_code' });
    if (state.creatorIdentityId && !(await store.hasCreatorAccess(state.userId, state.creatorIdentityId))) {
      return redirect({ youtube: 'failed', reason: 'creator_access_changed' });
    }
    const admissionReason = await integrationAdmissionReason('youtube', 'connect', state.creatorIdentityId ? [{ type: 'creator', id: state.creatorIdentityId }] : []);
    if (admissionReason) return redirect({ youtube: 'failed', reason: 'safety_hold' });
    try {
      const credential = await store.getExternalPlatformCredential(state.externalPlatformCredentialId);
      if (!credential || credential.userId !== state.userId || credential.platform !== 'youtube') {
        return redirect({ youtube: 'failed', reason: 'oauth_application_unavailable' });
      }
      const provider = providerForCredential(credential);
      if (!provider.isConfigured()) return redirect({ youtube: 'failed', reason: 'oauth_not_configured' });
      const tokens = await provider.exchangeAuthorizationCode(code, externalOAuthPkce(config, state.nonce));
      traceCallback('token_exchange', 'complete');
      const remoteAccount = await provider.getAccount(tokens.accessToken);
      traceCallback('channel_lookup', 'complete');
      const now = new Date().toISOString();
      const existing = (await store.listExternalAccountsByUser(state.userId)).find((account) => (
        account.platform === 'youtube' && account.externalUserId === remoteAccount.externalUserId
      ));
      const candidateCreators = !state.creatorIdentityId && !existing?.primaryCreatorIdentityId && !existing?.creatorIdentityId
        ? await store.listCreatorsByUserId(state.userId)
        : [];
      const soleCreator = candidateCreators.length === 1 ? candidateCreators[0] : undefined;
      const destinationCreatorIdentityId = state.creatorIdentityId
        || existing?.primaryCreatorIdentityId
        || existing?.creatorIdentityId
        || soleCreator?.creatorId;
      const account: ExternalAccount = {
        externalAccountId: existing?.externalAccountId || randomUUID(),
        userId: state.userId,
        creatorIdentityId: destinationCreatorIdentityId,
        primaryCreatorIdentityId: destinationCreatorIdentityId,
        externalPlatformCredentialId: credential.externalPlatformCredentialId,
        platform: 'youtube',
        externalUserId: remoteAccount.externalUserId,
        externalUsername: remoteAccount.externalUsername,
        accessTokenEncrypted: encryptExternalCredential(tokens.accessToken, config.externalTokenEncryptionKey),
        refreshTokenEncrypted: tokens.refreshToken
          ? encryptExternalCredential(tokens.refreshToken, config.externalTokenEncryptionKey)
          : existing?.refreshTokenEncrypted,
        tokenExpiresAt: tokens.expiresAt,
        connectionStatus: 'connected',
        lastSyncAttemptAt: existing?.lastSyncAttemptAt,
        lastSuccessfulSyncAt: existing?.lastSuccessfulSyncAt,
        initialContentSyncRequested: false,
        includeSourceFilesOnSync: false,
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };
      if (existing) await store.updateExternalAccount(account);
      else await store.createExternalAccount(account);
      if (destinationCreatorIdentityId) {
        await store.replaceExternalAccountCreatorAssignments(account.externalAccountId, [{
          externalAccountId: account.externalAccountId,
          creatorIdentityId: destinationCreatorIdentityId,
          userId: account.userId,
          createdAt: now,
          updatedAt: now
        }]);
      }
      traceCallback('account_storage', 'complete');
      return redirect({
        // A creator selected before OAuth is already a valid assignment.  Previously
        // this was reported as "assignment required" unless the fallback happened
        // to find exactly one creator, even though the account and assignment had
        // both been saved.  Studio consequently treated a successful connection as
        // a failure and did not reload its channel list.
        youtube: destinationCreatorIdentityId
          ? (state.creatorIdentityId ? 'connected' : soleCreator ? 'connected_destination_defaulted' : 'connected')
          : 'connected_assignment_required',
        account: account.externalAccountId
      });
    } catch (error) {
      // OAuth can succeed while the Google project still has the YouTube Data
      // API disabled.  That first becomes visible when we look up the channel,
      // before there is an account record to show in Studio.  Keep the provider
      // detail out of the URL, but give Studio an actionable setup state.
      const reason = error instanceof ExternalProviderError
        && /youtube data api v3 .*?(not been used|disabled|enable)/i.test(error.message)
        ? 'youtube_data_api_disabled'
        : error instanceof ExternalProviderError
          && error.operation === 'account_lookup'
          && /no youtube channel is available/i.test(error.message)
          ? 'youtube_channel_unavailable'
        : error instanceof ExternalProviderError
          ? error.code
          : 'connection_failed';
      logServerError('youtube.callback', error);
      const stage = error instanceof ExternalProviderError && error.operation
        ? error.operation
        : 'callback';
      traceCallback(stage, `failed:${reason}`);
      return redirect({ youtube: 'failed', reason, stage });
    }
  });

  app.get('/studio/integrations/youtube/accounts', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';
    if (creatorIdentityId && !(await ensureCreatorContentAccess(req, res, creatorIdentityId))) return;
    const accounts = creatorIdentityId
      ? await store.listExternalAccountsByCreatorIdentity(creatorIdentityId)
      : await store.listExternalAccountsByUser(req.authUser!.userId);
    const responses = await Promise.all(accounts
      .filter((account) => account.platform === 'youtube' && account.connectionStatus !== 'disabled')
      .map(async (account) => ({
        ...toExternalAccountResponse(account),
        creatorAssignments: (await store.listExternalAccountCreatorAssignments(account.externalAccountId))
          .map((assignment) => assignment.creatorIdentityId)
      })));
    return res.json(responses);
  });

  app.post('/studio/integrations/youtube/accounts/:externalAccountId/sync', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'youtube') return res.status(404).json({ message: 'YouTube account not found.' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this YouTube connection.' });
    if (!account.primaryCreatorIdentityId && !account.creatorIdentityId) {
      return res.status(409).json({ message: 'Assign this YouTube channel to a creator before synchronizing.' });
    }
    try {
      const job = await enqueueExternalSyncJob(account.externalAccountId, 'full_reconciliation', { syncContent: false });
      auditLog(req, 'youtube.sync.requested', { externalAccountId: account.externalAccountId, jobId: job.externalSyncJobId });
      return res.status(202).json(job);
    } catch (error) {
      logServerError('youtube.sync.enqueue', error);
      return res.status(503).json({ message: 'The synchronization queue is unavailable. The channel remains connected.' });
    }
  });

  app.delete('/studio/integrations/youtube/accounts/:externalAccountId', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'youtube') return res.status(404).json({ message: 'YouTube account not found.' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this YouTube connection.' });
    const now = new Date().toISOString();
    await store.updateExternalAccount({ ...account, accessTokenEncrypted: '', refreshTokenEncrypted: undefined, tokenExpiresAt: undefined, connectionStatus: 'disabled', updatedAt: now });
    const jobs = await store.listExternalSyncJobs(account.externalAccountId, 100);
    await Promise.all(jobs.filter((job) => ['queued', 'processing', 'retry_scheduled', 'rate_limited'].includes(job.status)).map((job) => (
      store.updateExternalSyncJob({ ...job, status: 'cancelled', errorCode: 'ACCOUNT_REMOVED', errorMessage: 'Synchronization stopped because the YouTube channel was removed', updatedAt: now })
    )));
    auditLog(req, 'youtube.account.removed', { externalAccountId: account.externalAccountId });
    return res.status(204).end();
  });

  app.get('/studio/integrations/soundcloud/configuration', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';
    if (creatorIdentityId && !(await ensureCreatorContentAccess(req, res, creatorIdentityId))) return;
    const credentials = creatorIdentityId
      ? await store.listExternalPlatformCredentialsByCreatorIdentity(creatorIdentityId)
      : await store.listExternalPlatformCredentialsByUser(req.authUser!.userId);
    const soundCloudCredentials = credentials.filter((item) => item.platform === 'soundcloud');
    return res.json({
      platform: 'soundcloud',
      enabled: config.soundCloudEnabled,
      configured: Boolean(config.soundCloudEnabled && config.externalTokenEncryptionKey && config.soundCloudOAuthRedirectUri && soundCloudCredentials.length),
      callbackUrl: config.soundCloudOAuthRedirectUri,
      credentials: soundCloudCredentials.map(toExternalPlatformCredentialResponse),
      sourceControlNotice: 'This connection does not back up your original audio. Upload the original file directly to Ubeeq if you want it retained under your control.',
      requiredConfiguration: [
        ...(config.soundCloudEnabled ? [] : ['SOUNDCLOUD_ENABLED compliance approval']),
        ...(config.externalTokenEncryptionKey ? [] : ['EXTERNAL_TOKEN_ENCRYPTION_KEY']),
        ...(config.soundCloudOAuthRedirectUri ? [] : ['SOUNDCLOUD_OAUTH_REDIRECT_URI']),
        ...(soundCloudCredentials.length ? [] : ['your SoundCloud client ID and client secret'])
      ]
    });
  });

  app.put('/studio/integrations/soundcloud/credentials', requireAuth, async (req, res) => {
    if (!config.soundCloudEnabled) return res.status(403).json({ message: 'SoundCloud is disabled pending provider and compliance approval.' });
    if (!config.externalTokenEncryptionKey || !config.soundCloudOAuthRedirectUri) return res.status(503).json({ message: 'SoundCloud callback or encrypted credential storage is not configured.' });
    const creatorIdentityId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    if (creatorIdentityId && !(await ensureCreatorAccountAccess(req, res, creatorIdentityId))) return;
    const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim().slice(0, 512) : '';
    const clientSecret = typeof req.body?.clientSecret === 'string' ? req.body.clientSecret.trim() : '';
    const applicationLabel = typeof req.body?.applicationLabel === 'string' ? req.body.applicationLabel.trim().slice(0, 120) : '';
    if (!clientId || !clientSecret) return res.status(400).json({ message: 'SoundCloud client ID and client secret are required.' });
    const now = new Date().toISOString();
    const credential: ExternalPlatformCredential = {
      externalPlatformCredentialId: randomUUID(), userId: req.authUser!.userId,
      creatorIdentityId: creatorIdentityId || undefined, platform: 'soundcloud',
      applicationLabel: applicationLabel || undefined, clientId,
      clientSecretEncrypted: encryptExternalCredential(clientSecret, config.externalTokenEncryptionKey),
      redirectUri: config.soundCloudOAuthRedirectUri, createdAt: now, updatedAt: now
    };
    await store.createExternalPlatformCredential(credential);
    auditLog(req, 'soundcloud.application.created', { externalPlatformCredentialId: credential.externalPlatformCredentialId, creatorIdentityId: credential.creatorIdentityId });
    return res.status(201).json(toExternalPlatformCredentialResponse(credential));
  });

  app.post('/studio/integrations/soundcloud/connect', requireAuth, async (req, res) => {
    if (!config.soundCloudEnabled) return res.status(403).json({ message: 'SoundCloud is disabled pending provider and compliance approval.' });
    const creatorIdentityId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    if (creatorIdentityId && !(await ensureCreatorAccountAccess(req, res, creatorIdentityId))) return;
    const credentialId = typeof req.body?.externalPlatformCredentialId === 'string' ? req.body.externalPlatformCredentialId.trim() : '';
    const credential = await store.getExternalPlatformCredential(credentialId);
    if (!credential || credential.userId !== req.authUser!.userId || credential.platform !== 'soundcloud') return res.status(404).json({ message: 'SoundCloud application not found.' });
    if (credential.creatorIdentityId && credential.creatorIdentityId !== creatorIdentityId) return res.status(403).json({ message: 'This SoundCloud application is assigned to another creator.' });
    const returnPath = typeof req.body?.returnPath === 'string' && req.body.returnPath.startsWith('/studio/') ? req.body.returnPath : '/studio/workspace?section=integrations';
    const issued = issueExternalOAuthState(config, { userId: req.authUser!.userId, creatorIdentityId: creatorIdentityId || undefined, externalPlatformCredentialId: credential.externalPlatformCredentialId, platform: 'soundcloud', returnPath, syncContentOnInitialImport: req.body?.syncContentOnInitialImport === true });
    return res.json({
      authorizationUrl: providerForCredential(credential).createAuthorizationUrl(issued.state, externalOAuthPkce(config, issued.nonce)),
      sourceControlNotice: 'Connecting SoundCloud does not create a backup. Upload the original directly to Ubeeq if you want the source retained under your control.'
    });
  });

  app.get('/integrations/soundcloud/callback', async (req, res) => {
    const stateValue = typeof req.query.state === 'string' ? req.query.state : '';
    let state: ReturnType<typeof verifyExternalOAuthState>;
    try {
      state = verifyExternalOAuthState(config, stateValue);
      if (state.platform !== 'soundcloud') throw new Error('Wrong OAuth platform');
    } catch {
      return res.status(400).json({ message: 'The SoundCloud connection request is invalid or has expired.' });
    }
    const redirect = (params: Record<string, string>) => res.redirect(302, resolveExternalOAuthReturnUrl(config, state.returnPath, params));
    if (!config.soundCloudEnabled) return redirect({ soundcloud: 'failed', reason: 'compliance_disabled' });
    if (typeof req.query.error === 'string') return redirect({ soundcloud: req.query.error === 'access_denied' ? 'cancelled' : 'failed', reason: req.query.error.slice(0, 120) });
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return redirect({ soundcloud: 'failed', reason: 'missing_authorization_code' });
    if (state.creatorIdentityId && !(await store.hasCreatorAccess(state.userId, state.creatorIdentityId))) return redirect({ soundcloud: 'failed', reason: 'creator_access_changed' });
    try {
      const credential = await store.getExternalPlatformCredential(state.externalPlatformCredentialId);
      if (!credential || credential.userId !== state.userId || credential.platform !== 'soundcloud') return redirect({ soundcloud: 'failed', reason: 'creator_application_unavailable' });
      const provider = providerForCredential(credential);
      const tokens = await provider.exchangeAuthorizationCode(code, externalOAuthPkce(config, state.nonce));
      const remote = await provider.getAccount(tokens.accessToken);
      const existing = (await store.listExternalAccountsByUser(state.userId)).find((item) => item.platform === 'soundcloud' && item.externalUserId === remote.externalUserId);
      const now = new Date().toISOString();
      const account: ExternalAccount = {
        externalAccountId: existing?.externalAccountId || randomUUID(), userId: state.userId,
        creatorIdentityId: state.creatorIdentityId, primaryCreatorIdentityId: state.creatorIdentityId,
        externalPlatformCredentialId: credential.externalPlatformCredentialId, platform: 'soundcloud',
        externalUserId: remote.externalUserId, externalUsername: remote.externalUsername,
        accessTokenEncrypted: encryptExternalCredential(tokens.accessToken, config.externalTokenEncryptionKey),
        refreshTokenEncrypted: tokens.refreshToken ? encryptExternalCredential(tokens.refreshToken, config.externalTokenEncryptionKey) : existing?.refreshTokenEncrypted,
        tokenExpiresAt: tokens.expiresAt, connectionStatus: 'connected',
        initialContentSyncRequested: state.syncContentOnInitialImport === true, includeSourceFilesOnSync: false,
        createdAt: existing?.createdAt || now, updatedAt: now
      };
      if (existing) await store.updateExternalAccount(account); else await store.createExternalAccount(account);
      if (state.creatorIdentityId) await store.replaceExternalAccountCreatorAssignments(account.externalAccountId, [{ externalAccountId: account.externalAccountId, creatorIdentityId: state.creatorIdentityId, userId: state.userId, createdAt: now, updatedAt: now }]);
      return redirect({ soundcloud: 'connected', account: account.externalAccountId });
    } catch (error) {
      logServerError('soundcloud.callback', error);
      return redirect({ soundcloud: 'failed', reason: error instanceof ExternalProviderError ? error.code : 'connection_failed' });
    }
  });

  app.get('/studio/integrations/soundcloud/accounts', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';
    if (creatorIdentityId && !(await ensureCreatorContentAccess(req, res, creatorIdentityId))) return;
    const accounts = creatorIdentityId ? await store.listExternalAccountsByCreatorIdentity(creatorIdentityId) : await store.listExternalAccountsByUser(req.authUser!.userId);
    return res.json(accounts.filter((item) => item.platform === 'soundcloud' && item.connectionStatus !== 'disabled').map(toExternalAccountResponse));
  });

  app.post('/studio/integrations/soundcloud/accounts/:externalAccountId/import', requireAuth, async (req, res) => {
    if (!config.soundCloudEnabled) return res.status(403).json({ message: 'SoundCloud is disabled pending provider and compliance approval.' });
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'soundcloud') return res.status(404).json({ message: 'SoundCloud account not found.' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this SoundCloud connection.' });
    if (!account.primaryCreatorIdentityId && !account.creatorIdentityId) return res.status(409).json({ message: 'Assign this SoundCloud account to a creator before importing tracks.' });
    if (req.body?.sourceControlNoticeAccepted !== true) return res.status(400).json({ message: 'Confirm that SoundCloud metadata import does not back up the original audio.' });
    try {
      const job = await enqueueExternalSyncJob(account.externalAccountId, 'account_import', { syncContent: false });
      auditLog(req, 'soundcloud.import.requested', { externalAccountId: account.externalAccountId, jobId: job.externalSyncJobId, sourceAudioDownload: false });
      return res.status(202).json({ ...job, sourceAudioDownload: false });
    } catch (error) {
      logServerError('soundcloud.import.enqueue', error);
      return res.status(503).json({ message: 'The import queue is unavailable. The account remains connected.' });
    }
  });

  app.delete('/studio/integrations/soundcloud/accounts/:externalAccountId', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'soundcloud') return res.status(404).json({ message: 'SoundCloud account not found.' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this SoundCloud connection.' });
    if (req.body?.confirm !== 'disconnect_and_purge_soundcloud') return res.status(400).json({ message: 'Explicitly confirm SoundCloud disconnect and provider-data purge.' });
    const now = new Date().toISOString();
    await store.updateExternalAccount({ ...account, accessTokenEncrypted: '', refreshTokenEncrypted: undefined, tokenExpiresAt: undefined, connectionStatus: 'disabled', updatedAt: now });
    const jobs = await store.listExternalSyncJobs(account.externalAccountId, 500);
    await Promise.all(jobs.filter((job) => ['queued', 'processing', 'retry_scheduled', 'rate_limited'].includes(job.status)).map((job) => store.updateExternalSyncJob({ ...job, status: 'cancelled', errorCode: 'ACCOUNT_REMOVED', errorMessage: 'SoundCloud disconnected and provider data purged', updatedAt: now })));
    const publications = await store.listExternalPublications(account.externalAccountId);
    for (const publication of publications) {
      await store.updateExternalPublication({ ...publication, rawMetadataJson: { purgedAt: now }, updatedAt: now });
      const comments = await store.listExternalComments(publication.externalPublicationId, 5000);
      await Promise.all(comments.map((comment) => store.updateExternalComment({ ...comment, externalAuthorId: undefined, externalAuthorName: undefined, externalAuthorAvatarUrl: undefined, body: '', rawPayload: undefined, lastSeenAt: now, lastSyncedAt: now })));
    }
    const activities = await store.listExternalActivitiesByAccount(account.externalAccountId, 5000);
    await Promise.all(activities.map((activity) => store.upsertExternalActivity({ ...activity, externalActorId: undefined, externalActorName: undefined, externalActorAvatarUrl: undefined, body: undefined, rawPayload: undefined, updatedAt: now })));
    const profile = await store.getExternalAccountProfile(account.externalAccountId);
    if (profile) await store.upsertExternalAccountProfile({ ...profile, realName: undefined, country: undefined, website: undefined, bio: undefined, rawPayload: undefined, capturedAt: now });
    auditLog(req, 'soundcloud.account.disconnected_and_purged', { externalAccountId: account.externalAccountId, publications: publications.length, activities: activities.length });
    return res.status(204).end();
  });

  app.get('/studio/integrations/soundcloud/accounts/:externalAccountId/publications/:externalContentId/comments', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'soundcloud') return res.status(404).json({ message: 'SoundCloud account not found.' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this SoundCloud connection.' });
    const publication = await store.getExternalPublication(account.externalAccountId, req.params.externalContentId);
    if (!publication) return res.status(404).json({ message: 'SoundCloud publication not found.' });
    const comments = await store.listExternalComments(publication.externalPublicationId, 100);
    return res.json(comments.map(({ rawPayload: _rawPayload, ...comment }) => comment));
  });

  app.post('/studio/integrations/soundcloud/accounts/:externalAccountId/publications/:externalContentId/comments/sync', requireAuth, async (req, res) => {
    if (!config.soundCloudEnabled) return res.status(403).json({ message: 'SoundCloud is disabled pending provider and compliance approval.' });
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'soundcloud') return res.status(404).json({ message: 'SoundCloud account not found.' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this SoundCloud connection.' });
    const publication = await store.getExternalPublication(account.externalAccountId, req.params.externalContentId);
    if (!publication || publication.syncStatus !== 'active') return res.status(404).json({ message: 'Active SoundCloud publication not found.' });
    return res.status(202).json(await enqueueExternalSyncJob(account.externalAccountId, 'comment_sync', { externalContentId: publication.externalContentId }));
  });

  app.post('/studio/integrations/soundcloud/accounts/:externalAccountId/publications/:externalContentId/actions/:action', requireAuth, async (req, res) => {
    if (!config.soundCloudEnabled) return res.status(403).json({ message: 'SoundCloud interactions are disabled pending provider and compliance approval.' });
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'soundcloud') return res.status(404).json({ message: 'SoundCloud account not found.' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this SoundCloud connection.' });
    const publication = await store.getExternalPublication(account.externalAccountId, req.params.externalContentId);
    if (!publication || publication.syncStatus !== 'active') return res.status(404).json({ message: 'Active SoundCloud publication not found.' });
    const action = ['comment', 'like', 'unlike', 'repost', 'unrepost'].includes(req.params.action) ? req.params.action : '';
    if (!action) return res.status(400).json({ message: 'Choose a supported SoundCloud action.' });
    const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 2000) : '';
    if (action === 'comment' && !body) return res.status(400).json({ message: 'A SoundCloud comment cannot be empty.' });
    const idempotencyKey = typeof req.get('idempotency-key') === 'string' ? req.get('idempotency-key')!.trim().slice(0, 200) : '';
    if (!idempotencyKey) return res.status(400).json({ message: 'An Idempotency-Key header is required for SoundCloud interactions.' });
    const existing = (await store.listExternalSyncJobs(account.externalAccountId, 200)).find((job) => job.type === 'user_action' && job.payload?.idempotencyKey === idempotencyKey);
    if (existing) return res.status(existing.status === 'successful' ? 200 : 202).json(existing);
    const job = await enqueueExternalSyncJob(account.externalAccountId, 'user_action', { action, targetId: publication.externalContentId, idempotencyKey, ...(body ? { body } : {}), ...(Number.isFinite(Number(req.body?.timestampMs)) ? { timestampMs: Math.max(0, Math.floor(Number(req.body.timestampMs))) } : {}) });
    auditLog(req, `soundcloud.${action}.requested`, { externalAccountId: account.externalAccountId, externalContentId: publication.externalContentId, jobId: job.externalSyncJobId });
    return res.status(202).json(job);
  });

  app.post('/studio/integrations/soundcloud/accounts/:externalAccountId/users/:externalUserId/actions/:action', requireAuth, async (req, res) => {
    if (!config.soundCloudEnabled) return res.status(403).json({ message: 'SoundCloud interactions are disabled pending provider and compliance approval.' });
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'soundcloud') return res.status(404).json({ message: 'SoundCloud account not found.' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this SoundCloud connection.' });
    const action = req.params.action === 'follow' || req.params.action === 'unfollow' ? req.params.action : '';
    if (!action) return res.status(400).json({ message: 'Choose follow or unfollow.' });
    const idempotencyKey = typeof req.get('idempotency-key') === 'string' ? req.get('idempotency-key')!.trim().slice(0, 200) : '';
    if (!idempotencyKey) return res.status(400).json({ message: 'An Idempotency-Key header is required for SoundCloud interactions.' });
    const existing = (await store.listExternalSyncJobs(account.externalAccountId, 200)).find((job) => job.type === 'user_action' && job.payload?.idempotencyKey === idempotencyKey);
    if (existing) return res.status(existing.status === 'successful' ? 200 : 202).json(existing);
    const job = await enqueueExternalSyncJob(account.externalAccountId, 'user_action', { action, targetId: req.params.externalUserId, idempotencyKey });
    auditLog(req, `soundcloud.${action}.requested`, { externalAccountId: account.externalAccountId, externalUserId: req.params.externalUserId, jobId: job.externalSyncJobId });
    return res.status(202).json(job);
  });

  app.get('/studio/integrations/deviantart/configuration', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';
    if (creatorIdentityId && !(await ensureCreatorContentAccess(req, res, creatorIdentityId))) return;
    const credentials = creatorIdentityId
      ? await store.listExternalPlatformCredentialsByCreatorIdentity(creatorIdentityId)
      : await store.listExternalPlatformCredentialsByUser(req.authUser!.userId);
    const credential = credentials.find((item) => item.platform === 'deviantart');
    return res.json({
      platform: 'deviantart',
      configured: Boolean(credential && config.externalTokenEncryptionKey && config.externalOAuthRedirectUri),
      callbackUrl: config.externalOAuthRedirectUri,
      credential: credential ? toExternalPlatformCredentialResponse(credential) : null,
      credentials: credentials.filter((item) => item.platform === 'deviantart').map(toExternalPlatformCredentialResponse),
      requiredConfiguration: [
        ...(config.externalTokenEncryptionKey ? [] : ['EXTERNAL_TOKEN_ENCRYPTION_KEY']),
        ...(config.externalOAuthRedirectUri ? [] : ['EXTERNAL_OAUTH_REDIRECT_URI']),
        ...(credential ? [] : ['your DeviantArt client ID and client secret'])
      ]
    });
  });

  app.put('/studio/integrations/deviantart/credentials', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    if (creatorIdentityId && !(await ensureCreatorAccountAccess(req, res, creatorIdentityId))) return;
    if (!config.externalTokenEncryptionKey || !config.externalOAuthRedirectUri) {
      return res.status(503).json({ message: 'The server callback URL or encrypted credential storage is not configured.' });
    }
    const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim().slice(0, 512) : '';
    const clientSecret = typeof req.body?.clientSecret === 'string' ? req.body.clientSecret.trim() : '';
    const applicationLabel = typeof req.body?.applicationLabel === 'string' ? req.body.applicationLabel.trim().slice(0, 120) : '';
    const credentials = (creatorIdentityId
      ? await store.listExternalPlatformCredentialsByCreatorIdentity(creatorIdentityId)
      : await store.listExternalPlatformCredentialsByUser(req.authUser!.userId));
    const requestedCredentialId = typeof req.body?.externalPlatformCredentialId === 'string' ? req.body.externalPlatformCredentialId.trim() : '';
    const createNew = req.body?.createNew === true;
    const existing = createNew
      ? undefined
      : requestedCredentialId
      ? credentials.find((item) => item.platform === 'deviantart' && item.externalPlatformCredentialId === requestedCredentialId)
      : credentials.find((item) => item.platform === 'deviantart');
    if (requestedCredentialId && !existing) return res.status(404).json({ message: 'DeviantArt application not found.' });
    if (!clientId) return res.status(400).json({ message: 'A DeviantArt client ID is required.' });
    if (!clientSecret && !existing) return res.status(400).json({ message: 'A DeviantArt client secret is required.' });
    const now = new Date().toISOString();
    const credential: ExternalPlatformCredential = {
      externalPlatformCredentialId: existing?.externalPlatformCredentialId || randomUUID(),
      userId: existing?.userId || req.authUser!.userId,
      creatorIdentityId: creatorIdentityId || undefined,
      platform: 'deviantart',
      applicationLabel: applicationLabel || existing?.applicationLabel,
      clientId,
      clientSecretEncrypted: clientSecret
        ? encryptExternalCredential(clientSecret, config.externalTokenEncryptionKey)
        : existing!.clientSecretEncrypted,
      redirectUri: config.externalOAuthRedirectUri,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (existing) await store.updateExternalPlatformCredential(credential);
    else await store.createExternalPlatformCredential(credential);
    return res.json(toExternalPlatformCredentialResponse(credential));
  });

  app.delete('/studio/integrations/deviantart/credentials/:externalPlatformCredentialId', requireAuth, async (req, res) => {
    const credential = await store.getExternalPlatformCredential(req.params.externalPlatformCredentialId);
    if (!credential || credential.platform !== 'deviantart') {
      return res.status(404).json({ message: 'DeviantArt application not found.' });
    }
    if (credential.userId !== req.authUser!.userId) {
      return res.status(403).json({ message: 'You do not control this DeviantArt application.' });
    }
    const connectedAccounts = (await store.listExternalAccountsByUser(req.authUser!.userId))
      .filter((account) => account.externalPlatformCredentialId === credential.externalPlatformCredentialId)
      .filter((account) => account.connectionStatus !== 'disabled');
    if (connectedAccounts.length) {
      return res.status(409).json({
        message: `Remove ${connectedAccounts.length === 1 ? 'the connected DeviantArt account' : 'all connected DeviantArt accounts'} before deleting this application.`,
        connectedAccountCount: connectedAccounts.length
      });
    }
    await store.deleteExternalPlatformCredential(credential.externalPlatformCredentialId);
    auditLog(req, 'deviantart.application.deleted', {
      externalPlatformCredentialId: credential.externalPlatformCredentialId
    });
    return res.status(204).end();
  });

  app.post('/studio/integrations/deviantart/connect', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    if (creatorIdentityId && !(await ensureCreatorAccountAccess(req, res, creatorIdentityId))) return;
    const admissionReason = await integrationAdmissionReason('deviantart', 'connect', creatorIdentityId ? [{ type: 'creator', id: creatorIdentityId }] : []);
    if (admissionReason) return res.status(409).json({ message: admissionReason });
    const requestedCredentialId = typeof req.body?.externalPlatformCredentialId === 'string' ? req.body.externalPlatformCredentialId.trim() : '';
    const credentials = (creatorIdentityId
      ? await store.listExternalPlatformCredentialsByCreatorIdentity(creatorIdentityId)
      : await store.listExternalPlatformCredentialsByUser(req.authUser!.userId));
    const credential = requestedCredentialId
      ? credentials.find((item) => item.platform === 'deviantart' && item.externalPlatformCredentialId === requestedCredentialId)
      : credentials.find((item) => item.platform === 'deviantart');
    const provider = credential ? providerForCredential(credential) : null;
    if (!credential || !provider?.isConfigured()) {
      return res.status(409).json({ message: 'Add your DeviantArt application credentials before connecting an account.' });
    }
    const requestedReturnPath = typeof req.body?.returnPath === 'string' ? req.body.returnPath : '';
    const returnPath = requestedReturnPath.startsWith('/studio/')
      ? requestedReturnPath
      : '/studio/workspace?section=integrations';
    const syncContentOnInitialImport = req.body?.syncContentOnInitialImport === true;
    const issuedState = issueExternalOAuthState(config, {
      userId: req.authUser!.userId,
      ...(creatorIdentityId ? { creatorIdentityId } : {}),
      externalPlatformCredentialId: credential.externalPlatformCredentialId,
      platform: 'deviantart',
      returnPath,
      syncContentOnInitialImport
    });
    return res.json({ authorizationUrl: provider.createAuthorizationUrl(issuedState.state, externalOAuthPkce(config, issuedState.nonce)) });
  });

  app.get('/studio/integrations/deviantart/connect', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';
    if (creatorIdentityId && !(await ensureCreatorAccountAccess(req, res, creatorIdentityId))) return;
    const admissionReason = await integrationAdmissionReason('deviantart', 'connect', creatorIdentityId ? [{ type: 'creator', id: creatorIdentityId }] : []);
    if (admissionReason) return res.status(409).json({ message: admissionReason });
    const credential = (creatorIdentityId
      ? await store.listExternalPlatformCredentialsByCreatorIdentity(creatorIdentityId)
      : await store.listExternalPlatformCredentialsByUser(req.authUser!.userId))
      .find((item) => item.platform === 'deviantart');
    const provider = credential ? providerForCredential(credential) : null;
    if (!credential || !provider?.isConfigured()) {
      return res.status(409).json({ message: 'Add your DeviantArt application credentials before connecting an account.' });
    }
    const requestedReturnPath = typeof req.query.returnPath === 'string' ? req.query.returnPath : '';
    const returnPath = requestedReturnPath.startsWith('/studio/')
      ? requestedReturnPath
      : '/studio/workspace?section=integrations';
    const issuedState = issueExternalOAuthState(config, {
      userId: req.authUser!.userId,
      ...(creatorIdentityId ? { creatorIdentityId } : {}),
      externalPlatformCredentialId: credential.externalPlatformCredentialId,
      platform: 'deviantart',
      returnPath
    });
    return res.redirect(302, provider.createAuthorizationUrl(issuedState.state, externalOAuthPkce(config, issuedState.nonce)));
  });

  app.get('/integrations/deviantart/callback', async (req, res) => {
    const stateValue = typeof req.query.state === 'string' ? req.query.state : '';
    let state: ReturnType<typeof verifyExternalOAuthState>;
    try {
      state = verifyExternalOAuthState(config, stateValue);
      if (state.platform !== 'deviantart') throw new Error('Incorrect OAuth platform');
    } catch {
      return res.status(400).json({ message: 'The DeviantArt connection request is invalid or has expired.' });
    }
    const redirect = (params: Record<string, string>) => {
      try {
        return res.redirect(302, resolveExternalOAuthReturnUrl(config, state.returnPath, params));
      } catch {
        return res.status(400).json({ message: 'The DeviantArt connection return URL is invalid.' });
      }
    };
    if (typeof req.query.error === 'string') {
      const reason = req.query.error.trim().slice(0, 120);
      const detail = typeof req.query.error_description === 'string'
        ? req.query.error_description.trim().slice(0, 300)
        : '';
      // DeviantArt uses this callback for both a user cancellation and OAuth
      // configuration failures. Preserve the provider code for the Studio UI.
      return redirect({ deviantart: reason === 'access_denied' ? 'cancelled' : 'failed', reason, ...(detail ? { detail } : {}) });
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return redirect({ deviantart: 'failed', reason: 'missing_authorization_code' });
    if (state.creatorIdentityId && !(await store.hasCreatorAccess(state.userId, state.creatorIdentityId))) {
      return redirect({ deviantart: 'failed', reason: 'creator_access_changed' });
    }
    const admissionReason = await integrationAdmissionReason('deviantart', 'connect', state.creatorIdentityId ? [{ type: 'creator', id: state.creatorIdentityId }] : []);
    if (admissionReason) return redirect({ deviantart: 'failed', reason: 'safety_hold' });
    try {
      const credential = await store.getExternalPlatformCredential(state.externalPlatformCredentialId);
      if (!credential || credential.userId !== state.userId || credential.platform !== 'deviantart') {
        return redirect({ deviantart: 'failed', reason: 'creator_application_unavailable' });
      }
      const provider = providerForCredential(credential);
      if (!provider.isConfigured()) return redirect({ deviantart: 'failed', reason: 'oauth_not_configured' });
      const tokens = await provider.exchangeAuthorizationCode(code, externalOAuthPkce(config, state.nonce));
      const remoteAccount = await provider.getAccount(tokens.accessToken);
      const now = new Date().toISOString();
      const existing = (await store.listExternalAccountsByUser(state.userId)).find((account) => (
        account.platform === 'deviantart' && account.externalUserId === remoteAccount.externalUserId
      ));
      const candidateCreators = !state.creatorIdentityId && !existing?.primaryCreatorIdentityId && !existing?.creatorIdentityId
        ? await store.listCreatorsByUserId(state.userId)
        : [];
      const soleCreator = candidateCreators.length === 1 ? candidateCreators[0] : undefined;
      const destinationCreatorIdentityId = state.creatorIdentityId
        || existing?.primaryCreatorIdentityId
        || existing?.creatorIdentityId
        || soleCreator?.creatorId;
      const account: ExternalAccount = {
        externalAccountId: existing?.externalAccountId || randomUUID(),
        userId: state.userId,
        creatorIdentityId: destinationCreatorIdentityId,
        primaryCreatorIdentityId: destinationCreatorIdentityId,
        externalPlatformCredentialId: credential.externalPlatformCredentialId,
        platform: 'deviantart',
        externalUserId: remoteAccount.externalUserId,
        externalUsername: remoteAccount.externalUsername,
        accessTokenEncrypted: encryptExternalCredential(tokens.accessToken, config.externalTokenEncryptionKey),
        refreshTokenEncrypted: tokens.refreshToken
          ? encryptExternalCredential(tokens.refreshToken, config.externalTokenEncryptionKey)
          : existing?.refreshTokenEncrypted,
        tokenExpiresAt: tokens.expiresAt,
        connectionStatus: 'connected',
        lastSyncAttemptAt: existing?.lastSyncAttemptAt,
        lastSuccessfulSyncAt: existing?.lastSuccessfulSyncAt,
        initialContentSyncRequested: state.syncContentOnInitialImport === true || existing?.initialContentSyncRequested === true,
        includeSourceFilesOnSync: existing?.includeSourceFilesOnSync ?? true,
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };
      if (existing) await store.updateExternalAccount(account);
      else await store.createExternalAccount(account);
      if (destinationCreatorIdentityId) {
        await store.replaceExternalAccountCreatorAssignments(account.externalAccountId, [{
          externalAccountId: account.externalAccountId,
          creatorIdentityId: destinationCreatorIdentityId,
          userId: account.userId,
          createdAt: now,
          updatedAt: now
        }]);
      }
      return redirect({
        deviantart: soleCreator ? 'connected_destination_defaulted' : 'connected_assignment_required',
        account: account.externalAccountId,
        application: credential.externalPlatformCredentialId
      });
    } catch (error) {
      const reason = error instanceof ExternalProviderError ? error.code : 'connection_failed';
      logServerError('deviantart.callback', error);
      return redirect({
        deviantart: 'failed',
        reason,
        ...(error instanceof ExternalProviderError && error.operation ? { stage: error.operation } : {})
      });
    }
  });

  app.get('/studio/integrations/deviantart/accounts', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';
    if (creatorIdentityId && !(await ensureCreatorContentAccess(req, res, creatorIdentityId))) return;
    const accounts = creatorIdentityId
      ? await store.listExternalAccountsByCreatorIdentity(creatorIdentityId)
      : await store.listExternalAccountsByUser(req.authUser!.userId);
    const responses = await Promise.all(accounts
      .filter((account) => account.platform === 'deviantart' && account.connectionStatus !== 'disabled')
      .map(async (account) => {
      const storedAssignments = (await store.listExternalAccountCreatorAssignments(account.externalAccountId))
        .map((assignment) => assignment.creatorIdentityId);
      return {
        ...toExternalAccountResponse(account),
        creatorAssignments: storedAssignments.length
          ? storedAssignments
          : [account.primaryCreatorIdentityId || account.creatorIdentityId].filter((item): item is string => Boolean(item))
      };
      }));
    return res.json(responses);
  });

  app.put('/studio/integrations/deviantart/accounts/:externalAccountId/preset', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'deviantart') return res.status(404).json({ message: 'DeviantArt account not found.' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    const preset = parseDeviantArtPreset(req.body);
    const updated = { ...account, deviantArtPublishingPreset: preset, updatedAt: new Date().toISOString() };
    await store.updateExternalAccount(updated);
    auditLog(req, 'deviantart.publishing-preset.updated', { externalAccountId: account.externalAccountId });
    return res.json({ deviantArtPublishingPreset: preset });
  });

  app.post('/studio/integrations/deviantart/accounts/:externalAccountId/galleries', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    const name = sanitizeOptional(req.body?.name, 50);
    if (!account || account.platform !== 'deviantart') return res.status(404).json({ message: 'DeviantArt account not found.' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    if (!name) return res.status(400).json({ message: 'Enter a gallery name (up to 50 characters).' });
    try {
      const credential = await store.getExternalPlatformCredential(account.externalPlatformCredentialId);
      if (!credential || credential.platform !== 'deviantart' || credential.userId !== account.userId) {
        return res.status(409).json({ message: 'The DeviantArt application credentials are unavailable.' });
      }
      const provider = providerForCredential(credential);
      let currentAccount = account;
      let accessToken = decryptExternalCredential(account.accessTokenEncrypted, config.externalTokenEncryptionKey);
      const expiresAt = account.tokenExpiresAt ? Date.parse(account.tokenExpiresAt) : NaN;
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000) {
        if (!account.refreshTokenEncrypted) {
          return res.status(401).json({ message: 'Your DeviantArt connection has expired. Reconnect it, then create the gallery.' });
        }
        const tokens = await provider.refreshAuthentication(decryptExternalCredential(account.refreshTokenEncrypted, config.externalTokenEncryptionKey));
        currentAccount = {
          ...account,
          accessTokenEncrypted: encryptExternalCredential(tokens.accessToken, config.externalTokenEncryptionKey),
          refreshTokenEncrypted: tokens.refreshToken
            ? encryptExternalCredential(tokens.refreshToken, config.externalTokenEncryptionKey)
            : account.refreshTokenEncrypted,
          tokenExpiresAt: tokens.expiresAt,
          connectionStatus: 'connected',
          updatedAt: new Date().toISOString()
        };
        await store.updateExternalAccount(currentAccount);
        accessToken = tokens.accessToken;
      }
      const remote = await provider.createGalleryFolder(accessToken, name);
      const now = new Date().toISOString();
      const existing = (await store.listExternalCollections(account.externalAccountId))
        .find((item) => item.externalCollectionExternalId === remote.externalCollectionId);
      const collection = {
        externalCollectionId: existing?.externalCollectionId || randomUUID(),
        externalAccountId: currentAccount.externalAccountId,
        platform: 'deviantart' as const,
        externalCollectionExternalId: remote.externalCollectionId,
        name: remote.name,
        description: remote.description,
        position: remote.position,
        remoteSize: remote.size,
        syncStatus: 'active' as const,
        lastSeenAt: now,
        lastSyncedAt: now,
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };
      if (existing) await store.updateExternalCollection(collection);
      else await store.createExternalCollection(collection);
      auditLog(req, 'deviantart.gallery.created', { externalAccountId: currentAccount.externalAccountId, externalCollectionId: collection.externalCollectionExternalId });
      return res.status(201).json(collection);
    } catch (error) {
      logServerError('deviantart.gallery.create', error);
      const message = error instanceof ExternalProviderError ? error.message : 'Unable to create the DeviantArt gallery.';
      return res.status(400).json({ message });
    }
  });

  const persistNativeDeviantArtPublication = async (
    work: Work,
    account: ExternalAccount,
    remote: { externalContentId: string; externalUrl?: string; rawMetadata: Record<string, unknown> },
    contentType: 'literature' | 'journal' | 'status',
    title: string,
    description: string | undefined
  ) => {
    const now = new Date().toISOString();
    const remoteId = contentType === 'status' ? `status:${remote.externalContentId}` : remote.externalContentId;
    const existing = (await store.listExternalPublications(account.externalAccountId)).find((item) => item.externalContentId === remoteId);
    const externalPublication: ExternalPublication = {
      externalPublicationId: existing?.externalPublicationId || randomUUID(),
      assetId: work.workId,
      externalAccountId: account.externalAccountId,
      platform: 'deviantart',
      externalContentId: remoteId,
      externalUrl: remote.externalUrl,
      externalTitle: title,
      externalDescription: description,
      publishedAt: existing?.publishedAt || now,
      lastSyncedAt: now,
      lastSeenAt: now,
      syncStatus: 'active',
      metadataSyncStatus: 'in_sync',
      rawMetadataJson: { ...remote.rawMetadata, nativeContentType: contentType, providerExternalId: remote.externalContentId },
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (existing) await store.updateExternalPublication(externalPublication);
    else await store.createExternalPublication(externalPublication);
    await store.upsertPublication({
      publicationId: externalPublication.externalPublicationId,
      tenantId: config.tenantId,
      creatorId: work.creatorId,
      workId: work.workId,
      destination: 'deviantart',
      integrationAccountId: account.externalAccountId,
      status: 'live',
      visibility: 'private',
      remoteId: remote.externalContentId,
      remoteUrl: remote.externalUrl,
      metadataOverrides: { title, description, fields: { nativeContentType: contentType } },
      sync: { status: 'in_sync', lastAttemptAt: now, lastSuccessfulAt: now, localRevision: work.revision },
      providerData: remote.rawMetadata,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      publishedAt: existing?.publishedAt || now
    });
    return externalPublication;
  };

  const resolveNativeDeviantArtContext = async (req: express.Request, res: express.Response) => {
    const work = await store.getWork(config.tenantId, req.params.workId);
    if (!work) {
      res.status(404).json({ message: 'Work not found' });
      return null;
    }
    if (!(await ensureCreatorContentAccess(req, res, work.creatorId))) return null;
    const externalAccountId = typeof req.body?.externalAccountId === 'string' ? req.body.externalAccountId.trim() : '';
    const account = externalAccountId ? await store.getExternalAccount(externalAccountId) : null;
    if (!account || account.platform !== 'deviantart' || account.userId !== req.authUser!.userId) {
      res.status(400).json({ message: 'Choose a DeviantArt account connected to this user.' });
      return null;
    }
    if (!['connected', 'rate_limited', 'temporarily_unavailable'].includes(account.connectionStatus)) {
      res.status(409).json({ message: 'Reconnect this DeviantArt account before publishing.' });
      return null;
    }
    const assignedCreatorIds = (await store.listExternalAccountCreatorAssignments(account.externalAccountId)).map((assignment) => assignment.creatorIdentityId);
    if (!assignedCreatorIds.includes(work.creatorId) && account.primaryCreatorIdentityId !== work.creatorId && account.creatorIdentityId !== work.creatorId) {
      res.status(403).json({ message: 'This DeviantArt account is not connected to the work’s creator.' });
      return null;
    }
    return { work, account };
  };

  const canonicalWorkBodyText = (work: Work): string => {
    const body = (work.body || []).map((block) => block.text || block.quote || '').filter(Boolean).join('\n\n').trim();
    return body || work.description || '';
  };

  app.post('/studio/works/:workId/destinations/deviantart/literature', requireAuth, async (req, res) => {
    const context = await resolveNativeDeviantArtContext(req, res);
    if (!context) return;
    if (!(await ensureWorkPublicationAllowed(context.work, res))) return;
    const content: ExternalLiteraturePublish = {
      title: sanitizeOptional(req.body?.title, 300) || context.work.title,
      body: sanitizeOptional(req.body?.body, 200_000) || canonicalWorkBodyText(context.work),
      description: sanitizeOptional(req.body?.description, 20_000) || context.work.description,
      tags: parseStringArray(req.body?.tags).slice(0, 100),
      collectionExternalIds: parseStringArray(req.body?.collectionExternalIds).slice(0, 100),
      isMature: req.body?.isMature === true,
      matureLevel: req.body?.matureLevel === 'moderate' ? 'moderate' : 'strict',
      matureClassification: parseStringArray(req.body?.matureClassification) as ExternalLiteraturePublish['matureClassification'],
      allowComments: req.body?.allowComments !== false,
      license: sanitizeOptional(req.body?.license, 100)
    };
    try {
      const result = await withIdempotency(req, async () => {
        const publication = await withDeviantArtAccess(context.account, async (provider, accessToken, currentAccount) => {
          const remote = await provider.createLiterature(accessToken, content);
          return persistNativeDeviantArtPublication(context.work, currentAccount, remote, 'literature', content.title, content.description);
        });
        return { status: 201, body: { publication } };
      });
      auditLog(req, 'deviantart.literature.created', { workId: context.work.workId, externalAccountId: context.account.externalAccountId });
      return res.status(result.status).json(result.body);
    } catch (error) {
      logServerError('deviantart.literature.create', error);
      return res.status(error instanceof ExternalProviderError && error.code === 'authentication_required' ? 401 : 400).json({ message: error instanceof Error ? error.message : 'Unable to publish DeviantArt literature.' });
    }
  });

  app.patch('/studio/works/:workId/destinations/deviantart/literature/:externalContentId', requireAuth, async (req, res) => {
    const context = await resolveNativeDeviantArtContext(req, res);
    if (!context) return;
    const content: ExternalLiteraturePublish = {
      title: sanitizeOptional(req.body?.title, 300) || context.work.title,
      body: sanitizeOptional(req.body?.body, 200_000) || canonicalWorkBodyText(context.work),
      description: sanitizeOptional(req.body?.description, 20_000) || context.work.description,
      tags: parseStringArray(req.body?.tags).slice(0, 100),
      collectionExternalIds: parseStringArray(req.body?.collectionExternalIds).slice(0, 100),
      isMature: req.body?.isMature === true,
      matureLevel: req.body?.matureLevel === 'moderate' ? 'moderate' : 'strict',
      matureClassification: parseStringArray(req.body?.matureClassification) as ExternalLiteraturePublish['matureClassification'],
      allowComments: req.body?.allowComments !== false,
      license: sanitizeOptional(req.body?.license, 100)
    };
    try {
      const result = await withIdempotency(req, async () => {
        const publication = await withDeviantArtAccess(context.account, async (provider, accessToken, currentAccount) => {
          const remote = await provider.updateLiterature(accessToken, req.params.externalContentId, content);
          return persistNativeDeviantArtPublication(context.work, currentAccount, remote, 'literature', content.title, content.description);
        });
        return { status: 200, body: { publication } };
      });
      return res.status(result.status).json(result.body);
    } catch (error) {
      logServerError('deviantart.literature.update', error);
      return res.status(error instanceof ExternalProviderError && error.code === 'authentication_required' ? 401 : 400).json({ message: error instanceof Error ? error.message : 'Unable to update DeviantArt literature.' });
    }
  });

  app.post('/studio/works/:workId/destinations/deviantart/journal', requireAuth, async (req, res) => {
    const context = await resolveNativeDeviantArtContext(req, res);
    if (!context) return;
    if (!(await ensureWorkPublicationAllowed(context.work, res))) return;
    const content: ExternalJournalPublish = {
      title: sanitizeOptional(req.body?.title, 300) || context.work.title,
      body: sanitizeOptional(req.body?.body, 200_000) || context.work.description || '',
      tags: parseStringArray(req.body?.tags).slice(0, 100),
      coverUrl: sanitizeOptional(req.body?.coverUrl, 2_000),
      embeddedImageUrl: sanitizeOptional(req.body?.embeddedImageUrl, 2_000),
      isMature: req.body?.isMature === true,
      matureLevel: req.body?.matureLevel === 'moderate' ? 'moderate' : 'strict',
      matureClassification: parseStringArray(req.body?.matureClassification) as ExternalJournalPublish['matureClassification'],
      allowComments: req.body?.allowComments !== false
    };
    try {
      const result = await withIdempotency(req, async () => {
        const publication = await withDeviantArtAccess(context.account, async (provider, accessToken, currentAccount) => {
          const remote = await provider.createJournal(accessToken, content);
          return persistNativeDeviantArtPublication(context.work, currentAccount, remote, 'journal', content.title, content.body);
        });
        return { status: 201, body: { publication } };
      });
      auditLog(req, 'deviantart.journal.created', { workId: context.work.workId, externalAccountId: context.account.externalAccountId });
      return res.status(result.status).json(result.body);
    } catch (error) {
      logServerError('deviantart.journal.create', error);
      return res.status(error instanceof ExternalProviderError && error.code === 'authentication_required' ? 401 : 400).json({ message: error instanceof Error ? error.message : 'Unable to publish DeviantArt journal.' });
    }
  });

  app.post('/studio/works/:workId/destinations/deviantart/status', requireAuth, async (req, res) => {
    const context = await resolveNativeDeviantArtContext(req, res);
    if (!context) return;
    if (!(await ensureWorkPublicationAllowed(context.work, res))) return;
    const content: ExternalStatusPublish = {
      body: sanitizeOptional(req.body?.body, 10_000) || '',
      parentExternalId: sanitizeOptional(req.body?.parentExternalId, 100),
      stashExternalId: sanitizeOptional(req.body?.stashExternalId, 100)
    };
    try {
      const result = await withIdempotency(req, async () => {
        const body = await withDeviantArtAccess(context.account, async (provider, accessToken, currentAccount) => {
          const remote = await provider.postStatus(accessToken, content);
          const publication = await persistNativeDeviantArtPublication(context.work, currentAccount, { ...remote, externalContentId: remote.externalPostId }, 'status', context.work.title, content.body);
          return { remote, publication };
        });
        return { status: 201, body };
      });
      auditLog(req, 'deviantart.status.created', { workId: context.work.workId, externalAccountId: context.account.externalAccountId });
      return res.status(result.status).json(result.body);
    } catch (error) {
      logServerError('deviantart.status.create', error);
      return res.status(error instanceof ExternalProviderError && error.code === 'authentication_required' ? 401 : 400).json({ message: error instanceof Error ? error.message : 'Unable to publish DeviantArt status.' });
    }
  });

  app.post('/studio/works/:workId/destinations/deviantart/poll', requireAuth, async (_req, res) => (
    res.status(501).json({
      message: 'DeviantArt poll creation is not available through the current public API reference. Polls can be imported when exposed by a remote deviation, but cannot be created here yet.'
    })
  ));

  app.get('/studio/integrations/deviantart/accounts/:externalAccountId/profile', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'deviantart') return res.status(404).json({ message: 'DeviantArt account not found' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    const [current, snapshots] = await Promise.all([
      store.getExternalAccountProfile(account.externalAccountId),
      store.listExternalAccountProfileSnapshots(account.externalAccountId, 100)
    ]);
    const withoutProviderPayload = <T extends { rawPayload?: Record<string, unknown>; profileFingerprint: string }>(profile: T) => {
      const { rawPayload: _rawPayload, profileFingerprint: _profileFingerprint, ...response } = profile;
      return response;
    };
    return res.json({
      current: current ? withoutProviderPayload(current) : null,
      snapshots: snapshots.map(withoutProviderPayload)
    });
  });

  app.delete('/studio/integrations/deviantart/accounts/:externalAccountId', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'deviantart') return res.status(404).json({ message: 'DeviantArt account not found' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    const now = new Date().toISOString();
    await store.updateExternalAccount({
      ...account,
      accessTokenEncrypted: '',
      refreshTokenEncrypted: undefined,
      tokenExpiresAt: undefined,
      connectionStatus: 'disabled',
      updatedAt: now
    });
    const jobs = await store.listExternalSyncJobs(account.externalAccountId, 100);
    await Promise.all(jobs
      .filter((job) => ['queued', 'processing', 'retry_scheduled', 'rate_limited'].includes(job.status))
      .map((job) => store.updateExternalSyncJob({
        ...job,
        status: 'cancelled',
        errorCode: 'ACCOUNT_REMOVED',
        errorMessage: 'Synchronization stopped because the DeviantArt account was removed',
        updatedAt: now
      })));
    auditLog(req, 'deviantart.account.removed', { externalAccountId: account.externalAccountId });
    return res.status(204).end();
  });

  app.put('/studio/integrations/deviantart/accounts/:externalAccountId/creators', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'deviantart') return res.status(404).json({ message: 'DeviantArt account not found' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    const requestedCreatorIdentityIds: unknown[] = Array.isArray(req.body?.creatorIdentityIds)
      ? req.body.creatorIdentityIds
      : [];
    const creatorIdentityIds: string[] = [...new Set(requestedCreatorIdentityIds
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean))];
    if (creatorIdentityIds.length > 1) {
      return res.status(400).json({ message: 'Choose one destination creator for this DeviantArt account. Advanced split synchronization is not available yet.' });
    }
    for (const creatorIdentityId of creatorIdentityIds) {
      if (!(await store.hasCreatorAccess(req.authUser!.userId, creatorIdentityId))) {
        return res.status(403).json({ message: 'You can only assign integrations to creators you manage.' });
      }
    }
    const requestedPrimary = typeof req.body?.primaryCreatorIdentityId === 'string'
      ? req.body.primaryCreatorIdentityId.trim()
      : '';
    const primaryCreatorIdentityId = creatorIdentityIds.includes(requestedPrimary)
      ? requestedPrimary
      : creatorIdentityIds[0];
    const now = new Date().toISOString();
    await store.replaceExternalAccountCreatorAssignments(account.externalAccountId, creatorIdentityIds.map((creatorIdentityId) => ({
      externalAccountId: account.externalAccountId,
      creatorIdentityId,
      userId: account.userId,
      createdAt: now,
      updatedAt: now
    })));
    const updatedAccount: ExternalAccount = {
      ...account,
      creatorIdentityId: primaryCreatorIdentityId || undefined,
      primaryCreatorIdentityId: primaryCreatorIdentityId || undefined,
      updatedAt: now
    };
    await store.updateExternalAccount(updatedAccount);
    if (!primaryCreatorIdentityId) {
      const pendingJobs = await store.listExternalSyncJobs(account.externalAccountId, 100);
      await Promise.all(pendingJobs
        .filter((job) => job.status === 'queued' || job.status === 'retry_scheduled' || job.status === 'rate_limited')
        .map((job) => store.updateExternalSyncJob({
          ...job,
          status: 'cancelled',
          errorCode: 'CREATOR_DISCONNECTED',
          errorMessage: 'Synchronization stopped because the destination creator was disconnected',
          updatedAt: now
        })));
    }
    auditLog(req, 'deviantart.creators.assigned', {
      externalAccountId: account.externalAccountId,
      creatorIdentityIds,
      primaryCreatorIdentityId
    });
    return res.json({
      ...toExternalAccountResponse(updatedAccount),
      creatorAssignments: creatorIdentityIds
    });
  });

  app.post('/studio/integrations/deviantart/accounts/:externalAccountId/sync', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'deviantart') return res.status(404).json({ message: 'DeviantArt account not found' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    if (!account.primaryCreatorIdentityId && !account.creatorIdentityId) {
      return res.status(409).json({ message: 'Assign this DeviantArt account to at least one creator before synchronizing.' });
    }
    try {
      const includeSourceFilesOnSync = req.body?.syncContent !== false;
      await store.updateExternalAccount({ ...account, includeSourceFilesOnSync, updatedAt: new Date().toISOString() });
      const job = await enqueueExternalSyncJob(account.externalAccountId, 'full_reconciliation', {
        syncContent: includeSourceFilesOnSync
      });
      auditLog(req, 'deviantart.sync.requested', { externalAccountId: account.externalAccountId, jobId: job.externalSyncJobId, includeSourceFilesOnSync });
      return res.status(202).json(job);
    } catch (error) {
      logServerError('deviantart.sync.enqueue', error);
      return res.status(503).json({ message: 'The synchronization queue is unavailable. The account remains connected.' });
    }
  });

  app.get('/studio/integrations/deviantart/accounts/:externalAccountId/jobs', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'deviantart') return res.status(404).json({ message: 'DeviantArt account not found' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    // Return the complete account history here. A full reconciliation can
    // create one content-sync job per imported work, so a small recent-jobs
    // limit hides source-copy results from the integration panel once an
    // account has more than a few dozen works.
    return res.json(await store.listExternalSyncJobs(account.externalAccountId));
  });

  app.post('/studio/integrations/deviantart/jobs/:externalSyncJobId/cancel', requireAuth, async (req, res) => {
    const job = await store.getExternalSyncJob(req.params.externalSyncJobId);
    if (!job) return res.status(404).json({ message: 'Synchronization job not found' });
    const account = await store.getExternalAccount(job.externalAccountId);
    if (!account || account.platform !== 'deviantart') return res.status(404).json({ message: 'DeviantArt account not found' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    if (!['account_import', 'full_reconciliation', 'account_scan'].includes(job.type)) {
      return res.status(409).json({ message: 'Only account synchronization jobs can be cancelled here.' });
    }
    if (!['queued', 'processing', 'retry_scheduled', 'rate_limited'].includes(job.status)) {
      return res.status(409).json({ message: `This synchronization is already ${job.status.replace(/_/g, ' ')}.` });
    }
    const now = new Date().toISOString();
    const cancelledJob: ExternalSyncJob = {
      ...job,
      status: 'cancelled',
      nextAttemptAt: undefined,
      errorCode: 'CANCELLED_BY_USER',
      errorMessage: 'Synchronization cancelled by the user',
      updatedAt: now
    };
    await store.updateExternalSyncJob(cancelledJob);
    const relatedJobs = (await store.listExternalSyncJobs(account.externalAccountId, 100))
      .filter((candidate) => candidate.payload?.parentJobId === job.externalSyncJobId)
      .filter((candidate) => ['queued', 'processing', 'retry_scheduled', 'rate_limited'].includes(candidate.status));
    await Promise.all(relatedJobs.map(async (candidate) => {
      await store.updateExternalSyncJob({
        ...candidate,
        status: 'cancelled',
        nextAttemptAt: undefined,
        errorCode: 'PARENT_SYNC_CANCELLED',
        errorMessage: 'Synchronization cancelled with its account import',
        updatedAt: now
      });
      if (candidate.type === 'content_sync' && typeof candidate.payload?.assetId === 'string') {
        const spacePublication = await store.getSpacePublication(candidate.payload.assetId);
        if (spacePublication && spacePublication.contentSyncStatus !== 'hosted') {
          await store.upsertSpacePublication({
            ...spacePublication,
            contentSyncStatus: 'not_requested',
            contentSyncError: undefined,
            updatedAt: now
          });
        }
      }
    }));
    auditLog(req, 'deviantart.sync.cancelled', {
      externalAccountId: account.externalAccountId,
      jobId: job.externalSyncJobId,
      relatedJobsCancelled: relatedJobs.length
    });
    return res.json({ job: cancelledJob, relatedJobsCancelled: relatedJobs.length });
  });

  app.get('/studio/integrations/deviantart/jobs/:externalSyncJobId/logs', requireAuth, async (req, res) => {
    const job = await store.getExternalSyncJob(req.params.externalSyncJobId);
    if (!job) return res.status(404).json({ message: 'Synchronization job not found' });
    const account = await store.getExternalAccount(job.externalAccountId);
    if (!account) return res.status(404).json({ message: 'DeviantArt account not found' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    return res.json(await store.listExternalSyncLogs(job.externalSyncJobId, 100));
  });

  app.get('/studio/integrations/deviantart/catalogue', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';
    if (!(await ensureCreatorContentAccess(req, res, creatorIdentityId))) return;
    const [ownedAssets, accounts] = await Promise.all([
      store.listAssetsByCreatorIdentity(creatorIdentityId),
      store.listExternalAccountsByCreatorIdentity(creatorIdentityId)
    ]);
    const accountById = new Map(accounts.map((account) => [account.externalAccountId, account]));
    const publications = (await Promise.all(accounts.map((account) => store.listExternalPublications(account.externalAccountId)))).flat();
    const publicationAssetIds = [...new Set(publications.map((publication) => publication.assetId))];
    const publicationAssets = await Promise.all(publicationAssetIds.map((assetId) => store.getAsset(assetId)));
    const assets = [...new Map([...ownedAssets, ...publicationAssets.filter((asset): asset is ExternalAsset => Boolean(asset))]
      .map((asset) => [asset.assetId, asset])).values()];
    const [spacePublicationPairs, engagementPairs] = await Promise.all([
      Promise.all(assets.map(async (asset) => [asset.assetId, await store.getSpacePublication(asset.assetId)] as const)),
      Promise.all(publications.map(async (publication) => [
        publication.externalPublicationId,
        await store.getExternalEngagementCurrent(publication.externalPublicationId)
      ] as const))
    ]);
    const spacePublicationByAssetId = new Map(spacePublicationPairs);
    const engagementByPublicationId = new Map(engagementPairs);
    const publicationByAssetId = new Map<string, typeof publications>();
    publications.forEach((publication) => {
      const current = publicationByAssetId.get(publication.assetId) || [];
      current.push(publication);
      publicationByAssetId.set(publication.assetId, current);
    });
    const query = typeof req.query.query === 'string' ? req.query.query.trim().toLowerCase() : '';
    const deviantArtPreviewUrl = (publication: ExternalPublication): string | undefined => {
      const metadata = publication.rawMetadataJson;
      if (!metadata || typeof metadata !== 'object') return undefined;
      const record = metadata as Record<string, unknown>;
      const thumbnail = Array.isArray(record.thumbs)
        ? record.thumbs.find((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).src === 'string')
        : undefined;
      if (thumbnail && typeof (thumbnail as Record<string, unknown>).src === 'string') return (thumbnail as Record<string, unknown>).src as string;
      for (const key of ['preview', 'content']) {
        const value = record[key];
        if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).src === 'string') {
          return (value as Record<string, unknown>).src as string;
        }
      }
      return undefined;
    };
    const metadataBoolean = (metadata: Record<string, unknown>, ...keys: string[]): boolean | undefined => {
      const nested = metadata.submission && typeof metadata.submission === 'object' && !Array.isArray(metadata.submission)
        ? metadata.submission as Record<string, unknown>
        : {};
      for (const key of keys) {
        const value = metadata[key] ?? nested[key];
        if (typeof value === 'boolean') return value;
        if (value === 'true' || value === 1 || value === '1') return true;
        if (value === 'false' || value === 0 || value === '0') return false;
      }
      return undefined;
    };
    const metadataText = (metadata: Record<string, unknown>, ...keys: string[]): string | undefined => {
      const nested = metadata.submission && typeof metadata.submission === 'object' && !Array.isArray(metadata.submission)
        ? metadata.submission as Record<string, unknown>
        : {};
      for (const key of keys) {
        const value = metadata[key] ?? nested[key];
        if (typeof value === 'string' && value.trim()) return value;
      }
      return undefined;
    };
    const metadataStrings = (metadata: Record<string, unknown>, ...keys: string[]): string[] | undefined => {
      const nested = metadata.submission && typeof metadata.submission === 'object' && !Array.isArray(metadata.submission)
        ? metadata.submission as Record<string, unknown>
        : {};
      for (const key of keys) {
        const value = metadata[key] ?? nested[key];
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
      }
      return undefined;
    };
    const rows = await Promise.all(assets
      .map(async (asset) => {
        const linkedPublications = publicationByAssetId.get(asset.assetId) || [];
        const linkedEngagement = linkedPublications
          .map((publication) => engagementByPublicationId.get(publication.externalPublicationId))
          .filter((engagement): engagement is ExternalEngagementCurrent => Boolean(engagement));
        const spacePublication = spacePublicationByAssetId.get(asset.assetId);
        const thumbnailUrl = spacePublication?.hostedObjectKey
          ? await publicMediaUrl(
            spacePublication.hostedThumbnailObjectKey || spacePublication.hostedObjectKey,
            `${req.protocol}://${req.get('host')}`
          )
          : undefined;
        return {
          ...asset,
          thumbnailUrl,
          spacePublication,
          engagement: linkedEngagement.length ? {
            views: linkedEngagement.reduce((total, engagement) => total + (engagement.views || 0), 0),
            favourites: linkedEngagement.reduce((total, engagement) => total + (engagement.favourites || 0), 0),
            comments: linkedEngagement.reduce((total, engagement) => total + (engagement.comments || 0), 0),
            downloads: linkedEngagement.reduce((total, engagement) => total + (engagement.downloads || 0), 0),
            capturedAt: linkedEngagement.map((engagement) => engagement.capturedAt).sort().at(-1),
            destinations: linkedEngagement.length
          } : undefined,
          publications: linkedPublications.map((publication) => ({
            externalPublicationId: publication.externalPublicationId,
            externalAccountId: publication.externalAccountId,
            platform: publication.platform,
            externalUsername: accountById.get(publication.externalAccountId)?.externalUsername || '',
            externalContentId: publication.externalContentId,
            targetStatus: publication.targetStatus || (publication.syncStatus === 'draft' ? 'draft' : 'published'),
            canUpdatePublishedDescription: publication.platform !== 'deviantart' || Boolean(
              config.deviantArtPublishedDescriptionUpdate && publication.externalDraftId
            ),
            publishedDescriptionUpdateMode: publication.platform === 'deviantart'
              && config.deviantArtPublishedDescriptionUpdate
              && publication.externalDraftId
              ? 'stash'
              : undefined,
            externalUrl: publication.externalUrl,
            previewUrl: deviantArtPreviewUrl(publication),
            externalTitle: publication.externalTitle,
            externalDescription: publication.externalDescription || metadataText(publication.rawMetadataJson, 'description', 'description_html', 'artist_comments', 'html', 'excerpt'),
            externalTags: publication.externalTags || [],
            displayOptions: {
              allowComments: metadataBoolean(publication.rawMetadataJson, 'allows_comments', 'allow_comments', 'allowComments'),
              displayResolution: (() => {
                const value = publication.rawMetadataJson.display_resolution ?? publication.rawMetadataJson.displayResolution;
                return typeof value === 'number' && value > 0 ? value : undefined;
              })(),
              allowFreeDownload: metadataBoolean(publication.rawMetadataJson, 'allow_free_download', 'allowFreeDownload'),
              addWatermark: metadataBoolean(publication.rawMetadataJson, 'add_watermark', 'addWatermark'),
              isMature: metadataBoolean(publication.rawMetadataJson, 'is_mature', 'isMature'),
              matureLevel: (() => {
                const level = metadataText(publication.rawMetadataJson, 'mature_level', 'matureLevel');
                return level === 'strict' || level === 'moderate' ? level : undefined;
              })(),
              matureClassification: metadataStrings(publication.rawMetadataJson, 'mature_classification', 'matureClassification'),
              isAiGenerated: metadataBoolean(publication.rawMetadataJson, 'is_ai_generated', 'isAiGenerated', 'ai_generated', 'created_with_ai'),
              noAi: metadataBoolean(publication.rawMetadataJson, 'noai', 'noAI', 'noAi', 'no_ai')
            },
            externalCollectionIds: publication.externalCollectionIds || [],
            publishedAt: publication.publishedAt,
            remoteUpdatedAt: publication.remoteUpdatedAt,
            metadataSyncStatus: publication.metadataSyncStatus,
            remoteChangeDetectedAt: publication.remoteChangeDetectedAt,
            lastOutboundSyncAt: publication.lastOutboundSyncAt,
            remoteStateReason: publication.remoteStateReason,
            syncStatus: publication.syncStatus
          }))
        };
      })
    );
    const filteredRows = rows
      .filter((asset) => !query || [
        asset.canonicalTitle,
        asset.canonicalDescription || '',
        ...asset.publications.flatMap((publication) => [publication.externalTitle || '', publication.externalUsername, ...publication.externalTags])
      ].some((value) => value.toLowerCase().includes(query)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return res.json({ items: filteredRows, total: filteredRows.length });
  });

  app.patch('/studio/integrations/assets/:assetId', requireAuth, async (req, res) => {
    const asset = await store.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ message: 'Asset not found' });
    if (asset.userId !== req.authUser!.userId && !(await ensureCreatorContentAccess(req, res, asset.creatorIdentityId))) return;
    const titlePolicy = req.body?.titleSyncPolicy === 'mirrored' || req.body?.titleSyncPolicy === 'independent' || req.body?.titleSyncPolicy === 'initially_mirrored' || req.body?.titleSyncPolicy === 'manual'
      ? req.body.titleSyncPolicy
      : (req.body?.canonicalTitle !== undefined ? 'independent' : asset.titleSyncPolicy);
    const descriptionPolicy = req.body?.descriptionSyncPolicy === 'mirrored' || req.body?.descriptionSyncPolicy === 'independent' || req.body?.descriptionSyncPolicy === 'initially_mirrored' || req.body?.descriptionSyncPolicy === 'manual'
      ? req.body.descriptionSyncPolicy
      : (req.body?.canonicalDescription !== undefined ? 'independent' : asset.descriptionSyncPolicy);
    const integrationMetadata = req.body?.integrationMetadata && typeof req.body.integrationMetadata === 'object' && !Array.isArray(req.body.integrationMetadata)
      ? req.body.integrationMetadata as Record<string, unknown>
      : null;
    const integrationPublicationId = typeof integrationMetadata?.externalPublicationId === 'string'
      ? integrationMetadata.externalPublicationId.trim()
      : '';
    const integrationTitle = typeof integrationMetadata?.title === 'string' ? integrationMetadata.title.trim().slice(0, 300) : undefined;
    const integrationDescription = typeof integrationMetadata?.description === 'string' ? sanitizeOptional(integrationMetadata.description, 20_000) : undefined;
    const integrationTags = Array.isArray(integrationMetadata?.tags)
      ? [...new Set(integrationMetadata.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().replace(/\s+/g, '_').slice(0, 64))
        .filter(Boolean))].slice(0, 30)
      : undefined;
    const integrationCollectionExternalIds = Array.isArray(integrationMetadata?.collectionExternalIds)
      ? [...new Set(integrationMetadata.collectionExternalIds
        .filter((collectionId): collectionId is string => typeof collectionId === 'string')
        .map((collectionId) => collectionId.trim())
        .filter(Boolean))]
      : undefined;
    const allowComments = typeof integrationMetadata?.allowComments === 'boolean' ? integrationMetadata.allowComments : undefined;
    const hasDisplayResolution = Boolean(integrationMetadata && Object.prototype.hasOwnProperty.call(integrationMetadata, 'displayResolution'));
    const displayResolution = hasDisplayResolution
      ? integrationMetadata?.displayResolution === null
        ? null
        : typeof integrationMetadata?.displayResolution === 'number' && deviantArtDisplayResolutions.has(integrationMetadata.displayResolution)
          ? integrationMetadata.displayResolution
          : undefined
      : undefined;
    if (hasDisplayResolution && displayResolution === undefined) {
      return res.status(400).json({ message: 'Choose a supported DeviantArt display size, or Original.' });
    }
    const allowFreeDownload = typeof integrationMetadata?.allowFreeDownload === 'boolean' ? integrationMetadata.allowFreeDownload : undefined;
    const addWatermark = typeof integrationMetadata?.addWatermark === 'boolean' ? integrationMetadata.addWatermark : undefined;
    if (addWatermark === true && displayResolution === null) {
      return res.status(400).json({ message: 'A DeviantArt watermark requires a reduced display size.' });
    }
    const isMature = typeof integrationMetadata?.isMature === 'boolean' ? integrationMetadata.isMature : undefined;
    const matureLevel = integrationMetadata?.matureLevel === 'strict' || integrationMetadata?.matureLevel === 'moderate'
      ? integrationMetadata.matureLevel
      : undefined;
    const matureClassification = Array.isArray(integrationMetadata?.matureClassification)
      ? [...new Set(integrationMetadata.matureClassification.filter((classification): classification is 'nudity' | 'sexual' | 'gore' | 'language' | 'ideology' => (
        classification === 'nudity' || classification === 'sexual' || classification === 'gore' || classification === 'language' || classification === 'ideology'
      )))]
      : undefined;
    const isAiGenerated = typeof integrationMetadata?.isAiGenerated === 'boolean' ? integrationMetadata.isAiGenerated : undefined;
    const noAi = typeof integrationMetadata?.noAi === 'boolean'
      ? integrationMetadata.noAi
      : (typeof integrationMetadata?.allowAiTraining === 'boolean' ? !integrationMetadata.allowAiTraining : undefined);
    const updated: ExternalAsset = {
      ...asset,
      canonicalTitle: req.body?.canonicalTitle !== undefined ? String(req.body.canonicalTitle).trim().slice(0, 300) : asset.canonicalTitle,
      canonicalDescription: req.body?.canonicalDescription !== undefined ? sanitizeOptional(req.body.canonicalDescription, 20_000) : asset.canonicalDescription,
      visibility: req.body?.visibility === 'public' || req.body?.visibility === 'unlisted' ? req.body.visibility : (req.body?.visibility === 'private' ? 'private' : asset.visibility),
      titleSyncPolicy: titlePolicy,
      descriptionSyncPolicy: descriptionPolicy,
      updatedAt: new Date().toISOString()
    };
    await store.updateAsset(updated);
    const publications = (await Promise.all(
      (await store.listExternalAccountsByCreatorIdentity(asset.creatorIdentityId))
        .map((account) => store.listExternalPublications(account.externalAccountId))
    )).flat().filter((publication) => publication.assetId === asset.assetId && (publication.syncStatus === 'active' || publication.syncStatus === 'pending_publish' || publication.syncStatus === 'draft'));
    const destinationPublications = integrationPublicationId
      ? publications.filter((publication) => publication.externalPublicationId === integrationPublicationId)
      : publications;
    if (integrationPublicationId && !destinationPublications.length) {
      return res.status(404).json({ message: 'The selected integration destination is no longer available.' });
    }
    const externalMetadataChanged = integrationTitle !== undefined
      || integrationDescription !== undefined
      || integrationTags !== undefined
      || integrationCollectionExternalIds !== undefined
      || allowComments !== undefined
      || displayResolution !== undefined
      || allowFreeDownload !== undefined
      || addWatermark !== undefined
      || isMature !== undefined
      || matureLevel !== undefined
      || matureClassification !== undefined
      || isAiGenerated !== undefined
      || noAi !== undefined;
    if (!externalMetadataChanged || !destinationPublications.length) return res.json(updated);
    const remoteUpdateWarnings: string[] = [];
    const now = new Date().toISOString();
    // Draft destinations have no remote state yet, so their settings can be
    // persisted immediately. Active publications are updated only after the
    // worker reads the deviation back and verifies that DeviantArt applied it.
    await Promise.all(destinationPublications.filter((publication) => publication.syncStatus !== 'active').map(async (publication) => {
      const rawMetadataJson = { ...publication.rawMetadataJson };
      if (allowComments !== undefined) rawMetadataJson.allow_comments = allowComments;
      if (displayResolution !== undefined) rawMetadataJson.display_resolution = displayResolution;
      if (allowFreeDownload !== undefined) rawMetadataJson.allow_free_download = allowFreeDownload;
      if (addWatermark !== undefined) rawMetadataJson.add_watermark = addWatermark;
      if (isMature !== undefined) rawMetadataJson.is_mature = isMature;
      if (matureLevel !== undefined) rawMetadataJson.mature_level = matureLevel;
      if (matureClassification !== undefined) rawMetadataJson.mature_classification = matureClassification;
      if (isAiGenerated !== undefined) rawMetadataJson.is_ai_generated = isAiGenerated;
      if (noAi !== undefined) rawMetadataJson.noai = noAi;
      await store.updateExternalPublication({
        ...publication,
        externalTitle: integrationTitle ?? publication.externalTitle,
        externalDescription: integrationDescription ?? publication.externalDescription,
        externalTags: integrationTags ?? publication.externalTags,
        externalCollectionIds: integrationCollectionExternalIds ?? publication.externalCollectionIds,
        rawMetadataJson,
        updatedAt: now
      });
    }));
    const remoteUpdateJobs = await Promise.all(destinationPublications.filter((publication) => publication.syncStatus === 'active').map(async (publication) => {
      const payload: Record<string, unknown> = {
        externalPublicationId: publication.externalPublicationId,
        ...(integrationTitle !== undefined ? { title: integrationTitle } : {}),
        ...(integrationTags !== undefined ? { tags: integrationTags } : {}),
        ...(integrationCollectionExternalIds !== undefined ? { collectionExternalIds: integrationCollectionExternalIds } : {}),
        ...(allowComments !== undefined ? { allowComments } : {}),
        ...(displayResolution !== undefined ? { displayResolution } : {}),
        ...(allowFreeDownload !== undefined ? { allowFreeDownload } : {}),
        ...(addWatermark !== undefined ? { addWatermark } : {}),
        ...(isMature !== undefined ? { isMature } : {}),
        ...(matureLevel !== undefined ? { matureLevel } : {}),
        ...(matureClassification !== undefined ? { matureClassification } : {}),
        ...(isAiGenerated !== undefined ? { isAiGenerated } : {}),
        ...(noAi !== undefined ? { noAi } : {})
      };
      if (
        integrationDescription !== undefined
        && publication.platform === 'deviantart'
        && !(config.deviantArtPublishedDescriptionUpdate && publication.externalDraftId)
      ) {
        remoteUpdateWarnings.push(`DeviantArt does not permit description changes for already-published deviations through its API. The ${brand.productName} description was saved, but the DeviantArt description remains unchanged.`);
      } else if (integrationDescription !== undefined) {
        payload.description = integrationDescription;
      }
      if (!Object.keys(payload).some((key) => key !== 'externalPublicationId')) return null;
      await store.updateExternalPublication({
        ...publication,
        metadataSyncStatus: 'local_update_pending',
        updatedAt: now
      });
      try {
        return await enqueueExternalSyncJob(publication.externalAccountId, 'remote_update', payload);
      } catch (queueError) {
        logServerError('integration.metadata-update.enqueue', queueError);
        const queuedJobs = await store.listExternalSyncJobs(publication.externalAccountId, 20);
        return queuedJobs.find((job) => (
          job.type === 'remote_update'
          && job.payload?.externalPublicationId === publication.externalPublicationId
          && job.createdAt >= now
        )) || null;
      }
    }));
    return res.json({
      ...updated,
      remoteUpdateJobs: remoteUpdateJobs.filter(Boolean),
      remoteUpdateWarnings: [...new Set(remoteUpdateWarnings)]
    });
  });

  const canonicalWorkView = async (work: Work, requestOrigin?: string) => {
    const assets = await store.listCanonicalAssetsByWork(work.tenantId, work.workId);
    const [publications, collections, discovery, legacySpace] = await Promise.all([
      store.listPublicationsByWork(work.tenantId, work.workId),
      store.listCreatorCollections(work.tenantId, work.creatorId),
      store.getWorkDiscoveryParticipation(work.tenantId, work.workId),
      legacySpacePublicationForWork(work, assets)
    ]);
    const legacyPublication = legacySpaceAsPublication(work, legacySpace);
    const effectivePublications = publications.some((publication) => publication.destination === 'eversally') || !legacyPublication
      ? publications
      : [...publications, legacyPublication];
    const memberCollectionIds = new Set<string>();
    await Promise.all(collections.map(async (collection) => {
      const memberships = await store.listCollectionWorks(work.tenantId, collection.collectionId);
      if (memberships.some((membership) => membership.workId === work.workId)) memberCollectionIds.add(collection.collectionId);
    }));
    const externalPublicationIds = effectivePublications.filter((publication) => publication.destination !== 'eversally').map((publication) => publication.publicationId);
    const engagementRows = await Promise.all(externalPublicationIds.map((publicationId) => store.getExternalEngagementCurrent(publicationId)));
    const engagement = engagementRows.reduce((total, row) => ({
      views: total.views + Number(row?.views || 0),
      favourites: total.favourites + Number(row?.favourites || 0),
      comments: total.comments + Number(row?.comments || 0),
      downloads: total.downloads + Number(row?.downloads || 0),
      capturedAt: !total.capturedAt || (row?.capturedAt && row.capturedAt > total.capturedAt) ? row?.capturedAt : total.capturedAt,
      destinations: total.destinations + (row ? 1 : 0)
    }), { views: 0, favourites: 0, comments: 0, downloads: 0, capturedAt: undefined as string | undefined, destinations: 0 });
    const publicationIntents = await store.listPublicationIntentsByWork(config.tenantId, work.workId);
    return {
      ...work,
      assets: await Promise.all(assets.map(async (asset, index) => {
        const isPrimary = asset.assetId === work.primaryAssetId || asset.attachment.role === 'primary' || index === 0;
        const objectKey = asset.storage.objectKey || (isPrimary ? legacySpace?.hostedObjectKey : undefined);
        const thumbnailObjectKey = asset.storage.thumbnailObjectKey || (isPrimary ? (legacySpace?.hostedThumbnailObjectKey || legacySpace?.hostedObjectKey) : undefined);
        return {
          ...asset,
          storage: objectKey ? { ...asset.storage, mode: 'hosted' as const, objectKey, thumbnailObjectKey } : asset.storage,
          url: objectKey ? await publicMediaUrl(objectKey, requestOrigin) : asset.storage.externalUrl,
          thumbnailUrl: thumbnailObjectKey ? await publicMediaUrl(thumbnailObjectKey, requestOrigin) : undefined
        };
      })),
      contentAvailability: contentAvailabilityForAssets(assets),
      publications: effectivePublications,
      publicationIntents,
      engagement,
      collections: collections.filter((collection) => memberCollectionIds.has(collection.collectionId)),
      discovery: discovery || {
        workId: work.workId,
        tenantId: work.tenantId,
        creatorId: work.creatorId,
        state: 'none',
        updatedAt: work.updatedAt
      }
    };
  };

  app.get('/studio/works', requireAuth, async (req, res) => {
    const creatorId = typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';
    if (!(await ensureCreatorContentAccess(req, res, creatorId))) return;
    const query = typeof req.query.query === 'string' ? req.query.query.trim().toLowerCase() : '';
    const works = (await store.listWorksByCreator(config.tenantId, creatorId)).filter((work) => (
      !query || [work.title, work.description || '', ...work.tags].some((value) => value.toLowerCase().includes(query))
    ));
    return res.json({
      items: await Promise.all(works.map((work) => canonicalWorkView(work, `${req.protocol}://${req.get('host')}`))),
      total: works.length
    });
  });

  app.get('/studio/works/:workId', requireAuth, async (req, res) => {
    const work = await store.getWork(config.tenantId, req.params.workId);
    if (!work) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, work.creatorId))) return;
    return res.json(await canonicalWorkView(work, `${req.protocol}://${req.get('host')}`));
  });

  app.post('/studio/works', requireAuth, async (req, res) => {
    const creatorId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    if (!(await ensureCreatorContentAccess(req, res, creatorId))) return;
    const originalFilename = sanitizeOptional(req.body?.originalFilename, 255) || 'Untitled work';
    const suppliedTitle = sanitizeOptional(req.body?.title, 300);
    const title = suppliedTitle || titleFromFilename(originalFilename);
    const requestedSlug = slugify(String(req.body?.slug || title));
    if ((await store.listWorksByCreator(config.tenantId, creatorId)).some((item) => item.slugHistory.includes(requestedSlug))) {
      return res.status(409).json({ message: 'Work slug is already in use for this Creator.' });
    }
    const now = new Date().toISOString();
    const work: Work = {
      workId: randomUUID(),
      tenantId: config.tenantId,
      creatorId,
      kind: req.body?.kind === 'video' || req.body?.kind === 'audio' || req.body?.kind === 'literature' || req.body?.kind === 'article' || req.body?.kind === 'animation' || req.body?.kind === 'gallery' || req.body?.kind === 'mixed'
        ? req.body.kind
        : 'image',
      title,
      slug: requestedSlug,
      slugHistory: [],
      description: sanitizeOptional(req.body?.description, 1_000_000),
      body: parsePostBlocks(req.body?.body, { unbounded: true }),
      tags: parseStringArray(req.body?.tags).slice(0, 100),
      contentRating: normalizeContentRating(req.body?.contentRating || 'general'),
      aiDisclosure: parseOptionalAiDisclosure(req.body?.aiDisclosure) || 'none',
      heavyTopics: parseOptionalHeavyTopics(req.body?.heavyTopics) || [],
      status: 'draft',
      origin: { type: 'local' },
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    work.slugHistory = [work.slug];
    await store.createWork(work);
    await store.upsertWorkDiscoveryParticipation({
      workId: work.workId,
      tenantId: work.tenantId,
      creatorId: work.creatorId,
      state: 'none',
      updatedAt: now
    });
    return res.status(201).json({ work: await canonicalWorkView(work, `${req.protocol}://${req.get('host')}`) });
  });

  app.patch('/studio/works/:workId', requireAuth, async (req, res) => {
    const work = await store.getWork(config.tenantId, req.params.workId);
    if (!work) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, work.creatorId))) return;
    const nextSlug = req.body?.slug !== undefined ? slugify(String(req.body.slug)) : work.slug;
    if (nextSlug !== work.slug && (await store.listWorksByCreator(config.tenantId, work.creatorId)).some((item) => item.workId !== work.workId && item.slugHistory.includes(nextSlug))) {
      return res.status(409).json({ message: 'Work slug is already in use for this Creator.' });
    }
    const status = req.body?.status === 'ready' || req.body?.status === 'archived' || req.body?.status === 'deleted' || req.body?.status === 'draft'
      ? req.body.status
      : work.status;
    const now = new Date().toISOString();
    const updated: Work = {
      ...work,
      title: req.body?.title !== undefined ? String(req.body.title).trim().slice(0, 300) || work.title : work.title,
      slug: nextSlug,
      slugHistory: uniqueSlugs([...(work.slugHistory || [work.slug]), nextSlug]),
      description: req.body?.description !== undefined ? sanitizeOptional(req.body.description, 1_000_000) : work.description,
      body: req.body?.body !== undefined ? parsePostBlocks(req.body.body, { unbounded: true }) : work.body,
      tags: req.body?.tags !== undefined ? parseStringArray(req.body.tags).slice(0, 100) : work.tags,
      contentRating: req.body?.contentRating !== undefined ? normalizeContentRating(req.body.contentRating) : work.contentRating,
      aiDisclosure: req.body?.aiDisclosure !== undefined ? (parseOptionalAiDisclosure(req.body.aiDisclosure) || 'none') : work.aiDisclosure,
      heavyTopics: req.body?.heavyTopics !== undefined ? (parseOptionalHeavyTopics(req.body.heavyTopics) || []) : work.heavyTopics,
      status,
      revision: work.revision + 1,
      updatedAt: now,
      archivedAt: status === 'archived' ? now : undefined,
      deletedAt: status === 'deleted' ? now : undefined
    };
    await store.updateWork(updated);
    return res.json(await canonicalWorkView(updated, `${req.protocol}://${req.get('host')}`));
  });

  app.put('/studio/works/:workId/image', requireAuth, express.raw({ type: 'image/*', limit: config.externalContentMaxBytes }), async (req, res) => {
    const work = await store.getWork(config.tenantId, req.params.workId);
    if (!work) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, work.creatorId))) return;
    if (!Buffer.isBuffer(req.body) || !req.body.byteLength) return res.status(400).json({ message: 'Upload one image file with this request.' });
    const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].split(';', 1)[0] : '';
    if (!contentType.startsWith('image/')) return res.status(400).json({ message: 'Only image uploads are supported for this endpoint.' });
    try {
      const assetId = randomUUID();
      const stored = await storeUbeeqWorkImage(config, {
        tenantId: config.tenantId,
        creatorId: work.creatorId,
        assetId,
        contentType,
        body: req.body
      });
      const now = new Date().toISOString();
      const asset: CanonicalAsset = {
        assetId,
        tenantId: config.tenantId,
        creatorId: work.creatorId,
        kind: 'image',
        status: 'ready',
        mimeType: stored.contentType,
        originalFilename: sanitizeOptional(req.query.originalFilename, 255),
        sizeBytes: stored.byteSize,
        checksumSha256: stored.checksumSha256,
        storage: {
          mode: 'hosted',
          objectKey: stored.objectKey,
          thumbnailObjectKey: stored.thumbnailObjectKey
        },
        createdAt: now,
        updatedAt: now
      };
      await store.createCanonicalAsset(asset);
      await store.attachAssetToWork(config.tenantId, { workId: work.workId, assetId, role: work.primaryAssetId ? 'content' : 'primary', position: (await store.listCanonicalAssetsByWork(config.tenantId, work.workId)).length });
      const updated = work.primaryAssetId ? work : { ...work, primaryAssetId: assetId, revision: work.revision + 1, updatedAt: now };
      if (updated !== work) await store.updateWork(updated);
      // The DeviantArt worker still consumes the established ExternalAsset /
      // SpacePublication contract. Mirror a local canonical upload into that
      // compatibility record so it can be published without first importing
      // from an external platform.
      const compatibilityAsset = await store.getAsset(work.workId);
      const externalAsset: ExternalAsset = {
        assetId: work.workId,
        userId: compatibilityAsset?.userId || req.authUser!.userId,
        creatorIdentityId: work.creatorId,
        assetType: 'image',
        canonicalTitle: updated.title,
        canonicalDescription: updated.description,
        visibility: 'private',
        titleSyncPolicy: compatibilityAsset?.titleSyncPolicy || 'mirrored',
        descriptionSyncPolicy: compatibilityAsset?.descriptionSyncPolicy || 'mirrored',
        createdAt: compatibilityAsset?.createdAt || now,
        updatedAt: now
      };
      if (compatibilityAsset) await store.updateAsset(externalAsset);
      else await store.createAsset(externalAsset);
      await store.upsertSpacePublication({
        assetId: work.workId,
        published: false,
        hostingMode: 'hosted',
        contentSyncStatus: 'hosted',
        sourceCopyQuality: 'original',
        hostedObjectKey: stored.objectKey,
        hostedThumbnailObjectKey: stored.thumbnailObjectKey,
        hostedContentType: stored.contentType,
        hostedByteSize: stored.byteSize,
        hostedChecksumSha256: stored.checksumSha256,
        visibility: 'private',
        updatedAt: now
      });
      return res.status(201).json(await canonicalWorkView(updated, `${req.protocol}://${req.get('host')}`));
    } catch (error) {
      logServerError('studio.work.image-upload', error);
      return res.status(400).json({ message: error instanceof Error ? error.message : 'Unable to store this work image.' });
    }
  });

  app.post('/studio/works/:assetId/destinations/deviantart', requireAuth, async (req, res) => {
    let work = await store.getWork(config.tenantId, req.params.assetId);
    let asset = await store.getAsset(req.params.assetId);
    if (!work && asset) {
      const now = new Date().toISOString();
      work = {
        workId: asset.assetId,
        tenantId: config.tenantId,
        creatorId: asset.creatorIdentityId,
        kind: asset.assetType === 'other' ? 'mixed' : asset.assetType,
        title: asset.canonicalTitle,
        slug: slugify(asset.canonicalTitle || asset.assetId),
        slugHistory: [slugify(asset.canonicalTitle || asset.assetId)],
        description: asset.canonicalDescription,
        tags: [],
        contentRating: 'general',
        aiDisclosure: 'none',
        heavyTopics: [],
        status: 'draft',
        origin: { type: 'local' },
        revision: 1,
        createdAt: asset.createdAt || now,
        updatedAt: asset.updatedAt || now
      };
      await store.createWork(work);
      await store.upsertWorkDiscoveryParticipation({ workId: work.workId, tenantId: work.tenantId, creatorId: work.creatorId, state: 'none', updatedAt: now });
    }
    if (!work) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, work.creatorId))) return;
    if (!(await ensureWorkPublicationAllowed(work, res))) return;
    if (!asset) {
      const now = new Date().toISOString();
      asset = {
        assetId: work.workId,
        userId: req.authUser!.userId,
        creatorIdentityId: work.creatorId,
        assetType: work.kind === 'video' ? 'video' : work.kind === 'literature' || work.kind === 'article' ? 'literature' : work.kind === 'animation' ? 'animation' : work.kind === 'image' ? 'image' : 'other',
        canonicalTitle: work.title,
        canonicalDescription: work.description,
        visibility: 'private',
        titleSyncPolicy: 'mirrored',
        descriptionSyncPolicy: 'mirrored',
        createdAt: now,
        updatedAt: now
      };
      await store.createAsset(asset);
    }
    const externalAccountId = typeof req.body?.externalAccountId === 'string' ? req.body.externalAccountId.trim() : '';
    const account = externalAccountId ? await store.getExternalAccount(externalAccountId) : null;
    if (!account || account.platform !== 'deviantart' || account.userId !== req.authUser!.userId || !['connected', 'rate_limited', 'temporarily_unavailable'].includes(account.connectionStatus)) {
      return res.status(400).json({ message: 'Choose an available DeviantArt account.' });
    }
    const preset = { ...defaultDeviantArtPreset(), ...account.deviantArtPublishingPreset };
    const targetStatus = req.body?.targetStatus === 'draft' || req.body?.targetStatus === 'published'
      ? req.body.targetStatus
      : preset.targetStatus;
    const hasDisplayResolutionOverride = Boolean(req.body && Object.prototype.hasOwnProperty.call(req.body, 'displayResolution'));
    if (hasDisplayResolutionOverride && req.body.displayResolution !== null && (typeof req.body.displayResolution !== 'number' || !deviantArtDisplayResolutions.has(req.body.displayResolution))) {
      return res.status(400).json({ message: 'Choose a supported DeviantArt display size, or Original.' });
    }
    const requestedDisplayResolution = typeof req.body?.displayResolution === 'number' && deviantArtDisplayResolutions.has(req.body.displayResolution)
      ? req.body.displayResolution
      : undefined;
    const displayResolution = hasDisplayResolutionOverride ? requestedDisplayResolution : preset.displayResolution;
    const allowFreeDownload = typeof req.body?.allowFreeDownload === 'boolean' ? req.body.allowFreeDownload : preset.allowFreeDownload;
    const addWatermark = displayResolution ? (typeof req.body?.addWatermark === 'boolean' ? req.body.addWatermark : preset.addWatermark) : false;
    const hasTagsOverride = Boolean(req.body && Object.prototype.hasOwnProperty.call(req.body, 'tags'));
    const tags = hasTagsOverride ? parseDeviantArtPreset({ defaultTags: req.body.tags }).defaultTags : preset.defaultTags;
    const hasGalleryOverride = Boolean(req.body && Object.prototype.hasOwnProperty.call(req.body, 'galleryExternalCollectionIds'));
    const galleryExternalCollectionIds = hasGalleryOverride
      ? parseDeviantArtPreset({ galleryExternalCollectionIds: req.body.galleryExternalCollectionIds }).galleryExternalCollectionIds
      : preset.galleryExternalCollectionIds;
    const hasMatureOverride = Boolean(req.body && (
      Object.prototype.hasOwnProperty.call(req.body, 'isMature')
      || Object.prototype.hasOwnProperty.call(req.body, 'matureLevel')
      || Object.prototype.hasOwnProperty.call(req.body, 'matureClassification')
    ));
    const matureSettings = parseDeviantArtPreset({
      isMature: typeof req.body?.isMature === 'boolean' ? req.body.isMature : preset.isMature,
      matureLevel: req.body?.matureLevel || preset.matureLevel,
      matureClassification: req.body?.matureClassification || preset.matureClassification
    });
    const isMature = matureSettings.isMature;
    const matureLevel = matureSettings.matureLevel;
    const matureClassification = matureSettings.matureClassification;
    const hasAiOverride = Boolean(req.body && (
      Object.prototype.hasOwnProperty.call(req.body, 'isAiGenerated')
      || Object.prototype.hasOwnProperty.call(req.body, 'noAi')
    ));
    const isAiGenerated = typeof req.body?.isAiGenerated === 'boolean' ? req.body.isAiGenerated : preset.isAiGenerated;
    const noAi = typeof req.body?.noAi === 'boolean' ? req.body.noAi : preset.noAi;
    const assignedCreatorIds = (await store.listExternalAccountCreatorAssignments(account.externalAccountId)).map((assignment) => assignment.creatorIdentityId);
    if (!assignedCreatorIds.includes(asset.creatorIdentityId) && account.primaryCreatorIdentityId !== asset.creatorIdentityId && account.creatorIdentityId !== asset.creatorIdentityId) {
      return res.status(403).json({ message: 'This DeviantArt account is not connected to the work’s creator.' });
    }
    const existing = (await store.listExternalPublications(account.externalAccountId)).find((publication) => publication.assetId === asset.assetId && publication.syncStatus !== 'deleted');
    if (existing) {
      if (existing.syncStatus === 'active' && targetStatus === 'draft') {
        return res.status(409).json({ message: 'This work is already published on DeviantArt. Unpublishing it to Sta.sh is not available through the connected API.' });
      }
      const hasSettingsOverride = hasDisplayResolutionOverride
        || typeof req.body?.allowFreeDownload === 'boolean'
        || typeof req.body?.addWatermark === 'boolean'
        || hasTagsOverride
        || hasGalleryOverride
        || hasMatureOverride
        || hasAiOverride;
      const updatedExisting: ExternalPublication = existing.targetStatus === targetStatus && !hasSettingsOverride ? existing : {
        ...existing,
        targetStatus,
        ...(hasTagsOverride ? { externalTags: tags } : {}),
        ...(hasGalleryOverride ? { externalCollectionIds: galleryExternalCollectionIds } : {}),
        rawMetadataJson: hasSettingsOverride ? (() => {
          const metadata = { ...existing.rawMetadataJson };
          if (hasDisplayResolutionOverride) {
            delete metadata.display_resolution;
            if (displayResolution) metadata.display_resolution = displayResolution;
          }
          if (typeof req.body?.allowFreeDownload === 'boolean') metadata.allow_free_download = allowFreeDownload;
          if (typeof req.body?.addWatermark === 'boolean' || hasDisplayResolutionOverride) metadata.add_watermark = addWatermark;
          if (hasMatureOverride) {
            metadata.is_mature = isMature;
            if (isMature) {
              metadata.mature_level = matureLevel;
              metadata.mature_classification = matureClassification;
            } else {
              delete metadata.mature_level;
              delete metadata.mature_classification;
            }
          }
          if (hasAiOverride) {
            metadata.is_ai_generated = isAiGenerated;
            metadata.noai = noAi;
          }
          return metadata;
        })() : existing.rawMetadataJson,
        updatedAt: new Date().toISOString()
      };
      if (updatedExisting !== existing) await store.updateExternalPublication(updatedExisting);
      await store.upsertPublication({
        publicationId: updatedExisting.externalPublicationId,
        tenantId: config.tenantId,
        creatorId: work.creatorId,
        workId: work.workId,
        destination: 'deviantart',
        integrationAccountId: account.externalAccountId,
        status: updatedExisting.syncStatus === 'active' ? 'live' : updatedExisting.syncStatus === 'draft' ? 'draft' : 'queued',
        visibility: 'public',
        remoteId: updatedExisting.externalContentId,
        remoteUrl: updatedExisting.externalUrl,
        metadataOverrides: { title: updatedExisting.externalTitle, description: updatedExisting.externalDescription, tags: updatedExisting.externalTags },
        sync: { status: updatedExisting.metadataSyncStatus === 'conflict' ? 'conflict' : 'local_newer', localRevision: work.revision, lastSuccessfulAt: updatedExisting.lastSyncedAt },
        providerData: { targetStatus, externalUsername: account.externalUsername, externalCollectionIds: updatedExisting.externalCollectionIds || [] },
        createdAt: updatedExisting.createdAt,
        updatedAt: updatedExisting.updatedAt,
        publishedAt: updatedExisting.publishedAt
      });
      const existingIntent = (await store.listPublicationIntentsByWork(config.tenantId, work.workId)).find((intent) => intent.destination === 'deviantart' && intent.integrationAccountId === account.externalAccountId);
      await store.upsertPublicationIntent({
        publicationIntentId: existingIntent?.publicationIntentId || randomUUID(),
        tenantId: config.tenantId,
        creatorId: work.creatorId,
        workId: work.workId,
        destination: 'deviantart',
        integrationAccountId: account.externalAccountId,
        enabled: true,
        desiredStatus: targetStatus === 'draft' ? 'draft' : 'live',
        createdAt: existingIntent?.createdAt || updatedExisting.createdAt,
        updatedAt: updatedExisting.updatedAt
      });
      return res.status(200).json({ publication: updatedExisting });
    }
    const now = new Date().toISOString();
    const workAssets = await store.listCanonicalAssetsByWork(config.tenantId, work.workId);
    const sourceFilename = workAssets.find((item) => item.assetId === work.primaryAssetId)?.originalFilename || workAssets[0]?.originalFilename;
    const presetTitle = sourceFilename && preset.titleFormat === 'filename_title_case'
      ? titleFromFilename(sourceFilename)
      : asset.canonicalTitle;
    const publication: ExternalPublication = {
      externalPublicationId: randomUUID(),
      assetId: asset.assetId,
      externalAccountId: account.externalAccountId,
      platform: 'deviantart',
      externalContentId: `pending:${asset.assetId}`,
      externalTitle: presetTitle,
      externalDescription: asset.canonicalDescription,
      externalTags: tags,
      externalCollectionIds: galleryExternalCollectionIds,
      targetStatus,
      syncStatus: 'pending_publish',
      rawMetadataJson: {
        ...(displayResolution ? { display_resolution: displayResolution } : {}),
        allow_free_download: allowFreeDownload,
        add_watermark: addWatermark,
        is_mature: isMature,
        ...(isMature ? { mature_level: matureLevel, mature_classification: matureClassification } : {}),
        is_ai_generated: isAiGenerated,
        noai: noAi
      },
      createdAt: now,
      updatedAt: now
    };
    await store.createExternalPublication(publication);
    await store.upsertPublication({
      publicationId: publication.externalPublicationId,
      tenantId: config.tenantId,
      creatorId: work.creatorId,
      workId: work.workId,
      destination: 'deviantart',
      integrationAccountId: account.externalAccountId,
      status: targetStatus === 'draft' ? 'draft' : 'queued',
      visibility: 'public',
      remoteId: publication.externalContentId,
      metadataOverrides: { title: publication.externalTitle, description: publication.externalDescription, tags: publication.externalTags },
      sync: { status: 'local_newer', localRevision: work.revision },
      providerData: { targetStatus, externalUsername: account.externalUsername, externalCollectionIds: publication.externalCollectionIds || [] },
      createdAt: now,
      updatedAt: now
    });
    const currentIntent = (await store.listPublicationIntentsByWork(config.tenantId, work.workId)).find((intent) => intent.destination === 'deviantart' && intent.integrationAccountId === account.externalAccountId);
    await store.upsertPublicationIntent({
      publicationIntentId: currentIntent?.publicationIntentId || randomUUID(),
      tenantId: config.tenantId,
      creatorId: work.creatorId,
      workId: work.workId,
      destination: 'deviantart',
      integrationAccountId: account.externalAccountId,
      enabled: true,
      desiredStatus: targetStatus === 'draft' ? 'draft' : 'live',
      createdAt: currentIntent?.createdAt || now,
      updatedAt: now
    });
    // A destination starts with shared Ubeeq values. A creator can opt out of that
    // relationship on the metadata review page before the first sync.
    await store.updateAsset({
      ...asset,
      titleSyncPolicy: 'mirrored',
      descriptionSyncPolicy: 'mirrored',
      updatedAt: now
    });
    return res.status(201).json({ publication });
  });

  app.put('/studio/works/:workId/publication-intents', requireAuth, async (req, res) => {
    const work = await store.getWork(config.tenantId, req.params.workId);
    if (!work) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, work.creatorId))) return;
    const destination = req.body?.destination === 'eversally' || req.body?.destination === 'deviantart' ? req.body.destination : '';
    if (!destination) return res.status(400).json({ message: 'Choose an available publishing destination.' });
    const integrationAccountId = destination === 'deviantart' && typeof req.body?.integrationAccountId === 'string' ? req.body.integrationAccountId.trim() : undefined;
    if (destination === 'deviantart') {
      const account = integrationAccountId ? await store.getExternalAccount(integrationAccountId) : null;
      if (!account || account.platform !== 'deviantart' || account.userId !== req.authUser!.userId || !['connected', 'rate_limited', 'temporarily_unavailable'].includes(account.connectionStatus)) {
        return res.status(400).json({ message: 'Choose an available DeviantArt account.' });
      }
      const assignedCreatorIds = (await store.listExternalAccountCreatorAssignments(account.externalAccountId)).map((assignment) => assignment.creatorIdentityId);
      if (!assignedCreatorIds.includes(work.creatorId) && account.primaryCreatorIdentityId !== work.creatorId && account.creatorIdentityId !== work.creatorId) {
        return res.status(403).json({ message: 'This DeviantArt account is not connected to the Work’s Creator.' });
      }
    }
    const desiredStatus = req.body?.desiredStatus === 'draft' || req.body?.desiredStatus === 'scheduled' ? req.body.desiredStatus : 'live';
    const existing = (await store.listPublicationIntentsByWork(config.tenantId, work.workId)).find((intent) => intent.destination === destination && intent.integrationAccountId === integrationAccountId);
    const now = new Date().toISOString();
    const intent: PublicationIntent = {
      publicationIntentId: existing?.publicationIntentId || randomUUID(),
      tenantId: config.tenantId,
      creatorId: work.creatorId,
      workId: work.workId,
      destination,
      integrationAccountId,
      enabled: req.body?.enabled !== false,
      desiredStatus,
      scheduledAt: desiredStatus === 'scheduled' && typeof req.body?.scheduledAt === 'string' ? req.body.scheduledAt : undefined,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    await store.upsertPublicationIntent(intent);
    return res.json(intent);
  });

  app.delete('/studio/works/:workId/publication-intents/:publicationIntentId', requireAuth, async (req, res) => {
    const work = await store.getWork(config.tenantId, req.params.workId);
    if (!work) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, work.creatorId))) return;
    const intent = await store.getPublicationIntent(config.tenantId, req.params.publicationIntentId);
    if (!intent || intent.workId !== work.workId) return res.status(404).json({ message: 'Publishing destination selection not found.' });
    await store.deletePublicationIntent(config.tenantId, intent.publicationIntentId);
    return res.status(204).end();
  });

  app.delete('/studio/works/:assetId/destinations/deviantart/:externalAccountId', requireAuth, async (req, res) => {
    const work = await store.getWork(config.tenantId, req.params.assetId);
    if (!work) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, work.creatorId))) return;
    const asset = await store.getAsset(work.workId);
    if (!asset) return res.status(404).json({ message: 'Work destination compatibility record not found' });
    const publication = (await store.listExternalPublications(req.params.externalAccountId))
      .find((item) => item.assetId === asset.assetId && item.platform === 'deviantart' && item.syncStatus !== 'deleted');
    if (!publication) return res.status(404).json({ message: 'DeviantArt destination not found.' });
    const now = new Date().toISOString();
    await store.updateExternalPublication({ ...publication, syncStatus: 'deleted', updatedAt: now });
    const canonical = await store.getPublication(config.tenantId, publication.externalPublicationId);
    if (canonical) await store.upsertPublication({ ...canonical, status: 'removed', removedAt: now, updatedAt: now });
    const intent = (await store.listPublicationIntentsByWork(config.tenantId, work.workId)).find((item) => item.destination === 'deviantart' && item.integrationAccountId === req.params.externalAccountId);
    if (intent) await store.deletePublicationIntent(config.tenantId, intent.publicationIntentId);
    return res.status(204).end();
  });

  app.post('/studio/works/:assetId/destinations/deviantart/:externalAccountId/sync', requireAuth, async (req, res) => {
    const work = await store.getWork(config.tenantId, req.params.assetId);
    if (!work) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, work.creatorId))) return;
    if (!(await ensureWorkPublicationAllowed(work, res))) return;
    const asset = await store.getAsset(work.workId);
    if (!asset) return res.status(404).json({ message: 'Work destination compatibility record not found' });
    const publication = (await store.listExternalPublications(req.params.externalAccountId))
      .find((item) => item.assetId === asset.assetId && item.platform === 'deviantart' && (item.syncStatus === 'pending_publish' || item.syncStatus === 'draft' || item.syncStatus === 'error'));
    if (!publication) return res.status(409).json({ message: 'This DeviantArt destination is already published or has been removed.' });
    try {
      const workAssets = await store.listCanonicalAssetsByWork(config.tenantId, work.workId);
      const sourceAsset = workAssets.find((item) => item.assetId === work.primaryAssetId) || workAssets[0];
      const queuedPublication = publication.syncStatus === 'error'
        ? { ...publication, syncStatus: 'pending_publish' as const, updatedAt: new Date().toISOString() }
        : publication;
      if (queuedPublication !== publication) await store.updateExternalPublication(queuedPublication);
      const canonical = await store.getPublication(config.tenantId, publication.externalPublicationId);
      if (canonical) await store.upsertPublication({ ...canonical, status: 'queued', sync: { ...canonical.sync, status: 'local_newer', lastAttemptAt: new Date().toISOString() }, updatedAt: new Date().toISOString() });
      const job = await enqueueExternalSyncJob(queuedPublication.externalAccountId, 'publish', {
        assetId: asset.assetId,
        externalPublicationId: queuedPublication.externalPublicationId,
        targetStatus: queuedPublication.targetStatus || 'published',
        ...(sourceAsset?.originalFilename ? { originalFilename: sourceAsset.originalFilename } : {})
      });
      return res.status(202).json(job);
    } catch (error) {
      logServerError('studio.work.destination.publish.enqueue', error);
      return res.status(503).json({ message: 'The publishing queue is unavailable. Please try again.' });
    }
  });

  app.post('/studio/works/:workId/publications/:publicationId/resolve', requireAuth, async (req, res) => {
    const work = await store.getWork(config.tenantId, req.params.workId);
    if (!work) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, work.creatorId))) return;
    const publication = await store.getPublication(config.tenantId, req.params.publicationId);
    if (!publication || publication.workId !== work.workId || publication.destination !== 'deviantart' || !publication.integrationAccountId) {
      return res.status(404).json({ message: 'DeviantArt publication not found' });
    }
    const account = await store.getExternalAccount(publication.integrationAccountId);
    if (!account || account.userId !== req.authUser!.userId || account.platform !== 'deviantart') {
      return res.status(403).json({ message: 'You do not control this DeviantArt publication.' });
    }
    const externalPublication = (await store.listExternalPublications(account.externalAccountId))
      .find((item) => item.externalPublicationId === publication.publicationId);
    if (!externalPublication || externalPublication.syncStatus !== 'active') {
      return res.status(409).json({ message: 'Only an active DeviantArt publication can be reconciled.' });
    }
    const strategy = req.body?.strategy === 'pull' || req.body?.strategy === 'push' ? req.body.strategy : '';
    if (!strategy) return res.status(400).json({ message: 'Choose whether to pull from DeviantArt or push the Ubeeq version.' });
    const now = new Date().toISOString();
    try {
      if (strategy === 'pull') {
        const compatibilityAsset = await store.getAsset(work.workId);
        if (compatibilityAsset) {
          await store.updateAsset({
            ...compatibilityAsset,
            titleSyncPolicy: 'mirrored',
            descriptionSyncPolicy: 'mirrored',
            updatedAt: now
          });
        }
        await store.upsertPublication({
          ...publication,
          sync: { ...publication.sync, status: 'remote_newer', lastAttemptAt: now, errorCode: undefined, errorMessage: undefined },
          updatedAt: now
        });
        const job = await enqueueExternalSyncJob(account.externalAccountId, 'full_reconciliation', {
          reason: 'manual_pull',
          externalContentId: externalPublication.externalContentId,
          publicationId: publication.publicationId
        });
        auditLog(req, 'deviantart.publication.pull.requested', { workId: work.workId, publicationId: publication.publicationId, jobId: job.externalSyncJobId });
        return res.status(202).json({ strategy, job });
      }
      const compatibilityAsset = await store.getAsset(work.workId);
      const updatePayload = {
        externalPublicationId: externalPublication.externalPublicationId,
        title: work.title,
        description: work.description || '',
        tags: work.tags
      };
      await store.updateExternalPublication({
        ...externalPublication,
        externalTitle: work.title,
        externalDescription: work.description || '',
        externalTags: work.tags,
        metadataSyncStatus: 'local_update_pending',
        updatedAt: now
      });
      await store.upsertPublication({
        ...publication,
        metadataOverrides: { ...publication.metadataOverrides, title: work.title, description: work.description, tags: work.tags },
        sync: { ...publication.sync, status: 'local_newer', lastAttemptAt: now, errorCode: undefined, errorMessage: undefined },
        updatedAt: now
      });
      if (compatibilityAsset) await store.updateAsset({ ...compatibilityAsset, updatedAt: now });
      const job = await enqueueExternalSyncJob(account.externalAccountId, 'remote_update', updatePayload);
      auditLog(req, 'deviantart.publication.push.requested', { workId: work.workId, publicationId: publication.publicationId, jobId: job.externalSyncJobId });
      return res.status(202).json({ strategy, job });
    } catch (error) {
      logServerError('deviantart.publication.resolve.enqueue', error);
      return res.status(503).json({ message: 'The reconciliation job could not be queued. No remote changes were made.' });
    }
  });

  /** Provider-neutral confirmation-gated resolution for a persisted field diff. */
  app.post('/studio/works/:workId/publications/:publicationId/reconciliation/resolve', requireAuth, async (req, res) => {
    const work = await store.getWork(config.tenantId, req.params.workId);
    if (!work) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, work.creatorId))) return;
    const publication = await store.getPublication(config.tenantId, req.params.publicationId);
    if (!publication || publication.workId !== work.workId) return res.status(404).json({ message: 'Publication not found' });
    const action = req.body?.action;
    if (action !== 'accept_remote' && action !== 'keep_local' && action !== 'create_detached_copy') {
      return res.status(400).json({ message: 'Choose a valid reconciliation action.' });
    }
    if (req.body?.confirm !== true) return res.status(400).json({ message: 'Explicit reconciliation confirmation is required.' });
    try {
      const result = resolvePublicationReconciliation(publication, { action, confirmed: true });
      await store.upsertPublication(result.publication);
      let detachedPublication: Publication | undefined;
      if (result.detachedPublication) {
        detachedPublication = { ...result.detachedPublication, publicationId: randomUUID() };
        await store.upsertPublication(detachedPublication);
      }
      auditLog(req, 'integration.publication.reconciliation.resolved', {
        workId: work.workId,
        publicationId: publication.publicationId,
        reconciliationAction: action,
        ...(detachedPublication ? { detachedPublicationId: detachedPublication.publicationId } : {})
      });
      return res.json({ publication: result.publication, detachedPublication });
    } catch (error) {
      return res.status(409).json({ message: error instanceof Error ? error.message : 'Unable to resolve reconciliation.' });
    }
  });

  app.put('/studio/integrations/assets/:assetId/space-publication', requireAuth, async (req, res) => {
    const asset = await store.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ message: 'Asset not found' });
    if (asset.userId !== req.authUser!.userId && !(await ensureCreatorContentAccess(req, res, asset.creatorIdentityId))) return;
    const current = await store.getSpacePublication(asset.assetId);
    const published = Boolean(req.body?.published);
    const contentSyncRequested = published && req.body?.hostingMode === 'hosted';
    const visibility = req.body?.visibility === 'public' || req.body?.visibility === 'unlisted' ? req.body.visibility : 'private';
    const candidatePublications = (await Promise.all(
      (await store.listExternalAccountsByCreatorIdentity(asset.creatorIdentityId))
        .map((account) => store.listExternalPublications(account.externalAccountId))
    )).flat().filter((publication) => publication.assetId === asset.assetId);
    const sourcePublication = candidatePublications[0];
    if (contentSyncRequested && !sourcePublication) {
      return res.status(409).json({ message: `This work has no connected source available for a ${brand.workspaceFullName} backup.` });
    }
    const now = new Date().toISOString();
    const publication = {
      assetId: asset.assetId,
      published,
      // The work remains linked while the background transfer is in progress.
      hostingMode: contentSyncRequested ? (current?.hostingMode === 'hosted' ? 'hosted' : 'linked') : 'linked',
      publishedAt: published ? (current?.publishedAt || now) : undefined,
      ubeeqTitleOverride: sanitizeOptional(req.body?.ubeeqTitleOverride, 300),
      ubeeqDescriptionOverride: sanitizeOptional(req.body?.ubeeqDescriptionOverride, 20_000),
      visibility,
      contentSyncStatus: contentSyncRequested ? 'queued' : (published ? current?.contentSyncStatus || 'not_requested' : 'not_requested'),
      contentSyncError: contentSyncRequested ? undefined : current?.contentSyncError,
      updatedAt: now
    } satisfies SpacePublication;
    await store.upsertSpacePublication(publication);
    if (!contentSyncRequested) return res.json(publication);
    try {
      const job = await enqueueExternalSyncJob(sourcePublication!.externalAccountId, 'content_sync', {
        assetId: asset.assetId,
        externalPublicationId: sourcePublication!.externalPublicationId
      });
      return res.status(202).json({ ...publication, contentSyncJob: job });
    } catch (error) {
      logServerError('space.content-sync.enqueue', error);
      return res.status(503).json({ message: `The ${brand.workspaceFullName} backup queue is unavailable. Please try again.` });
    }
  });

  app.put('/studio/works/:workId/publications/eversally', requireAuth, async (req, res) => {
    const work = await store.getWork(config.tenantId, req.params.workId);
    if (!work) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, work.creatorId))) return;
    const assets = await store.listCanonicalAssetsByWork(config.tenantId, work.workId);
    if (!assets.length && !(['literature', 'article'].includes(work.kind) && (work.body || []).some((block) => (block.text || block.quote || block.html || '').trim()))) {
      return res.status(409).json({ message: 'Attach at least one Asset, or add body content for a literature Work, before publishing.' });
    }
    const existing = (await store.listPublicationsByWork(config.tenantId, work.workId)).find((item) => item.destination === 'eversally');
    const shouldPublish = req.body?.published !== false;
    if (shouldPublish && !(await ensureWorkPublicationAllowed(work, res))) return;
    const visibility = req.body?.visibility === 'public' || req.body?.visibility === 'unlisted' ? req.body.visibility : 'private';
    const newlyPublicInSpace = shouldPublish && visibility === 'public' && !(existing?.status === 'live' && existing.visibility === 'public');
    const now = new Date().toISOString();
    const publication: Publication = {
      publicationId: existing?.publicationId || randomUUID(),
      tenantId: config.tenantId,
      creatorId: work.creatorId,
      workId: work.workId,
      destination: 'eversally',
      status: shouldPublish ? 'live' : 'draft',
      visibility,
      metadataOverrides: {
        title: sanitizeOptional(req.body?.title, 300),
        description: sanitizeOptional(req.body?.description, 20_000)
      },
      sync: {
        status: 'not_applicable',
        localRevision: work.revision,
        lastSuccessfulAt: shouldPublish ? now : existing?.sync.lastSuccessfulAt
      },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      publishedAt: shouldPublish ? (existing?.publishedAt || now) : existing?.publishedAt,
      removedAt: shouldPublish ? undefined : existing?.removedAt
    };
    await store.upsertPublication(publication);
    let spaceContentSyncJob: ExternalSyncJob | undefined;
    let spacePublicationForResponse: SpacePublication | undefined;
    // Publishing an asset to the hosted Space must not leave the public page
    // dependent on an external provider.  If the Work originated on a
    // connected platform and no durable hosted copy exists yet, queue the
    // same content-sync path used by the explicit backup control.
    if (shouldPublish && assets.length && !['literature', 'article'].includes(work.kind)) {
      const primaryAsset = assets.find((asset) => asset.assetId === work.primaryAssetId)
        || assets.find((asset) => asset.attachment.role === 'primary')
        || assets[0];
      const sourceAssetIds = new Set([
        primaryAsset.assetId,
        work.workId,
        primaryAsset.assetId.endsWith(':remote') ? primaryAsset.assetId.slice(0, -':remote'.length) : ''
      ].filter(Boolean));
      const sourcePublications = (await Promise.all(
        (await store.listExternalAccountsByCreatorIdentity(work.creatorId))
          .map((account) => store.listExternalPublications(account.externalAccountId))
      )).flat().filter((candidate) => (
        sourceAssetIds.has(candidate.assetId)
        && candidate.syncStatus !== 'deleted'
      ));
      const sourcePublication = sourcePublications[0];
      const spaceAssetId = sourcePublication?.assetId || primaryAsset.assetId;
      // Preserve a legacy hosted copy even after the source DeviantArt
      // account has been disconnected.  Imported canonical assets may carry
      // a `:remote` suffix while their SpacePublication uses the original ID.
      const currentSpace = await legacySpacePublicationForWork(work, assets)
        || await store.getSpacePublication(spaceAssetId)
        || await store.getSpacePublication(primaryAsset.assetId);
      spacePublicationForResponse = currentSpace || undefined;
      const hasHostedCopy = Boolean(currentSpace?.hostedObjectKey || currentSpace?.contentSyncStatus === 'hosted');
      const syncAlreadyQueued = currentSpace?.contentSyncStatus === 'queued' || currentSpace?.contentSyncStatus === 'syncing';
      if (sourcePublication && !hasHostedCopy && !syncAlreadyQueued) {
        const syncPublication: SpacePublication = {
          ...currentSpace,
          assetId: spaceAssetId,
          published: true,
          hostingMode: currentSpace?.hostingMode === 'hosted' ? 'hosted' : 'linked',
          publishedAt: currentSpace?.publishedAt || now,
          visibility,
          contentSyncStatus: 'queued',
          contentSyncError: undefined,
          remoteContentFingerprint: sourcePublication.remoteContentFingerprint,
          updatedAt: now
        };
        await store.upsertSpacePublication(syncPublication);
        spacePublicationForResponse = syncPublication;
        try {
          spaceContentSyncJob = await enqueueExternalSyncJob(sourcePublication.externalAccountId, 'content_sync', {
            assetId: sourcePublication.assetId,
            externalPublicationId: sourcePublication.externalPublicationId
          });
        } catch (error) {
          logServerError('space.content-sync.enqueue-from-publication', error);
          await store.upsertSpacePublication({
            ...syncPublication,
            contentSyncStatus: 'failed',
            contentSyncError: `The ${brand.workspaceFullName} hosted copy could not be queued. Please try again.`,
            updatedAt: new Date().toISOString()
          });
          spacePublicationForResponse = {
            ...syncPublication,
            contentSyncStatus: 'failed',
            contentSyncError: `The ${brand.workspaceFullName} hosted copy could not be queued. Please try again.`,
            updatedAt: new Date().toISOString()
          };
        }
      }
    }
    const currentIntent = (await store.listPublicationIntentsByWork(config.tenantId, work.workId)).find((intent) => intent.destination === 'eversally' && !intent.integrationAccountId);
    await store.upsertPublicationIntent({
      publicationIntentId: currentIntent?.publicationIntentId || randomUUID(),
      tenantId: config.tenantId,
      creatorId: work.creatorId,
      workId: work.workId,
      destination: 'eversally',
      enabled: shouldPublish,
      desiredStatus: 'live',
      createdAt: currentIntent?.createdAt || now,
      updatedAt: now
    });
    const currentDiscovery = await store.getWorkDiscoveryParticipation(config.tenantId, work.workId);
    if ((!shouldPublish || visibility !== 'public') && currentDiscovery?.state === 'opted_in') {
      await store.upsertWorkDiscoveryParticipation({
        ...currentDiscovery,
        state: 'none',
        withdrawnAt: now,
        updatedAt: now
      });
    }
    const announcementMode = ['default', 'per_work', 'digest', 'none'].includes(req.body?.announcement?.mode)
      ? req.body.announcement.mode
      : 'default';
    const announcementPreset = ['recommended', 'image_showcase', 'writing_release', 'video_premiere', 'audio_release', 'compact_link', 'text_only', 'collection_digest', 'series_digest'].includes(req.body?.announcement?.preset)
      ? req.body.announcement.preset
      : undefined;
    const includePrimaryMedia = req.body?.announcement?.includePrimaryMedia !== false;
    if (newlyPublicInSpace && !['digest', 'none'].includes(announcementMode)) {
      const creator = (await store.listCreators()).find((item) => item.creatorId === work.creatorId);
      if (creator) {
        const title = publication.metadataOverrides?.title || work.title;
        const description = publication.metadataOverrides?.description || work.description;
        const workUrl = `${canonicalSpaceBaseUrl(creator)}/works/${encodeURIComponent(work.slug)}`;
        void queueDiscordWorkPublished(store, config, {
          userId: req.authUser!.userId,
          creatorIdentityId: work.creatorId,
          workId: work.workId,
          title,
          description,
          url: workUrl,
          creatorName: creator.name,
          kind: work.kind,
          // "Use channel default" must leave these undefined: the Discord
          // destination owns its recommended layout and media preference.
          ...(announcementMode === 'per_work'
            ? { preset: announcementPreset, includePrimaryMedia }
            : {}),
          idempotencyKey: `discord:space-live:${publication.publicationId}`
        }, communityDeliveryQueue.enqueue.bind(communityDeliveryQueue)).catch((error) => logServerError('discord.work-published.enqueue', error));
      }
    }
    return res.json({ ...publication, spaceContentSyncJob, spacePublication: spacePublicationForResponse });
  });

  app.put('/studio/works/:workId/discovery', requireAuth, async (req, res) => {
    const work = await store.getWork(config.tenantId, req.params.workId);
    if (!work) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, work.creatorId))) return;
    const state = req.body?.state === 'eligible' || req.body?.state === 'opted_in' || req.body?.state === 'removed'
      ? req.body.state
      : 'none';
    if (state === 'opted_in') {
      const space = (await store.listPublicationsByWork(config.tenantId, work.workId)).find((item) => item.destination === 'eversally');
      if (!space || space.status !== 'live' || space.visibility !== 'public') {
        return res.status(409).json({ message: 'Only a public Work that is live in its Space can opt into discovery.' });
      }
    }
    const now = new Date().toISOString();
    const participation = {
      workId: work.workId,
      tenantId: config.tenantId,
      creatorId: work.creatorId,
      state,
      optedInAt: state === 'opted_in' ? now : undefined,
      withdrawnAt: state === 'none' ? now : undefined,
      removedAt: state === 'removed' ? now : undefined,
      removalReason: state === 'removed' ? sanitizeOptional(req.body?.reason, 1000) : undefined,
      updatedAt: now
    };
    await store.upsertWorkDiscoveryParticipation(participation);
    return res.json(participation);
  });

  app.get('/studio/collections', requireAuth, async (req, res) => {
    const creatorId = typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';
    if (!(await ensureCreatorContentAccess(req, res, creatorId))) return;
    const collections = await store.listCreatorCollections(config.tenantId, creatorId);
    return res.json({
      items: await Promise.all(collections.map(async (collection) => ({
        ...collection,
        workIds: (await store.listCollectionWorks(config.tenantId, collection.collectionId)).map((item) => item.workId)
      })))
    });
  });

  app.post('/studio/collections', requireAuth, async (req, res) => {
    const creatorId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    if (!(await ensureCreatorContentAccess(req, res, creatorId))) return;
    const title = sanitizeOptional(req.body?.title, 200);
    if (!title) return res.status(400).json({ message: 'Collection title is required.' });
    const existing = await store.listCreatorCollections(config.tenantId, creatorId);
    const requestedSlug = slugify(String(req.body?.slug || title));
    if (existing.some((collection) => collection.slugHistory.includes(requestedSlug))) {
      return res.status(409).json({ message: 'Collection slug is already in use.' });
    }
    const now = new Date().toISOString();
    const collection: CanonicalCollection = {
      collectionId: randomUUID(),
      tenantId: config.tenantId,
      creatorId,
      type: req.body?.type === 'gallery' || req.body?.type === 'series' || req.body?.type === 'playlist' ? req.body.type : 'collection',
      title,
      slug: requestedSlug,
      slugHistory: [requestedSlug],
      description: sanitizeOptional(req.body?.description, 20_000),
      coverAssetId: sanitizeOptional(req.body?.coverAssetId, 200),
      status: req.body?.status === 'published' ? 'published' : 'draft',
      visibility: req.body?.visibility === 'public' || req.body?.visibility === 'unlisted' ? req.body.visibility : 'private',
      createdAt: now,
      updatedAt: now
    };
    await store.createCreatorCollection(collection);
    return res.status(201).json({ ...collection, workIds: [] });
  });

  app.patch('/studio/collections/:collectionId', requireAuth, async (req, res) => {
    const collection = await store.getCreatorCollection(config.tenantId, req.params.collectionId);
    if (!collection) return res.status(404).json({ message: 'Collection not found.' });
    if (!(await ensureCreatorContentAccess(req, res, collection.creatorId))) return;
    const nextSlug = req.body?.slug !== undefined ? slugify(String(req.body.slug)) : collection.slug;
    const status = req.body?.status === 'published' || req.body?.status === 'archived' || req.body?.status === 'deleted' || req.body?.status === 'draft'
      ? req.body.status
      : collection.status;
    const now = new Date().toISOString();
    const updated = {
      ...collection,
      type: req.body?.type === 'gallery' || req.body?.type === 'series' || req.body?.type === 'playlist' || req.body?.type === 'collection' ? req.body.type : collection.type,
      title: req.body?.title !== undefined ? String(req.body.title).trim().slice(0, 200) || collection.title : collection.title,
      slug: nextSlug,
      slugHistory: uniqueSlugs([...(collection.slugHistory || [collection.slug]), nextSlug]),
      description: req.body?.description !== undefined ? sanitizeOptional(req.body.description, 20_000) : collection.description,
      coverAssetId: req.body?.coverAssetId !== undefined ? sanitizeOptional(req.body.coverAssetId, 200) : collection.coverAssetId,
      status,
      visibility: req.body?.visibility === 'public' || req.body?.visibility === 'unlisted' || req.body?.visibility === 'private' ? req.body.visibility : collection.visibility,
      updatedAt: now,
      archivedAt: status === 'archived' ? now : undefined,
      deletedAt: status === 'deleted' ? now : undefined
    };
    await store.updateCreatorCollection(updated);
    return res.json({ ...updated, workIds: (await store.listCollectionWorks(config.tenantId, updated.collectionId)).map((item) => item.workId) });
  });

  app.delete('/studio/collections/:collectionId', requireAuth, async (req, res) => {
    const collection = await store.getCreatorCollection(config.tenantId, req.params.collectionId);
    if (!collection) return res.status(404).json({ message: 'Collection not found.' });
    if (!(await ensureCreatorContentAccess(req, res, collection.creatorId))) return;
    const now = new Date().toISOString();
    await store.updateCreatorCollection({ ...collection, status: 'deleted', deletedAt: now, updatedAt: now });
    return res.status(204).end();
  });

  app.put('/studio/collections/:collectionId/works', requireAuth, async (req, res) => {
    const collection = await store.getCreatorCollection(config.tenantId, req.params.collectionId);
    if (!collection) return res.status(404).json({ message: 'Collection not found.' });
    if (!(await ensureCreatorContentAccess(req, res, collection.creatorId))) return;
    const workIds = parseStringArray(req.body?.workIds);
    const works = await Promise.all(workIds.map((workId) => store.getWork(config.tenantId, workId)));
    if (works.some((work) => !work || work.creatorId !== collection.creatorId)) {
      return res.status(400).json({ message: 'Choose Works owned by this Creator.' });
    }
    const now = new Date().toISOString();
    await store.replaceCollectionWorks(config.tenantId, collection.collectionId, workIds.map((workId, position) => ({
      collectionId: collection.collectionId,
      workId,
      position,
      addedAt: now
    })));
    return res.json({ ...collection, workIds });
  });

  app.get('/studio/creators/:creatorId/export', requireAuth, async (req, res) => {
    const creatorId = req.params.creatorId.trim();
    if (!(await ensureCreatorContentAccess(req, res, creatorId))) return;
    const creator = (await store.listCreators()).find((item) => item.creatorId === creatorId);
    if (!creator) return res.status(404).json({ message: 'Creator not found.' });
    const creatorExportDecision = await supportSafetyService.accessPolicy(await creatorSafetyTargets(creatorId));
    if (!creatorExportDecision.export) {
      return res.status(423).json({ message: 'Creator export is unavailable while restricted safety review is active.' });
    }

    const works = await store.listWorksByCreator(config.tenantId, creatorId);
    const collections = await store.listCreatorCollections(config.tenantId, creatorId);
    const integrationAccounts = await store.listExternalAccountsByCreatorIdentity(creatorId);
    const [workRecords, collectionRecords] = await Promise.all([
      Promise.all(works.map(async (work) => {
        const [assets, publications, publicationIntents, discovery] = await Promise.all([
          store.listCanonicalAssetsByWork(config.tenantId, work.workId),
          store.listPublicationsByWork(config.tenantId, work.workId),
          store.listPublicationIntentsByWork(config.tenantId, work.workId),
          store.getWorkDiscoveryParticipation(config.tenantId, work.workId)
        ]);
        const workDecision = await supportSafetyService.accessPolicy([{ type: 'work', id: work.workId }]);
        if (!workDecision.export) return null;
        const exportableAssets = (await Promise.all(assets.map(async (asset) => ({
          asset,
          decision: await supportSafetyService.accessPolicy([{ type: 'asset', id: asset.assetId }])
        })))).filter(({ decision }) => decision.export).map(({ asset }) => asset);
        return { work, assets: exportableAssets, publications, publicationIntents, discovery };
      })),
      Promise.all(collections.map(async (collection) => ({
        collection,
        works: await store.listCollectionWorks(config.tenantId, collection.collectionId)
      })))
    ]);
    const exportableWorkRecords = workRecords.filter((record): record is NonNullable<typeof record> => Boolean(record));
    const exportableWorkIds = new Set(exportableWorkRecords.map(({ work }) => work.workId));
    const generatedAt = new Date().toISOString();
    const manifest = {
      schema: 'https://ubeeq.site/schemas/creator-export/v1',
      schemaVersion: 1,
      generatedAt,
      source: {
        product: brand.productName,
        tenantId: config.tenantId
      },
      creator,
      works: exportableWorkRecords,
      collections: collectionRecords.map(({ collection, works: memberships }) => ({
        collection,
        works: memberships.filter((membership) => exportableWorkIds.has(membership.workId))
      })),
      integrationAccounts: integrationAccounts.map(toExternalAccountResponse)
    };
    const filename = `${slugify(creator.slug || creator.name)}-ubeeq-export-${generatedAt.slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(JSON.stringify(manifest, null, 2));
  });

  app.get('/studio/integrations/deviantart/collections', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';
    if (!(await ensureCreatorContentAccess(req, res, creatorIdentityId))) return;
    const accounts = await store.listExternalAccountsByCreatorIdentity(creatorIdentityId);
    const [ubeeqCollections, externalCollections, mappings] = await Promise.all([
      store.listUbeeqCollectionsByCreatorIdentity(creatorIdentityId),
      Promise.all(accounts.map((account) => store.listExternalCollections(account.externalAccountId))),
      Promise.all(accounts.map((account) => store.listExternalCollectionMappings(account.externalAccountId)))
    ]);
    const collectionAssetLists = await Promise.all(ubeeqCollections.map(async (collection) => [
      collection.ubeeqCollectionId,
      await store.listUbeeqCollectionAssets(collection.ubeeqCollectionId)
    ] as const));
    const collectionAssetIdsByCollection = Object.fromEntries(collectionAssetLists.map(([collectionId, items]) => [
      collectionId,
      items.map((item) => item.assetId)
    ]));
    const collectionMembershipSummaryByCollection = Object.fromEntries(collectionAssetLists.map(([collectionId, items]) => [
      collectionId,
      {
        total: items.length,
        manual: items.filter((item) => item.manuallyAssigned ?? !(item.externalCollectionMappingIds || []).length).length,
        synchronized: items.filter((item) => (item.externalCollectionMappingIds || []).length > 0).length
      }
    ]));
    return res.json({
      ubeeqCollections,
      externalCollections: externalCollections.flat().map((collection) => ({
        ...collection,
        externalUsername: accounts.find((account) => account.externalAccountId === collection.externalAccountId)?.externalUsername || ''
      })),
      mappings: mappings.flat(),
      collectionAssetIdsByCollection,
      collectionMembershipSummaryByCollection
    });
  });

  app.post('/studio/integrations/collections', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.body?.creatorIdentityId === 'string' ? req.body.creatorIdentityId.trim() : '';
    if (!(await ensureCreatorAccountAccess(req, res, creatorIdentityId))) return;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 200) : '';
    if (!name) return res.status(400).json({ message: 'Collection name is required' });
    const now = new Date().toISOString();
    const collection: UbeeqCollection = {
      ubeeqCollectionId: randomUUID(),
      userId: req.authUser!.userId,
      creatorIdentityId,
      name,
      parentUbeeqCollectionId: typeof req.body?.parentUbeeqCollectionId === 'string' ? req.body.parentUbeeqCollectionId : undefined,
      position: Math.max(0, Math.floor(Number(req.body?.position || 0))),
      visibility: req.body?.visibility === 'public' || req.body?.visibility === 'unlisted' ? req.body.visibility : 'private',
      collectionType: req.body?.collectionType === 'gallery' || req.body?.collectionType === 'series' ? req.body.collectionType : 'collection',
      ruleDefinition: req.body?.ruleDefinition && typeof req.body.ruleDefinition === 'object' && !Array.isArray(req.body.ruleDefinition)
        ? req.body.ruleDefinition as Record<string, unknown>
        : undefined,
      createdAt: now,
      updatedAt: now
    };
    await store.createUbeeqCollection(collection);
    return res.status(201).json(collection);
  });

  app.patch('/studio/integrations/collections/:ubeeqCollectionId', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.body?.creatorIdentityId === 'string' ? req.body.creatorIdentityId.trim() : '';
    if (!(await ensureCreatorAccountAccess(req, res, creatorIdentityId))) return;
    const collection = (await store.listUbeeqCollectionsByCreatorIdentity(creatorIdentityId))
      .find((item) => item.ubeeqCollectionId === req.params.ubeeqCollectionId);
    if (!collection) return res.status(404).json({ message: `${brand.productName} collection not found` });
    const visibility = req.body?.visibility === 'public' || req.body?.visibility === 'unlisted' || req.body?.visibility === 'private'
      ? req.body.visibility
      : collection.visibility;
    const collectionType = req.body?.collectionType === 'gallery' || req.body?.collectionType === 'series' || req.body?.collectionType === 'collection'
      ? req.body.collectionType
      : collection.collectionType;
    const updated: UbeeqCollection = {
      ...collection,
      visibility,
      collectionType,
      updatedAt: new Date().toISOString()
    };
    await store.updateUbeeqCollection(updated);
    return res.json(updated);
  });

  app.put('/studio/integrations/collections/:ubeeqCollectionId/assets', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.body?.creatorIdentityId === 'string' ? req.body.creatorIdentityId.trim() : '';
    if (!(await ensureCreatorAccountAccess(req, res, creatorIdentityId))) return;
    const collection = (await store.listUbeeqCollectionsByCreatorIdentity(creatorIdentityId))
      .find((item) => item.ubeeqCollectionId === req.params.ubeeqCollectionId);
    if (!collection) return res.status(404).json({ message: `${brand.productName} collection not found` });
    const rawAssetIds: unknown[] = Array.isArray(req.body?.assetIds) ? req.body.assetIds as unknown[] : [];
    const assetIds: string[] = [...new Set(rawAssetIds
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean))];
    const assets = await Promise.all(assetIds.map((assetId) => store.getAsset(assetId)));
    if (assets.some((asset) => !asset || asset.creatorIdentityId !== creatorIdentityId)) {
      return res.status(400).json({ message: 'Choose works owned by this creator.' });
    }
    const now = new Date().toISOString();
    const existingAssets = await store.listUbeeqCollectionAssets(collection.ubeeqCollectionId);
    const existingByAssetId = new Map(existingAssets.map((item) => [item.assetId, item]));
    const manuallyAssignedAssetIds = new Set(assetIds);
    const nextAssets = new Map<string, UbeeqCollectionAsset>();
    for (const existing of existingAssets) {
      const externalCollectionMappingIds = existing.externalCollectionMappingIds || [];
      if (externalCollectionMappingIds.length || manuallyAssignedAssetIds.has(existing.assetId)) {
        nextAssets.set(existing.assetId, {
          ...existing,
          manuallyAssigned: manuallyAssignedAssetIds.has(existing.assetId),
          externalCollectionMappingIds,
          updatedAt: now
        });
      }
    }
    for (const assetId of assetIds) {
      const existing = existingByAssetId.get(assetId);
      nextAssets.set(assetId, {
        ubeeqCollectionId: collection.ubeeqCollectionId,
        assetId,
        userId: req.authUser!.userId,
        creatorIdentityId,
        manuallyAssigned: true,
        externalCollectionMappingIds: existing?.externalCollectionMappingIds || [],
        createdAt: existing?.createdAt || now,
        updatedAt: now
      });
    }
    await store.replaceUbeeqCollectionAssets(collection.ubeeqCollectionId, [...nextAssets.values()]);
    return res.json({ ubeeqCollectionId: collection.ubeeqCollectionId, assetIds });
  });

  app.put('/studio/integrations/deviantart/collection-mappings/:externalCollectionId', requireAuth, async (req, res) => {
    const externalAccountId = typeof req.body?.externalAccountId === 'string' ? req.body.externalAccountId.trim() : '';
    const ubeeqCollectionId = typeof req.body?.ubeeqCollectionId === 'string' ? req.body.ubeeqCollectionId.trim() : '';
    const account = await store.getExternalAccount(externalAccountId);
    if (!account || account.platform !== 'deviantart') return res.status(404).json({ message: 'DeviantArt account not found' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    const assignmentCreatorIds = (await store.listExternalAccountCreatorAssignments(account.externalAccountId))
      .map((assignment) => assignment.creatorIdentityId);
    const creatorIdentityIds = assignmentCreatorIds.length
      ? assignmentCreatorIds
      : [account.primaryCreatorIdentityId || account.creatorIdentityId].filter((item): item is string => Boolean(item));
    const [externalCollections, collectionGroups, mappings] = await Promise.all([
      store.listExternalCollections(externalAccountId),
      Promise.all(creatorIdentityIds.map((creatorIdentityId) => store.listUbeeqCollectionsByCreatorIdentity(creatorIdentityId))),
      store.listExternalCollectionMappings(externalAccountId)
    ]);
    const ubeeqCollections = collectionGroups.flat();
    const externalCollection = externalCollections.find((item) => item.externalCollectionId === req.params.externalCollectionId);
    const ubeeqCollection = ubeeqCollections.find((item) => item.ubeeqCollectionId === ubeeqCollectionId);
    if (!externalCollection || !ubeeqCollection) return res.status(400).json({ message: 'Choose a collection owned by an assigned creator.' });
    const now = new Date().toISOString();
    const existing = mappings.find((item) => item.externalCollectionId === externalCollection.externalCollectionId);
    const syncMode = req.body?.syncMode === 'continuous' || req.body?.syncMode === 'initial_only' || req.body?.syncMode === 'manual' || req.body?.syncMode === 'ignored'
      ? req.body.syncMode
      : 'manual';
    const mappingTargetChanged = Boolean(existing && existing.ubeeqCollectionId !== ubeeqCollectionId);
    const mappingModeChanged = Boolean(existing && existing.syncMode !== syncMode);
    const mapping: ExternalCollectionMapping = {
      ...existing,
      externalCollectionMappingId: existing?.externalCollectionMappingId || randomUUID(),
      externalAccountId,
      externalCollectionId: externalCollection.externalCollectionId,
      ubeeqCollectionId,
      syncMode,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (mappingTargetChanged || mappingModeChanged) {
      mapping.lastMembershipSyncAt = undefined;
      mapping.lastMembershipFingerprint = undefined;
      mapping.lastMembershipCount = undefined;
      mapping.lastMembershipError = undefined;
    }
    if (existing && (existing.ubeeqCollectionId !== ubeeqCollectionId || syncMode === 'manual' || syncMode === 'ignored')) {
      const previousAssets = await store.listUbeeqCollectionAssets(existing.ubeeqCollectionId);
      const nextPreviousAssets = previousAssets.map((item) => ({
        ...item,
        manuallyAssigned: syncMode === 'manual' && (item.externalCollectionMappingIds || []).includes(existing.externalCollectionMappingId)
          ? true
          : item.manuallyAssigned,
        externalCollectionMappingIds: (item.externalCollectionMappingIds || []).filter((mappingId) => mappingId !== existing.externalCollectionMappingId),
        updatedAt: now
      })).filter((item) => item.manuallyAssigned || (item.externalCollectionMappingIds || []).length);
      await store.replaceUbeeqCollectionAssets(existing.ubeeqCollectionId, nextPreviousAssets);
    }
    if (existing) await store.updateExternalCollectionMapping(mapping);
    else await store.createExternalCollectionMapping(mapping);
    let syncJob: ExternalSyncJob | undefined;
    if (syncMode === 'continuous' || (syncMode === 'initial_only' && !mapping.lastMembershipSyncAt)) {
      try {
        syncJob = await enqueueExternalSyncJob(account.externalAccountId, 'full_reconciliation', { reason: 'gallery_mapping_updated' });
      } catch (error) {
        logServerError('deviantart.gallery-mapping.enqueue', error);
      }
    }
    return res.json({ ...mapping, syncJobId: syncJob?.externalSyncJobId });
  });

  app.get('/studio/integrations/activity/works/:assetId', requireAuth, async (req, res) => {
    const asset = await store.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, asset.creatorIdentityId))) return;
    const accounts = (await store.listExternalAccountsByUser(req.authUser!.userId))
      .filter((account) => account.connectionStatus !== 'disabled');
    const accountById = new Map(accounts.map((account) => [account.externalAccountId, account]));
    const publications = (await Promise.all(accounts.map((account) => store.listExternalPublications(account.externalAccountId))))
      .flat()
      .filter((publication) => publication.assetId === asset.assetId);
    const destinations = await Promise.all(publications.map(async (publication) => {
      const [engagement, comments, favourites, activities] = await Promise.all([
        store.getExternalEngagementCurrent(publication.externalPublicationId),
        store.listExternalComments(publication.externalPublicationId, 500),
        store.listExternalFavourites(publication.externalPublicationId, 500),
        store.listExternalActivitiesByPublication(publication.externalPublicationId, 500)
      ]);
      const account = accountById.get(publication.externalAccountId);
      const { rawMetadataJson: _rawMetadataJson, ...publicationResponse } = publication;
      return {
        publication: { ...publicationResponse, externalUsername: account?.externalUsername || '' },
        account: account ? toExternalAccountResponse(account) : undefined,
        engagement,
        comments: comments.map(({ rawPayload: _rawPayload, ...comment }) => comment),
        favourites: favourites.map(({ rawPayload: _rawPayload, ...favourite }) => favourite),
        activities: activities.map(({ rawPayload: _rawPayload, ...activity }) => activity),
        capabilities: {
          reply: publication.syncStatus === 'active',
          remoteCommentModeration: false,
          remoteCommentModerationReason: 'DeviantArt’s public API supports posting replies but does not expose comment hide or delete operations.'
        }
      };
    }));
    return res.json({ asset, destinations });
  });

  app.post('/studio/integrations/activity/works/:assetId/sync', requireAuth, async (req, res) => {
    const asset = await store.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ message: 'Work not found' });
    if (!(await ensureCreatorContentAccess(req, res, asset.creatorIdentityId))) return;
    const accounts = (await store.listExternalAccountsByUser(req.authUser!.userId))
      .filter((account) => account.connectionStatus !== 'disabled');
    const publications = (await Promise.all(accounts.map((account) => store.listExternalPublications(account.externalAccountId))))
      .flat()
      .filter((publication) => publication.assetId === asset.assetId && publication.syncStatus === 'active');
    const jobs: ExternalSyncJob[] = [];
    for (const publication of publications) {
      jobs.push(await enqueueExternalSyncJob(publication.externalAccountId, 'engagement_sync', {
        externalContentId: publication.externalContentId
      }));
    }
    for (const externalAccountId of [...new Set(publications.map((publication) => publication.externalAccountId))]) {
      jobs.push(await enqueueExternalSyncJob(externalAccountId, 'activity_sync'));
    }
    return res.status(202).json({ jobs });
  });

  app.get('/studio/integrations/activity', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.query.creatorId === 'string' ? req.query.creatorId.trim() : '';
    if (!(await ensureCreatorContentAccess(req, res, creatorIdentityId))) return;
    const accounts = await store.listExternalAccountsByCreatorIdentity(creatorIdentityId);
    const requestedAccountId = typeof req.query.accountId === 'string' ? req.query.accountId.trim() : '';
    const requestedType = typeof req.query.type === 'string' ? req.query.type.trim() : '';
    const requestedStatus = req.query.status === 'read' || req.query.status === 'unread' || req.query.status === 'dismissed'
      ? req.query.status
      : 'all';
    const limit = Math.max(1, Math.min(100, Math.floor(Number(req.query.limit || 50)) || 50));
    const offset = Math.max(0, Math.floor(Number(req.query.cursor || 0)) || 0);
    const accountById = new Map(accounts.map((account) => [account.externalAccountId, account]));
    const [activityLists, publicationLists, watcherCheckpoints, profiles] = await Promise.all([
      Promise.all(accounts.map((account) => store.listExternalActivitiesByAccount(account.externalAccountId, 1000))),
      Promise.all(accounts.map((account) => store.listExternalPublications(account.externalAccountId))),
      Promise.all(accounts.map((account) => store.getExternalSyncCheckpoint(account.externalAccountId, 'watchers', account.externalAccountId))),
      Promise.all(accounts.map((account) => store.getExternalAccountProfile(account.externalAccountId)))
    ]);
    const publications = publicationLists.flat();
    const publicationById = new Map(publications.map((publication) => [publication.externalPublicationId, publication]));
    const allItems = activityLists
      .flat()
      .filter((activity) => !activity.creatorIdentityId || activity.creatorIdentityId === creatorIdentityId)
      .filter((activity) => !requestedAccountId || activity.externalAccountId === requestedAccountId)
      .filter((activity) => !requestedType || requestedType === 'all' || activity.type === requestedType)
      .filter((activity) => (
        requestedStatus === 'all'
        || (requestedStatus === 'read' && Boolean(activity.readAt) && !activity.remoteDeletedAt)
        || (requestedStatus === 'unread' && !activity.readAt && !activity.remoteDeletedAt)
        || (requestedStatus === 'dismissed' && Boolean(activity.remoteDeletedAt))
      ))
      .sort((left, right) => (right.occurredAt || right.firstSeenAt).localeCompare(left.occurredAt || left.firstSeenAt));
    const items = allItems.slice(offset, offset + limit);
    const assetIds = [...new Set(items.map((activity) => {
      const publication = activity.externalPublicationId
        ? publicationById.get(activity.externalPublicationId)
        : undefined;
      return activity.assetId || publication?.assetId;
    }).filter((assetId): assetId is string => Boolean(assetId)))];
    const [assetPairs, spacePublicationPairs] = await Promise.all([
      Promise.all(assetIds.map(async (assetId) => [assetId, await store.getAsset(assetId)] as const)),
      Promise.all(assetIds.map(async (assetId) => [assetId, await store.getSpacePublication(assetId)] as const))
    ]);
    const assetById = new Map(assetPairs);
    const spacePublicationByAssetId = new Map(spacePublicationPairs);
    const localOrigin = `${req.protocol}://${req.get('host')}`;
    const hostedThumbnailPairs = await Promise.all(assetIds.map(async (assetId) => {
      const spacePublication = spacePublicationByAssetId.get(assetId);
      const objectKey = spacePublication?.contentSyncStatus === 'hosted'
        ? spacePublication.hostedThumbnailObjectKey || spacePublication.hostedObjectKey
        : undefined;
      return [assetId, await publicMediaUrl(objectKey, localOrigin)] as const;
    }));
    const hostedThumbnailByAssetId = new Map(hostedThumbnailPairs);
    const remotePreviewUrl = (publication?: ExternalPublication): string | undefined => {
      if (!publication?.rawMetadataJson || typeof publication.rawMetadataJson !== 'object') return undefined;
      const metadata = publication.rawMetadataJson as Record<string, unknown>;
      const thumbnails = Array.isArray(metadata.thumbs)
        ? metadata.thumbs
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
          .filter((item) => typeof item.src === 'string')
          .sort((left, right) => {
            const leftArea = Number(left.width || 0) * Number(left.height || 0);
            const rightArea = Number(right.width || 0) * Number(right.height || 0);
            return rightArea - leftArea;
          })
        : [];
      if (thumbnails.length) return thumbnails[0].src as string;
      for (const key of ['preview', 'content']) {
        const value = metadata[key];
        if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).src === 'string') {
          return (value as Record<string, unknown>).src as string;
        }
      }
      return undefined;
    };
    return res.json({
      accounts: accounts.map((account, index) => {
        const profile = profiles[index];
        const { rawPayload: _rawPayload, profileFingerprint: _profileFingerprint, ...profileResponse } = profile || {};
        return {
          externalAccountId: account.externalAccountId,
          platform: account.platform,
          externalUsername: account.externalUsername,
          watchers: watcherCheckpoints[index]?.summary,
          watchersLastSyncedAt: watcherCheckpoints[index]?.lastSuccessfulSyncAt,
          profile: profile ? profileResponse : undefined
        };
      }),
      items: items.map(({ rawPayload: _rawPayload, ...activity }) => {
        const account = accountById.get(activity.externalAccountId);
        const publication = (activity.externalPublicationId
          ? publicationById.get(activity.externalPublicationId)
          : undefined) || publications.find((candidate) => (
          candidate.externalAccountId === activity.externalAccountId
            && candidate.assetId === activity.assetId
        ));
        const assetId = activity.assetId || publication?.assetId;
        const asset = assetId ? assetById.get(assetId) : undefined;
        return {
          ...activity,
          account: account ? {
            externalAccountId: account.externalAccountId,
            platform: account.platform,
            externalUserId: account.externalUserId,
            externalUsername: account.externalUsername
          } : undefined,
          work: asset && assetId ? {
            assetId,
            title: asset.canonicalTitle || publication?.externalTitle || 'Untitled work',
            assetType: asset.assetType,
            thumbnailUrl: asset.assetType === 'image'
              ? hostedThumbnailByAssetId.get(assetId) || remotePreviewUrl(publication)
              : undefined,
            externalUrl: publication?.externalUrl
          } : undefined
        };
      }),
      total: allItems.length,
      nextCursor: offset + limit < allItems.length ? String(offset + limit) : undefined
    });
  });

  app.post('/studio/integrations/activity/sync', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    if (!(await ensureCreatorContentAccess(req, res, creatorIdentityId))) return;
    const accounts = (await store.listExternalAccountsByCreatorIdentity(creatorIdentityId))
      .filter((account) => account.connectionStatus === 'connected');
    const jobs = await Promise.all(accounts.map((account) => enqueueExternalSyncJob(account.externalAccountId, 'activity_sync')));
    return res.status(202).json({ jobs });
  });

  app.patch('/studio/integrations/activity/accounts/:externalAccountId/:remoteActivityId', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account) return res.status(404).json({ message: 'Connected account not found' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this connected account.' });
    const activity = await store.getExternalActivityByRemoteId(account.externalAccountId, req.params.remoteActivityId);
    if (!activity) return res.status(404).json({ message: 'Activity not found' });
    const now = new Date().toISOString();
    const updated = { ...activity, readAt: req.body?.read === false ? undefined : now, updatedAt: now };
    await store.upsertExternalActivity(updated);
    const { rawPayload: _rawPayload, ...response } = updated;
    return res.json(response);
  });

  app.patch('/studio/integrations/activity/bulk', requireAuth, async (req, res) => {
    const creatorIdentityId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    if (!(await ensureCreatorContentAccess(req, res, creatorIdentityId))) return;
    const activityIds = new Set((Array.isArray(req.body?.activityIds) ? req.body.activityIds : [])
      .filter((activityId: unknown): activityId is string => typeof activityId === 'string' && Boolean(activityId.trim())));
    if (!activityIds.size) return res.status(400).json({ message: 'Choose at least one activity item.' });
    const accounts = await store.listExternalAccountsByCreatorIdentity(creatorIdentityId);
    const now = new Date().toISOString();
    const read = req.body?.read !== false;
    let updated = 0;
    for (const account of accounts) {
      const activities = await store.listExternalActivitiesByAccount(account.externalAccountId, 1000);
      for (const activity of activities) {
        if (!activityIds.has(activity.externalActivityId)) continue;
        await store.upsertExternalActivity({ ...activity, readAt: read ? now : undefined, updatedAt: now });
        updated += 1;
      }
    }
    return res.json({ updated, read });
  });

  app.post('/studio/integrations/activity/accounts/:externalAccountId/:remoteActivityId/dismiss', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'deviantart') return res.status(404).json({ message: 'DeviantArt account not found' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    const activity = await store.getExternalActivityByRemoteId(account.externalAccountId, req.params.remoteActivityId);
    if (!activity) return res.status(404).json({ message: 'Activity not found' });
    try {
      const updated = await dismissExternalActivity(store, config, account, activity, req.body?.stack === true);
      const { rawPayload: _rawPayload, ...response } = updated;
      return res.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to dismiss this DeviantArt notification.';
      if (error instanceof ExternalProviderError && error.code === 'unsupported') return res.status(409).json({ message });
      if (error instanceof ExternalProviderError && error.code === 'authentication_required') return res.status(409).json({ message: 'Reconnect DeviantArt before dismissing notifications.' });
      if (error instanceof ExternalProviderError && error.code === 'rate_limited') return res.status(429).json({ message });
      return res.status(502).json({ message });
    }
  });

  app.get('/studio/integrations/deviantart/accounts/:externalAccountId/publications/:externalContentId/comments', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'deviantart') return res.status(404).json({ message: 'DeviantArt account not found' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    const publication = await store.getExternalPublication(account.externalAccountId, req.params.externalContentId);
    if (!publication) return res.status(404).json({ message: 'Publication not found' });
    return res.json(await store.listExternalComments(publication.externalPublicationId, 100));
  });

  app.post('/studio/integrations/deviantart/accounts/:externalAccountId/publications/:externalContentId/comments/sync', requireAuth, async (req, res) => {
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'deviantart') return res.status(404).json({ message: 'DeviantArt account not found' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    const publication = await store.getExternalPublication(account.externalAccountId, req.params.externalContentId);
    if (!publication || publication.syncStatus !== 'active') return res.status(404).json({ message: 'Published DeviantArt work not found' });
    const job = await enqueueExternalSyncJob(account.externalAccountId, 'comment_sync', { externalContentId: publication.externalContentId });
    return res.status(202).json(job);
  });

  app.post('/studio/integrations/deviantart/accounts/:externalAccountId/publications/:externalContentId/comments/:externalCommentId/reply', requireAuth, async (req, res) => {
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ message: 'A reply cannot be empty.' });
    const account = await store.getExternalAccount(req.params.externalAccountId);
    if (!account || account.platform !== 'deviantart') return res.status(404).json({ message: 'DeviantArt account not found' });
    if (account.userId !== req.authUser!.userId) return res.status(403).json({ message: 'You do not control this DeviantArt connection.' });
    const publication = await store.getExternalPublication(account.externalAccountId, req.params.externalContentId);
    if (!publication || publication.syncStatus !== 'active') return res.status(404).json({ message: 'Published DeviantArt work not found' });
    const parent = (await store.listExternalComments(publication.externalPublicationId, 500))
      .find((comment) => comment.externalCommentExternalId === req.params.externalCommentId);
    if (!parent) return res.status(404).json({ message: 'The DeviantArt comment has not been synchronized yet.' });
    try {
      const comment = await replyToExternalComment(store, config, account, publication, body, parent.externalCommentExternalId);
      return res.status(201).json(comment);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to post the DeviantArt reply.';
      if (error instanceof ExternalProviderError && error.code === 'authentication_required') return res.status(409).json({ message: 'DeviantArt needs to be reconnected before you can reply.' });
      if (error instanceof ExternalProviderError && error.code === 'rate_limited') return res.status(429).json({ message });
      return res.status(502).json({ message });
    }
  });

  app.post('/studio/creators', requireAuth, async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ message: `A ${brand.workspaceName} name is required.` });
    const slug = slugify(String(req.body?.slug || name || randomUUID().slice(0, 8)));
    const creators = await store.listCreators();
    const conflictName = creators.find((item) => creatorMatchesName(item, name));
    if (conflictName) {
      const nameSuggestions = buildCreatorNameSuggestions(creators, name);
      return res.status(409).json({
        message: 'Creator name is already taken.',
        name,
        nameSuggestions,
        // Keep the name and handle pills paired. A name alternative therefore
        // selects an available derived handle before a creator edits either.
        slugSuggestions: [...new Set([
          ...nameSuggestions.map(slugify),
          ...buildCreatorSlugSuggestions(creators, slug)
        ])].slice(0, 8)
      });
    }
    const conflict = creators.find((item) => creatorMatchesSlug(item, slug));
    if (conflict) {
      return res.status(409).json({
        message: 'Creator slug is already taken.',
        slug,
        slugSuggestions: buildCreatorSlugSuggestions(creators, slug)
      });
    }

    const creator: Creator = {
      creatorId: randomUUID(),
      name,
      slug,
      visibleIntegrations: req.body?.visibleIntegrations !== undefined
        ? parseStringArray(req.body.visibleIntegrations)
        : ['deviantart', 'bluesky'],
      spaceTier: 'free',
      slugHistory: uniqueSlugs([slug]),
      defaultProfileTab: req.body?.defaultProfileTab === 'groupings' ? 'groupings' : 'feed',
      featuredItemIds: parseStringArray(req.body?.featuredItemIds),
      featuredGroupingIds: parseStringArray(req.body?.featuredGroupingIds),
      discoverSquareCropEnabled: typeof req.body?.discoverSquareCropEnabled === 'boolean'
        ? req.body.discoverSquareCropEnabled
        : true,
      defaultAiDisclosure: parseOptionalAiDisclosure(req.body?.defaultAiDisclosure) || 'none',
      defaultHeavyTopics: parseOptionalHeavyTopics(req.body?.defaultHeavyTopics) || [],
      space: req.body?.space && typeof req.body.space === 'object' ? {
        bio: sanitizeLimitedRichText(req.body.space.bio, 5000),
        externalLinks: parseCreatorExternalLinks(req.body.space.externalLinks),
        theme: parseCreatorSpaceTheme(req.body.space.theme),
        coverPreset: parseCreatorCoverPreset(req.body.space.coverPreset),
        visibility: parseCreatorSpaceVisibility(req.body.space.visibility),
        shareCode: parseCreatorShareCode(req.body.space.shareCode),
        showOnMemberProfile: req.body.space.showOnMemberProfile === true,
      } : undefined,
      status: req.body?.status === 'inactive' ? 'inactive' : 'active',
      sortOrder: Number(req.body?.sortOrder || 0),
      createdAt: new Date().toISOString()
    };
    await store.createCreator(creator);
    await store.addCreatorMember({
      creatorId: creator.creatorId,
      userId: req.authUser!.userId,
      role: 'owner',
      invitedByUserId: req.authUser!.userId,
      createdAt: new Date().toISOString()
    });
    return res.status(201).json(creator);
  });

  app.put('/studio/creators/:creatorId/approved-tier', requireAdmin, async (req, res) => {
    const creators = await store.listCreators();
    const existing = creators.find((creator) => creator.creatorId === req.params.creatorId);
    if (!existing) return res.status(404).json({ message: 'Creator not found' });
    const approved = Boolean(req.body?.approved);
    const updated: Creator = {
      ...existing,
      spaceTier: approved ? 'approved' : 'free',
      approvedCreatorAt: approved ? (existing.approvedCreatorAt || new Date().toISOString()) : undefined
    };
    await store.updateCreator(updated);
    auditLog(req, 'creator.approved_tier.updated', { creatorId: updated.creatorId, approved });
    return res.json(updated);
  });

  app.get('/studio/files', requireAuth, async (req, res) => {
    return res.json(await listVisibleCreatorFiles(req));
  });

  app.post('/studio/files', requireAuth, async (req, res) => {
    const creatorId = typeof req.body?.creatorId === 'string'
      ? req.body.creatorId
      : (typeof req.body?.creatorId === 'string' ? req.body.creatorId : '');
    if (!creatorId) return res.status(400).json({ message: 'creatorId is required' });
    if (!(await ensureCreatorContentAccess(req, res, creatorId))) return;
    if (!store.createSourceFile) return res.status(503).json({ message: 'File service unavailable' });
    const now = new Date().toISOString();
    const file: SourceFile = {
      fileId: randomUUID(),
      creatorId,
      sourceKind: req.body?.sourceKind === 'video' || req.body?.sourceKind === 'audio' || req.body?.sourceKind === 'document' || req.body?.sourceKind === 'archive'
        ? req.body.sourceKind
        : 'image',
      mimeType: typeof req.body?.mimeType === 'string' && req.body.mimeType.trim() ? req.body.mimeType.trim() : 'application/octet-stream',
      storageKey: typeof req.body?.storageKey === 'string' && req.body.storageKey.trim() ? req.body.storageKey.trim() : `uploads/${randomUUID()}`,
      originalFilename: sanitizeOptional(req.body?.originalFilename, 255),
      sizeBytes: Number.isFinite(Number(req.body?.sizeBytes)) ? Math.max(0, Number(req.body.sizeBytes)) : undefined,
      metadata: req.body?.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
        ? req.body.metadata as Record<string, string | number | boolean | null>
        : undefined,
      downloadable: req.body?.downloadable === undefined ? true : Boolean(req.body.downloadable),
      premium: Boolean(req.body?.premium),
      restricted: Boolean(req.body?.restricted),
      createdAt: now,
      updatedAt: now
    };
    await store.createSourceFile(file);
    return res.status(201).json(file);
  });

  app.get('/studio/groupings', requireAuth, async (req, res) => {
    return res.json(await listVisibleCreatorGroupings(req));
  });

  app.get('/studio/posts', requireAuth, async (req, res) => {
    const requestedCreatorId = typeof req.query.creatorId === 'string'
      ? req.query.creatorId.trim()
      : '';
    if (requestedCreatorId && !(await ensureCreatorContentAccess(req, res, requestedCreatorId))) return;
    return res.json(await listVisibleCreatorPosts(req, requestedCreatorId));
  });

  app.get('/studio/challenges', requireAuth, async (req, res) => {
    const contexts = store.listContributionContexts ? await store.listContributionContexts() : [];
    const challengeContexts = contexts.filter((context) => context.type === 'challenge');
    if (isAdminRequest(req)) return res.json(challengeContexts);
    return res.json(challengeContexts.filter((context) => context.status === 'active' || context.status === 'closed'));
  });

  app.get('/studio/entries', requireAuth, async (req, res) => {
    const entries = await listCreatorSubmissions(req);
    return res.json(entries.map((entry) => ({
      ...entry,
      promotionOutcome: entry.status === 'approved' ? 'contributor' : 'none'
    })));
  });

  app.get('/studio/users', requireAuth, async (req, res) => {
    const profiles = store.listUserProfiles ? await store.listUserProfiles() : [];
    const identities = store.listUserIdentities ? await store.listUserIdentities() : [];
    const identityByUserId = new Map(identities.map((identity) => [identity.userId, identity]));
    if (!isAdminRequest(req)) {
      const currentProfile = profiles.find((profile) => profile.userId === req.authUser!.userId)
        || await store.getUserProfile(req.authUser!.userId);
      const currentIdentity = identityByUserId.get(req.authUser!.userId);
      return res.json(currentProfile ? [{
        ...currentProfile,
        role: currentIdentity?.role || 'user',
        isBeeker: Boolean(currentIdentity?.isBeeker),
        managedCreatorCount: (await store.listCreatorsByUserId(req.authUser!.userId)).length
      }] : []);
    }

    const users = await Promise.all(profiles.map(async (profile) => ({
      ...profile,
      role: identityByUserId.get(profile.userId)?.role || 'user',
      isBeeker: Boolean(identityByUserId.get(profile.userId)?.isBeeker),
      managedCreatorCount: (await store.listCreatorsByUserId(profile.userId)).length
    })));
    return res.json(users);
  });

  app.get('/studio/operations/audit', requireAdmin, async (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 100)));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const actionFilter = typeof req.query.action === 'string' ? req.query.action : undefined;
    const actorUserIdFilter = typeof req.query.actorUserId === 'string' ? req.query.actorUserId : undefined;
    const page = await store.listAuditEvents(limit, cursor);
    const items = page.items.filter((event) => {
      if (actionFilter && event.action !== actionFilter) return false;
      if (actorUserIdFilter && event.actorUserId !== actorUserIdFilter) return false;
      return true;
    });
    return res.json({
      items,
      nextCursor: page.nextCursor
    });
  });

  app.get('/studio/creators/:creatorId/members', requireAuth, async (req, res) => {
    if (!(await ensureCreatorContentAccess(req, res, req.params.creatorId))) {
      return;
    }
    const members = await store.listCreatorMembers(req.params.creatorId);
    return res.json(members);
  });

  app.post('/studio/creators/:creatorId/members', requireAuth, async (req, res) => {
    if (!(await ensureCreatorAccountAccess(req, res, req.params.creatorId))) {
      return;
    }
    const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    const role = req.body?.role === 'owner' || req.body?.role === 'manager' || req.body?.role === 'editor'
      ? req.body.role
      : 'editor';
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }
    const member: CreatorMember = {
      creatorId: req.params.creatorId,
      userId,
      role,
      invitedByUserId: req.authUser!.userId,
      createdAt: new Date().toISOString()
    };
    await store.addCreatorMember(member);
    return res.status(201).json(member);
  });

  app.delete('/studio/creators/:creatorId/members/:userId', requireAuth, async (req, res) => {
    if (!(await ensureCreatorAccountAccess(req, res, req.params.creatorId))) {
      return;
    }
    await store.removeCreatorMember(req.params.creatorId, req.params.userId);
    return res.status(204).send();
  });

  app.patch('/studio/creators/:creatorId', requireAuth, async (req, res) => {
    if (!(await ensureCreatorAccountAccess(req, res, req.params.creatorId))) {
      return;
    }
    const creators = await store.listCreators();
    const existing = creators.find((creator) => creator.creatorId === req.params.creatorId);
    if (!existing) {
      return res.status(404).json({ message: 'Creator not found' });
    }

    const nextName = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
    if (!nextName) {
      return res.status(400).json({ message: 'Creator name is required.' });
    }
    const conflictName = creators.find((creator) => (
      creator.creatorId !== existing.creatorId && creatorMatchesName(creator, nextName)
    ));
    if (conflictName) {
      const nameSuggestions = buildCreatorNameSuggestions(creators, nextName, existing.creatorId);
      return res.status(409).json({
        message: 'Creator name is already taken.',
        name: nextName,
        nameSuggestions,
        slugSuggestions: [...new Set([
          ...nameSuggestions.map(slugify),
          ...buildCreatorSlugSuggestions(creators, req.body?.slug ? String(req.body.slug) : existing.slug, existing.creatorId)
        ])].slice(0, 8)
      });
    }

    const nextSlug = req.body?.slug ? slugify(String(req.body.slug)) : existing.slug;
    const nextSlugHistory = uniqueSlugs([...(existing.slugHistory || [existing.slug]), nextSlug]);
    const conflictSlug = nextSlugHistory.find((slug) =>
      creators.some((item) => item.creatorId !== existing.creatorId && creatorMatchesSlug(item, slug))
    );
    if (conflictSlug) {
      return res.status(409).json({
        message: 'Creator slug is already taken.',
        slug: conflictSlug,
        slugSuggestions: buildCreatorSlugSuggestions(creators, nextSlug, existing.creatorId)
      });
    }

    const requestedFeaturedItemIds = req.body?.featuredItemIds !== undefined
      ? parseStringArray(req.body.featuredItemIds)
      : undefined;
    if (requestedFeaturedItemIds) {
      const creator = new Set((await store.listMediaByCreator(existing.creatorId)).map((item) => item.mediaId));
      const invalid = requestedFeaturedItemIds.find((itemId) => !creator.has(itemId));
      if (invalid) {
        return res.status(400).json({ message: `featuredItemId does not belong to creator: ${invalid}` });
      }
    }
    const requestedFeaturedGroupingIds = req.body?.featuredGroupingIds !== undefined
      ? parseStringArray(req.body.featuredGroupingIds)
      : undefined;
    if (requestedFeaturedGroupingIds) {
      const creator = new Set((await store.listAllGroupings()).filter((item) => item.creatorId === existing.creatorId).map((item) => item.groupingId));
      const invalid = requestedFeaturedGroupingIds.find((groupingId) => !creator.has(groupingId));
      if (invalid) {
        return res.status(400).json({ message: `featuredGroupingId does not belong to creator: ${invalid}` });
      }
    }

    const updated: Creator = {
      ...existing,
      name: nextName,
      slug: nextSlug,
      visibleIntegrations: req.body?.visibleIntegrations !== undefined
        ? parseStringArray(req.body.visibleIntegrations)
        : (existing.visibleIntegrations || ['deviantart', 'bluesky']),
      slugHistory: nextSlugHistory,
      defaultProfileTab: req.body?.defaultProfileTab === 'groupings'
        ? 'groupings'
        : (req.body?.defaultProfileTab === 'feed' ? 'feed' : (existing.defaultProfileTab === 'groupings' ? 'groupings' : 'feed')),
      featuredItemIds: req.body?.featuredItemIds !== undefined
        ? (requestedFeaturedItemIds || [])
        : (existing.featuredItemIds || []),
      featuredGroupingIds: req.body?.featuredGroupingIds !== undefined
        ? (requestedFeaturedGroupingIds || [])
        : (existing.featuredGroupingIds || []),
      discoverSquareCropEnabled: typeof req.body?.discoverSquareCropEnabled === 'boolean'
        ? req.body.discoverSquareCropEnabled
        : (existing.discoverSquareCropEnabled ?? true),
      defaultAiDisclosure: req.body?.defaultAiDisclosure !== undefined
        ? (parseOptionalAiDisclosure(req.body.defaultAiDisclosure) || 'none')
        : normalizeAiDisclosure(existing.defaultAiDisclosure),
      defaultHeavyTopics: req.body?.defaultHeavyTopics !== undefined
        ? (parseOptionalHeavyTopics(req.body.defaultHeavyTopics) || [])
        : normalizeHeavyTopics(existing.defaultHeavyTopics),
      space: req.body?.space && typeof req.body.space === 'object' ? {
        bio: req.body.space.bio !== undefined ? sanitizeLimitedRichText(req.body.space.bio, 5000) : existing.space?.bio,
        externalLinks: req.body.space.externalLinks !== undefined ? parseCreatorExternalLinks(req.body.space.externalLinks) : (existing.space?.externalLinks || []),
        theme: req.body.space.theme !== undefined ? parseCreatorSpaceTheme(req.body.space.theme) : (existing.space?.theme || 'default'),
        announcement: req.body.space.announcement !== undefined ? req.body.space.announcement : existing.space?.announcement,
        coverPreset: req.body.space.coverPreset !== undefined ? parseCreatorCoverPreset(req.body.space.coverPreset) : existing.space?.coverPreset,
        visibility: req.body.space.visibility !== undefined ? parseCreatorSpaceVisibility(req.body.space.visibility) : (existing.space?.visibility || 'public-discoverable'),
        shareCode: req.body.space.shareCode !== undefined ? parseCreatorShareCode(req.body.space.shareCode) : existing.space?.shareCode,
        showOnMemberProfile: req.body.space.showOnMemberProfile !== undefined
          ? req.body.space.showOnMemberProfile === true
          : existing.space?.showOnMemberProfile === true,
      } : existing.space,
      status: req.body?.status === 'inactive' ? 'inactive' : (req.body?.status === 'active' ? 'active' : existing.status),
      sortOrder: req.body?.sortOrder !== undefined ? Number(req.body.sortOrder) : existing.sortOrder
    };

    await store.updateCreator(updated);
    return res.json(updated);
  });

  app.post('/studio/creators/:creatorId/branding/profile-image', requireAuth, async (req, res) => {
    if (!(await ensureCreatorAccountAccess(req, res, req.params.creatorId))) return;
    const creators = await store.listCreators();
    const existing = creators.find((creator) => creator.creatorId === req.params.creatorId);
    if (!existing) {
      return res.status(404).json({ message: 'Creator not found' });
    }
    const sourceKey = sanitizeOptional(req.body?.sourceKey, 1024);
    if (!sourceKey) return res.status(400).json({ message: 'sourceKey is required' });
    const generated = config.localMediaDirectory
      ? await generateLocalCreatorProfileRenditions({
          root: config.localMediaDirectory,
          sourceKey,
          targetPrefix: `${existing.creatorId}/branding/profile`,
          squareCrop: parseSquareCrop(req.body?.squareCrop)
        })
      : await generateCreatorProfileRenditions({
          s3: s3Client,
          bucket: config.mediaBucket,
          sourceKey,
          targetPrefix: `${existing.creatorId}/branding/profile`,
          squareCrop: parseSquareCrop(req.body?.squareCrop)
        });
    const updated: Creator = {
      ...existing,
      branding: {
        ...(existing.branding || {}),
        profileImage: {
          sourceKey: generated.sourceKey,
          thumbnailKeys: generated.thumbnailKeys,
          squareCrop: generated.squareCrop,
          altText: sanitizeOptional(req.body?.altText, 200),
          updatedAt: new Date().toISOString()
        }
      }
    };
    await store.updateCreator(updated);
    return res.status(201).json(updated.branding?.profileImage);
  });

  app.post('/studio/creators/:creatorId/branding/upload-url', requireAuth, async (req, res) => {
    if (!(await ensureCreatorAccountAccess(req, res, req.params.creatorId))) return;
    const creators = await store.listCreators();
    const existing = creators.find((creator) => creator.creatorId === req.params.creatorId);
    if (!existing) return res.status(404).json({ message: 'Creator not found' });
    const contentType = req.body?.contentType ? String(req.body.contentType) : 'image/jpeg';
    const extension = contentType.includes('png') ? 'png' : (contentType.includes('webp') ? 'webp' : 'jpg');
    const kind = req.body?.kind === 'cover' ? 'cover' : 'profile';
    const key = `${existing.creatorId}/branding/${kind}/source.${extension}`;
    if (config.localMediaDirectory) {
      return res.status(201).json({
        key,
        uploadUrl: `${req.protocol}://${req.get('host')}/studio/creators/${encodeURIComponent(existing.creatorId)}/branding/local-upload?kind=${kind}`,
        contentType,
        requiresAuth: true
      });
    }
    const uploadUrl = await getS3SignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: config.mediaBucket,
        Key: key,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable'
      }),
      { expiresIn: 300 }
    );
    return res.status(201).json({ key, uploadUrl, contentType, requiresAuth: false });
  });

  app.put('/studio/creators/:creatorId/branding/local-upload', requireAuth, express.raw({ type: 'image/*', limit: '25mb' }), async (req, res) => {
    if (!config.localMediaDirectory) return res.status(404).json({ message: 'Local media storage is not enabled.' });
    if (!(await ensureCreatorAccountAccess(req, res, req.params.creatorId))) return;
    const contentType = req.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/') || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ message: 'An image body is required.' });
    }
    const extension = contentType.includes('png') ? 'png' : (contentType.includes('webp') ? 'webp' : 'jpg');
    const kind = req.query.kind === 'cover' ? 'cover' : 'profile';
    const key = `${req.params.creatorId}/branding/${kind}/source.${extension}`;
    await writeLocalMediaSource(key, req.body);
    return res.status(201).json({ key });
  });

  app.post('/studio/creators/:creatorId/branding/cover-image', requireAuth, async (req, res) => {
    if (!(await ensureCreatorAccountAccess(req, res, req.params.creatorId))) return;
    const creators = await store.listCreators();
    const existing = creators.find((creator) => creator.creatorId === req.params.creatorId);
    if (!existing) {
      return res.status(404).json({ message: 'Creator not found' });
    }
    const sourceKey = sanitizeOptional(req.body?.sourceKey, 1024);
    if (!sourceKey) return res.status(400).json({ message: 'sourceKey is required' });
    const coverOptions = {
      sourceKey,
      targetPrefix: `${existing.creatorId}/branding/cover`,
      focalPoint: parseFocalPoint(req.body?.focalPoint),
      crops: {
        desktop: parseCoverCrop(req.body?.crops?.desktop),
        tablet: parseCoverCrop(req.body?.crops?.tablet),
        mobile: parseCoverCrop(req.body?.crops?.mobile)
      }
    };
    const generated = config.localMediaDirectory
      ? await generateLocalCreatorCoverRenditions({ root: config.localMediaDirectory, ...coverOptions })
      : await generateCreatorCoverRenditions({ s3: s3Client, bucket: config.mediaBucket, ...coverOptions });
    const updated: Creator = {
      ...existing,
      branding: {
        ...(existing.branding || {}),
        coverImage: {
          sourceKey: generated.sourceKey,
          renditionKeys: generated.renditionKeys,
          crops: generated.crops,
          focalPoint: generated.focalPoint,
          altText: sanitizeOptional(req.body?.altText, 200),
          updatedAt: new Date().toISOString()
        }
      }
    };
    await store.updateCreator(updated);
    return res.status(201).json(updated.branding?.coverImage);
  });

  app.patch('/studio/creators/:creatorId/branding', requireAuth, async (req, res) => {
    if (!(await ensureCreatorAccountAccess(req, res, req.params.creatorId))) return;
    const creators = await store.listCreators();
    const existing = creators.find((creator) => creator.creatorId === req.params.creatorId);
    if (!existing) {
      return res.status(404).json({ message: 'Creator not found' });
    }
    let updated: Creator = { ...existing, branding: { ...(existing.branding || {}) } };

    if (req.body?.profileImage !== undefined && updated.branding?.profileImage) {
      const nextCrop = parseSquareCrop(req.body?.profileImage?.squareCrop);
      if (nextCrop && updated.branding.profileImage.sourceKey) {
        const generated = await generateCreatorProfileRenditions({
          s3: s3Client,
          bucket: config.mediaBucket,
          sourceKey: updated.branding.profileImage.sourceKey,
          targetPrefix: `${existing.creatorId}/branding/profile`,
          squareCrop: nextCrop
        });
        updated.branding.profileImage.thumbnailKeys = generated.thumbnailKeys;
        updated.branding.profileImage.squareCrop = generated.squareCrop;
      }
      updated.branding.profileImage.altText = req.body.profileImage.altText !== undefined
        ? sanitizeOptional(req.body.profileImage.altText, 200)
        : updated.branding.profileImage.altText;
      updated.branding.profileImage.updatedAt = new Date().toISOString();
    }

    if (req.body?.coverImage !== undefined && updated.branding?.coverImage) {
      const nextFocalPoint = parseFocalPoint(req.body?.coverImage?.focalPoint) || updated.branding.coverImage.focalPoint;
      const nextCrops = {
        desktop: parseCoverCrop(req.body?.coverImage?.crops?.desktop) || updated.branding.coverImage.crops?.desktop,
        tablet: parseCoverCrop(req.body?.coverImage?.crops?.tablet) || updated.branding.coverImage.crops?.tablet,
        mobile: parseCoverCrop(req.body?.coverImage?.crops?.mobile) || updated.branding.coverImage.crops?.mobile
      };
      const shouldRegenerate = Boolean(
        req.body?.coverImage?.focalPoint
        || req.body?.coverImage?.crops?.desktop
        || req.body?.coverImage?.crops?.tablet
        || req.body?.coverImage?.crops?.mobile
      );
      if (shouldRegenerate && updated.branding.coverImage.sourceKey) {
        const generated = await generateCreatorCoverRenditions({
          s3: s3Client,
          bucket: config.mediaBucket,
          sourceKey: updated.branding.coverImage.sourceKey,
          targetPrefix: `${existing.creatorId}/branding/cover`,
          focalPoint: nextFocalPoint,
          crops: nextCrops
        });
        updated.branding.coverImage.renditionKeys = generated.renditionKeys;
        updated.branding.coverImage.crops = generated.crops;
        updated.branding.coverImage.focalPoint = generated.focalPoint;
      }
      updated.branding.coverImage.altText = req.body.coverImage.altText !== undefined
        ? sanitizeOptional(req.body.coverImage.altText, 200)
        : updated.branding.coverImage.altText;
      updated.branding.coverImage.updatedAt = new Date().toISOString();
    }

    await store.updateCreator(updated);
    return res.json(updated.branding || {});
  });

  app.delete('/studio/creators/:creatorId/branding/profile-image', requireAuth, async (req, res) => {
    if (!(await ensureCreatorAccountAccess(req, res, req.params.creatorId))) return;
    const creators = await store.listCreators();
    const existing = creators.find((creator) => creator.creatorId === req.params.creatorId);
    if (!existing) return res.status(404).json({ message: 'Creator not found' });
    const updated: Creator = {
      ...existing,
      branding: {
        ...(existing.branding || {}),
        profileImage: undefined
      }
    };
    await store.updateCreator(updated);
    return res.status(204).send();
  });

  app.delete('/studio/creators/:creatorId/branding/cover-image', requireAuth, async (req, res) => {
    if (!(await ensureCreatorAccountAccess(req, res, req.params.creatorId))) return;
    const creators = await store.listCreators();
    const existing = creators.find((creator) => creator.creatorId === req.params.creatorId);
    if (!existing) return res.status(404).json({ message: 'Creator not found' });
    const updated: Creator = {
      ...existing,
      branding: {
        ...(existing.branding || {}),
        coverImage: undefined
      }
    };
    await store.updateCreator(updated);
    return res.status(204).send();
  });

  app.delete('/studio/creators/:creatorId', requireAuth, async (req, res) => {
    if (!(await ensureCreatorAccountAccess(req, res, req.params.creatorId))) {
      return;
    }
    await store.deleteCreator(req.params.creatorId);
    return res.status(204).send();
  });

  app.patch('/studio/settings/site', requireAdmin, async (req, res) => {
    const current = await store.getSiteSettings();
    const requestedTheme = req.body?.theme;
    const theme: SiteSettings['theme'] =
      requestedTheme === 'ubeeq' || requestedTheme === 'sand' || requestedTheme === 'forest' || requestedTheme === 'slate'
        ? requestedTheme
        : current.theme;
    const updated: SiteSettings = {
      ...current,
      siteName: req.body?.siteName ? String(req.body.siteName) : current.siteName,
      theme,
      logoKey: req.body?.logoKey !== undefined ? (req.body.logoKey ? String(req.body.logoKey) : undefined) : current.logoKey,
      updatedAt: new Date().toISOString()
    };
    await store.updateSiteSettings(updated);
    return res.json(updated);
  });

  app.post('/studio/settings/site/logo-upload-url', requireAdmin, async (req, res) => {
    const contentType = req.body?.contentType ? String(req.body.contentType) : 'image/png';
    const extension = contentType.includes('jpeg') ? 'jpg' : (contentType.split('/')[1] || 'png');
    const key = `branding/logo-${randomUUID()}.${extension}`;
    const uploadUrl = await getS3SignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: config.mediaBucket,
        Key: key,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable'
      }),
      { expiresIn: 300 }
    );
    return res.status(201).json({ key, uploadUrl, contentType });
  });

  app.post('/studio/posts', requireAuth, async (req, res) => {
    const creator = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    if (!creator) return res.status(400).json({ message: 'creator is required' });
    if (!(await ensureCreatorContentAccess(req, res, creator))) return;
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title) return res.status(400).json({ message: 'title is required' });

    const slug = slugify(typeof req.body?.slug === 'string' && req.body.slug.trim() ? req.body.slug : title);
    const existing = await store.getPostBySlug(slug);
    if (existing) return res.status(409).json({ message: 'Post slug already exists', slug });

    const now = new Date().toISOString();
    const status = req.body?.status === 'draft' || req.body?.status === 'archived' ? req.body.status : 'published';
    const post: Post = {
      postId: randomUUID(),
      creatorId: creator,
      authorId: req.authUser?.userId,
      title,
      slug,
      slugHistory: uniqueSlugs([slug]),
      summary: sanitizeOptional(req.body?.summary, 2000),
      status,
      blocks: parsePostBlocks(req.body?.blocks),
      media: parsePostMediaRefs(req.body?.media),
      primaryMediaId: sanitizeOptional(req.body?.primaryMediaId, 128),
      discovery: {
        mode: parsePostDiscoveryMode(req.body?.discoveryMode ?? req.body?.discovery?.mode)
      },
      destination: req.body?.destination && typeof req.body.destination === 'object'
        ? {
            type: req.body.destination.type === 'pdf' || req.body.destination.type === 'external' || req.body.destination.type === 'internal'
              ? req.body.destination.type
              : 'post',
            url: typeof req.body.destination.url === 'string' ? req.body.destination.url.slice(0, 2048) : ''
          }
        : null,
      metadata: metadataWithPostType(req.body),
      createdAt: now,
      updatedAt: now,
      publishedAt: status === 'published' ? now : undefined
    };
    if (post.primaryMediaId && !post.media.some((item) => item.mediaId === post.primaryMediaId)) {
      post.media.unshift({ mediaId: post.primaryMediaId, discoverable: true, sortOrder: 0 });
    }
    await store.createPost(post);
    return res.status(201).json(post);
  });

  app.patch('/studio/posts/:postId', requireAuth, async (req, res) => {
    const existing = await store.getPostById(req.params.postId);
    if (!existing) return res.status(404).json({ message: 'Post not found' });
    if (!(await ensureCreatorContentAccess(req, res, existing.creatorId))) return;

    const nextTitle = typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim()
      : existing.title;
    const nextSlug = typeof req.body?.slug === 'string' && req.body.slug.trim()
      ? slugify(req.body.slug)
      : existing.slug;
    const conflict = await store.getPostBySlug(nextSlug);
    if (conflict && conflict.postId !== existing.postId) {
      return res.status(409).json({ message: 'Post slug already exists', slug: nextSlug });
    }
    const nextStatus = req.body?.status === 'draft' || req.body?.status === 'published' || req.body?.status === 'archived'
      ? req.body.status
      : existing.status;
    const updated: Post = {
      ...existing,
      title: nextTitle,
      slug: nextSlug,
      slugHistory: uniqueSlugs([...(existing.slugHistory || [existing.slug]), nextSlug]),
      summary: req.body?.summary !== undefined ? sanitizeOptional(req.body.summary, 2000) : existing.summary,
      status: nextStatus,
      blocks: req.body?.blocks !== undefined ? parsePostBlocks(req.body.blocks) : existing.blocks,
      media: req.body?.media !== undefined ? parsePostMediaRefs(req.body.media) : existing.media,
      primaryMediaId: req.body?.primaryMediaId !== undefined ? sanitizeOptional(req.body.primaryMediaId, 128) : existing.primaryMediaId,
      discovery: {
        mode: req.body?.discoveryMode !== undefined || req.body?.discovery?.mode !== undefined
          ? parsePostDiscoveryMode(req.body?.discoveryMode ?? req.body?.discovery?.mode)
          : existing.discovery.mode
      },
      destination: req.body?.destination !== undefined
        ? (
            req.body.destination && typeof req.body.destination === 'object'
              ? {
                  type: req.body.destination.type === 'pdf' || req.body.destination.type === 'external' || req.body.destination.type === 'internal'
                    ? req.body.destination.type
                    : 'post',
                  url: typeof req.body.destination.url === 'string' ? req.body.destination.url.slice(0, 2048) : ''
                }
              : null
          )
        : existing.destination,
      metadata: req.body?.metadata !== undefined || req.body?.postType !== undefined || req.body?.postFormat !== undefined
        ? metadataWithPostType(req.body, existing.metadata)
        : existing.metadata,
      updatedAt: new Date().toISOString(),
      publishedAt: nextStatus === 'published' ? (existing.publishedAt || new Date().toISOString()) : existing.publishedAt
    };
    if (updated.primaryMediaId && !updated.media.some((item) => item.mediaId === updated.primaryMediaId)) {
      updated.media.unshift({ mediaId: updated.primaryMediaId, discoverable: true, sortOrder: 0 });
    }
    await store.updatePost(updated);
    return res.json(updated);
  });

  app.delete('/studio/posts/:postId', requireAuth, async (req, res) => {
    const existing = await store.getPostById(req.params.postId);
    if (!existing) return res.status(404).json({ message: 'Post not found' });
    if (!(await ensureCreatorContentAccess(req, res, existing.creatorId))) return;
    await store.deletePost(existing.postId);
    return res.status(204).send();
  });

  app.post('/studio/groupings', requireAuth, async (req, res) => {
    const creator = String(req.body?.creatorId || '');
    if (!(await ensureCreatorContentAccess(req, res, creator))) {
      return;
    }
    const visibility: Grouping['visibility'] = req.body?.visibility === 'premium'
      ? 'premium'
      : (req.body?.visibility === 'preview' ? 'preview' : 'free');
    const passwordHash = visibility === 'premium' && req.body?.premiumPassword
      ? await hashPassword(String(req.body.premiumPassword))
      : undefined;
    const title = String(req.body?.title || '').trim();
    if (!title) {
      return res.status(400).json({ message: 'title is required' });
    }
    const requestedSlug = req.body?.slug ? String(req.body.slug) : title;
    const slug = slugify(requestedSlug);

    const grouping: Grouping = {
      groupingId: randomUUID(),
      creatorId: String(req.body?.creatorId || ''),
      title,
      slug,
      slugHistory: uniqueSlugs([slug]),
      discoverSquareCropEnabled: typeof req.body?.discoverSquareCropEnabled === 'boolean'
        ? req.body.discoverSquareCropEnabled
        : true,
      defaultAiDisclosure: parseOptionalAiDisclosure(req.body?.defaultAiDisclosure) || 'none',
      defaultHeavyTopics: parseOptionalHeavyTopics(req.body?.defaultHeavyTopics) || [],
      coverImageId: req.body?.coverImageId ? String(req.body.coverImageId) : undefined,
      visibility,
      pairedPremiumGroupingId: req.body?.pairedPremiumGroupingId ? String(req.body.pairedPremiumGroupingId) : undefined,
      purchaseUrl: req.body?.purchaseUrl ? String(req.body.purchaseUrl) : undefined,
      defaultPreviewMaxWidth: parseOptionalPreviewWidth(req.body?.defaultPreviewMaxWidth),
      status: req.body?.status === 'published' ? 'published' : 'draft',
      premiumPasswordHash: passwordHash,
      createdAt: new Date().toISOString()
    };

    await store.createGrouping(grouping);

    const creatorGroupings = (await store.listAllGroupings()).filter((item) => item.creatorId === grouping.creatorId);
    const defaultStreamGrouping = creatorGroupings.find((item) => item.isDefaultStream);
    if (defaultStreamGrouping && creatorGroupings.length > 1) {
      const desiredTitle = defaultStreamGrouping.title?.trim() || 'Original Series';
      if (defaultStreamGrouping.title !== desiredTitle) {
        await store.updateGrouping({
          ...defaultStreamGrouping,
          title: desiredTitle,
          slugHistory: uniqueSlugs([...(defaultStreamGrouping.slugHistory || [defaultStreamGrouping.slug]), defaultStreamGrouping.slug])
        });
      }
    }

    return res.status(201).json({ ...grouping, premiumPasswordHash: undefined });
  });

  app.patch('/studio/groupings/:groupingId', requireAuth, async (req, res) => {
    const groupings = await store.listAllGroupings();
    const existing = groupings.find((grouping) => grouping.groupingId === req.params.groupingId);
    if (!existing) {
      return res.status(404).json({ message: 'Grouping not found' });
    }
    if (!(await ensureCreatorContentAccess(req, res, existing.creatorId))) {
      return;
    }
    if (req.body?.creatorId && String(req.body.creatorId) !== existing.creatorId) {
      if (!(await ensureCreatorContentAccess(req, res, String(req.body.creatorId)))) {
        return;
      }
    }

    const visibility: Grouping['visibility'] = req.body?.visibility === 'premium'
      ? 'premium'
      : (req.body?.visibility === 'preview' ? 'preview' : (req.body?.visibility === 'free' ? 'free' : existing.visibility));
    const nextTitle = req.body?.title ? String(req.body.title) : existing.title;
    const nextSlug = req.body?.slug
      ? slugify(String(req.body.slug))
      : (req.body?.title ? slugify(String(req.body.title)) : existing.slug);

    const updated: Grouping = {
      ...existing,
      creatorId: req.body?.creatorId ? String(req.body.creatorId) : existing.creatorId,
      title: nextTitle,
      slug: nextSlug,
      slugHistory: uniqueSlugs([...(existing.slugHistory || [existing.slug]), nextSlug]),
      discoverSquareCropEnabled: typeof req.body?.discoverSquareCropEnabled === 'boolean'
        ? req.body.discoverSquareCropEnabled
        : (existing.discoverSquareCropEnabled ?? true),
      defaultAiDisclosure: req.body?.defaultAiDisclosure !== undefined
        ? (parseOptionalAiDisclosure(req.body.defaultAiDisclosure) || 'none')
        : normalizeAiDisclosure(existing.defaultAiDisclosure),
      defaultHeavyTopics: req.body?.defaultHeavyTopics !== undefined
        ? (parseOptionalHeavyTopics(req.body.defaultHeavyTopics) || [])
        : normalizeHeavyTopics(existing.defaultHeavyTopics),
      coverImageId: req.body?.coverImageId !== undefined ? (req.body.coverImageId ? String(req.body.coverImageId) : undefined) : existing.coverImageId,
      visibility,
      pairedPremiumGroupingId: req.body?.pairedPremiumGroupingId !== undefined
        ? (req.body.pairedPremiumGroupingId ? String(req.body.pairedPremiumGroupingId) : undefined)
        : existing.pairedPremiumGroupingId,
      purchaseUrl: req.body?.purchaseUrl !== undefined
        ? (req.body.purchaseUrl ? String(req.body.purchaseUrl) : undefined)
        : existing.purchaseUrl,
      defaultPreviewMaxWidth: req.body?.defaultPreviewMaxWidth !== undefined
        ? parseOptionalPreviewWidth(req.body.defaultPreviewMaxWidth)
        : existing.defaultPreviewMaxWidth,
      status: req.body?.status === 'published' ? 'published' : (req.body?.status === 'draft' ? 'draft' : existing.status)
    };

    if (req.body?.premiumPassword && visibility === 'premium') {
      updated.premiumPasswordHash = await hashPassword(String(req.body.premiumPassword));
    } else if (visibility === 'free') {
      updated.premiumPasswordHash = undefined;
    }

    await store.updateGrouping(updated);
    return res.json({ ...updated, premiumPasswordHash: undefined });
  });

  app.delete('/studio/groupings/:groupingId', requireAuth, async (req, res) => {
    const grouping = (await store.listAllGroupings()).find((item) => item.groupingId === req.params.groupingId);
    if (!grouping) {
      return res.status(404).json({ message: 'Grouping not found' });
    }
    if (!(await ensureCreatorContentAccess(req, res, grouping.creatorId))) {
      return;
    }
    await store.deleteGrouping(req.params.groupingId);
    return res.status(204).send();
  });

  app.get('/studio/groupings/:groupingId/media', requireAuth, async (req, res) => {
    const grouping = (await store.listAllGroupings()).find((item) => item.groupingId === req.params.groupingId);
    if (!grouping) {
      return res.status(404).json({ message: 'Grouping not found' });
    }
    if (!(await ensureCreatorContentAccess(req, res, grouping.creatorId))) {
      return;
    }
    const mediaItems = await store.getMediaByGrouping(req.params.groupingId);
    return res.json(mediaItems.map((item) => ({ ...item, imageId: item.mediaId, sortOrder: item.position })));
  });

  app.post('/studio/media', requireAuth, async (req, res) => {
    const groupingIdRaw = req.body?.groupingId ? String(req.body.groupingId) : '';
    const groupingId = groupingIdRaw.trim() || undefined;
    const position = Number(req.body?.sortOrder || 0);
    const grouping = groupingId
      ? (await store.listAllGroupings()).find((item) => item.groupingId === groupingId)
      : undefined;
    const creator = grouping
      ? grouping.creatorId
      : String(req.body?.creatorId || '').trim();
    if (groupingId && !grouping) {
      return res.status(400).json({ message: 'groupingId must exist when provided' });
    }
    if (!creator) {
      return res.status(400).json({ message: 'creator is required when groupingId is not provided' });
    }
    if (!(await ensureCreatorContentAccess(req, res, creator))) {
      return;
    }
    const originalFilename = req.body?.originalFilename ? String(req.body.originalFilename) : undefined;
    const title = req.body?.title
      ? String(req.body.title).trim()
      : (originalFilename ? originalFilename.replace(/\.[^.]+$/, '') : undefined);
    const slug = title ? slugify(title) : undefined;
    const media: Media = {
      mediaId: randomUUID(),
      creatorId: creator,
      appearsInFeed: parseOptionalBoolean(req.body?.appearsInFeed) ?? true,
      assetType: req.body?.assetType === 'video' ? 'video' : 'image',
      discoverSquareCropEnabled: typeof req.body?.discoverSquareCropEnabled === 'boolean'
        ? req.body.discoverSquareCropEnabled
        : true,
      contentRating: normalizeContentRating(req.body?.contentRating),
      moderatorContentRating: parseOptionalContentRating(req.body?.moderatorContentRating),
      aiDisclosure: normalizeAiDisclosure(req.body?.aiDisclosure),
      moderatorAiDisclosure: parseOptionalAiDisclosure(req.body?.moderatorAiDisclosure),
      heavyTopics: normalizeHeavyTopics(req.body?.heavyTopics),
      moderatorHeavyTopics: parseOptionalHeavyTopics(req.body?.moderatorHeavyTopics),
      title,
      slug,
      slugHistory: slug ? uniqueSlugs([slug]) : undefined,
      originalFilename,
      previewKey: String(req.body?.previewKey || ''),
      premiumKey: req.body?.premiumKey ? String(req.body?.premiumKey) : undefined,
      previewPosterKey: req.body?.previewPosterKey ? String(req.body?.previewPosterKey) : undefined,
      premiumPosterKey: req.body?.premiumPosterKey ? String(req.body?.premiumPosterKey) : undefined,
      width: Number(req.body?.width || 0),
      height: Number(req.body?.height || 0),
      durationSeconds: req.body?.durationSeconds ? Number(req.body.durationSeconds) : undefined,
      altText: req.body?.altText ? String(req.body.altText) : undefined,
      createdAt: new Date().toISOString()
    };

    if (media.assetType === 'image') {
      const targetPrefix = `${creator}/${media.mediaId}`;
      const generated = await generateImageRenditions({
        s3: s3Client,
        bucket: config.mediaBucket,
        sourceKey: media.previewKey,
        targetPrefix,
        squareCrop: parseSquareCrop(req.body?.squareCrop)
      });
      media.thumbnailKeys = generated.keys;
      media.squareCrop = generated.squareCrop;
      media.width = generated.sourceWidth;
      media.height = generated.sourceHeight;
    }

    await store.createMedia(media, groupingId, position, {
      isPreview: parseOptionalBoolean(req.body?.isPreview),
      previewMaxWidth: parseOptionalPreviewWidth(req.body?.previewMaxWidth)
    });
    return res.status(201).json({ ...media, imageId: media.mediaId, groupingId, sortOrder: groupingId ? position : undefined });
  });

  app.post('/studio/groupings/:groupingId/media/:imageId', requireAuth, async (req, res) => {
    const grouping = (await store.listAllGroupings()).find((item) => item.groupingId === req.params.groupingId);
    if (!grouping) {
      return res.status(404).json({ message: 'Grouping not found' });
    }
    if (!(await ensureCreatorContentAccess(req, res, grouping.creatorId))) {
      return;
    }
    const creatorMedia = await store.listMediaByCreator(grouping.creatorId);
    const media = creatorMedia.find((item) => item.mediaId === req.params.imageId);
    if (!media) {
      return res.status(404).json({ message: 'Image not found for creator' });
    }
    const position = Number(req.body?.sortOrder);
    const resolvedPosition = Number.isFinite(position)
      ? Math.max(0, Math.floor(position))
      : (await store.getMediaByGrouping(grouping.groupingId)).length;
    await store.addMediaToGrouping(grouping.groupingId, media.mediaId, resolvedPosition, {
      isPreview: parseOptionalBoolean(req.body?.isPreview),
      previewMaxWidth: parseOptionalPreviewWidth(req.body?.previewMaxWidth)
    });
    return res.status(201).json({
      groupingId: grouping.groupingId,
      imageId: media.mediaId,
      sortOrder: resolvedPosition,
      isPreview: parseOptionalBoolean(req.body?.isPreview),
      previewMaxWidth: parseOptionalPreviewWidth(req.body?.previewMaxWidth)
    });
  });

  app.patch('/studio/groupings/:groupingId/media/:imageId', requireAuth, async (req, res) => {
    const grouping = (await store.listAllGroupings()).find((item) => item.groupingId === req.params.groupingId);
    if (!grouping) {
      return res.status(404).json({ message: 'Grouping not found' });
    }
    if (!(await ensureCreatorContentAccess(req, res, grouping.creatorId))) {
      return;
    }
    const mediaItems = await store.getMediaByGrouping(req.params.groupingId);
    const existing = mediaItems.find((item) => item.mediaId === req.params.imageId);
    if (!existing) {
      return res.status(404).json({ message: 'Image not found' });
    }

    const nextTitle = req.body?.title !== undefined
      ? String(req.body.title).trim()
      : (existing.title || existing.originalFilename?.replace(/\.[^.]+$/, '') || '');
    const nextSlug = req.body?.slug !== undefined
      ? slugify(String(req.body.slug))
      : (req.body?.title !== undefined ? slugify(String(req.body.title)) : (existing.slug || (nextTitle ? slugify(nextTitle) : undefined)));

    const updated: Media = {
      ...existing,
      mediaId: req.params.imageId,
      appearsInFeed: req.body?.appearsInFeed !== undefined
        ? Boolean(req.body.appearsInFeed)
        : (existing.appearsInFeed !== false),
      assetType: req.body?.assetType === 'video' ? 'video' : (req.body?.assetType === 'image' ? 'image' : existing.assetType),
      discoverSquareCropEnabled: typeof req.body?.discoverSquareCropEnabled === 'boolean'
        ? req.body.discoverSquareCropEnabled
        : (existing.discoverSquareCropEnabled ?? true),
      contentRating: req.body?.contentRating !== undefined
        ? normalizeContentRating(req.body.contentRating)
        : normalizeContentRating(existing.contentRating),
      moderatorContentRating: req.body?.moderatorContentRating !== undefined
        ? parseOptionalContentRating(req.body.moderatorContentRating)
        : existing.moderatorContentRating,
      aiDisclosure: req.body?.aiDisclosure !== undefined
        ? normalizeAiDisclosure(req.body.aiDisclosure)
        : normalizeAiDisclosure(existing.aiDisclosure),
      moderatorAiDisclosure: req.body?.moderatorAiDisclosure !== undefined
        ? parseOptionalAiDisclosure(req.body.moderatorAiDisclosure)
        : parseOptionalAiDisclosure(existing.moderatorAiDisclosure),
      heavyTopics: req.body?.heavyTopics !== undefined
        ? normalizeHeavyTopics(req.body.heavyTopics)
        : normalizeHeavyTopics(existing.heavyTopics),
      moderatorHeavyTopics: req.body?.moderatorHeavyTopics !== undefined
        ? parseOptionalHeavyTopics(req.body.moderatorHeavyTopics)
        : parseOptionalHeavyTopics(existing.moderatorHeavyTopics),
      title: nextTitle || undefined,
      slug: nextSlug,
      slugHistory: nextSlug ? uniqueSlugs([...(existing.slugHistory || (existing.slug ? [existing.slug] : [])), nextSlug]) : existing.slugHistory,
      originalFilename: req.body?.originalFilename !== undefined
        ? (req.body.originalFilename ? String(req.body.originalFilename) : undefined)
        : existing.originalFilename,
      previewKey: req.body?.previewKey ? String(req.body.previewKey) : existing.previewKey,
      premiumKey: req.body?.premiumKey !== undefined ? (req.body.premiumKey ? String(req.body.premiumKey) : undefined) : existing.premiumKey,
      previewPosterKey: req.body?.previewPosterKey !== undefined ? (req.body.previewPosterKey ? String(req.body.previewPosterKey) : undefined) : existing.previewPosterKey,
      premiumPosterKey: req.body?.premiumPosterKey !== undefined ? (req.body.premiumPosterKey ? String(req.body.premiumPosterKey) : undefined) : existing.premiumPosterKey,
      width: (req.body?.assetType === 'video' || existing.assetType === 'video')
        ? (req.body?.width !== undefined ? Number(req.body.width) : existing.width)
        : existing.width,
      height: (req.body?.assetType === 'video' || existing.assetType === 'video')
        ? (req.body?.height !== undefined ? Number(req.body.height) : existing.height)
        : existing.height,
      durationSeconds: req.body?.durationSeconds !== undefined ? (req.body.durationSeconds ? Number(req.body.durationSeconds) : undefined) : existing.durationSeconds,
      altText: req.body?.altText !== undefined ? (req.body.altText ? String(req.body.altText) : undefined) : existing.altText
    };

    const shouldGenerateRenditions =
      (updated.assetType || 'image') === 'image' &&
      (
        Boolean(req.body?.generateRenditions)
        || Boolean(req.body?.squareCrop)
        || req.body?.previewKey !== undefined
        || (existing.assetType || 'image') !== 'image'
        || !existing.thumbnailKeys?.w640
        || !((existing.width || 0) > 0 && (existing.height || 0) > 0)
      );

    if (shouldGenerateRenditions) {
      const targetPrefix = `${grouping.creatorId || existing.creatorId}/${updated.mediaId}`;
      const generated = await generateImageRenditions({
        s3: s3Client,
        bucket: config.mediaBucket,
        sourceKey: updated.previewKey,
        targetPrefix,
        squareCrop: parseSquareCrop(req.body?.squareCrop)
      });
      updated.thumbnailKeys = generated.keys;
      updated.squareCrop = generated.squareCrop;
      updated.width = generated.sourceWidth;
      updated.height = generated.sourceHeight;
    }

    await store.updateMedia(updated);
    const nextPosition = req.body?.sortOrder !== undefined ? Number(req.body.sortOrder) : existing.position;
    const nextIsPreview = req.body?.isPreview !== undefined
      ? Boolean(req.body.isPreview)
      : existing.isPreview;
    const nextPreviewMaxWidth = req.body?.previewMaxWidth !== undefined
      ? parseOptionalPreviewWidth(req.body.previewMaxWidth)
      : existing.previewMaxWidth;
    if (
      nextPosition !== existing.position
      || nextIsPreview !== existing.isPreview
      || nextPreviewMaxWidth !== existing.previewMaxWidth
    ) {
      await store.addMediaToGrouping(req.params.groupingId, updated.mediaId, nextPosition, {
        isPreview: nextIsPreview,
        previewMaxWidth: nextPreviewMaxWidth
      });
    }
    return res.json({
      ...updated,
      imageId: updated.mediaId,
      groupingId: req.params.groupingId,
      sortOrder: nextPosition,
      isPreview: nextIsPreview,
      previewMaxWidth: nextPreviewMaxWidth
    });
  });

  app.post('/studio/groupings/:groupingId/media/:imageId/renditions', requireAuth, async (req, res) => {
    const grouping = (await store.listAllGroupings()).find((item) => item.groupingId === req.params.groupingId);
    if (!grouping) {
      return res.status(404).json({ message: 'Grouping not found' });
    }
    if (!(await ensureCreatorContentAccess(req, res, grouping.creatorId))) {
      return;
    }
    const mediaItems = await store.getMediaByGrouping(req.params.groupingId);
    const existing = mediaItems.find((item) => item.mediaId === req.params.imageId);
    if (!existing) {
      return res.status(404).json({ message: 'Image not found' });
    }
    if ((existing.assetType || 'image') !== 'image') {
      return res.status(400).json({ message: 'Renditions only apply to image assets' });
    }

    const targetPrefix = `${grouping.creatorId || existing.creatorId}/${existing.mediaId}`;
    const generated = await generateImageRenditions({
      s3: s3Client,
      bucket: config.mediaBucket,
      sourceKey: existing.previewKey,
      targetPrefix,
      squareCrop: parseSquareCrop(req.body?.squareCrop)
    });

    const updated: Media = {
      ...existing,
      mediaId: existing.mediaId,
      thumbnailKeys: generated.keys,
      squareCrop: generated.squareCrop,
      width: generated.sourceWidth,
      height: generated.sourceHeight
    };
    await store.updateMedia(updated);
    return res.json({ ...updated, imageId: updated.mediaId, groupingId: req.params.groupingId, sortOrder: existing.position });
  });

  app.delete('/studio/groupings/:groupingId/media/:imageId', requireAuth, async (req, res) => {
    const grouping = (await store.listAllGroupings()).find((item) => item.groupingId === req.params.groupingId);
    if (!grouping) {
      return res.status(404).json({ message: 'Grouping not found' });
    }
    if (!(await ensureCreatorContentAccess(req, res, grouping.creatorId))) {
      return;
    }
    await store.deleteMediaFromGrouping(req.params.groupingId, req.params.imageId);
    return res.status(204).send();
  });

  app.patch('/studio/moderation/comments/:commentId', requireAdmin, async (req, res) => {
    await store.updateCommentVisibility(req.params.commentId, Boolean(req.body?.hidden));
    return res.status(204).send();
  });

  app.delete('/studio/moderation/comments/:commentId', requireAdmin, async (req, res) => {
    await store.deleteComment(req.params.commentId);
    return res.status(204).send();
  });

  app.post('/studio/moderation/users/:userId/block', requireAdmin, async (req, res) => {
    await store.blockUser({ userId: req.params.userId, reason: req.body?.reason, blockedAt: new Date().toISOString() });
    return res.status(201).json({ userId: req.params.userId, blocked: true });
  });

  app.delete('/studio/moderation/users/:userId/block', requireAdmin, async (req, res) => {
    await store.unblockUser(req.params.userId);
    return res.status(204).send();
  });

  app.post('/studio/operations/trending/rebuild', requireAdmin, async (_req, res) => {
    const startedAt = Date.now();
    try {
      const stats = await refreshTrendingFeeds(store, config, Date.now());
      return res.json({
        ok: true,
        durationMs: Date.now() - startedAt,
        stats
      });
    } catch (error) {
      logServerError('POST /studio/operations/trending/rebuild', error);
      return res.status(500).json({ message: 'Failed to rebuild trending feed' });
    }
  });

  return app;
};
