import express from 'express';
import cors from 'cors';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AdminUpdateUserAttributesCommand, CognitoIdentityProviderClient, SignUpCommand } from '@aws-sdk/client-cognito-identity-provider';
import { getSignedUrl as getS3SignedUrl } from '@aws-sdk/s3-request-presigner';
import { getSignedUrl as getCloudFrontSignedUrl } from '@aws-sdk/cloudfront-signer';
import { randomUUID } from 'crypto';
import { createOptionalAuthMiddleware, requireAdmin, requireAuth, resolveRole } from './auth';
import { checkRateLimit } from './rateLimit';
import { issueRememberAccessToken, issueUnlockToken, verifyPassword, verifyUnlockToken } from './unlock';
import type { AppConfig } from './config';
import type { DataStore } from './store';
import { hashPassword } from './unlock';
import type {
  AiDisclosure,
  Creator,
  CreatorMember,
  ChallengePrize,
  Comment,
  ContentRating,
  ContextSubmission,
  ContributionContext,
  Grouping,
  HeavyTopic,
  Media,
  PlatformRole,
  Post,
  PostBlock,
  PostDiscoveryMode,
  SiteSettings,
  SourceFile,
  UserCapabilities,
  UserProfile
} from './domain';
import { generateImageRenditions, type SquareCropInput } from './renditions';
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

interface CreateAppOptions {
  config: AppConfig;
  store: DataStore;
}

let hasHandledInvocation = false;

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'item';

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
  'grouping',
  'carousel',
  'pdf_preview',
  'html_fragment'
]);

const parsePostBlocks = (value: unknown): PostBlock[] => {
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
      if (typeof row.text === 'string') block.text = row.text.slice(0, 20000);
      if (typeof row.level === 'number' && Number.isFinite(row.level)) block.level = Math.max(1, Math.min(6, Math.floor(row.level)));
      if (typeof row.mediaId === 'string' && row.mediaId.trim()) block.mediaId = row.mediaId.trim();
      if (typeof row.caption === 'string') block.caption = row.caption.slice(0, 2000);
      if (typeof row.quote === 'string') block.quote = row.quote.slice(0, 4000);
      if (typeof row.author === 'string') block.author = row.author.slice(0, 200);
      if (typeof row.url === 'string') block.url = row.url.slice(0, 2048);
      if (typeof row.mimeType === 'string') block.mimeType = row.mimeType.slice(0, 255);
      if (typeof row.title === 'string') block.title = row.title.slice(0, 300);
      if (typeof row.html === 'string') block.html = row.html.slice(0, 50000);
      if (row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)) {
        block.payload = row.payload as Record<string, unknown>;
      }
      return block;
    })
    .filter((item): item is PostBlock => Boolean(item));
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
    result.push({
      mediaId,
      discoverable: row.discoverable === undefined ? true : Boolean(row.discoverable),
      sortOrder: Number.isFinite(sortOrderRaw) ? Math.max(0, Math.floor(sortOrderRaw)) : undefined,
      caption: typeof row.caption === 'string' ? row.caption.slice(0, 2000) : undefined
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

const buildUsernameSuggestions = async (store: DataStore, input: string): Promise<string[]> => {
  const base = normalizeUsername(input).replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '') || 'user';
  const trimmed = base.slice(0, 20);
  const candidates = new Set<string>();
  candidates.add(`${trimmed}-${Math.floor(100 + Math.random() * 900)}`);
  candidates.add(`${trimmed}${new Date().getFullYear()}`);
  candidates.add(`${trimmed}-grouping`);
  candidates.add(`${trimmed}-art`);
  candidates.add(`u${trimmed}-${Math.floor(10 + Math.random() * 89)}`);

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

export const createApp = ({ config, store }: CreateAppOptions) => {
  const app = express();
  const s3Client = new S3Client({ region: config.awsRegion });
  const cognitoClient = new CognitoIdentityProviderClient({ region: config.awsRegion });
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
  const publicMediaUrl = async (key?: string): Promise<string | undefined> => {
    if (!key) return undefined;
    if (mediaCdnDomain) {
      return `https://${mediaCdnDomain}/${encodeS3LikePath(key)}`;
    }
    return getS3SignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: config.mediaBucket, Key: key }),
      { expiresIn: config.signedUrlTtlSeconds }
    );
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
      hideHeavyTopics: false,
      hidePoliticsPublicAffairs: false,
      hideCrimeDisastersTragedy: false,
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
          hideHeavyTopics: queryHideHeavyTopics ?? false,
          hidePoliticsPublicAffairs: queryHidePolitics ?? false,
          hideCrimeDisastersTragedy: queryHideCrime ?? false
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
    assetType: 'image' | 'video';
    surfaceType?: 'media' | 'post';
    postId?: string;
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
    width?: number;
    height?: number;
    aspectRatio?: number;
    favoriteCount: number;
    createdAt: string;
    score: number;
  };

  type DiscoveryItemType = 'image' | 'video' | 'post';
  type DiscoveryItemTypeFilter = {
    image: boolean;
    video: boolean;
    post: boolean;
  };

  const normalizeDiscoveryItemType = (value: string): DiscoveryItemType | null => {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === 'image' || normalized === 'images') return 'image';
    if (normalized === 'video' || normalized === 'videos') return 'video';
    if (normalized === 'post' || normalized === 'posts') return 'post';
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
      return { image: true, video: true, post: true };
    }

    const selected = new Set<DiscoveryItemType>();
    for (const token of tokens) {
      const normalized = normalizeDiscoveryItemType(token);
      if (normalized) selected.add(normalized);
    }

    if (selected.size === 0) {
      return { image: true, video: true, post: true };
    }

    return {
      image: selected.has('image'),
      video: selected.has('video'),
      post: selected.has('post')
    };
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
      : 'combined';
    const itemTypes = opts?.itemTypes || { image: true, video: true, post: true };
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
    const candidates: Array<{
      imageId: string;
      assetType: 'image' | 'video';
      surfaceType: 'media' | 'post';
      creatorId: string;
      groupingId: string;
      groupingSlug: string;
      groupingVisibility: 'free' | 'preview';
      postId?: string;
      relatedPostIds: string[];
      isPrimaryPostSurface: boolean;
      discoverSquareCropEnabled: boolean;
      effectiveContentRating: ContentRating;
      effectiveAiDisclosure: AiDisclosure;
      effectiveHeavyTopics: HeavyTopic[];
      title: string;
      createdAt: string;
      createdAtMs: number;
      recencyBoost: number;
      previewKey?: string;
      previewPosterKey?: string;
      width: number;
      height: number;
      aspectRatio: number;
    }> = [];
    const mediaPostLinks = new Map<string, Set<string>>();
    if (source !== 'post') {
      const mediaByGrouping = await Promise.all(
        allGalleries.map(async (grouping) => ({ grouping, media: await store.getMediaByGrouping(grouping.groupingId) }))
      );
      for (const { grouping, media } of mediaByGrouping) {
        for (const item of media) {
          const assetType = (item.assetType || 'image') === 'video' ? 'video' : 'image';
          if (assetType === 'image' && !itemTypes.image) continue;
          if (assetType === 'video' && !itemTypes.video) continue;
          if (isHiddenByVisibility(item.releaseVisibility)) continue;
          if (!canViewBySchedule(item.publishAt || grouping.publishAt, item.publicReleaseAt || grouping.publicReleaseAt, nowMs, false)) {
            continue;
          }
          const createdAtMs = asTime(item.createdAt) || nowMs;
          const discoverSquareCropEnabled =
            (creatorById.get(item.creatorId)?.discoverSquareCropEnabled ?? true) &&
            (grouping.discoverSquareCropEnabled ?? true) &&
            (item.discoverSquareCropEnabled ?? true);
          const creatorProfile = creatorById.get(item.creatorId);
          const effectiveContentRating = getEffectiveContentRating(item);
          const effectiveAiDisclosure = getEffectiveAiDisclosure(item, grouping, creatorProfile);
          const effectiveHeavyTopics = getEffectiveHeavyTopics(item, grouping, creatorProfile);
          if (!isRatingAllowed(effectiveContentRating, viewerPolicy.maxAllowedContentRating)) continue;
          if (!passesDisclosureFilter(effectiveAiDisclosure, effectiveHeavyTopics, viewerPolicy.disclosurePolicy)) continue;
          candidates.push({
            imageId: item.mediaId,
            assetType,
            surfaceType: 'media',
            creatorId: item.creatorId,
            groupingId: grouping.groupingId,
            groupingSlug: grouping.slug,
            groupingVisibility: grouping.visibility === 'preview' ? 'preview' : 'free',
            relatedPostIds: [],
            isPrimaryPostSurface: false,
            discoverSquareCropEnabled,
            effectiveContentRating,
            effectiveAiDisclosure,
            effectiveHeavyTopics,
            title: item.title || grouping.title || 'Artwork',
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
    if (source !== 'media') {
      if (!itemTypes.post) {
        // Post surfaces explicitly excluded.
      } else {
      const targetCreators = opts?.creatorId
        ? allCreators.filter((creator) => creator.creatorId === opts.creatorId && creator.status === 'active')
        : allCreators.filter((creator) => creator.status === 'active');
      const perPostSurfaceLimit = 3;
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
            const assetType = (item.assetType || 'image') === 'video' ? 'video' : 'image';
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
              surfaceType: 'post',
              creatorId: item.creatorId,
              groupingId: placedGrouping.groupingId,
              groupingSlug: placedGrouping.slug,
              groupingVisibility: placedGrouping.visibility === 'preview' ? 'preview' : 'free',
              postId: post.postId,
              relatedPostIds: [post.postId],
              isPrimaryPostSurface: Boolean(post.primaryMediaId && ref.mediaId === post.primaryMediaId),
              discoverSquareCropEnabled,
              effectiveContentRating,
              effectiveAiDisclosure,
              effectiveHeavyTopics,
              title: item.title || post.title || placedGrouping.title || 'Artwork',
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
        surfaceType: item.surfaceType,
        postId: item.postId,
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
        previewUrl: await publicMediaUrl(item.previewKey) || '',
        previewPosterUrl: await publicMediaUrl(item.previewPosterKey),
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
      console.info(`[api-timing] id=${requestId} method=${req.method} path=${req.originalUrl} status=${res.statusCode} cold=${coldStart ? 1 : 0} handlerMs=${elapsedMs.toFixed(1)}`);
      return originalEnd(...args);
    }) as typeof res.end;

    return next();
  });

  app.use((req, res, next) => {
    if (req.method !== 'OPTIONS') return next();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(','));
    res.setHeader('Access-Control-Expose-Headers', exposedHeaders.join(','));
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).send();
  });
  app.use(cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders,
    exposedHeaders
  }));
  app.use(express.json());
  app.use(createOptionalAuthMiddleware(config));

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

  app.get('/auth/username/check', async (req, res) => {
    const requested = typeof req.query.username === 'string' ? req.query.username : '';
    const { normalized, reasons } = validateUsername(requested);
    if (reasons.length > 0) {
      return res.json({ username: normalized, available: false, reasons, suggestions: await buildUsernameSuggestions(store, requested) });
    }
    const available = await store.isUsernameAvailable(normalized);
    return res.json({
      username: normalized,
      available,
      reasons: available ? [] : ['Username is already taken.'],
      suggestions: available ? [] : await buildUsernameSuggestions(store, requested)
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

    const { normalized, reasons } = validateUsername(usernameInput);
    if (reasons.length > 0) {
      return res.status(400).json({ message: reasons[0], reasons, suggestions: await buildUsernameSuggestions(store, usernameInput) });
    }

    const available = await store.isUsernameAvailable(normalized);
    if (!available) {
      return res.status(409).json({
        message: 'Username is already taken.',
        suggestions: await buildUsernameSuggestions(store, normalized)
      });
    }

    try {
      await store.reserveUsername(normalized, normalized, email);
    } catch {
      return res.status(409).json({
        message: 'Username is already taken.',
        suggestions: await buildUsernameSuggestions(store, normalized)
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

  const resolveCreatorFromSlug = async (requestedSlug: string): Promise<Creator | null> => {
    const creators = await store.listCreators();
    return creators.find((item) => item.slug === requestedSlug || (item.slugHistory || []).includes(requestedSlug)) || null;
  };

  app.get('/creators', async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    try {
      const result = await getDiscoveryCached(req, 'discovery:creators', async () => {
        const creators = await store.listCreators();
        const active = creators
          .filter((creator) => creator.status === 'active')
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
            creatorThumbnailUrl: thumb.groupingThumbnailUrl,
            followerCount,
            groupingCount: creatorGroupings.length
          };
        }));
      });
      res.setHeader('x-discovery-cache', result.cacheStatus);
      const payload = result.payload;
      res.json(payload);
    } catch (error) {
      logServerError('GET /creators', error);
      res.setHeader('x-discovery-cache', 'BYPASS');
      res.setHeader('x-api-fallback', 'creators-empty');
      res.json([]);
    }
  });

  app.get('/creators/:slug/feed', async (req, res) => {
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    const creator = await resolveCreatorFromSlug(requestedSlug);
    if (!creator || creator.status !== 'active') {
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

    const media = (await store.listMediaByCreator(creator.creatorId))
      .filter((item) => item.appearsInFeed !== false)
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

    return res.json({
      creatorId: creator.creatorId,
      creatorSlug: creator.slug,
      items: payload,
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
    if (!creator || creator.status !== 'active') {
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
          return {
            mediaId: source.mediaId,
            assetType: (source.assetType || 'image') as 'image' | 'video',
            previewUrl: await publicMediaUrl(source.previewKey),
            previewPosterUrl: await publicMediaUrl(source.previewPosterKey),
            width: source.width,
            height: source.height
          };
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
        blockCount: post.blocks.length,
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
    const media = await Promise.all(post.media.map(async (ref) => {
      const source = mediaById.get(ref.mediaId);
      if (!source) return null;
      return {
        mediaId: source.mediaId,
        assetType: (source.assetType || 'image') as 'image' | 'video',
        title: source.title || source.originalFilename || source.mediaId,
        previewUrl: await publicMediaUrl(source.previewKey),
        previewPosterUrl: await publicMediaUrl(source.previewPosterKey),
        width: source.width,
        height: source.height,
        discoverable: ref.discoverable !== false,
        sortOrder: ref.sortOrder ?? 0,
        caption: ref.caption
      };
    }));

    return res.json({
      ...post,
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

    return res.json({ ...settings, logoUrl });
  });

  app.get('/discovery/trending-content', async (req, res) => {
    const startedAt = Date.now();
    const period: 'hourly' | 'daily' = req.query.period === 'hourly' ? 'hourly' : 'daily';
    const source: 'media' | 'post' | 'combined' = req.query.source === 'post'
      ? 'post'
      : req.query.source === 'media'
        ? 'media'
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
    const cacheKey = `viewer=${viewerPolicy.loggedIn ? 'auth' : 'anon'}:${viewerPolicy.matureEnabled ? 'm1' : 'm0'}:${viewerPolicy.maxAllowedContentRating}|${disclosureKey}|period=${period}|source=${source}|types=i${itemTypes.image ? 1 : 0}v${itemTypes.video ? 1 : 0}p${itemTypes.post ? 1 : 0}|limit=${limit}|cursor=${decodedCursor || ''}`;
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
        const items = await Promise.all(filtered.map(async (item) => {
          const effective = normalizeContentRating(item.effectiveContentRating);
          const contentProjection = projectContentRating(effective, viewerPolicy);
          const effectiveAi = normalizeAiDisclosure(item.effectiveAiDisclosure);
          const effectiveHeavyTopics = normalizeHeavyTopics(item.effectiveHeavyTopics);
          const disclosureProjection = projectDisclosures(effectiveAi, effectiveHeavyTopics);
          return {
            imageId: item.imageId,
            assetType: item.assetType === 'video' ? 'video' : 'image',
            surfaceType: item.surfaceType === 'post_surface' || Boolean(item.postId) ? 'post' : 'media',
            postId: item.postId,
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
            title: item.title,
            previewUrl: await publicMediaUrl(item.previewKey) || '',
            previewPosterUrl: await publicMediaUrl(item.previewPosterKey),
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
        res.setHeader('x-trending-scored', String(feedPage.items.length));
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
    const source: 'media' | 'post' | 'combined' = req.query.source === 'post'
      ? 'post'
      : req.query.source === 'media'
        ? 'media'
        : 'combined';
    const itemTypes = parseDiscoveryItemTypes(req);
    const result = await getDiscoveryCached(
      req,
      `discovery:creator-trending:${creator.creatorId}:source=${source}:types=i${itemTypes.image ? 1 : 0}v${itemTypes.video ? 1 : 0}p${itemTypes.post ? 1 : 0}`,
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
    if (!profile) {
      return res.status(404).json({ message: 'Profile not found' });
    }
    if (profile.username !== slug) {
      return res.redirect(302, `/u/${profile.username}`);
    }
    return res.json({
      username: profile.username,
      displayName: profile.displayName || profile.username,
      bio: profile.bio,
      location: profile.location,
      website: profile.website
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
    const feedPreview = feedAll.slice(0, 18);
    const featuredItemIds = creator.featuredItemIds || [];
    const featuredGroupingIds = creator.featuredGroupingIds || [];
    const feedFavoriteCounts = await store.getImageFavoriteCounts(feedPreview.map((item) => item.mediaId));
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
      defaultProfileTab: creator.defaultProfileTab === 'groupings' ? 'groupings' : 'feed',
      followerCount,
      imageCount,
      groupingCount: visibleGalleries.length,
      feedItems: await Promise.all(feedPreview.map(async (item) => {
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
      if (isAdminRequest(req)) {
        return res.json(creators.map((creator) => ({ ...creator, memberRole: 'admin' })));
      }
      const memberships = await Promise.all(
        creators.map(async (creator) => {
          const member = await getCreatorMembership(creator.creatorId, req.authUser!.userId);
          return { ...creator, memberRole: member?.role || 'editor' };
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
      displayName: sanitizeOptional(req.body?.displayName, 80),
      bio: sanitizeOptional(req.body?.bio, 600),
      location: sanitizeOptional(req.body?.location, 120),
      website: sanitizeOptional(req.body?.website, 220),
      matureContentEnabled,
      maxAllowedContentRating,
      aiFilter: disclosurePolicy.aiFilter,
      hideHeavyTopics: disclosurePolicy.hideHeavyTopics,
      hidePoliticsPublicAffairs: disclosurePolicy.hidePoliticsPublicAffairs,
      hideCrimeDisastersTragedy: disclosurePolicy.hideCrimeDisastersTragedy,
      updatedAt: new Date().toISOString()
    };
    await store.upsertUserProfile(updated);
    return res.json(updated);
  });

  app.patch('/me/username', requireAuth, async (req, res) => {
    const requested = typeof req.body?.username === 'string' ? req.body.username : '';
    const { normalized, reasons } = validateUsername(requested);
    if (reasons.length > 0) {
      return res.status(400).json({ message: reasons[0], reasons, suggestions: await buildUsernameSuggestions(store, requested) });
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
      return res.status(409).json({ message: 'Username is already taken.', suggestions: await buildUsernameSuggestions(store, normalized) });
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
    return res.json({
      ...collection,
      imageIds,
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
    const collection = {
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
    const approvedSubmissions = submissions.filter((item) => item.status === 'approved').length;
    const thresholds = await store.listContextUnlockThresholds?.(context.contextId) || [];
    const prizes = await store.listChallengePrizes?.(context.contextId) || [];
    return res.json({
      ...context,
      metrics: {
        submissionCount: submissions.length,
        approvedSubmissionCount: approvedSubmissions
      },
      unlockThresholds: thresholds,
      prizes
    });
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
    const submission: ContextSubmission = {
      submissionId: randomUUID(),
      contextId: context.contextId,
      userId: req.authUser!.userId,
      status: 'pending',
      title,
      notes: sanitizeOptional(req.body?.notes, 4000),
      mediaIds,
      fileIds,
      submittedAt: new Date().toISOString()
    };
    await store.createContextSubmission(submission);
    return res.status(201).json(submission);
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
    const context: ContributionContext = {
      contextId: randomUUID(),
      type: req.body?.type === 'event' ? 'event' : 'challenge',
      title,
      slug: slugify(typeof req.body?.slug === 'string' && req.body.slug.trim() ? req.body.slug : title),
      status: req.body?.status === 'active' || req.body?.status === 'closed' || req.body?.status === 'archived'
        ? req.body.status
        : 'draft',
      description: sanitizeOptional(req.body?.description, 5000),
      rules: {
        maxEntriesPerUser: Number.isFinite(Number(req.body?.rules?.maxEntriesPerUser)) ? Math.max(1, Math.floor(Number(req.body.rules.maxEntriesPerUser))) : 3,
        requiresOtp: req.body?.rules?.requiresOtp !== false
      },
      submissionWindow: {
        opensAt: sanitizeOptional(req.body?.submissionWindow?.opensAt, 64),
        closesAt: sanitizeOptional(req.body?.submissionWindow?.closesAt, 64)
      },
      rewardConfig: { manual: true },
      createdByUserId: req.authUser!.userId,
      createdAt: now,
      updatedAt: now
    };
    await store.createContributionContext(context);
    return res.status(201).json(context);
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
    if (!nextStatus) return res.status(400).json({ message: 'status must be approved or rejected' });
    const now = new Date().toISOString();
    const updated: ContextSubmission = {
      ...submission,
      status: nextStatus,
      reviewedAt: now,
      reviewedByUserId: req.authUser!.userId
    };

    if (nextStatus === 'approved' && !submission.convertedPostId) {
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
      category: req.body?.category === 'digital' || req.body?.category === 'physical' || req.body?.category === 'draw' ? req.body.category : 'platform',
      placement: req.body?.placement === 'runner_up' || req.body?.placement === 'top_n' || req.body?.placement === 'random_supporter' ? req.body.placement : 'winner',
      quantity: Number.isFinite(Number(req.body?.quantity)) ? Math.max(1, Math.floor(Number(req.body.quantity))) : 1,
      status: req.body?.status === 'active' || req.body?.status === 'awarded' ? req.body.status : 'draft',
      createdAt: now,
      updatedAt: now
    };
    await store.createChallengePrize(prize);
    return res.status(201).json(prize);
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
    return res.json(await listVisibleCreators(req));
  });

  app.post('/studio/creators', requireAuth, async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const slug = slugify(String(req.body?.slug || name || randomUUID().slice(0, 8)));
    const creators = await store.listCreators();
    const conflict = creators.find((item) => creatorMatchesSlug(item, slug));
    if (conflict) {
      return res.status(409).json({ message: 'Creator slug is already taken.', slug });
    }

    const creator: Creator = {
      creatorId: randomUUID(),
      name,
      slug,
      slugHistory: uniqueSlugs([slug]),
      defaultProfileTab: req.body?.defaultProfileTab === 'groupings' ? 'groupings' : 'feed',
      featuredItemIds: parseStringArray(req.body?.featuredItemIds),
      featuredGroupingIds: parseStringArray(req.body?.featuredGroupingIds),
      discoverSquareCropEnabled: typeof req.body?.discoverSquareCropEnabled === 'boolean'
        ? req.body.discoverSquareCropEnabled
        : true,
      defaultAiDisclosure: parseOptionalAiDisclosure(req.body?.defaultAiDisclosure) || 'none',
      defaultHeavyTopics: parseOptionalHeavyTopics(req.body?.defaultHeavyTopics) || [],
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

    const nextSlug = req.body?.slug ? slugify(String(req.body.slug)) : existing.slug;
    const nextSlugHistory = uniqueSlugs([...(existing.slugHistory || [existing.slug]), nextSlug]);
    const conflictSlug = nextSlugHistory.find((slug) =>
      creators.some((item) => item.creatorId !== existing.creatorId && creatorMatchesSlug(item, slug))
    );
    if (conflictSlug) {
      return res.status(409).json({ message: 'Creator slug is already taken.', slug: conflictSlug });
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
      name: req.body?.name ? String(req.body.name) : existing.name,
      slug: nextSlug,
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
      status: req.body?.status === 'inactive' ? 'inactive' : (req.body?.status === 'active' ? 'active' : existing.status),
      sortOrder: req.body?.sortOrder !== undefined ? Number(req.body.sortOrder) : existing.sortOrder
    };

    await store.updateCreator(updated);
    return res.json(updated);
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
      metadata: req.body?.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
        ? Object.fromEntries(
            Object.entries(req.body.metadata as Record<string, unknown>)
              .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
              .map(([key, value]) => [key.slice(0, 120), String(value).slice(0, 1000)])
          )
        : {},
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
      metadata: req.body?.metadata !== undefined
        ? (
            req.body.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
              ? Object.fromEntries(
                  Object.entries(req.body.metadata as Record<string, unknown>)
                    .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
                    .map(([key, value]) => [key.slice(0, 120), String(value).slice(0, 1000)])
                )
              : {}
          )
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
