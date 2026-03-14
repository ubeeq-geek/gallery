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
import type { AiDisclosure, Artist, ArtistMember, Comment, ContentRating, Gallery, HeavyTopic, Media, SiteSettings, UserProfile } from './domain';
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

interface CreateAppOptions {
  config: AppConfig;
  store: DataStore;
}

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

const artistHasSlug = (artist: Artist, slug: string): boolean => {
  const normalized = slugify(slug);
  if (!normalized) return false;
  if (artist.slug === normalized) return true;
  return (artist.slugHistory || []).some((item) => slugify(item) === normalized);
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
  candidates.add(`${trimmed}-gallery`);
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
    'x-gallery-access-token',
    'x-unlock-token',
    'x-idempotency-key'
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

  const hasPremiumAccess = async (req: express.Request, galleryId: string): Promise<boolean> => {
    if (req.authUser?.userId && await store.hasGalleryAccess(req.authUser.userId, galleryId)) {
      return true;
    }

    const token = req.headers['x-gallery-access-token'];
    if (typeof token === 'string') {
      try {
        const payload = verifyUnlockToken(token, config.unlockJwtSecret);
        if (payload.galleryId === galleryId && payload.tokenType === 'remember') {
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

  const getArtistMembership = async (artistId: string, userId: string): Promise<ArtistMember | null> => {
    const members = await store.listArtistMembers(artistId);
    return members.find((member) => member.userId === userId) || null;
  };

  const ensureArtistContentAccess = async (req: express.Request, res: express.Response, artistId: string): Promise<boolean> => {
    if (!req.authUser) {
      res.status(401).json({ message: 'Authentication required' });
      return false;
    }
    if (!artistId) {
      res.status(400).json({ message: 'artistId is required' });
      return false;
    }
    if (isAdminRequest(req)) return true;
    const allowed = await store.hasArtistAccess(req.authUser.userId, artistId);
    if (!allowed) {
      res.status(403).json({ message: 'Artist access required' });
      return false;
    }
    return true;
  };

  const ensureArtistAccountAccess = async (req: express.Request, res: express.Response, artistId: string): Promise<boolean> => {
    if (!(await ensureArtistContentAccess(req, res, artistId))) return false;
    if (isAdminRequest(req)) return true;
    const membership = await getArtistMembership(artistId, req.authUser!.userId);
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
      actorRole: event.actorRole as 'public' | 'user' | 'artist' | 'admin',
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
  ): Promise<{ ownerProfileType: 'user' | 'artist'; ownerProfileId: string } | null> => {
    const payload = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
    const requestedType = payload.ownerProfileType === 'artist' ? 'artist' : 'user';
    if (requestedType === 'artist') {
      const artistId = typeof payload.ownerProfileId === 'string' ? payload.ownerProfileId : '';
      if (!artistId) return null;
      if (!(await store.hasArtistAccess(req.authUser!.userId, artistId)) && !isAdminRequest(req)) {
        return null;
      }
      return { ownerProfileType: 'artist', ownerProfileId: artistId };
    }
    return { ownerProfileType: 'user', ownerProfileId: req.authUser!.userId };
  };

  const canManageCollection = async (req: express.Request, collection: { ownerUserId: string; ownerProfileType?: 'user' | 'artist'; ownerProfileId?: string }): Promise<boolean> => {
    if (isAdminRequest(req)) return true;
    const profileType = collection.ownerProfileType || 'user';
    const profileId = collection.ownerProfileId || collection.ownerUserId;
    if (profileType === 'user') {
      return req.authUser!.userId === collection.ownerUserId;
    }
    return store.hasArtistAccess(req.authUser!.userId, profileId);
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

  const resolveGalleryThumbnail = async (gallery: Gallery): Promise<{ galleryThumbnailUrl?: string; galleryThumbnailMediaId?: string }> => {
    const mediaItems = await store.getMediaByGallery(gallery.galleryId);
    const cover = mediaItems.find((item) => item.mediaId === gallery.coverImageId) || mediaItems[0];
    if (!cover) return {};
    const key = cover.thumbnailKeys?.square512 || cover.thumbnailKeys?.square256 || cover.previewPosterKey || cover.previewKey;
    const galleryThumbnailUrl = await publicMediaUrl(key);
    return { galleryThumbnailUrl, galleryThumbnailMediaId: cover.mediaId };
  };

  const resolveGalleryStackPreviewUrls = async (gallery: Gallery): Promise<string[]> => {
    const mediaItems = await store.getMediaByGallery(gallery.galleryId);
    if (!mediaItems.length) return [];
    const sorted = [...mediaItems].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const coverFirst = gallery.coverImageId
      ? [
        ...sorted.filter((item) => item.mediaId === gallery.coverImageId),
        ...sorted.filter((item) => item.mediaId !== gallery.coverImageId)
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
    artistId: string;
    artistName: string;
    galleryId: string;
    gallerySlug: string;
    galleryVisibility: 'free' | 'preview';
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

  const computeTrendingImages = async (
    _req: express.Request,
    opts?: { period?: 'hourly' | 'daily'; cursor?: string; limit?: number; artistId?: string }
  ): Promise<{
    period: 'hourly' | 'daily';
    items: Omit<TrendingImageItem, 'score'>[];
    nextCursor?: string;
    metrics: { candidateCount: number; scoredCount: number; galleryCount: number };
  }> => {
    const period = opts?.period === 'hourly' ? 'hourly' : 'daily';
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

    let allArtists: Artist[] = [];
    try {
      allArtists = await store.listArtists();
    } catch (error) {
      logServerError('computeTrendingImages:listArtists', error);
      return { period, items: [], metrics: { candidateCount: 0, scoredCount: 0, galleryCount: 0 } };
    }
    const artistById = new Map(allArtists.map((artist) => [artist.artistId, artist]));
    const activeArtistIds = new Set(allArtists.filter((artist) => artist.status === 'active').map((artist) => artist.artistId));

    const galleries = (await store.listAllGalleries()).filter((gallery) => {
      if (opts?.artistId && gallery.artistId !== opts.artistId) return false;
      if (gallery.status !== 'published') return false;
      if (gallery.visibility === 'premium') return false;
      if (!activeArtistIds.has(gallery.artistId)) return false;
      if (isHiddenByVisibility(gallery.releaseVisibility)) return false;
      // Public discovery feed intentionally ignores follower/admin early-access windows.
      return canViewBySchedule(gallery.publishAt, gallery.publicReleaseAt, nowMs, false);
    });

    const mediaByGallery = await Promise.all(
      galleries.map(async (gallery) => ({ gallery, media: await store.getMediaByGallery(gallery.galleryId) }))
    );
    const candidates: Array<{
      imageId: string;
      assetType: 'image' | 'video';
      artistId: string;
      galleryId: string;
      gallerySlug: string;
      galleryVisibility: 'free' | 'preview';
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
    for (const { gallery, media } of mediaByGallery) {
      for (const item of media) {
        const assetType = (item.assetType || 'image') === 'video' ? 'video' : 'image';
        if (isHiddenByVisibility(item.releaseVisibility)) continue;
        if (!canViewBySchedule(item.publishAt || gallery.publishAt, item.publicReleaseAt || gallery.publicReleaseAt, nowMs, false)) {
          continue;
        }
        const createdAtMs = asTime(item.createdAt) || nowMs;
        const discoverSquareCropEnabled =
          (artistById.get(item.artistId)?.discoverSquareCropEnabled ?? true) &&
          (gallery.discoverSquareCropEnabled ?? true) &&
          (item.discoverSquareCropEnabled ?? true);
        const artist = artistById.get(item.artistId);
        const effectiveContentRating = getEffectiveContentRating(item);
        const effectiveAiDisclosure = getEffectiveAiDisclosure(item, gallery, artist);
        const effectiveHeavyTopics = getEffectiveHeavyTopics(item, gallery, artist);
        if (!isRatingAllowed(effectiveContentRating, viewerPolicy.maxAllowedContentRating)) {
          continue;
        }
        if (!passesDisclosureFilter(effectiveAiDisclosure, effectiveHeavyTopics, viewerPolicy.disclosurePolicy)) {
          continue;
        }
        candidates.push({
          imageId: item.mediaId,
          assetType,
          artistId: item.artistId,
          galleryId: gallery.galleryId,
          gallerySlug: gallery.slug,
          galleryVisibility: gallery.visibility === 'preview' ? 'preview' : 'free',
          discoverSquareCropEnabled,
          effectiveContentRating,
          effectiveAiDisclosure,
          effectiveHeavyTopics,
          title: item.title || gallery.title || 'Artwork',
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
    candidates.sort((a, b) => b.createdAtMs - a.createdAtMs);
    const sampled = candidates.slice(0, candidateLimit);
    const favoriteCounts = await store.getImageFavoriteCounts(sampled.map((item) => item.imageId));
    const flat = await Promise.all(sampled.map(async (item) => {
      const favoriteCount = Math.max(0, Number(favoriteCounts[item.imageId] || 0));
      const discoverSquareCropBonus = item.discoverSquareCropEnabled ? 1.25 : 0;
      const score = favoriteCount * 2 + item.recencyBoost * 10 + discoverSquareCropBonus;
      const contentProjection = projectContentRating(item.effectiveContentRating, viewerPolicy);
      const disclosureProjection = projectDisclosures(item.effectiveAiDisclosure, item.effectiveHeavyTopics);
      return {
        imageId: item.imageId,
        assetType: item.assetType,
        artistId: item.artistId,
        artistName: artistById.get(item.artistId)?.name || 'Artist',
        galleryId: item.galleryId,
        gallerySlug: item.gallerySlug,
        galleryVisibility: item.galleryVisibility,
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
        score
      } satisfies TrendingImageItem;
    }));
    flat.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    const diversified: TrendingImageItem[] = [];
    const queue = [...flat];
    while (queue.length > 0) {
      const lastArtistId = diversified.length > 0 ? diversified[diversified.length - 1].artistId : undefined;
      const nextIndex = queue.findIndex((item) => item.artistId !== lastArtistId);
      diversified.push(queue.splice(nextIndex >= 0 ? nextIndex : 0, 1)[0]);
    }

    const page = diversified.slice(offset, offset + limit);
    const nextCursor = offset + page.length < diversified.length ? encodeOffsetCursor(offset + page.length) : undefined;
    const items = page.map(({ score: _score, ...item }) => item);
    return {
      period,
      items,
      nextCursor,
      metrics: {
        candidateCount: candidates.length,
        scoredCount: sampled.length,
        galleryCount: galleries.length
      }
    };
  };

  app.use((req, res, next) => {
    if (req.method !== 'OPTIONS') return next();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(','));
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).send();
  });
  app.use(cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders
  }));
  app.use(express.json());
  app.use(createOptionalAuthMiddleware(config));

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

  app.get('/artists', async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    try {
      const result = await getDiscoveryCached(req, 'discovery:artists', async () => {
        const artists = await store.listArtists();
        const active = artists
          .filter((artist) => artist.status === 'active')
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        return Promise.all(active.map(async (artist) => {
          const artistGalleries = (await store.listGalleriesByArtistSlug(artist.slug))
            .filter((gallery) => gallery.status === 'published')
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
          const recent = artistGalleries[0];
          const followerCount = await store.countFollowersByArtist(artist.artistId);
          if (!recent) return { ...artist, followerCount, galleryCount: artistGalleries.length };
          const thumb = await resolveGalleryThumbnail(recent);
          return {
            ...artist,
            latestGalleryId: recent.galleryId,
            artistThumbnailUrl: thumb.galleryThumbnailUrl,
            followerCount,
            galleryCount: artistGalleries.length
          };
        }));
      });
      res.setHeader('x-discovery-cache', result.cacheStatus);
      const payload = result.payload;
      res.json(payload);
    } catch (error) {
      logServerError('GET /artists', error);
      res.setHeader('x-discovery-cache', 'BYPASS');
      res.setHeader('x-api-fallback', 'artists-empty');
      res.json([]);
    }
  });

  app.get('/site-settings', async (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
    const settings = await store.getSiteSettings();
    const logoUrl = await publicMediaUrl(settings.logoKey);

    return res.json({ ...settings, logoUrl });
  });

  app.get('/discovery/trending-images', async (req, res) => {
    const startedAt = Date.now();
    const period: 'hourly' | 'daily' = req.query.period === 'hourly' ? 'hourly' : 'daily';
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
    const cacheKey = `viewer=${viewerPolicy.loggedIn ? 'auth' : 'anon'}:${viewerPolicy.matureEnabled ? 'm1' : 'm0'}:${viewerPolicy.maxAllowedContentRating}|${disclosureKey}|period=${period}|limit=${limit}|cursor=${decodedCursor || ''}`;
    const cached = readTrendingResponseCache<{
      body: { period: 'hourly' | 'daily'; items: Omit<TrendingImageItem, 'score'>[]; nextCursor?: string };
      source: 'materialized' | 'fallback';
      candidates: number;
      scored: number;
      galleries: number;
    }>(cacheKey);
    if (cached) {
      res.setHeader('x-trending-source', cached.source);
      res.setHeader('x-trending-cache', 'HIT');
      res.setHeader('x-trending-ms', String(Date.now() - startedAt));
      res.setHeader('x-trending-candidates', String(cached.candidates));
      res.setHeader('x-trending-scored', String(cached.scored));
      res.setHeader('x-trending-galleries', String(cached.galleries));
      return res.json(cached.body);
    }
    try {
      let feedPage = await store.listTrendingFeed(period, limit, decodedCursor);
      if (!feedPage.items.length && !decodedCursor) {
        // Warm feed on demand so first request after deploy can still switch to materialized quickly.
        await triggerTrendingWarmup();
        feedPage = await store.listTrendingFeed(period, limit, decodedCursor);
      }
      if (feedPage.items.length > 0) {
        const filtered = feedPage.items.filter((item) => {
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
            artistId: item.artistId,
            artistName: item.artistName,
            galleryId: item.galleryId,
            gallerySlug: item.gallerySlug,
            galleryVisibility: item.galleryVisibility,
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
          galleries: 0
        });
        res.setHeader('x-trending-source', 'materialized');
        res.setHeader('x-trending-cache', 'MISS');
        res.setHeader('x-trending-ms', String(Date.now() - startedAt));
        res.setHeader('x-trending-candidates', String(feedPage.items.length));
        res.setHeader('x-trending-scored', String(feedPage.items.length));
        res.setHeader('x-trending-galleries', '0');
        return res.json(body);
      }
      const fallback = await computeTrendingImages(req, {
        period,
        cursor: cursorToken,
        limit
      });
      const payload = fallback as Awaited<ReturnType<typeof computeTrendingImages>>;
      const body = { period: payload.period, items: payload.items, nextCursor: payload.nextCursor };
      writeTrendingResponseCache(cacheKey, {
        body,
        source: 'fallback',
        candidates: payload.metrics.candidateCount,
        scored: payload.metrics.scoredCount,
        galleries: payload.metrics.galleryCount
      });
      res.setHeader('x-trending-source', 'fallback');
      res.setHeader('x-trending-cache', 'MISS');
      res.setHeader('x-trending-ms', String(Date.now() - startedAt));
      res.setHeader('x-trending-candidates', String(payload.metrics.candidateCount));
      res.setHeader('x-trending-scored', String(payload.metrics.scoredCount));
      res.setHeader('x-trending-galleries', String(payload.metrics.galleryCount));
      return res.json(body);
    } catch (error) {
      logServerError('GET /discovery/trending-images', error);
      res.setHeader('x-trending-source', 'error');
      res.setHeader('x-trending-cache', 'MISS');
      res.setHeader('x-api-fallback', 'trending-empty');
      res.setHeader('x-trending-ms', String(Date.now() - startedAt));
      res.setHeader('x-trending-candidates', '0');
      res.setHeader('x-trending-scored', '0');
      res.setHeader('x-trending-galleries', '0');
      return res.json({ period: req.query.period === 'hourly' ? 'hourly' : 'daily', items: [] });
    }
  });

  app.get('/artists/:slug/trending-images', async (req, res) => {
    const startedAt = Date.now();
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    let artists: Artist[] = [];
    try {
      artists = await store.listArtists();
    } catch (error) {
      logServerError('GET /artists/:slug/trending-images:listArtists', error);
      res.setHeader('x-discovery-cache', 'BYPASS');
      res.setHeader('x-api-fallback', 'trending-empty');
      res.setHeader('x-trending-ms', String(Date.now() - startedAt));
      res.setHeader('x-trending-candidates', '0');
      res.setHeader('x-trending-scored', '0');
      res.setHeader('x-trending-galleries', '0');
      return res.json({ period: req.query.period === 'hourly' ? 'hourly' : 'daily', items: [] });
    }
    const artist = artists.find((item) => item.slug === requestedSlug || (item.slugHistory || []).includes(requestedSlug));
    if (!artist || artist.status !== 'active') {
      return res.status(404).json({ message: 'Artist not found' });
    }
    const result = await getDiscoveryCached(req, `discovery:artist-trending:${artist.artistId}`, () => computeTrendingImages(req, {
      period: req.query.period === 'hourly' ? 'hourly' : 'daily',
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit: Number(req.query.limit || 24),
      artistId: artist.artistId
    }));
    res.setHeader('x-discovery-cache', result.cacheStatus);
    const payload = result.payload as Awaited<ReturnType<typeof computeTrendingImages>>;
    res.setHeader('x-trending-ms', String(Date.now() - startedAt));
    res.setHeader('x-trending-candidates', String(payload.metrics.candidateCount));
    res.setHeader('x-trending-scored', String(payload.metrics.scoredCount));
    res.setHeader('x-trending-galleries', String(payload.metrics.galleryCount));
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

  app.get('/artists/:slug/galleries', async (req, res) => {
    const galleries = await store.listGalleriesByArtistSlug(req.params.slug);
    const nowMs = Date.now();
    const followerArtistIds = new Set<string>();
    if (req.authUser?.userId) {
      const follows = await store.listFollowsByUser(req.authUser.userId);
      follows.forEach((follow) => followerArtistIds.add(follow.artistId));
    }
    const filtered = galleries.filter((gallery) => {
      if (gallery.status !== 'published') return false;
      if (isHiddenByVisibility(gallery.releaseVisibility)) return false;
      const isFollowerOrAdmin = isAdminRequest(req) || followerArtistIds.has(gallery.artistId);
      return canViewBySchedule(gallery.publishAt, gallery.publicReleaseAt, nowMs, isFollowerOrAdmin);
    });
    const byId = new Map(filtered.map((gallery) => [gallery.galleryId, gallery]));
    const payload: Array<Gallery & { premiumPasswordHash?: undefined; hasAccess: boolean }> = [];
    const seen = new Set<string>();

    for (const gallery of filtered) {
      if (seen.has(gallery.galleryId)) continue;
      if (gallery.visibility === 'free') {
        const thumb = await resolveGalleryThumbnail(gallery);
        payload.push({ ...gallery, ...thumb, premiumPasswordHash: undefined, hasAccess: true });
        seen.add(gallery.galleryId);
        continue;
      }

      if (gallery.visibility === 'premium') {
        const hasAccess = await hasPremiumAccess(req, gallery.galleryId);
        const previews = filtered.filter((item) => item.visibility === 'preview' && item.pairedPremiumGalleryId === gallery.galleryId);
        if (hasAccess || previews.length === 0) {
          const thumb = await resolveGalleryThumbnail(gallery);
          payload.push({ ...gallery, ...thumb, premiumPasswordHash: undefined, hasAccess: true });
          seen.add(gallery.galleryId);
          previews.forEach((item) => seen.add(item.galleryId));
        } else {
          for (const preview of previews) {
            if (seen.has(preview.galleryId)) continue;
            const thumb = await resolveGalleryThumbnail(preview);
            payload.push({ ...preview, ...thumb, premiumPasswordHash: undefined, hasAccess: false });
            seen.add(preview.galleryId);
          }
          seen.add(gallery.galleryId);
        }
        continue;
      }

      if (gallery.visibility === 'preview') {
        const premium = gallery.pairedPremiumGalleryId ? byId.get(gallery.pairedPremiumGalleryId) : undefined;
        if (premium) {
          const hasAccess = await hasPremiumAccess(req, premium.galleryId);
          if (hasAccess) {
            if (!seen.has(premium.galleryId)) {
              const thumb = await resolveGalleryThumbnail(premium);
              payload.push({ ...premium, ...thumb, premiumPasswordHash: undefined, hasAccess: true });
              seen.add(premium.galleryId);
            }
          } else {
            const thumb = await resolveGalleryThumbnail(gallery);
            payload.push({ ...gallery, ...thumb, premiumPasswordHash: undefined, hasAccess: false });
            seen.add(gallery.galleryId);
          }
        } else {
          const thumb = await resolveGalleryThumbnail(gallery);
          payload.push({ ...gallery, ...thumb, premiumPasswordHash: undefined, hasAccess: false });
          seen.add(gallery.galleryId);
        }
      }
    }
    res.json(payload);
  });

  app.get('/discovery/latest-galleries', async (req, res) => {
    try {
      const result = await getDiscoveryCached(req, 'discovery:latest-galleries', async () => {
        const nowMs = Date.now();
        const limitRaw = Number(req.query.limit || 12);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(24, limitRaw)) : 12;
        const artistList = await store.listArtists();
        const artistById = new Map(artistList.map((artist) => [artist.artistId, artist]));
        const galleries = (await store.listAllGalleries())
          .filter((gallery) => gallery.status === 'published' && !isHiddenByVisibility(gallery.releaseVisibility))
          .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        const followerArtistIds = new Set<string>();
        if (req.authUser?.userId) {
          const follows = await store.listFollowsByUser(req.authUser.userId);
          follows.forEach((follow) => followerArtistIds.add(follow.artistId));
        }
        const canViewGalleryBySchedule = (gallery: Gallery): boolean => {
          const isFollowerOrAdmin = isAdminRequest(req) || followerArtistIds.has(gallery.artistId);
          return canViewBySchedule(gallery.publishAt, gallery.publicReleaseAt, nowMs, isFollowerOrAdmin);
        };
        const visibleGalleries = galleries.filter(canViewGalleryBySchedule);
        const visibleById = new Map(visibleGalleries.map((gallery) => [gallery.galleryId, gallery]));
        const previewsByPremiumId = new Map<string, Gallery[]>();
        for (const gallery of visibleGalleries) {
          if (gallery.visibility === 'preview' && gallery.pairedPremiumGalleryId) {
            const existing = previewsByPremiumId.get(gallery.pairedPremiumGalleryId) || [];
            existing.push(gallery);
            previewsByPremiumId.set(gallery.pairedPremiumGalleryId, existing);
          }
        }
        const payload: Array<Gallery & {
          premiumPasswordHash?: undefined;
          hasAccess: boolean;
          artistName: string;
          artistSlug: string;
          stackPreviewUrls: string[];
        }> = [];
        const seen = new Set<string>();
        const premiumAccessByGalleryId = new Map<string, boolean>();
        const readPremiumAccess = async (galleryId: string): Promise<boolean> => {
          const cached = premiumAccessByGalleryId.get(galleryId);
          if (cached !== undefined) return cached;
          const hasAccess = await hasPremiumAccess(req, galleryId);
          premiumAccessByGalleryId.set(galleryId, hasAccess);
          return hasAccess;
        };
        const pushGallery = async (gallery: Gallery, hasAccess: boolean, artistName: string, artistSlug: string) => {
          if (payload.length >= limit) return;
          if (seen.has(gallery.galleryId)) return;
          const [thumb, stackPreviewUrls] = await Promise.all([
            resolveGalleryThumbnail(gallery),
            resolveGalleryStackPreviewUrls(gallery)
          ]);
          payload.push({
            ...gallery,
            ...thumb,
            stackPreviewUrls,
            premiumPasswordHash: undefined,
            hasAccess,
            artistName,
            artistSlug
          });
          seen.add(gallery.galleryId);
        };

        for (const gallery of visibleGalleries) {
          if (payload.length >= limit) break;
          if (seen.has(gallery.galleryId)) continue;
          const artist = artistById.get(gallery.artistId);
          const artistName = artist?.name || 'Artist';
          const artistSlug = artist?.slug || '';

          if (gallery.visibility === 'free') {
            await pushGallery(gallery, true, artistName, artistSlug);
            continue;
          }

          if (gallery.visibility === 'premium') {
            const hasAccess = await readPremiumAccess(gallery.galleryId);
            const previews = previewsByPremiumId.get(gallery.galleryId) || [];
            if (hasAccess || previews.length === 0) {
              await pushGallery(gallery, true, artistName, artistSlug);
              previews.forEach((item) => seen.add(item.galleryId));
            } else {
              for (const preview of previews) {
                if (payload.length >= limit) break;
                const previewArtist = artistById.get(preview.artistId);
                await pushGallery(preview, false, previewArtist?.name || artistName, previewArtist?.slug || artistSlug);
              }
              seen.add(gallery.galleryId);
            }
            continue;
          }

          if (gallery.visibility === 'preview') {
            const premium = gallery.pairedPremiumGalleryId ? visibleById.get(gallery.pairedPremiumGalleryId) : undefined;
            if (premium) {
              const hasAccess = await readPremiumAccess(premium.galleryId);
              if (hasAccess) {
                const premiumArtist = artistById.get(premium.artistId);
                await pushGallery(premium, true, premiumArtist?.name || artistName, premiumArtist?.slug || artistSlug);
              } else {
                await pushGallery(gallery, false, artistName, artistSlug);
              }
            } else {
              await pushGallery(gallery, false, artistName, artistSlug);
            }
          }
        }

        return payload;
      });
      res.setHeader('x-discovery-cache', result.cacheStatus);
      res.json(result.payload);
    } catch (error) {
      logServerError('GET /discovery/latest-galleries', error);
      res.setHeader('x-discovery-cache', 'BYPASS');
      res.setHeader('x-api-fallback', 'latest-galleries-empty');
      res.json([]);
    }
  });

  app.get('/artists/:slug/profile', async (req, res) => {
    const requestedSlug = String(req.params.slug || '').trim().toLowerCase();
    const artists = await store.listArtists();
    const artist = artists.find((item) => item.slug === requestedSlug || (item.slugHistory || []).includes(requestedSlug));
    if (!artist || artist.status !== 'active') {
      return res.status(404).json({ message: 'Artist not found' });
    }
    if (artist.slug !== requestedSlug) {
      return res.redirect(302, `/artists/${artist.slug}/profile`);
    }
    const allGalleries = (await store.listAllGalleries())
      .filter((item) => item.artistId === artist.artistId && item.status === 'published' && !isHiddenByVisibility(item.releaseVisibility))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const nowMs = Date.now();
    const isFollower = req.authUser?.userId ? await store.isFollowingArtist(req.authUser.userId, artist.artistId) : false;
    const isFollowerOrAdmin = isAdminRequest(req) || isFollower;
    const visibleGalleries = allGalleries.filter((item) => canViewBySchedule(item.publishAt, item.publicReleaseAt, nowMs, isFollowerOrAdmin));
    const imageCount = (await Promise.all(visibleGalleries.map((gallery) => store.getMediaByGallery(gallery.galleryId)))).flat().filter((item) => (item.assetType || 'image') === 'image').length;
    const followerCount = await store.countFollowersByArtist(artist.artistId);
    const galleries = await Promise.all(visibleGalleries.slice(0, 12).map(async (gallery) => {
      const thumb = await resolveGalleryThumbnail(gallery);
      const favoriteCount = await store.countFavorites('gallery', gallery.galleryId);
      return {
        galleryId: gallery.galleryId,
        title: gallery.title,
        slug: gallery.slug,
        visibility: gallery.visibility,
        createdAt: gallery.createdAt,
        imageCount: (await store.getMediaByGallery(gallery.galleryId)).filter((item) => (item.assetType || 'image') === 'image').length,
        favoriteCount,
        galleryThumbnailUrl: thumb.galleryThumbnailUrl
      };
    }));
    const trending = await computeTrendingImages(req, { period: 'daily', limit: 18, artistId: artist.artistId });
    const publicFavorites = await store.listPublicFavoritesByProfile('artist', artist.artistId);
    const publicCollections = await store.listPublicCollectionsByProfile('artist', artist.artistId, 6);
    const galleryById = new Map(visibleGalleries.map((item) => [item.galleryId, item]));
    const mediaRows = await Promise.all(visibleGalleries.map((item) => store.getMediaByGallery(item.galleryId)));
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
    const toPublicGalleryFavorite = async (item: { targetId: string; createdAt: string }) => {
      const gallery = galleryById.get(item.targetId);
      if (!gallery) return { targetId: item.targetId, createdAt: item.createdAt };
      const thumb = await resolveGalleryThumbnail(gallery);
      return {
        targetId: item.targetId,
        createdAt: item.createdAt,
        title: gallery.title,
        slug: gallery.slug,
        galleryThumbnailUrl: thumb.galleryThumbnailUrl
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
      artistId: artist.artistId,
      name: artist.name,
      slug: artist.slug,
      status: artist.status,
      followerCount,
      imageCount,
      galleryCount: visibleGalleries.length,
      trendingImages: trending.items,
      galleries,
      publicFavoritesByType: {
        images: await Promise.all(publicFavorites.filter((item) => item.targetType === 'image').map(toPublicImageFavorite)),
        galleries: await Promise.all(publicFavorites.filter((item) => item.targetType === 'gallery').map(toPublicGalleryFavorite)),
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

  app.get('/galleries/:slug', async (req, res) => {
    const gallery = await store.getGalleryBySlug(req.params.slug);
    if (!gallery || gallery.status !== 'published' || isHiddenByVisibility(gallery.releaseVisibility)) {
      return res.status(404).json({ message: 'Gallery not found' });
    }
    const isFollower = req.authUser?.userId ? await store.isFollowingArtist(req.authUser.userId, gallery.artistId) : false;
    const isFollowerOrAdmin = isAdminRequest(req) || isFollower;
    const viewerPolicy = await resolveViewerContentPolicy(req);
    if (!canViewBySchedule(gallery.publishAt, gallery.publicReleaseAt, Date.now(), isFollowerOrAdmin)) {
      return res.status(404).json({ message: 'Gallery not found' });
    }

    const galleryHasAccess = gallery.visibility === 'free'
      ? true
      : (gallery.visibility === 'preview' && gallery.pairedPremiumGalleryId
        ? await hasPremiumAccess(req, gallery.pairedPremiumGalleryId)
        : await hasPremiumAccess(req, gallery.galleryId));
    let resolvedGallery = gallery;
    if (gallery.visibility === 'preview' && galleryHasAccess && gallery.pairedPremiumGalleryId) {
      const premiumGallery = (await store.listAllGalleries()).find((item) => item.galleryId === gallery.pairedPremiumGalleryId);
      if (premiumGallery) {
        resolvedGallery = premiumGallery;
      }
    }
    const mediaItems = (await store.getMediaByGallery(resolvedGallery.galleryId)).filter((item) => {
      if (isHiddenByVisibility(item.releaseVisibility)) return false;
      if (item.status && item.status !== 'published' && item.status !== 'scheduled') return false;
      const effectiveContentRating = getEffectiveContentRating(item);
      if (!isRatingAllowed(effectiveContentRating, viewerPolicy.maxAllowedContentRating)) return false;
      return canViewBySchedule(item.publishAt || resolvedGallery.publishAt, item.publicReleaseAt || resolvedGallery.publicReleaseAt, Date.now(), isFollowerOrAdmin);
    });
    const coverMedia = mediaItems.find((item) => item.mediaId === gallery.coverImageId) || mediaItems[0];
    let coverPreviewUrl = coverMedia
      ? await publicMediaUrl(coverMedia.previewPosterKey || coverMedia.previewKey)
      : undefined;
    let coverBlur = (gallery.visibility === 'premium' || gallery.visibility === 'preview') && !galleryHasAccess;
    if (coverMedia) {
      const effectiveCoverRating = getEffectiveContentRating(coverMedia);
      coverBlur = coverBlur || shouldBlurContent(effectiveCoverRating, viewerPolicy);
    }
    // For premium galleries without an explicit cover, prefer paired preview cover.
    if (gallery.visibility === 'premium' && !gallery.coverImageId) {
      const previewGallery = (await store.listAllGalleries()).find((item) =>
        item.status === 'published' &&
        item.visibility === 'preview' &&
        item.pairedPremiumGalleryId === gallery.galleryId
      );
      if (previewGallery) {
        const previewMedia = await store.getMediaByGallery(previewGallery.galleryId);
        const previewCover = previewMedia.find((item) => item.mediaId === previewGallery.coverImageId) || previewMedia[0];
        if (previewCover) {
          coverPreviewUrl = await publicMediaUrl(previewCover.previewPosterKey || previewCover.previewKey);
          coverBlur = shouldBlurContent(getEffectiveContentRating(previewCover), viewerPolicy);
        }
      }
    }
    const mediaPayload = await Promise.all(mediaItems.map(async (item) => {
      const effectiveContentRating = getEffectiveContentRating(item);
      const effectiveAiDisclosure = getEffectiveAiDisclosure(item, resolvedGallery);
      const effectiveHeavyTopics = getEffectiveHeavyTopics(item, resolvedGallery);
      const contentProjection = projectContentRating(effectiveContentRating, viewerPolicy);
      const disclosureProjection = projectDisclosures(effectiveAiDisclosure, effectiveHeavyTopics);
      return {
        ...item,
        imageId: item.mediaId,
        sortOrder: item.position,
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
    if (gallery.visibility === 'preview' && gallery.pairedPremiumGalleryId && !galleryHasAccess) {
      const premiumMedia = (await store.getMediaByGallery(gallery.pairedPremiumGalleryId))
        .filter((item) => isRatingAllowed(getEffectiveContentRating(item), viewerPolicy.maxAllowedContentRating));
      premiumTeaserMedia = await Promise.all(premiumMedia.map(async (item) => ({
        ...(projectDisclosures(getEffectiveAiDisclosure(item), getEffectiveHeavyTopics(item))),
        imageId: item.mediaId,
        assetType: (item.assetType || 'image') as 'image' | 'video',
        ...projectContentRating(getEffectiveContentRating(item), viewerPolicy),
        previewUrl: (await publicMediaUrl(item.previewKey)) || '',
        previewPosterUrl: await publicMediaUrl(item.previewPosterKey)
      })));
    }

    return res.json({
      ...resolvedGallery,
      sourceGalleryId: gallery.galleryId,
      premiumPasswordHash: undefined,
      hasAccess: galleryHasAccess,
      coverMediaId: coverMedia?.mediaId,
      coverPreviewUrl,
      coverBlur,
      premiumTeaserMedia,
      favoriteCount: await store.countFavorites('gallery', resolvedGallery.galleryId),
      media: mediaPayload,
      images: mediaPayload.filter((asset) => asset.assetType === 'image'),
      videos: mediaPayload.filter((asset) => asset.assetType === 'video')
    });
  });

  app.post('/galleries/:slug/unlock', async (req, res) => {
    const gallery = await store.getGalleryBySlug(req.params.slug);
    if (!gallery || gallery.status !== 'published') {
      return res.status(404).json({ message: 'Gallery not found' });
    }
    if (gallery.visibility !== 'premium') {
      return res.status(400).json({ message: 'Gallery is not premium' });
    }

    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`unlock:${gallery.galleryId}:${ip}`, 60_000, 10)) {
      return res.status(429).json({ message: 'Too many unlock attempts, try again later' });
    }

    const password = String(req.body?.password || '');
    if (!gallery.premiumPasswordHash || !(await verifyPassword(password, gallery.premiumPasswordHash))) {
      auditLog(req, 'gallery.unlock.failed', { galleryId: gallery.galleryId, reason: 'invalid-password' });
      return res.status(401).json({ message: 'Invalid password' });
    }

    if (req.authUser?.userId) {
      await store.grantGalleryAccess(req.authUser.userId, gallery.galleryId);
    }
    const unlockToken = issueUnlockToken({ galleryId: gallery.galleryId, userId: req.authUser?.userId }, config.unlockJwtSecret, config.unlockTokenTtlSeconds);
    const rememberToken = issueRememberAccessToken(
      { galleryId: gallery.galleryId, userId: req.authUser?.userId },
      config.unlockJwtSecret,
      config.rememberGalleryAccessTtlSeconds
    );
    auditLog(req, 'gallery.unlock.success', { galleryId: gallery.galleryId });
    return res.json({
      unlockToken,
      expiresInSeconds: config.unlockTokenTtlSeconds,
      rememberToken,
      rememberExpiresInSeconds: config.rememberGalleryAccessTtlSeconds
    });
  });

  app.get('/galleries/:slug/premium-images', async (req, res) => {
    const gallery = await store.getGalleryBySlug(req.params.slug);
    if (!gallery || gallery.status !== 'published') {
      return res.status(404).json({ message: 'Gallery not found' });
    }

    const hasUserAccess = req.authUser?.userId ? await store.hasGalleryAccess(req.authUser.userId, gallery.galleryId) : false;
    const unlockToken = req.headers['x-unlock-token'];
    const rememberToken = req.headers['x-gallery-access-token'];
    if (!hasUserAccess && typeof unlockToken !== 'string' && typeof rememberToken !== 'string') {
      return res.status(401).json({ message: 'Unlock token required' });
    }

    if (!hasUserAccess) {
      const scopedToken = typeof unlockToken === 'string' ? unlockToken : String(rememberToken);
      try {
        const payload = verifyUnlockToken(scopedToken, config.unlockJwtSecret);
        if (payload.galleryId !== gallery.galleryId) {
          return res.status(403).json({ message: 'Invalid unlock token scope' });
        }
        if (typeof unlockToken === 'string' && payload.tokenType !== 'unlock') {
          return res.status(401).json({ message: 'Invalid unlock token type' });
        }
        if (typeof rememberToken === 'string' && payload.tokenType !== 'remember') {
          return res.status(401).json({ message: 'Invalid gallery access token type' });
        }
      } catch {
        return res.status(401).json({ message: 'Invalid unlock token' });
      }
    }

    const viewerPolicy = await resolveViewerContentPolicy(req);
    const mediaItems = await store.getMediaByGallery(gallery.galleryId);
    const premiumMedia = await Promise.all(mediaItems
      .filter((item) => Boolean(item.premiumKey))
      .map(async (item) => {
        const effectiveRating = getEffectiveContentRating(item);
        const effectiveAiDisclosure = getEffectiveAiDisclosure(item, gallery);
        const effectiveHeavyTopics = getEffectiveHeavyTopics(item, gallery);
        const contentProjection = projectContentRating(effectiveRating, viewerPolicy);
        const disclosureProjection = projectDisclosures(effectiveAiDisclosure, effectiveHeavyTopics);
        if (contentProjection.blurred) {
          return {
            imageId: item.mediaId,
            assetType: item.assetType || 'image',
            ...contentProjection,
            ...disclosureProjection,
            premiumUrl: (await publicMediaUrl(item.previewKey)) || '',
            premiumPosterUrl: await publicMediaUrl(item.previewPosterKey)
          };
        }
        return {
          imageId: item.mediaId,
          assetType: item.assetType || 'image',
          ...contentProjection,
          ...disclosureProjection,
          premiumUrl: (await privateMediaUrl(item.premiumKey!)) || '',
          premiumPosterUrl: await privateMediaUrl(item.premiumPosterKey)
        };
      }));

    return res.json(premiumMedia);
  });

  app.get('/galleries/:slug/comments', async (req, res) => {
    const gallery = await store.getGalleryBySlug(req.params.slug);
    if (!gallery) {
      return res.status(404).json({ message: 'Gallery not found' });
    }
    const comments = await store.listComments('gallery', gallery.galleryId);
    return res.json(comments.map(toPublicComment));
  });

  app.post('/galleries/:slug/comments', requireAuth, async (req, res) => {
    const gallery = await store.getGalleryBySlug(req.params.slug);
    if (!gallery) {
      return res.status(404).json({ message: 'Gallery not found' });
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

    const requestedProfileType = req.body?.authorProfileType === 'artist' ? 'artist' : 'user';
    let authorProfileType: 'user' | 'artist' = 'user';
    let authorProfileId = 'profile';
    let displayName = req.authUser!.displayName;
    if (requestedProfileType === 'artist') {
      const requestedArtistId = typeof req.body?.authorProfileId === 'string' ? req.body.authorProfileId : '';
      const artists = await store.listArtists();
      const artist = artists.find((item) => item.artistId === requestedArtistId);
      if (!artist) {
        return res.status(400).json({ message: 'Artist profile not found' });
      }
      if (!(await ensureArtistContentAccess(req, res, artist.artistId))) {
        return;
      }
      authorProfileType = 'artist';
      authorProfileId = artist.slug;
      displayName = artist.name;
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
      targetType: 'gallery' as const,
      targetId: gallery.galleryId,
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

    const requestedProfileType = req.body?.authorProfileType === 'artist' ? 'artist' : 'user';
    let authorProfileType: 'user' | 'artist' = 'user';
    let authorProfileId = 'profile';
    let displayName = req.authUser!.displayName;
    if (requestedProfileType === 'artist') {
      const requestedArtistId = typeof req.body?.authorProfileId === 'string' ? req.body.authorProfileId : '';
      const artists = await store.listArtists();
      const artist = artists.find((item) => item.artistId === requestedArtistId);
      if (!artist) {
        return res.status(400).json({ message: 'Artist profile not found' });
      }
      if (!(await ensureArtistContentAccess(req, res, artist.artistId))) {
        return;
      }
      authorProfileType = 'artist';
      authorProfileId = artist.slug;
      displayName = artist.name;
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
      return res.status(403).json({ message: 'Artist access required for artist profile actions' });
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

  app.get('/me/artists', requireAuth, async (req, res) => {
    try {
      const artists = isAdminRequest(req)
        ? await store.listArtists()
        : await store.listArtistsByUserId(req.authUser!.userId);
      if (isAdminRequest(req)) {
        return res.json(artists.map((artist) => ({ ...artist, memberRole: 'admin' })));
      }
      const memberships = await Promise.all(
        artists.map(async (artist) => {
          const member = await getArtistMembership(artist.artistId, req.authUser!.userId);
          return { ...artist, memberRole: member?.role || 'editor' };
        })
      );
      return res.json(memberships);
    } catch (error) {
      logServerError('GET /me/artists', error);
      res.setHeader('x-api-fallback', 'me-artists-empty');
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
    if ((targetType !== 'gallery' && targetType !== 'image' && targetType !== 'collection') || !targetId) {
      return res.status(400).json({ message: 'targetType and targetId are required' });
    }

    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`favorite:add:${req.authUser!.userId}:${ip}`, 60_000, 90)) {
      return res.status(429).json({ message: 'Too many favorite requests, try again later' });
    }

    const ownerProfile = await resolveOwnerProfile(req, req.body);
    if (!ownerProfile) {
      return res.status(403).json({ message: 'Artist access required for artist profile actions' });
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
    if ((targetType !== 'gallery' && targetType !== 'image' && targetType !== 'collection') || !targetId) {
      return res.status(400).json({ message: 'targetType and targetId are required' });
    }

    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`favorite:remove:${req.authUser!.userId}:${ip}`, 60_000, 90)) {
      return res.status(429).json({ message: 'Too many favorite requests, try again later' });
    }

    const ownerProfile = await resolveOwnerProfile(req, req.body);
    if (!ownerProfile) {
      return res.status(403).json({ message: 'Artist access required for artist profile actions' });
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

  app.post('/artists/:artistId/follow', requireAuth, async (req, res) => {
    const artists = await store.listArtists();
    const artist = artists.find((item) => item.artistId === req.params.artistId);
    if (!artist || artist.status !== 'active') {
      return res.status(404).json({ message: 'Artist not found' });
    }
    const follow = {
      followId: randomUUID(),
      followerUserId: req.authUser!.userId,
      artistId: artist.artistId,
      notificationsEnabled: Boolean(req.body?.notificationsEnabled),
      insertedDate: new Date().toISOString()
    };
    await store.followArtist(follow);
    auditLog(req, 'follow.add', { artistId: follow.artistId });
    return res.status(201).json(follow);
  });

  app.delete('/artists/:artistId/follow', requireAuth, async (req, res) => {
    await store.unfollowArtist(req.authUser!.userId, req.params.artistId);
    auditLog(req, 'follow.remove', { artistId: req.params.artistId });
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
      return res.status(403).json({ message: 'Artist access required for artist profile actions' });
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
      return res.status(403).json({ message: 'Artist access required for artist profile actions' });
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

  app.get('/admin/artists', requireAuth, async (req, res) => {
    const artists = isAdminRequest(req)
      ? await store.listArtists()
      : await store.listArtistsByUserId(req.authUser!.userId);
    return res.json(artists);
  });

  app.get('/admin/audit', requireAdmin, async (req, res) => {
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

  app.post('/admin/artists', requireAuth, async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const slug = slugify(String(req.body?.slug || name || randomUUID().slice(0, 8)));
    const artists = await store.listArtists();
    const conflict = artists.find((item) => artistHasSlug(item, slug));
    if (conflict) {
      return res.status(409).json({ message: 'Artist slug is already taken.', slug });
    }

    const artist: Artist = {
      artistId: randomUUID(),
      name,
      slug,
      slugHistory: uniqueSlugs([slug]),
      discoverSquareCropEnabled: typeof req.body?.discoverSquareCropEnabled === 'boolean'
        ? req.body.discoverSquareCropEnabled
        : true,
      defaultAiDisclosure: parseOptionalAiDisclosure(req.body?.defaultAiDisclosure) || 'none',
      defaultHeavyTopics: parseOptionalHeavyTopics(req.body?.defaultHeavyTopics) || [],
      status: req.body?.status === 'inactive' ? 'inactive' : 'active',
      sortOrder: Number(req.body?.sortOrder || 0),
      createdAt: new Date().toISOString()
    };
    await store.createArtist(artist);
    await store.addArtistMember({
      artistId: artist.artistId,
      userId: req.authUser!.userId,
      role: 'owner',
      invitedByUserId: req.authUser!.userId,
      createdAt: new Date().toISOString()
    });
    return res.status(201).json(artist);
  });

  app.get('/admin/artists/:artistId/members', requireAuth, async (req, res) => {
    if (!(await ensureArtistContentAccess(req, res, req.params.artistId))) {
      return;
    }
    const members = await store.listArtistMembers(req.params.artistId);
    return res.json(members);
  });

  app.post('/admin/artists/:artistId/members', requireAuth, async (req, res) => {
    if (!(await ensureArtistAccountAccess(req, res, req.params.artistId))) {
      return;
    }
    const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    const role = req.body?.role === 'owner' || req.body?.role === 'manager' || req.body?.role === 'editor'
      ? req.body.role
      : 'editor';
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }
    const member: ArtistMember = {
      artistId: req.params.artistId,
      userId,
      role,
      invitedByUserId: req.authUser!.userId,
      createdAt: new Date().toISOString()
    };
    await store.addArtistMember(member);
    return res.status(201).json(member);
  });

  app.delete('/admin/artists/:artistId/members/:userId', requireAuth, async (req, res) => {
    if (!(await ensureArtistAccountAccess(req, res, req.params.artistId))) {
      return;
    }
    await store.removeArtistMember(req.params.artistId, req.params.userId);
    return res.status(204).send();
  });

  app.patch('/admin/artists/:artistId', requireAuth, async (req, res) => {
    if (!(await ensureArtistAccountAccess(req, res, req.params.artistId))) {
      return;
    }
    const artists = await store.listArtists();
    const existing = artists.find((artist) => artist.artistId === req.params.artistId);
    if (!existing) {
      return res.status(404).json({ message: 'Artist not found' });
    }

    const nextSlug = req.body?.slug ? slugify(String(req.body.slug)) : existing.slug;
    const nextSlugHistory = uniqueSlugs([...(existing.slugHistory || [existing.slug]), nextSlug]);
    const conflictSlug = nextSlugHistory.find((slug) =>
      artists.some((item) => item.artistId !== existing.artistId && artistHasSlug(item, slug))
    );
    if (conflictSlug) {
      return res.status(409).json({ message: 'Artist slug is already taken.', slug: conflictSlug });
    }

    const updated: Artist = {
      ...existing,
      name: req.body?.name ? String(req.body.name) : existing.name,
      slug: nextSlug,
      slugHistory: nextSlugHistory,
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

    await store.updateArtist(updated);
    return res.json(updated);
  });

  app.delete('/admin/artists/:artistId', requireAuth, async (req, res) => {
    if (!(await ensureArtistAccountAccess(req, res, req.params.artistId))) {
      return;
    }
    await store.deleteArtist(req.params.artistId);
    return res.status(204).send();
  });

  app.patch('/admin/site-settings', requireAdmin, async (req, res) => {
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

  app.post('/admin/site-settings/logo-upload-url', requireAdmin, async (req, res) => {
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

  app.get('/admin/galleries', requireAuth, async (req, res) => {
    const galleries = await store.listAllGalleries();
    if (isAdminRequest(req)) {
      return res.json(galleries.map((gallery) => ({ ...gallery, premiumPasswordHash: undefined })));
    }
    const allowedArtistIds = new Set((await store.listArtistsByUserId(req.authUser!.userId)).map((artist) => artist.artistId));
    const scoped = galleries.filter((gallery) => allowedArtistIds.has(gallery.artistId));
    return res.json(scoped.map((gallery) => ({ ...gallery, premiumPasswordHash: undefined })));
  });

  app.post('/admin/galleries', requireAuth, async (req, res) => {
    const artistId = String(req.body?.artistId || '');
    if (!(await ensureArtistContentAccess(req, res, artistId))) {
      return;
    }
    const visibility: Gallery['visibility'] = req.body?.visibility === 'premium'
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

    const gallery: Gallery = {
      galleryId: randomUUID(),
      artistId,
      artistSlug: String(req.body?.artistSlug || ''),
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
      pairedPremiumGalleryId: req.body?.pairedPremiumGalleryId ? String(req.body.pairedPremiumGalleryId) : undefined,
      purchaseUrl: req.body?.purchaseUrl ? String(req.body.purchaseUrl) : undefined,
      status: req.body?.status === 'published' ? 'published' : 'draft',
      premiumPasswordHash: passwordHash,
      createdAt: new Date().toISOString()
    };

    await store.createGallery(gallery);
    return res.status(201).json({ ...gallery, premiumPasswordHash: undefined });
  });

  app.patch('/admin/galleries/:galleryId', requireAuth, async (req, res) => {
    const galleries = await store.listAllGalleries();
    const existing = galleries.find((gallery) => gallery.galleryId === req.params.galleryId);
    if (!existing) {
      return res.status(404).json({ message: 'Gallery not found' });
    }
    if (!(await ensureArtistContentAccess(req, res, existing.artistId))) {
      return;
    }
    if (req.body?.artistId && String(req.body.artistId) !== existing.artistId) {
      if (!(await ensureArtistContentAccess(req, res, String(req.body.artistId)))) {
        return;
      }
    }

    const visibility: Gallery['visibility'] = req.body?.visibility === 'premium'
      ? 'premium'
      : (req.body?.visibility === 'preview' ? 'preview' : (req.body?.visibility === 'free' ? 'free' : existing.visibility));
    const nextTitle = req.body?.title ? String(req.body.title) : existing.title;
    const nextSlug = req.body?.slug
      ? slugify(String(req.body.slug))
      : (req.body?.title ? slugify(String(req.body.title)) : existing.slug);

    const updated: Gallery = {
      ...existing,
      artistId: req.body?.artistId ? String(req.body.artistId) : existing.artistId,
      artistSlug: req.body?.artistSlug ? String(req.body.artistSlug) : existing.artistSlug,
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
      pairedPremiumGalleryId: req.body?.pairedPremiumGalleryId !== undefined
        ? (req.body.pairedPremiumGalleryId ? String(req.body.pairedPremiumGalleryId) : undefined)
        : existing.pairedPremiumGalleryId,
      purchaseUrl: req.body?.purchaseUrl !== undefined
        ? (req.body.purchaseUrl ? String(req.body.purchaseUrl) : undefined)
        : existing.purchaseUrl,
      status: req.body?.status === 'published' ? 'published' : (req.body?.status === 'draft' ? 'draft' : existing.status)
    };

    if (req.body?.premiumPassword && visibility === 'premium') {
      updated.premiumPasswordHash = await hashPassword(String(req.body.premiumPassword));
    } else if (visibility === 'free') {
      updated.premiumPasswordHash = undefined;
    }

    await store.updateGallery(updated);
    return res.json({ ...updated, premiumPasswordHash: undefined });
  });

  app.delete('/admin/galleries/:galleryId', requireAuth, async (req, res) => {
    const gallery = (await store.listAllGalleries()).find((item) => item.galleryId === req.params.galleryId);
    if (!gallery) {
      return res.status(404).json({ message: 'Gallery not found' });
    }
    if (!(await ensureArtistContentAccess(req, res, gallery.artistId))) {
      return;
    }
    await store.deleteGallery(req.params.galleryId);
    return res.status(204).send();
  });

  app.get('/admin/galleries/:galleryId/images', requireAuth, async (req, res) => {
    const gallery = (await store.listAllGalleries()).find((item) => item.galleryId === req.params.galleryId);
    if (!gallery) {
      return res.status(404).json({ message: 'Gallery not found' });
    }
    if (!(await ensureArtistContentAccess(req, res, gallery.artistId))) {
      return;
    }
    const mediaItems = await store.getMediaByGallery(req.params.galleryId);
    return res.json(mediaItems.map((item) => ({ ...item, imageId: item.mediaId, sortOrder: item.position })));
  });

  app.post('/admin/images', requireAuth, async (req, res) => {
    const galleryId = String(req.body?.galleryId || '');
    const position = Number(req.body?.sortOrder || 0);
    const gallery = (await store.listAllGalleries()).find((item) => item.galleryId === galleryId);
    if (!gallery) {
      return res.status(400).json({ message: 'galleryId is required and must exist' });
    }
    if (!(await ensureArtistContentAccess(req, res, gallery.artistId))) {
      return;
    }
    const originalFilename = req.body?.originalFilename ? String(req.body.originalFilename) : undefined;
    const title = req.body?.title
      ? String(req.body.title).trim()
      : (originalFilename ? originalFilename.replace(/\.[^.]+$/, '') : undefined);
    const slug = title ? slugify(title) : undefined;
    const media: Media = {
      mediaId: randomUUID(),
      artistId: gallery.artistId,
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
      const targetPrefix = `${gallery.artistId}/${media.mediaId}`;
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

    await store.createMedia(media, galleryId, position);
    return res.status(201).json({ ...media, imageId: media.mediaId, galleryId, sortOrder: position });
  });

  app.patch('/admin/images/:galleryId/:imageId', requireAuth, async (req, res) => {
    const gallery = (await store.listAllGalleries()).find((item) => item.galleryId === req.params.galleryId);
    if (!gallery) {
      return res.status(404).json({ message: 'Gallery not found' });
    }
    if (!(await ensureArtistContentAccess(req, res, gallery.artistId))) {
      return;
    }
    const mediaItems = await store.getMediaByGallery(req.params.galleryId);
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
      const targetPrefix = `${gallery.artistId || existing.artistId}/${updated.mediaId}`;
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
    if (nextPosition !== existing.position) {
      await store.moveMediaInGallery(req.params.galleryId, updated.mediaId, nextPosition);
    }
    return res.json({ ...updated, imageId: updated.mediaId, galleryId: req.params.galleryId, sortOrder: nextPosition });
  });

  app.post('/admin/images/:galleryId/:imageId/renditions', requireAuth, async (req, res) => {
    const gallery = (await store.listAllGalleries()).find((item) => item.galleryId === req.params.galleryId);
    if (!gallery) {
      return res.status(404).json({ message: 'Gallery not found' });
    }
    if (!(await ensureArtistContentAccess(req, res, gallery.artistId))) {
      return;
    }
    const mediaItems = await store.getMediaByGallery(req.params.galleryId);
    const existing = mediaItems.find((item) => item.mediaId === req.params.imageId);
    if (!existing) {
      return res.status(404).json({ message: 'Image not found' });
    }
    if ((existing.assetType || 'image') !== 'image') {
      return res.status(400).json({ message: 'Renditions only apply to image assets' });
    }

    const targetPrefix = `${gallery.artistId || existing.artistId}/${existing.mediaId}`;
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
    return res.json({ ...updated, imageId: updated.mediaId, galleryId: req.params.galleryId, sortOrder: existing.position });
  });

  app.delete('/admin/images/:galleryId/:imageId', requireAuth, async (req, res) => {
    const gallery = (await store.listAllGalleries()).find((item) => item.galleryId === req.params.galleryId);
    if (!gallery) {
      return res.status(404).json({ message: 'Gallery not found' });
    }
    if (!(await ensureArtistContentAccess(req, res, gallery.artistId))) {
      return;
    }
    await store.deleteMediaFromGallery(req.params.galleryId, req.params.imageId);
    return res.status(204).send();
  });

  app.patch('/admin/comments/:commentId', requireAdmin, async (req, res) => {
    await store.updateCommentVisibility(req.params.commentId, Boolean(req.body?.hidden));
    return res.status(204).send();
  });

  app.delete('/admin/comments/:commentId', requireAdmin, async (req, res) => {
    await store.deleteComment(req.params.commentId);
    return res.status(204).send();
  });

  app.post('/admin/users/:userId/block', requireAdmin, async (req, res) => {
    await store.blockUser({ userId: req.params.userId, reason: req.body?.reason, blockedAt: new Date().toISOString() });
    return res.status(201).json({ userId: req.params.userId, blocked: true });
  });

  app.delete('/admin/users/:userId/block', requireAdmin, async (req, res) => {
    await store.unblockUser(req.params.userId);
    return res.status(204).send();
  });

  app.post('/admin/trending/rebuild', requireAdmin, async (_req, res) => {
    const startedAt = Date.now();
    try {
      const stats = await refreshTrendingFeeds(store, config, Date.now());
      return res.json({
        ok: true,
        durationMs: Date.now() - startedAt,
        stats
      });
    } catch (error) {
      logServerError('POST /admin/trending/rebuild', error);
      return res.status(500).json({ message: 'Failed to rebuild trending feed' });
    }
  });

  return app;
};
