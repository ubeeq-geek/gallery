import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from './api';
import { StudioWorkspace } from './StudioWorkspace';
import { ForCreatorsPage } from './pages/ForCreatorsPage';
import DiscoveryQuickReadOverlay, { type DiscoveryOverlayItem } from './components/DiscoveryQuickReadOverlay';
import {
  changePassword,
  clearStoredAuthSession,
  confirmForgotPassword,
  confirmRegistration,
  forgotPassword,
  getCurrentUser,
  startEmailOtpSignIn,
  setInitialPassword,
  signIn,
  signOut,
  verifyEmailOtpSignIn,
  type CurrentUser
} from './cognitoAuth';

type Artist = { artistId: string; name: string; slug: string; artistThumbnailUrl?: string };
type ManagedArtist = Artist & { memberRole?: 'owner' | 'manager' | 'editor' | 'admin' };
type FeedDensity = 'small' | 'medium' | 'large';
type DensityViewport = 'mobile' | 'tablet' | 'desktop';
type DiscoveryFilterSection = 'period' | 'density' | 'media' | 'heavy' | 'search';
type DiscoveryDockSummary = {
  active: boolean;
  viewport: DensityViewport;
  period: 'hourly' | 'daily';
  periodLabel?: string;
  density: FeedDensity;
  mediaLabel: string;
  showImages: boolean;
  showVideos: boolean;
  showPosts: boolean;
  heavyLabel:
    | 'Heavy Shown'
    | 'Some Heavy'
    | 'Heavy Hidden'
    | 'Heavy Topics Shown'
    | 'Some Heavy Topics'
    | 'Heavy Topics Hidden';
  searchActive: boolean;
};
const DISCOVERY_FILTER_EVENT_NAME = 'ubeeq:discovery-filters';
const OTP_TRUST_DAYS = 30;
const otpTrustStorageKey = (email: string) => `ubeeq.otpTrust.${email.trim().toLowerCase()}`;
const hasValidOtpTrust = (email: string): boolean => {
  if (!email.trim()) return false;
  const raw = localStorage.getItem(otpTrustStorageKey(email));
  if (!raw) return false;
  const expiresAt = Number(raw);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    localStorage.removeItem(otpTrustStorageKey(email));
    return false;
  }
  return true;
};
const rememberOtpTrust = (email: string) => {
  if (!email.trim()) return;
  const expiresAt = Date.now() + OTP_TRUST_DAYS * 24 * 60 * 60 * 1000;
  localStorage.setItem(otpTrustStorageKey(email), String(expiresAt));
};
type RoleNotificationCounts = { studio: number; admin: number };
type PlatformRole = 'user' | 'contributor' | 'creator' | 'admin';
const ROLE_DISPLAY_LABELS: Partial<Record<PlatformRole, string>> = {
  contributor: 'Beeker'
};
const roleDisplayLabel = (role: PlatformRole): string => ROLE_DISPLAY_LABELS[role] || role[0].toUpperCase() + role.slice(1);
const ROLE_NOTIFICATION_STORAGE_KEY = 'ubeeq.roleNotifications';
const sanitizeNotificationCount = (value: unknown): number => {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return 0;
  return Math.max(0, Math.trunc(normalized));
};
const readRoleNotificationCounts = (): Partial<RoleNotificationCounts> => {
  try {
    const raw = localStorage.getItem(ROLE_NOTIFICATION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      studio: sanitizeNotificationCount(parsed.studio),
      admin: sanitizeNotificationCount(parsed.admin)
    };
  } catch {
    return {};
  }
};
const extractStudioNotificationCount = (artist: ManagedArtist): number => {
  const candidate = artist as unknown as Record<string, unknown>;
  return sanitizeNotificationCount(
    candidate.studioNotificationCount
      ?? candidate.notificationCount
      ?? candidate.notifications
      ?? candidate.unreadCount
  );
};
const formatNotificationBadge = (count: number): string => {
  if (count > 99) return '99+';
  return `${count}`;
};
type ContentRating = 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
type AiDisclosure = 'none' | 'ai-assisted' | 'ai-generated';
type AiFilterPreference = 'show-all' | 'hide-ai-generated' | 'hide-all-ai';
type HeavyTopic = 'politics-public-affairs' | 'crime-disasters-tragedy';
const contentRatingOptions: Array<{ value: ContentRating; label: string }> = [
  { value: 'general', label: 'General' },
  { value: 'suggestive', label: 'Suggestive' },
  { value: 'mature', label: 'Mature' },
  { value: 'sexual', label: 'Sexual' },
  { value: 'fetish', label: 'Fetish' },
  { value: 'graphic', label: 'Graphic' }
];
const aiFilterOptions: Array<{ value: AiFilterPreference; label: string }> = [
  { value: 'show-all', label: 'Show all content' },
  { value: 'hide-ai-generated', label: 'Hide AI-generated content' },
  { value: 'hide-all-ai', label: 'Hide AI-generated and AI-assisted content' }
];
const heavyTopicLabels: Record<HeavyTopic, string> = {
  'politics-public-affairs': 'Politics & Public Affairs',
  'crime-disasters-tragedy': 'Crime, Disasters & Tragedy'
};
const formatDisclosureLine = (item: {
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
type DiscoveryMediaFilters = {
  showImages: boolean;
  showVideos: boolean;
  showPosts: boolean;
};
const getDiscoveryMediaLabel = (filters: DiscoveryMediaFilters): string => {
  const parts: string[] = [];
  if (filters.showImages) parts.push('Images');
  if (filters.showVideos) parts.push('Videos');
  if (filters.showPosts) parts.push('Posts');
  return parts.length > 0 ? parts.join(' + ') : 'None';
};
type DiscoveryMediaKind = 'image' | 'video' | 'post';
const DiscoveryMediaIcon = ({ kind, className }: { kind: DiscoveryMediaKind; className?: string }) => {
  if (kind === 'video') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
        <rect x="2.5" y="4.5" width="10.5" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M9 8.2L12.4 10L9 11.8V8.2Z" fill="currentColor" />
        <path d="M13 8L17 5.8V14.2L13 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'post') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
        <rect x="3" y="2.8" width="14" height="14.4" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M6.2 7.1H13.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M6.2 10H13.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M6.2 12.9H10.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
      <rect x="2.8" y="3.3" width="14.4" height="13.4" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="7.2" cy="8.1" r="1.3" fill="currentColor" />
      <path d="M4.7 14L8.2 10.5C8.6 10.1 9.2 10.1 9.6 10.5L11 11.9C11.4 12.3 12 12.3 12.4 11.9L15.3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};
const DiscoveryMediaIndicator = ({
  showImages,
  showVideos,
  showPosts
}: {
  showImages: boolean;
  showVideos: boolean;
  showPosts: boolean;
}) => (
  <span className="discovery-media-indicator" aria-hidden="true">
    {showImages && <DiscoveryMediaIcon kind="image" className="discovery-media-icon" />}
    {showVideos && <DiscoveryMediaIcon kind="video" className="discovery-media-icon" />}
    {showPosts && <DiscoveryMediaIcon kind="post" className="discovery-media-icon" />}
  </span>
);
const passesDiscoveryMediaFilter = (
  item: { assetType?: 'image' | 'video'; surfaceType?: 'media' | 'post'; postId?: string },
  filters: DiscoveryMediaFilters
): boolean => {
  const isPostSurface = item.surfaceType === 'post' || Boolean(item.postId);
  if (isPostSurface) return filters.showPosts;
  const normalizedType = item.assetType === 'video' ? 'video' : 'image';
  if (normalizedType === 'video') return filters.showVideos;
  return filters.showImages;
};
const passesAiDisclosureFilter = (aiDisclosure: AiDisclosure | undefined, aiFilter: AiFilterPreference): boolean => {
  const normalized = aiDisclosure || 'none';
  if (aiFilter === 'hide-ai-generated') return normalized !== 'ai-generated';
  if (aiFilter === 'hide-all-ai') return normalized === 'none';
  return true;
};
const passesHeavyTopicFilter = (
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
const matchesDiscoverySearch = (needle: string, fields: Array<string | undefined>): boolean => {
  const trimmed = needle.trim().toLowerCase();
  if (!trimmed) return true;
  return fields
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(trimmed);
};
const getDensityRangeStyle = (sliderValue: number): CSSProperties => {
  const clamped = Math.max(0, Math.min(2, sliderValue));
  const darkSegmentWidth = 64;
  const start = (clamped / 2) * (100 - darkSegmentWidth);
  const end = start + darkSegmentWidth;
  return {
    ['--density-start' as any]: `${start}%`,
    ['--density-end' as any]: `${end}%`
  };
};
const guessArtistNameFromSlug = (slug?: string): string => {
  if (!slug) return '';
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};
const normalizeCreatorProfilePayload = (raw: CreatorProfilePayload): CreatorProfilePayload => {
  const normalizedGalleries = raw.galleries || raw.groupings || [];
  return {
    ...raw,
    artistId: raw.artistId || raw.creatorId || '',
    galleries: normalizedGalleries,
    groupings: normalizedGalleries,
    publicFavoritesByType: {
      images: raw.publicFavoritesByType?.images || [],
      galleries: raw.publicFavoritesByType?.galleries || [],
      collections: raw.publicFavoritesByType?.collections || []
    },
    publicCollections: raw.publicCollections || []
  };
};
const isUnauthorizedError = (value: unknown): boolean => {
  const message = value instanceof Error ? value.message : String(value || '');
  return /\b401\b|unauthorized|not authorized/i.test(message);
};
type CollectionSummary = {
  collectionId: string;
  ownerUserId: string;
  title: string;
  description?: string;
  coverImageId?: string;
  visibility: 'public' | 'private';
  insertedDate: string;
  updatedDate: string;
  imageCount: number;
  favoriteCount: number;
};
type TrendingImage = {
  imageId: string;
  assetType?: 'image' | 'video';
  surfaceType?: 'media' | 'post';
  postId?: string;
  postSlug?: string;
  postTitle?: string;
  postSummary?: string;
  artistId: string;
  artistName: string;
  galleryId: string;
  gallerySlug: string;
  galleryVisibility?: 'free' | 'preview' | 'premium';
  discoverSquareCropEnabled?: boolean;
  effectiveContentRating?: ContentRating;
  displayedContentRating?: string;
  blurred?: boolean;
  effectiveAiDisclosure?: AiDisclosure;
  displayedAiDisclosure?: string;
  effectiveHeavyTopics?: HeavyTopic[];
  displayedHeavyTopics?: string[];
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
};

type PostBlockType =
  | 'heading'
  | 'paragraph'
  | 'image'
  | 'video'
  | 'audio'
  | 'quote'
  | 'divider'
  | 'embed'
  | 'file'
  | 'link'
  | 'gallery'
  | 'carousel'
  | 'pdf_preview'
  | 'html_fragment';

const buildImageSrcSet = (thumbnailUrls?: TrendingImage['thumbnailUrls']): string | undefined => {
  if (!thumbnailUrls) return undefined;
  const entries: Array<[keyof NonNullable<TrendingImage['thumbnailUrls']>, number]> = [
    ['w320', 320],
    ['w640', 640],
    ['w1280', 1280],
    ['w1920', 1920]
  ];
  const parts = entries
    .map(([key, width]) => thumbnailUrls[key] ? `${thumbnailUrls[key]} ${width}w` : '')
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
};

type PostBlock = {
  blockId: string;
  type: PostBlockType;
  text?: string;
  level?: number;
  mediaId?: string;
  caption?: string;
  quote?: string;
  author?: string;
  url?: string;
  mimeType?: string;
  title?: string;
  html?: string;
  payload?: Record<string, unknown>;
};

type CreatorPostSummary = {
  postId: string;
  artistId?: string;
  creatorId?: string;
  title: string;
  slug: string;
  summary?: string;
  status: 'draft' | 'published' | 'archived';
  discovery: { mode: 'primary' | 'all' | 'selected' };
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  mediaCount: number;
  blockCount: number;
  primaryMediaId?: string;
  discoveryMediaIds?: string[];
  primaryMedia?: {
    mediaId: string;
    assetType: 'image' | 'video';
    previewUrl: string;
    previewPosterUrl?: string;
    width?: number;
    height?: number;
  } | null;
  discoveryMedia?: Array<{
    mediaId: string;
    assetType: 'image' | 'video';
    previewUrl: string;
    previewPosterUrl?: string;
    width?: number;
    height?: number;
  }>;
};

type PostDetailPayload = {
  postId: string;
  artistId: string;
  title: string;
  slug: string;
  summary?: string;
  status: 'draft' | 'published' | 'archived';
  discovery: { mode: 'primary' | 'all' | 'selected' };
  primaryMediaId?: string;
  destination?: { type: 'post' | 'pdf' | 'external' | 'internal'; url: string } | null;
  metadata?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  blocks: PostBlock[];
  media: Array<{
    mediaId: string;
    assetType: 'image' | 'video';
    title?: string;
    previewUrl: string;
    previewPosterUrl?: string;
    width?: number;
    height?: number;
    discoverable?: boolean;
    sortOrder?: number;
    caption?: string;
  }>;
  creator?: {
    artistId?: string;
    creatorId: string;
    name: string;
    slug: string;
  };
  artist?: {
    artistId: string;
    name: string;
    slug: string;
  };
};

const isLikelyImageUrl = (url?: string): boolean => {
  if (!url) return false;
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)(\?|#|$)/i.test(url);
};
type CreatorProfilePayload = {
  artistId?: string;
  creatorId?: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive';
  defaultProfileTab?: 'feed' | 'galleries';
  followerCount: number;
  imageCount: number;
  galleryCount: number;
  feedItems?: Array<{
    imageId: string;
    title: string;
    assetType: 'image' | 'video';
    createdAt: string;
    previewUrl?: string;
    previewPosterUrl?: string;
    effectiveContentRating?: ContentRating;
    displayedContentRating?: string;
    blurred?: boolean;
    effectiveAiDisclosure?: AiDisclosure;
    displayedAiDisclosure?: string;
    effectiveHeavyTopics?: HeavyTopic[];
    displayedHeavyTopics?: string[];
    favoriteCount?: number;
  }>;
  featured?: {
    items: Array<{ imageId: string; title: string; previewUrl?: string; previewPosterUrl?: string }>;
    galleries: Array<{ galleryId: string; title: string; slug: string; visibility: 'free' | 'preview' | 'premium'; galleryThumbnailUrl?: string }>;
  };
  trendingImages: TrendingImage[];
  galleries?: Array<{
    galleryId: string;
    title: string;
    slug: string;
    visibility: 'free' | 'preview' | 'premium';
    createdAt: string;
    imageCount: number;
    favoriteCount: number;
    galleryThumbnailUrl?: string;
  }>;
  groupings?: Array<{
    galleryId: string;
    title: string;
    slug: string;
    visibility: 'free' | 'preview' | 'premium';
    createdAt: string;
    imageCount: number;
    favoriteCount: number;
    galleryThumbnailUrl?: string;
  }>;
  publicFavoritesByType?: {
    images?: Array<{ targetId: string; targetType?: 'image'; createdAt?: string; title?: string; previewUrl?: string }>;
    galleries?: Array<{ targetId: string; targetType?: 'gallery'; createdAt?: string; title?: string; slug?: string; galleryThumbnailUrl?: string }>;
    collections?: Array<{ targetId: string; targetType?: 'collection'; createdAt?: string; title?: string }>;
  };
  publicCollections?: Array<{
    collectionId: string;
    title: string;
    description?: string;
    visibility: 'public' | 'private';
    insertedDate: string;
    updatedDate: string;
    imageCount: number;
    favoriteCount: number;
  }>;
};
type GallerySummary = {
  galleryId: string;
  title: string;
  slug: string;
  visibility: 'free' | 'preview' | 'premium';
  hasAccess?: boolean;
  purchaseUrl?: string;
  galleryThumbnailUrl?: string;
  stackPreviewUrls?: string[];
};
type GalleryAsset = {
  imageId: string;
  title?: string;
  assetType: 'image' | 'video';
  effectiveContentRating?: ContentRating;
  displayedContentRating?: string;
  blurred?: boolean;
  effectiveAiDisclosure?: AiDisclosure;
  displayedAiDisclosure?: string;
  effectiveHeavyTopics?: HeavyTopic[];
  displayedHeavyTopics?: string[];
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
  favoriteCount: number;
};
type Gallery = {
  galleryId: string;
  title: string;
  artistName?: string;
  artistSlug?: string;
  visibility: 'free' | 'preview' | 'premium';
  hasAccess?: boolean;
  purchaseUrl?: string;
  coverMediaId?: string;
  coverPreviewUrl?: string;
  coverBlur?: boolean;
  premiumTeaserMedia?: Array<{
    imageId: string;
    title?: string;
    assetType: 'image' | 'video';
    effectiveContentRating?: ContentRating;
    displayedContentRating?: string;
    blurred?: boolean;
    effectiveAiDisclosure?: AiDisclosure;
    displayedAiDisclosure?: string;
    effectiveHeavyTopics?: HeavyTopic[];
    displayedHeavyTopics?: string[];
    previewUrl: string;
    previewPosterUrl?: string;
  }>;
  favoriteCount: number;
  media: GalleryAsset[];
};
type Comment = {
  commentId: string;
  authorProfileType?: 'user' | 'artist';
  authorProfileId?: string;
  displayName: string;
  body: string;
  createdAt: string;
};
type SiteSettings = { siteName: string; theme: 'ubeeq' | 'sand' | 'forest' | 'slate'; logoUrl?: string };
type UserProfile = {
  userId: string;
  username: string;
  displayName?: string;
  bio?: string;
  location?: string;
  website?: string;
  matureContentEnabled?: boolean;
  maxAllowedContentRating?: ContentRating;
  aiFilter?: AiFilterPreference;
  hideHeavyTopics?: boolean;
  hidePoliticsPublicAffairs?: boolean;
  hideCrimeDisastersTragedy?: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsernameChangeAt?: string;
};
type ManagedFavorite = {
  targetType: 'gallery' | 'image' | 'collection';
  targetId: string;
  visibility?: 'public' | 'private';
  createdAt: string;
};
type ManagedCollection = {
  collectionId: string;
  title: string;
  description?: string;
  visibility: 'public' | 'private';
  imageCount: number;
  favoriteCount: number;
  updatedDate: string;
  imageIds?: string[];
};
type StoredAccessToken = { token: string; expiresAt: number };
type StoredAccessMap = Record<string, StoredAccessToken>;

const GALLERY_ACCESS_STORAGE_KEY = 'gallery.access.tokens';
const AUTH_PERSISTENCE_KEY = 'authPersistence';

const readAccessMap = (): StoredAccessMap => {
  try {
    const raw = localStorage.getItem(GALLERY_ACCESS_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as StoredAccessMap;
  } catch {
    return {};
  }
};

const getStoredGalleryAccessToken = (slug: string): string | undefined => {
  const map = readAccessMap();
  const item = map[slug];
  if (!item) return undefined;
  if (Date.now() > item.expiresAt) {
    delete map[slug];
    localStorage.setItem(GALLERY_ACCESS_STORAGE_KEY, JSON.stringify(map));
    return undefined;
  }
  return item.token;
};

const setStoredGalleryAccessToken = (slug: string, token: string, ttlSeconds: number) => {
  const map = readAccessMap();
  map[slug] = {
    token,
    expiresAt: Date.now() + ttlSeconds * 1000
  };
  localStorage.setItem(GALLERY_ACCESS_STORAGE_KEY, JSON.stringify(map));
};

type AuthMode = 'signin' | 'register' | 'confirm' | 'forgot' | 'initial';

const authLinks: Array<{ mode: AuthMode; label: string }> = [
  { mode: 'signin', label: 'Sign In' },
  { mode: 'register', label: 'Create Account' }
];

function AutoLoadSentinel({
  enabled,
  loading,
  onLoadMore,
  rootMargin = '240px 0px'
}: {
  enabled: boolean;
  loading: boolean;
  onLoadMore: () => Promise<void> | void;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!enabled || loading || !ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void onLoadMore();
      }
    }, { rootMargin });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [enabled, loading, onLoadMore, rootMargin]);

  if (!enabled) return null;
  return (
    <div ref={ref} className="inline-form mt-4">
      <button onClick={() => void onLoadMore()} disabled={loading}>{loading ? 'Loading...' : 'Load more'}</button>
    </div>
  );
}

function HeaderAuth({
  user,
  onSignOut,
  settings,
  profile,
  discoveryDock,
  managedArtists,
  roleNotificationCounts
}: {
  user: CurrentUser;
  onSignOut: () => Promise<void>;
  settings: SiteSettings;
  profile?: UserProfile | null;
  discoveryDock?: DiscoveryDockSummary | null;
  managedArtists?: ManagedArtist[];
  roleNotificationCounts?: RoleNotificationCounts;
}) {
  const location = useLocation();
  const headerRef = useRef<HTMLElement | null>(null);
  const closeUserMenus = () => {
    document.querySelectorAll('details.user-menu[open]').forEach((item) => item.removeAttribute('open'));
  };
  const handleSignOutClick = async () => {
    closeUserMenus();
    await onSignOut();
  };
  const rawDisplay = (profile?.displayName || user?.displayName || '').trim();
  const fallbackIdentity = (user?.email || user?.username || profile?.username || '').trim();
  const initialsSource = rawDisplay || fallbackIdentity;
  const menuSecondaryLabel = (user?.email || fallbackIdentity || '').trim();
  const displayName = rawDisplay || initialsSource
    .split('@')[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  const initials = initialsSource
    .split('@')[0]
    .split(/[.\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || 'U';
  const normalizedGroups = (user?.groups || []).map((group) => group.toLowerCase());
  const isAdmin = normalizedGroups.includes('admin') || normalizedGroups.includes('admins');
  const primaryManagedArtist = (managedArtists || []).find((artist) => Boolean(artist.slug)) || managedArtists?.[0];
  const canAccessStudio = Boolean(primaryManagedArtist);
  const showCreatorNav = Boolean(user) && (canAccessStudio || isAdmin);
  const studioCount = sanitizeNotificationCount(roleNotificationCounts?.studio);
  const adminCount = sanitizeNotificationCount(roleNotificationCounts?.admin);
  const artistProfileHref = primaryManagedArtist?.slug ? `/creators/${primaryManagedArtist.slug}` : '/settings';
  const studioHref = '/studio';
  const adminHref = studioHref;
  const isExternalAdminHref = false;
  const compactNavLabel = canAccessStudio ? 'Creator' : 'Studio';
  const compactNavHref = studioHref;
  const isExternalCompactNavHref = false;
  const compactNavCount = studioCount;
  const isArtistNavActive = location.pathname.startsWith('/creators/');
  const isStudioNavActive = location.pathname.startsWith('/studio');
  const isAdminNavActive = false;
  const showMobileDiscoveryButton = discoveryDock?.viewport === 'mobile';
  const openDiscoveryFilters = (section: DiscoveryFilterSection = 'period') => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent(DISCOVERY_FILTER_EVENT_NAME, {
        detail: { section }
      })
    );
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const header = headerRef.current;
    if (!header) return;
    const updateTopbarHeight = () => {
      const height = Math.max(0, Math.round(header.getBoundingClientRect().height));
      document.documentElement.style.setProperty('--topbar-height', `${height}px`);
    };
    updateTopbarHeight();
    let resizeObserver: ResizeObserver | null = null;
    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(() => updateTopbarHeight());
      resizeObserver.observe(header);
    }
    window.addEventListener('resize', updateTopbarHeight);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateTopbarHeight);
    };
  }, []);

  return (
    <>
      <header className="topbar" ref={headerRef}>
        <div className="topbar-inner">
          <div className="brand">
            <Link to="/" className="no-underline" aria-label="Go to home">
              <div className="brand-css-logo" role="img" aria-label={`${settings.siteName} logo`}>
                <div className="brand-css-orb-wrap">
                  <div className="brand-css-orb">
                    <div className="brand-css-orb-ring brand-css-orb-ring-outer" />
                    <div className="brand-css-orb-ring brand-css-orb-ring-inner" />
                    <div className="brand-css-orb-core" />
                  </div>
                </div>
                <div>
                  <div className="brand-css-wordmark">{settings.siteName}</div>
                  <div className="brand-css-tagline">Creativity. Everywhere.</div>
                </div>
              </div>
            </Link>
          </div>
          {discoveryDock?.active && discoveryDock.viewport !== 'mobile' && (
            <div className="topbar-discovery-summary" aria-label="Discovery filter summary">
              <button type="button" className="topbar-discovery-chip topbar-discovery-chip-interactive topbar-discovery-open-btn" onClick={() => openDiscoveryFilters('period')}>
                <span>Filters</span>
                <DiscoveryMediaIndicator
                  showImages={discoveryDock.showImages}
                  showVideos={discoveryDock.showVideos}
                  showPosts={discoveryDock.showPosts}
                />
              </button>
              <div className="topbar-discovery-chip-list">
                <button type="button" className="topbar-discovery-chip topbar-discovery-chip-interactive" onClick={() => openDiscoveryFilters('period')}>
                  {discoveryDock.periodLabel || (discoveryDock.period === 'daily' ? 'Daily' : 'Hourly')}
                </button>
                <button type="button" className="topbar-discovery-chip topbar-discovery-chip-interactive" onClick={() => openDiscoveryFilters('media')}>
                  {discoveryDock.mediaLabel}
                </button>
                <button type="button" className="topbar-discovery-chip topbar-discovery-chip-interactive" onClick={() => openDiscoveryFilters('density')}>
                  Density: {discoveryDock.density[0].toUpperCase() + discoveryDock.density.slice(1)}
                </button>
                <button type="button" className="topbar-discovery-chip topbar-discovery-chip-interactive" onClick={() => openDiscoveryFilters('heavy')}>
                  {discoveryDock.heavyLabel}
                </button>
                <button type="button" className="topbar-discovery-chip topbar-discovery-chip-interactive" onClick={() => openDiscoveryFilters('search')}>
                  {discoveryDock.searchActive ? 'Search active' : 'Search'}
                </button>
              </div>
            </div>
          )}
          <section className={`auth-panel ${user ? 'auth-panel-user auth-panel-user-desktop' : 'auth-panel-guest'}`}>
            {user ? (
              <div className="auth-line">
                {showCreatorNav && (
                  <>
                    <nav
                      className="hidden items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-2 shadow-sm lg:flex"
                      aria-label="Creator navigation"
                    >
                      {canAccessStudio && (
                        <span className="rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-white">
                          Creator
                        </span>
                      )}
                      {canAccessStudio && (
                        <Link
                          to={artistProfileHref}
                          className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm font-semibold no-underline transition-colors ${isArtistNavActive ? 'bg-emerald-100 text-emerald-900' : 'text-emerald-900 hover:bg-emerald-100'}`}
                        >
                          <span>Profile</span>
                        </Link>
                      )}
                      {canAccessStudio && (
                        <Link
                          to={studioHref}
                          className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm font-semibold no-underline transition-colors ${isStudioNavActive ? 'bg-emerald-100 text-emerald-900' : 'text-emerald-900 hover:bg-emerald-100'}`}
                        >
                          <span>Studio</span>
                          {studioCount > 0 && (
                            <span className="ml-2 inline-flex min-w-[1.15rem] items-center justify-center rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                              {formatNotificationBadge(studioCount)}
                            </span>
                          )}
                        </Link>
                      )}
                      {false && isAdmin && (
                        isExternalAdminHref ? (
                          <a
                            href={adminHref}
                            className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm font-semibold no-underline transition-colors ${isAdminNavActive ? 'bg-emerald-100 text-emerald-900' : 'text-slate-600 hover:bg-emerald-100 hover:text-emerald-900'}`}
                          >
                            <span>Admin</span>
                            {adminCount > 0 && (
                              <span className="ml-2 inline-flex min-w-[1.15rem] items-center justify-center rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                                {formatNotificationBadge(adminCount)}
                              </span>
                            )}
                          </a>
                        ) : (
                          <Link
                            to={adminHref}
                            className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm font-semibold no-underline transition-colors ${isAdminNavActive ? 'bg-emerald-100 text-emerald-900' : 'text-slate-600 hover:bg-emerald-100 hover:text-emerald-900'}`}
                          >
                            <span>Admin</span>
                            {adminCount > 0 && (
                              <span className="ml-2 inline-flex min-w-[1.15rem] items-center justify-center rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                                {formatNotificationBadge(adminCount)}
                              </span>
                            )}
                          </Link>
                        )
                      )}
                    </nav>
                    <nav className="inline-flex items-center lg:hidden" aria-label="Creator navigation">
                      {canAccessStudio ? (
                        <Link
                          to={compactNavHref}
                          className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-900 no-underline transition-colors hover:bg-emerald-100"
                        >
                          <span>{compactNavLabel}</span>
                          {compactNavCount > 0 && (
                            <span className="ml-2 inline-flex min-w-[1.05rem] items-center justify-center rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                              {formatNotificationBadge(compactNavCount)}
                            </span>
                          )}
                        </Link>
                      ) : isExternalCompactNavHref ? (
                        <a
                          href={compactNavHref}
                          className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-900 no-underline transition-colors hover:bg-emerald-100"
                        >
                          <span>{compactNavLabel}</span>
                          {compactNavCount > 0 && (
                            <span className="ml-2 inline-flex min-w-[1.05rem] items-center justify-center rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                              {formatNotificationBadge(compactNavCount)}
                            </span>
                          )}
                        </a>
                      ) : (
                        <Link
                          to={compactNavHref}
                          className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-900 no-underline transition-colors hover:bg-emerald-100"
                        >
                          <span>{compactNavLabel}</span>
                          {compactNavCount > 0 && (
                            <span className="ml-2 inline-flex min-w-[1.05rem] items-center justify-center rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                              {formatNotificationBadge(compactNavCount)}
                            </span>
                          )}
                        </Link>
                      )}
                    </nav>
                  </>
                )}
                <details className="user-menu">
                  <summary className="user-menu-trigger" aria-label="Open account menu">{initials}</summary>
                  <div className="user-menu-items">
                    <div className="user-menu-email">{menuSecondaryLabel || displayName}</div>
                    {canAccessStudio && <Link to={artistProfileHref} onClick={closeUserMenus}>Creator</Link>}
                    {canAccessStudio && (
                      <Link to={studioHref} onClick={closeUserMenus}>
                        Studio{studioCount > 0 ? ` (${formatNotificationBadge(studioCount)})` : ''}
                      </Link>
                    )}
                    {false && isAdmin && (isExternalAdminHref ? (
                      <a href={adminHref} onClick={closeUserMenus}>
                        Admin{adminCount > 0 ? ` (${formatNotificationBadge(adminCount)})` : ''}
                      </a>
                    ) : (
                      <Link to={adminHref} onClick={closeUserMenus}>
                        Admin{adminCount > 0 ? ` (${formatNotificationBadge(adminCount)})` : ''}
                      </Link>
                    ))}
                    <Link to="/settings" onClick={closeUserMenus}>Settings</Link>
                    <button onClick={() => void handleSignOutClick()}>Sign Out</button>
                  </div>
                </details>
              </div>
            ) : (
              <div className="auth-line">
                <div className="auth-links">
                  <Link
                    to="/for-creators"
                    className={`auth-nav-btn auth-nav-btn-secondary${location.pathname.startsWith('/for-creators') ? ' is-active' : ''}`}
                  >
                    For Creators
                  </Link>
                  <Link
                    to="/auth/signin"
                    className={`auth-nav-btn auth-nav-btn-secondary${location.pathname.startsWith('/auth/signin') ? ' is-active' : ''}`}
                  >
                    Sign in
                  </Link>
                  <Link
                    to="/auth/register"
                    className={`auth-nav-btn auth-nav-btn-primary${location.pathname.startsWith('/auth/register') ? ' is-active' : ''}`}
                  >
                    <span className="create-account-label-long">Create account</span>
                    <span className="create-account-label-short">Sign Up</span>
                  </Link>
                </div>
              </div>
            )}
          </section>
        </div>
      </header>

      {user && (
        <div className="mobile-user-dock">
          <div className={`mobile-user-dock-inner${showMobileDiscoveryButton || showCreatorNav ? ' has-discovery' : ''}`}>
            {showMobileDiscoveryButton && (
              <button type="button" className="mobile-discovery-dock-btn" onClick={() => openDiscoveryFilters('period')}>
                <span>Filters</span>
                {discoveryDock && (
                  <DiscoveryMediaIndicator
                    showImages={discoveryDock.showImages}
                    showVideos={discoveryDock.showVideos}
                    showPosts={discoveryDock.showPosts}
                  />
                )}
              </button>
            )}
            {showCreatorNav && (
              canAccessStudio ? (
                <Link to={compactNavHref} className="mobile-creator-dock-btn">
                  <span>{compactNavLabel}</span>
                  {compactNavCount > 0 && <span className="creator-nav-notification">{formatNotificationBadge(compactNavCount)}</span>}
                </Link>
              ) : isExternalCompactNavHref ? (
                <a href={compactNavHref} className="mobile-creator-dock-btn">
                  <span>{compactNavLabel}</span>
                  {compactNavCount > 0 && <span className="creator-nav-notification">{formatNotificationBadge(compactNavCount)}</span>}
                </a>
              ) : (
                <Link to={compactNavHref} className="mobile-creator-dock-btn">
                  <span>{compactNavLabel}</span>
                  {compactNavCount > 0 && <span className="creator-nav-notification">{formatNotificationBadge(compactNavCount)}</span>}
                </Link>
              )
            )}
            <details className="user-menu">
              <summary className="user-menu-trigger" aria-label="Open account menu">
                <span className="mobile-user-email-label">{menuSecondaryLabel || displayName}</span>
              </summary>
              <div className="user-menu-items">
                <div className="user-menu-sheet-handle" />
                <div className="user-menu-profile">
                  <div className="user-menu-profile-avatar">{initials}</div>
                  <div>
                    <div className="user-menu-profile-name">{displayName}</div>
                    <div className="user-menu-profile-email">{menuSecondaryLabel || displayName}</div>
                  </div>
                </div>
                <Link to="/settings" className="user-menu-settings-row" onClick={closeUserMenus}>
                  <span>Settings</span>
                  <span aria-hidden="true">›</span>
                </Link>
                <Link to="/studio" className="user-menu-settings-row" onClick={closeUserMenus}>
                  <span>Studio</span>
                  <span aria-hidden="true">›</span>
                </Link>
                <button className="user-menu-signout-btn" onClick={() => void handleSignOutClick()}>Sign out</button>
              </div>
            </details>
          </div>
        </div>
      )}

      {!user && (
        <div className="mobile-auth-dock">
          <div className={`mobile-auth-dock-inner${showMobileDiscoveryButton ? ' has-discovery' : ''}`}>
            <Link
              to="/auth/signin"
              className={`auth-nav-btn auth-nav-btn-secondary${location.pathname.startsWith('/auth/signin') ? ' is-active' : ''}`}
            >
              Sign in
            </Link>
            <Link
              to="/auth/register"
              className={`auth-nav-btn auth-nav-btn-primary${location.pathname.startsWith('/auth/register') ? ' is-active' : ''}`}
            >
              <span className="create-account-label-long">Create account</span>
              <span className="create-account-label-short">Sign Up</span>
            </Link>
            {showMobileDiscoveryButton && (
              <button type="button" className="mobile-discovery-dock-btn" onClick={() => openDiscoveryFilters('period')}>
                <span>Filters</span>
                {discoveryDock && (
                  <DiscoveryMediaIndicator
                    showImages={discoveryDock.showImages}
                    showVideos={discoveryDock.showVideos}
                    showPosts={discoveryDock.showPosts}
                  />
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function LegacyArtistAreaRedirect() {
  return <Navigate to="/studio" replace />;
}

function LegacyArtistAreaWorkspaceRedirect() {
  return <Navigate to="/studio/workspace" replace />;
}

function AuthPage({ user, setUser }: { user: CurrentUser; setUser: (u: CurrentUser) => void }) {
  const navigate = useNavigate();
  const { mode = 'signin' } = useParams();
  const authMode = mode as AuthMode;

  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpSession, setOtpSession] = useState('');
  const [otpContext, setOtpContext] = useState<'direct' | 'mfa'>('direct');
  const [trustBrowser, setTrustBrowser] = useState(true);
  const [signinMethod, setSigninMethod] = useState<'password' | 'email_otp'>('password');
  const [forgotStage, setForgotStage] = useState<'request' | 'confirm'>('request');
  const [keepSignedIn, setKeepSignedIn] = useState(() => localStorage.getItem(AUTH_PERSISTENCE_KEY) !== 'session');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [usernameSuggestions, setUsernameSuggestions] = useState<string[]>([]);
  const [usernameReason, setUsernameReason] = useState<string>('');
  const socialEnabled = Boolean(
    import.meta.env.VITE_COGNITO_DOMAIN &&
    import.meta.env.VITE_COGNITO_CLIENT_ID &&
    import.meta.env.VITE_COGNITO_REDIRECT_URI
  );

  useEffect(() => {
    if (authMode === 'initial') {
      setEmail(sessionStorage.getItem('auth.initial.username') || '');
    }
    if (authMode === 'signin') {
      setOtpCode('');
      setOtpSession('');
      setOtpContext('direct');
      setTrustBrowser(true);
      setSigninMethod('password');
    }
    if (authMode === 'forgot') {
      setForgotStage('request');
      setCode('');
      setNewPassword('');
      setConfirmPassword('');
    }
  }, [authMode]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }, [authMode]);

  useEffect(() => {
    if (authMode !== 'register') return;
    const raw = username.trim();
    if (!raw) {
      setUsernameReason('');
      setUsernameSuggestions([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.checkUsername(raw) as { available: boolean; reasons?: string[]; suggestions?: string[] };
        if (result.available) {
          setUsernameReason('');
          setUsernameSuggestions([]);
          return;
        }
        setUsernameReason(result.reasons?.[0] || 'Username unavailable');
        setUsernameSuggestions(result.suggestions || []);
      } catch {
        setUsernameReason('');
        setUsernameSuggestions([]);
      }
    }, 260);
    return () => window.clearTimeout(timer);
  }, [authMode, username]);

  const withFeedback = async (fn: () => Promise<void>) => {
    try {
      setError('');
      setMessage('');
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doSignIn = () => withFeedback(async () => {
    const result = await signIn(email, password, keepSignedIn);
    if (result.status === 'new_password_required') {
      sessionStorage.setItem('auth.initial.session', result.session);
      sessionStorage.setItem('auth.initial.username', result.username);
      navigate('/auth/initial');
      return;
    }

    const groups = new Set(result.user?.groups || []);
    const bypassOtpMfa = groups.has('Admins') || groups.has('Artists');
    if (!bypassOtpMfa && !hasValidOtpTrust(email)) {
      clearStoredAuthSession();
      const otpResult = await startEmailOtpSignIn(email.trim(), keepSignedIn);
      if (otpResult.status === 'authenticated') {
        if (trustBrowser) rememberOtpTrust(email);
        setUser(otpResult.user);
        navigate('/');
        return;
      }
      setOtpContext('mfa');
      setOtpSession(otpResult.session);
      setSigninMethod('email_otp');
      setMessage('Password verified. Enter the email code to finish signing in.');
      return;
    }

    setUser(result.user);
    navigate('/');
  });

  const doStartOtpSignIn = () => withFeedback(async () => {
    if (!email.trim()) throw new Error('Email is required');
    const result = await startEmailOtpSignIn(email.trim(), keepSignedIn);
    if (result.status === 'authenticated') {
      setUser(result.user);
      navigate('/');
      return;
    }
    setOtpContext('direct');
    setOtpSession(result.session);
    setMessage('A sign-in code was sent to your email.');
  });

  const doVerifyOtpSignIn = () => withFeedback(async () => {
    if (!email.trim()) throw new Error('Email is required');
    if (!otpSession) throw new Error('Start email OTP sign-in first.');
    if (!otpCode.trim()) throw new Error('Enter the verification code.');
    const loggedIn = await verifyEmailOtpSignIn(email.trim(), otpSession, otpCode.trim());
    setUser(loggedIn);
    if (otpContext === 'mfa' && trustBrowser) {
      rememberOtpTrust(email);
    }
    setOtpSession('');
    setOtpCode('');
    setOtpContext('direct');
    navigate('/');
  });

  const doRegister = () => withFeedback(async () => {
    if (password !== confirmPassword) {
      throw new Error('Passwords do not match');
    }
    const check = await api.checkUsername(username) as { available: boolean; reasons?: string[]; suggestions?: string[] };
    if (!check.available) {
      setUsernameReason(check.reasons?.[0] || 'Username unavailable');
      setUsernameSuggestions(check.suggestions || []);
      throw new Error(check.reasons?.[0] || 'Username unavailable');
    }
    await api.registerAccount(email, password, username);
    sessionStorage.setItem('auth.confirm.username', email);
    navigate('/auth/confirm');
    setMessage('Registration started. Check your email for the code.');
  });

  const doConfirm = () => withFeedback(async () => {
    const username = email || sessionStorage.getItem('auth.confirm.username') || '';
    await confirmRegistration(username, code);
    navigate('/auth/signin');
  });

  const doForgot = () => withFeedback(async () => {
    await forgotPassword(email);
    setForgotStage('confirm');
    setMessage('Reset code sent. Enter code and new password.');
  });

  const doForgotConfirm = () => withFeedback(async () => {
    if (!email) throw new Error('Email is required');
    await confirmForgotPassword(email, code, newPassword);
    navigate('/auth/signin');
  });

  const doInitialPassword = () => withFeedback(async () => {
    if (newPassword !== confirmPassword) {
      throw new Error('Passwords do not match');
    }
    const username = sessionStorage.getItem('auth.initial.username') || email;
    const session = sessionStorage.getItem('auth.initial.session') || '';
    const loggedIn = await setInitialPassword(username, session, newPassword);
    sessionStorage.removeItem('auth.initial.username');
    sessionStorage.removeItem('auth.initial.session');
    setUser(loggedIn);
    navigate('/');
  });

  const startSocialSignIn = (provider: 'Google' | 'SignInWithApple') => {
    const domain = import.meta.env.VITE_COGNITO_DOMAIN;
    const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
    const redirectUri = import.meta.env.VITE_COGNITO_REDIRECT_URI;
    if (!domain || !clientId || !redirectUri) return;
    const url = `https://${domain}/oauth2/authorize?identity_provider=${encodeURIComponent(provider)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent('openid email profile')}`;
    window.location.href = url;
  };

  const isPrimaryAuth = authMode === 'signin' || authMode === 'register';

  if (isPrimaryAuth) {
    return (
      <div className="layout auth-layout">
        <div className="panel auth-card">
          <div className="auth-card-header">
            <h2>{authMode === 'signin' ? 'Welcome back' : 'Create account'}</h2>
            <span className="badge">Secure sign-in</span>
          </div>
          <p className="small">
            {authMode === 'signin'
              ? (otpContext === 'mfa'
                ? 'Complete sign-in with the email code. Trusted browsers can skip this step for 30 days.'
                : signinMethod === 'email_otp'
                ? 'Sign in with a one-time code sent to your email.'
                : 'Sign in to continue to your account.')
              : 'Create your account to continue.'}
          </p>
          {authMode === 'signin' && otpContext !== 'mfa' && (
            <div className="auth-method-switch">
              <button
                type="button"
                className={`auth-nav-btn auth-nav-btn-secondary${signinMethod === 'password' ? ' is-active' : ''}`}
                onClick={() => setSigninMethod('password')}
              >
                Password
              </button>
              <button
                type="button"
                className={`auth-nav-btn auth-nav-btn-secondary${signinMethod === 'email_otp' ? ' is-active' : ''}`}
                onClick={() => setSigninMethod('email_otp')}
              >
                Email OTP
              </button>
            </div>
          )}
          <input
            name="email"
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {authMode === 'register' && (
            <>
              <input
                name="preferred_username"
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Profile URL"
                data-lpignore="true"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              {usernameReason && <p className="error">{usernameReason}</p>}
              {usernameSuggestions.length > 0 && (
                <div className="username-suggestions">
                  {usernameSuggestions.map((candidate) => (
                    <button key={candidate} className="username-suggestion-pill" onClick={() => setUsername(candidate)}>
                      {candidate}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {(authMode === 'register' || (authMode === 'signin' && signinMethod === 'password')) && (
            <>
              <div className="auth-inline-label">
                <span>Password</span>
                {authMode === 'signin' && <Link to="/auth/forgot">Forgot password?</Link>}
              </div>
              <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </>
          )}
          {authMode === 'register' && (
            <input
              type="password"
              className="auth-confirm-input"
              placeholder="Confirm password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          )}
          {authMode === 'signin' && signinMethod === 'email_otp' && otpSession && (
            <input
              placeholder="Verification code"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
            />
          )}
          {authMode === 'signin' && otpContext === 'mfa' && (
            <label className="auth-checkbox">
              <input type="checkbox" checked={trustBrowser} onChange={(e) => setTrustBrowser(e.target.checked)} />
              <span>Trust this browser for {OTP_TRUST_DAYS} days</span>
            </label>
          )}

          {authMode === 'signin' && (
            <label className="auth-checkbox">
              <input type="checkbox" checked={keepSignedIn} onChange={(e) => setKeepSignedIn(e.target.checked)} />
              <span>Keep me signed in on this device</span>
            </label>
          )}

          <div className="auth-main-actions">
            {authMode === 'signin'
              ? (
                signinMethod === 'password'
                  ? <button className="auth-primary-btn w-full" onClick={doSignIn}>Sign in</button>
                  : (
                    otpSession
                      ? <button className="auth-primary-btn w-full" onClick={doVerifyOtpSignIn}>Verify code</button>
                      : <button className="auth-primary-btn w-full" onClick={doStartOtpSignIn}>Send code</button>
                  )
              )
              : <button className="auth-primary-btn w-full" onClick={doRegister}>Create account</button>}
            <button className="auth-secondary-btn w-full" onClick={() => navigate('/')}>Cancel</button>
          </div>

          <div className="auth-divider"><span>or</span></div>
          <div className="auth-social-grid">
            <button className="auth-secondary-btn" disabled={!socialEnabled} onClick={() => startSocialSignIn('Google')}>Continue with Google</button>
            <button className="auth-secondary-btn" disabled={!socialEnabled} onClick={() => startSocialSignIn('SignInWithApple')}>Continue with Apple</button>
          </div>

          <div className="auth-confirm-banner">
            Need to confirm your account? <Link to="/auth/confirm">Confirm registration</Link>
          </div>

          <div className="small">
            {authMode === 'signin'
              ? <>New to Ubeeq? <Link to="/auth/register">Create an account</Link></>
              : <>Already have an account? <Link to="/auth/signin">Sign in</Link></>}
          </div>

          {message && <p className="success">{message}</p>}
          {error && <p className="error">{error}</p>}
        </div>

        <div className="auth-showcase panel">
          <span className="auth-chip">Trusted access for collectors and creators</span>
          <h1>{`${authMode === 'signin' ? 'Sign in' : 'Create your account'} to follow artists, favourite work, and unlock early access.`}</h1>
          <p>A cleaner entrance experience for a curated gallery platform.</p>
          <div className="auth-feature-grid">
            <article><strong>Follow creators</strong><p>Unlock follower-access releases and stay current with new drops.</p></article>
            <article><strong>Favourite pieces</strong><p>Build your own collection trail and surface relevant work faster.</p></article>
            <article><strong>Early access</strong><p>See scheduled releases before wide release when artists enable it.</p></article>
          </div>
          <div className="auth-showcase-actions">
            {authMode === 'signin'
              ? <button className="auth-primary-btn" onClick={() => navigate('/auth/register')}>Create account</button>
              : <button className="auth-primary-btn" onClick={() => navigate('/auth/signin')}>Sign in</button>}
            <Link className="auth-secondary-btn" to="/">Browse public galleries</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="layout">
      <div className="panel max-w-3xl">
        <h1>Account</h1>

        {(authMode === 'confirm' || authMode === 'forgot' || authMode === 'initial') && (
          <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        )}

        {(authMode === 'confirm' || (authMode === 'forgot' && forgotStage === 'confirm')) && (
          <input placeholder="Confirmation code" value={code} onChange={(e) => setCode(e.target.value)} />
        )}

        {((authMode === 'forgot' && forgotStage === 'confirm') || authMode === 'initial') && (
          <input type="password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        )}

        {authMode === 'initial' && (
          <input type="password" placeholder="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
        )}

        {authMode === 'confirm' && <button onClick={doConfirm}>Confirm Registration</button>}
        {authMode === 'forgot' && forgotStage === 'request' && <button onClick={doForgot}>Send Reset Code</button>}
        {authMode === 'forgot' && forgotStage === 'confirm' && <button onClick={doForgotConfirm}>Reset Password</button>}
        {authMode === 'initial' && <button onClick={doInitialPassword}>Set Initial Password</button>}

        {message && <p className="success">{message}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

function SettingsPage({ user, onProfileChanged }: { user: CurrentUser; onProfileChanged?: (profile: UserProfile) => void }) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [managedArtists, setManagedArtists] = useState<ManagedArtist[]>([]);
  const [selectedProfileKey, setSelectedProfileKey] = useState<string>('user');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [location, setLocation] = useState('');
  const [website, setWebsite] = useState('');
  const [matureContentEnabled, setMatureContentEnabled] = useState(false);
  const [maxAllowedContentRating, setMaxAllowedContentRating] = useState<ContentRating>('graphic');
  const [aiFilter, setAiFilter] = useState<AiFilterPreference>('show-all');
  const [hideHeavyTopics, setHideHeavyTopics] = useState(false);
  const [hidePoliticsPublicAffairs, setHidePoliticsPublicAffairs] = useState(false);
  const [hideCrimeDisastersTragedy, setHideCrimeDisastersTragedy] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [usernameSuggestions, setUsernameSuggestions] = useState<string[]>([]);
  const [usernameError, setUsernameError] = useState('');
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [profileFavorites, setProfileFavorites] = useState<ManagedFavorite[]>([]);
  const [profileCollections, setProfileCollections] = useState<ManagedCollection[]>([]);
  const [favoritesCursor, setFavoritesCursor] = useState<string | undefined>(undefined);
  const [collectionsCursor, setCollectionsCursor] = useState<string | undefined>(undefined);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [newCollectionTitle, setNewCollectionTitle] = useState('');
  const [newCollectionVisibility, setNewCollectionVisibility] = useState<'public' | 'private'>('public');
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>('');
  const [selectedCollectionImageIds, setSelectedCollectionImageIds] = useState<string[]>([]);
  const [collectionImageIdInput, setCollectionImageIdInput] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const selectedArtistId = selectedProfileKey.startsWith('artist:') ? selectedProfileKey.slice('artist:'.length) : '';
  const selectedArtist = managedArtists.find((artist) => artist.artistId === selectedArtistId) || null;
  const profileUrlPreview = `${window.location.origin.replace(/\/$/, '')}/${selectedArtist ? 'creators' : 'u'}/${(usernameInput || '').trim() || 'your-profile-url'}`;
  const selectedOwnerContext = selectedArtist
    ? { ownerProfileType: 'artist' as const, ownerProfileId: selectedArtist.artistId }
    : { ownerProfileType: 'user' as const };

  const reloadCuration = async () => {
    const [favoritesPage, collectionsPage] = await Promise.all([
      api.myFavoritesPage(selectedOwnerContext, undefined, 24) as Promise<{ items: ManagedFavorite[]; nextCursor?: string }>,
      api.myCollectionsPage(selectedOwnerContext, undefined, 24) as Promise<{ items: ManagedCollection[]; nextCursor?: string }>
    ]);
    setProfileFavorites(favoritesPage.items || []);
    setProfileCollections(collectionsPage.items || []);
    setFavoritesCursor(favoritesPage.nextCursor);
    setCollectionsCursor(collectionsPage.nextCursor);
  };

  if (!user) return <Navigate to="/auth/signin" replace />;

  useEffect(() => {
    const load = async () => {
      try {
        const loaded = await api.getMyProfile() as UserProfile;
        const myArtists = await api.getMyArtists() as ManagedArtist[];
        setProfile(loaded);
        setManagedArtists(myArtists);
        onProfileChanged?.(loaded);
        setDisplayName(loaded.displayName || '');
        setBio(loaded.bio || '');
        setLocation(loaded.location || '');
        setWebsite(loaded.website || '');
        setMatureContentEnabled(Boolean(loaded.matureContentEnabled));
        setMaxAllowedContentRating(loaded.maxAllowedContentRating || 'graphic');
        setAiFilter(loaded.aiFilter || 'show-all');
        setHideHeavyTopics(Boolean(loaded.hideHeavyTopics));
        setHidePoliticsPublicAffairs(Boolean(loaded.hidePoliticsPublicAffairs));
        setHideCrimeDisastersTragedy(Boolean(loaded.hideCrimeDisastersTragedy));
        setUsernameInput(loaded.username || '');
      } catch (e) {
        const msg = (e as Error).message || '';
        if (msg.toLowerCase().includes('authentication required') || msg.toLowerCase().includes('unauthorized')) {
          await signOut();
          navigate('/auth/signin', { replace: true });
          return;
        }
        setError(msg);
      }
    };
    void load();
  }, [navigate, onProfileChanged]);

  const saveProfile = async () => {
    try {
      setError('');
      setMessage('');
      if (selectedArtist) {
        const updatedArtist = await api.updateArtist(selectedArtist.artistId, {
          name: displayName || selectedArtist.name
        }) as ManagedArtist;
        setManagedArtists((prev) => prev.map((item) => (item.artistId === updatedArtist.artistId ? { ...item, ...updatedArtist } : item)));
        setMessage('Creator profile updated');
        return;
      }
      const updated = await api.updateMyProfile({
        displayName: displayName || undefined,
        bio: bio || undefined,
        location: location || undefined,
        website: website || undefined,
        matureContentEnabled,
        maxAllowedContentRating,
        aiFilter,
        hideHeavyTopics,
        hidePoliticsPublicAffairs,
        hideCrimeDisastersTragedy
      }) as UserProfile;
      setProfile(updated);
      onProfileChanged?.(updated);
      setMessage('Profile updated');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    if (selectedArtist) {
      setDisplayName(selectedArtist.name || '');
      setUsernameInput(selectedArtist.slug || '');
      setUsernameError('');
      return;
    }
    if (profile) {
      setDisplayName(profile.displayName || '');
      setUsernameInput(profile.username || '');
      setMatureContentEnabled(Boolean(profile.matureContentEnabled));
      setMaxAllowedContentRating(profile.maxAllowedContentRating || 'graphic');
      setAiFilter(profile.aiFilter || 'show-all');
      setHideHeavyTopics(Boolean(profile.hideHeavyTopics));
      setHidePoliticsPublicAffairs(Boolean(profile.hidePoliticsPublicAffairs));
      setHideCrimeDisastersTragedy(Boolean(profile.hideCrimeDisastersTragedy));
    }
  }, [selectedArtistId, profile?.userId]);

  useEffect(() => {
    const loadProfileCuration = async () => {
      try {
        setError('');
        await reloadCuration();
      } catch (e) {
        setError((e as Error).message);
      }
    };
    if (!user) return;
    void loadProfileCuration();
  }, [selectedProfileKey, user?.username]);

  const changeUsername = async () => {
    try {
      setError('');
      setMessage('');
      setUsernameError('');
      if (selectedArtist) {
        const updatedArtist = await api.updateArtist(selectedArtist.artistId, {
          slug: usernameInput
        }) as ManagedArtist;
        setManagedArtists((prev) => prev.map((item) => (item.artistId === updatedArtist.artistId ? { ...item, ...updatedArtist } : item)));
        setUsernameInput(updatedArtist.slug);
        setUsernameSuggestions([]);
        setMessage('Creator profile URL updated');
        return;
      }
      const updated = await api.updateMyUsername(usernameInput) as UserProfile;
      setProfile(updated);
      onProfileChanged?.(updated);
      setUsernameInput(updated.username);
      setUsernameSuggestions([]);
      setMessage('Username updated');
    } catch (e) {
      const err = e as Error;
      setUsernameError(err.message);
      if (!selectedArtist) {
        try {
          const result = await api.checkUsername(usernameInput) as { suggestions?: string[] };
          setUsernameSuggestions(result.suggestions || []);
        } catch {
          setUsernameSuggestions([]);
        }
      }
    }
  };

  const submitPasswordChange = async () => {
    try {
      setError('');
      setMessage('');
      if (newPassword !== confirmPassword) throw new Error('Passwords do not match');
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordOpen(false);
      setMessage('Password changed');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const createCollection = async () => {
    try {
      setError('');
      setMessage('');
      const title = newCollectionTitle.trim();
      if (!title) throw new Error('Collection title is required');
      await api.createCollection({
        title,
        visibility: newCollectionVisibility,
        ...selectedOwnerContext
      });
      setNewCollectionTitle('');
      await reloadCuration();
      setMessage('Collection created');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeFavorite = async (favorite: ManagedFavorite) => {
    try {
      setError('');
      await api.unfavorite(favorite.targetType, favorite.targetId, selectedOwnerContext);
      await reloadCuration();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggleFavoriteVisibility = async (favorite: ManagedFavorite) => {
    try {
      setError('');
      const nextVisibility: 'public' | 'private' = (favorite.visibility || 'public') === 'public' ? 'private' : 'public';
      await api.unfavorite(favorite.targetType, favorite.targetId, selectedOwnerContext);
      await api.favorite(favorite.targetType, favorite.targetId, nextVisibility, selectedOwnerContext);
      await reloadCuration();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const loadCollectionImages = async (collectionId: string) => {
    try {
      if (!collectionId) {
        setSelectedCollectionImageIds([]);
        return;
      }
      const detail = await api.getCollection(collectionId) as ManagedCollection & { imageIds?: string[] };
      setSelectedCollectionImageIds(detail.imageIds || []);
    } catch (e) {
      setError((e as Error).message);
      setSelectedCollectionImageIds([]);
    }
  };

  const loadMoreFavorites = async () => {
    try {
      if (!favoritesCursor) return;
      setFavoritesLoading(true);
      const page = await api.myFavoritesPage(selectedOwnerContext, favoritesCursor, 24) as { items: ManagedFavorite[]; nextCursor?: string };
      setProfileFavorites((prev) => [...prev, ...(page.items || [])]);
      setFavoritesCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFavoritesLoading(false);
    }
  };

  const loadMoreCollections = async () => {
    try {
      if (!collectionsCursor) return;
      setCollectionsLoading(true);
      const page = await api.myCollectionsPage(selectedOwnerContext, collectionsCursor, 24) as { items: ManagedCollection[]; nextCursor?: string };
      setProfileCollections((prev) => [...prev, ...(page.items || [])]);
      setCollectionsCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCollectionsLoading(false);
    }
  };

  const toggleCollectionVisibility = async (collection: ManagedCollection) => {
    try {
      setError('');
      const nextVisibility: 'public' | 'private' = collection.visibility === 'public' ? 'private' : 'public';
      await api.updateCollection(collection.collectionId, { visibility: nextVisibility });
      await reloadCuration();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteCollection = async (collectionId: string) => {
    try {
      setError('');
      await api.deleteCollection(collectionId);
      if (selectedCollectionId === collectionId) {
        setSelectedCollectionId('');
        setSelectedCollectionImageIds([]);
      }
      await reloadCuration();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addImageToSelectedCollection = async () => {
    try {
      setError('');
      const imageId = collectionImageIdInput.trim();
      if (!selectedCollectionId) throw new Error('Select a collection first');
      if (!imageId) throw new Error('Image ID is required');
      await api.addImageToCollection(selectedCollectionId, imageId);
      setCollectionImageIdInput('');
      await loadCollectionImages(selectedCollectionId);
      await reloadCuration();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeImageFromSelectedCollection = async (imageId: string) => {
    try {
      setError('');
      if (!selectedCollectionId) return;
      await api.removeImageFromCollection(selectedCollectionId, imageId);
      await loadCollectionImages(selectedCollectionId);
      await reloadCuration();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="layout">
      <div className="panel max-w-6xl">
        <h1>Settings</h1>
        <h2>Profile Context</h2>
        <div className="grid">
          <div className="settings-field">
            <label htmlFor="settings-profile-context" className="settings-field-label">Edit profile as</label>
            <select
              id="settings-profile-context"
              className="settings-select"
              value={selectedProfileKey}
              onChange={(e) => setSelectedProfileKey(e.target.value)}
            >
              <option value="user">User Profile</option>
              {managedArtists.map((artist) => (
                <option key={artist.artistId} value={`artist:${artist.artistId}`}>
                  Creator: {artist.name} ({artist.memberRole || 'editor'})
                </option>
              ))}
            </select>
          </div>
        </div>
        <h2>Profile</h2>
        <div className="grid">
          <div className="settings-field">
            <label htmlFor="settings-display-name" className="settings-field-label">Display Name</label>
            <input
              id="settings-display-name"
              placeholder="Ubeeq Girl"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <p className="small">{selectedArtist ? 'The name shown on this creator profile' : 'The name shown on your profile'}</p>
          </div>
          <button onClick={saveProfile}>{selectedArtist ? 'Save Creator Name' : 'Save Display Name'}</button>
          {!selectedArtist && (
            <>
              <input placeholder="Location" value={location} onChange={(e) => setLocation(e.target.value)} />
              <input placeholder="Website" value={website} onChange={(e) => setWebsite(e.target.value)} />
              <textarea className="rounded-xl border px-3 py-2 text-sm" rows={4} placeholder="Bio" value={bio} onChange={(e) => setBio(e.target.value)} />
              <label className="inline-form">
                <input
                  type="checkbox"
                  checked={matureContentEnabled}
                  onChange={(e) => setMatureContentEnabled(e.target.checked)}
                />
                <span>Enable mature content viewing</span>
              </label>
              <div className="settings-field">
                <label htmlFor="settings-max-content-rating" className="settings-field-label">Maximum feed rating</label>
                <select
                  id="settings-max-content-rating"
                  className="settings-select"
                  value={maxAllowedContentRating}
                  onChange={(e) => setMaxAllowedContentRating(e.target.value as ContentRating)}
                >
                  {contentRatingOptions.map((option) => (
                    <option key={`max-rating-${option.value}`} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-field">
                <label htmlFor="settings-ai-filter" className="settings-field-label">AI Content</label>
                <select
                  id="settings-ai-filter"
                  className="settings-select"
                  value={aiFilter}
                  onChange={(e) => setAiFilter(e.target.value as AiFilterPreference)}
                >
                  {aiFilterOptions.map((option) => (
                    <option key={`ai-filter-${option.value}`} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-field">
                <label className="settings-field-label">Heavy Topics</label>
                <label className="inline-form">
                  <input
                    type="checkbox"
                    checked={hideHeavyTopics}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setHideHeavyTopics(checked);
                      if (checked) {
                        setHidePoliticsPublicAffairs(true);
                        setHideCrimeDisastersTragedy(true);
                      }
                    }}
                  />
                  <span>Hide Heavy Topics</span>
                </label>
                <label className="inline-form">
                  <input
                    type="checkbox"
                    checked={hidePoliticsPublicAffairs}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setHidePoliticsPublicAffairs(checked);
                      if (!checked) setHideHeavyTopics(false);
                    }}
                  />
                  <span>{heavyTopicLabels['politics-public-affairs']}</span>
                </label>
                <label className="inline-form">
                  <input
                    type="checkbox"
                    checked={hideCrimeDisastersTragedy}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setHideCrimeDisastersTragedy(checked);
                      if (!checked) setHideHeavyTopics(false);
                    }}
                  />
                  <span>{heavyTopicLabels['crime-disasters-tragedy']}</span>
                </label>
              </div>
            </>
          )}
        </div>

        <h2 className="mt-6">Profile URL</h2>
        <div className="grid">
          <div className="settings-field">
            <label htmlFor="settings-profile-url" className="settings-field-label">Profile URL</label>
            <input
              id="settings-profile-url"
              name="preferred_username"
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="ubeeq-girl"
              data-lpignore="true"
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
            />
            <p className="small">{selectedArtist ? 'This creator profile will be available at:' : 'Your profile will be available at:'}</p>
            <p className="small settings-profile-url-preview">{profileUrlPreview}</p>
          </div>
          <button onClick={changeUsername}>{selectedArtist ? 'Save Creator URL' : 'Save Profile URL'}</button>
          {!selectedArtist && profile?.lastUsernameChangeAt && (
            <p className="small">Last changed: {new Date(profile.lastUsernameChangeAt).toLocaleDateString()}</p>
          )}
          {usernameError && <p className="error">{usernameError}</p>}
          {!selectedArtist && usernameSuggestions.length > 0 && (
            <div className="username-suggestions">
              {usernameSuggestions.map((candidate) => (
                <button key={candidate} className="username-suggestion-pill" onClick={() => setUsernameInput(candidate)}>
                  {candidate}
                </button>
              ))}
            </div>
          )}
        </div>

        {!selectedArtist && (
          <>
            <h2 className="mt-6">Security</h2>
            <div className="inline-form">
              <button onClick={() => setPasswordOpen(true)}>Change Password</button>
            </div>
          </>
        )}

        <h2 className="mt-6">Curation</h2>
        <div className="grid">
          <div className="inline-form">
            <input
              placeholder={selectedArtist ? `New collection for ${selectedArtist.name}` : 'New collection title'}
              value={newCollectionTitle}
              onChange={(e) => setNewCollectionTitle(e.target.value)}
            />
            <select
              className="settings-select"
              value={newCollectionVisibility}
              onChange={(e) => setNewCollectionVisibility(e.target.value === 'private' ? 'private' : 'public')}
            >
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
            <button onClick={createCollection}>Create Collection</button>
          </div>
          <div className="panel">
            <h3 className="m-0 mb-2 text-lg">Collections ({profileCollections.length})</h3>
            <div className="inline-form mb-3">
              <label className="small">Selected collection</label>
              <select
                className="settings-select"
                value={selectedCollectionId}
                onChange={(e) => {
                  const value = e.target.value;
                  setSelectedCollectionId(value);
                  void loadCollectionImages(value);
                }}
              >
                <option value="">Select collection</option>
                {profileCollections.map((item) => (
                  <option key={item.collectionId} value={item.collectionId}>{item.title}</option>
                ))}
              </select>
            </div>
            {selectedCollectionId && (
              <div className="inline-form mb-3">
                <input
                  placeholder="Image ID to add"
                  value={collectionImageIdInput}
                  onChange={(e) => setCollectionImageIdInput(e.target.value)}
                />
                <button onClick={addImageToSelectedCollection}>Add Image</button>
              </div>
            )}
            {selectedCollectionId && (
              <div className="grid">
                {selectedCollectionImageIds.length === 0 && <p className="small">No images in selected collection yet.</p>}
                {selectedCollectionImageIds.map((imageId) => (
                  <article key={imageId} className="inline-form">
                    <span className="small">{imageId}</span>
                    <button onClick={() => void removeImageFromSelectedCollection(imageId)}>Remove</button>
                  </article>
                ))}
              </div>
            )}
            <div className="grid">
              {profileCollections.map((item) => (
                <article key={item.collectionId} className="rounded-xl border p-3">
                  <strong>{item.title}</strong>
                  <p className="small">{item.imageCount} images • {item.visibility}</p>
                  <div className="inline-form">
                    <button onClick={() => void toggleCollectionVisibility(item)}>
                      Make {item.visibility === 'public' ? 'Private' : 'Public'}
                    </button>
                    <button onClick={() => void deleteCollection(item.collectionId)}>Delete</button>
                  </div>
                </article>
              ))}
            </div>
            <AutoLoadSentinel enabled={Boolean(collectionsCursor)} loading={collectionsLoading} onLoadMore={() => loadMoreCollections()} />
          </div>
          <div className="panel">
            <h3 className="m-0 mb-2 text-lg">Favorites ({profileFavorites.length})</h3>
            <div className="grid">
              {profileFavorites.map((item) => (
                <article key={`${item.targetType}:${item.targetId}`} className="inline-form">
                  <span className="small">{item.targetType}: {item.targetId} ({item.visibility || 'public'})</span>
                  <button onClick={() => void toggleFavoriteVisibility(item)}>
                    Make {(item.visibility || 'public') === 'public' ? 'Private' : 'Public'}
                  </button>
                  <button onClick={() => void removeFavorite(item)}>Remove</button>
                </article>
              ))}
            </div>
            <AutoLoadSentinel enabled={Boolean(favoritesCursor)} loading={favoritesLoading} onLoadMore={() => loadMoreFavorites()} />
          </div>
        </div>
        {message && <p className="success">{message}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      {passwordOpen && (
        <div className="settings-drawer-overlay" onClick={() => setPasswordOpen(false)}>
          <aside className="settings-drawer" onClick={(e) => e.stopPropagation()}>
            <h2>Change Password</h2>
            <div className="grid">
              <input type="password" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
              <input type="password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              <input type="password" placeholder="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
              <button onClick={submitPasswordChange}>Save Password</button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function HomePage({
  viewerProfile,
  onDiscoveryDockChange
}: {
  viewerProfile?: UserProfile | null;
  onDiscoveryDockChange?: (state: DiscoveryDockSummary | null) => void;
}) {
  const currentUser = getCurrentUser();
  const dailySeed = new Date().toISOString().slice(0, 10);
  const trendingBaseLimit = 18;
  type TrendingCardEntry = {
    item: TrendingImage;
    index: number;
  };
  type TrendingPairRow = {
    left: TrendingImage;
    right?: TrendingImage;
    startIndex: number;
  };
  type TrendingMediumBlock =
    | { kind: 'pair'; row: TrendingPairRow }
    | { kind: 'pair-with-insets'; row: TrendingPairRow; insets: TrendingCardEntry[]; insetOn: 'left' | 'right' };
  type MediumBlockBuildResult = {
    blocks: TrendingMediumBlock[];
    consumedBorrowedImageIds: Set<string>;
  };
  type DiscoveryGallery = GallerySummary & { artistName: string; artistSlug: string; stackPreviewUrls?: string[] };

  const [artists, setArtists] = useState<Artist[]>([]);
  const [galleries, setGalleries] = useState<DiscoveryGallery[]>([]);
  const [trendingImages, setTrendingImages] = useState<TrendingImage[]>([]);
  const [trendingCursor, setTrendingCursor] = useState<string | undefined>(undefined);
  const [trendingReloadNonce, setTrendingReloadNonce] = useState(0);
  const [discoverySort, setDiscoverySort] = useState<'latest' | 'trending'>('trending');
  const [trendingPeriod, setTrendingPeriod] = useState<'hourly' | 'daily'>('daily');
  const [feedDensity, setFeedDensity] = useState<FeedDensity>('large');
  const [densityViewport, setDensityViewport] = useState<DensityViewport>(() => {
    if (typeof window === 'undefined') return 'desktop';
    if (window.innerWidth >= 1100) return 'desktop';
    if (window.innerWidth >= 700) return 'tablet';
    return 'mobile';
  });
  const [densityFadeState, setDensityFadeState] = useState<'idle' | 'fading-out' | 'fading-in'>('idle');
  const [densitySwitchLoading, setDensitySwitchLoading] = useState(false);
  const [favoriteIdentity, setFavoriteIdentity] = useState<string>('user');
  const [managedArtists, setManagedArtists] = useState<ManagedArtist[]>([]);
  const [favoriteImageIds, setFavoriteImageIds] = useState<Set<string>>(new Set());
  const [favoriteGalleryIds, setFavoriteGalleryIds] = useState<Set<string>>(new Set());
  const [loadingMoreTrending, setLoadingMoreTrending] = useState(false);
  const [loadingTrending, setLoadingTrending] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [loadingCollections, setLoadingCollections] = useState(false);
  const [deferredSectionsReady, setDeferredSectionsReady] = useState(false);
  const [disclosureAiFilter, setDisclosureAiFilter] = useState<AiFilterPreference>(viewerProfile?.aiFilter || 'show-all');
  const [hideHeavyTopics, setHideHeavyTopics] = useState<boolean>(Boolean(viewerProfile?.hideHeavyTopics));
  const [hidePoliticsPublicAffairs, setHidePoliticsPublicAffairs] = useState<boolean>(Boolean(viewerProfile?.hidePoliticsPublicAffairs));
  const [hideCrimeDisastersTragedy, setHideCrimeDisastersTragedy] = useState<boolean>(Boolean(viewerProfile?.hideCrimeDisastersTragedy));
  const [heavyTopicsExpanded, setHeavyTopicsExpanded] = useState(true);
  const [discoverySearch, setDiscoverySearch] = useState('');
  const [showImageMedia, setShowImageMedia] = useState(true);
  const [showVideoMedia, setShowVideoMedia] = useState(true);
  const [showPostMedia, setShowPostMedia] = useState(true);
  const [showCompactDiscoveryDock, setShowCompactDiscoveryDock] = useState(false);
  const [compactFiltersOpen, setCompactFiltersOpen] = useState(false);
  const [compactFilterSection, setCompactFilterSection] = useState<DiscoveryFilterSection>('period');
  const [compactHeavyTopicsExpanded, setCompactHeavyTopicsExpanded] = useState(true);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [followedArtistIds, setFollowedArtistIds] = useState<Set<string>>(new Set());
  const [focusedDiscoveryOpen, setFocusedDiscoveryOpen] = useState(false);
  const [focusedDiscoveryContextItems, setFocusedDiscoveryContextItems] = useState<TrendingImage[]>([]);
  const [focusedDiscoveryContextIndex, setFocusedDiscoveryContextIndex] = useState(0);
  const [focusedDiscoveryPost, setFocusedDiscoveryPost] = useState<PostDetailPayload | null>(null);
  const [focusedDiscoveryLoading, setFocusedDiscoveryLoading] = useState(false);
  const [focusedDiscoveryError, setFocusedDiscoveryError] = useState('');
  const [focusedDiscoveryVideoMuted, setFocusedDiscoveryVideoMuted] = useState(true);
  const [focusedDiscoveryVideoVolume, setFocusedDiscoveryVideoVolume] = useState(1);
  const [error, setError] = useState('');
  const densityTransitionTimersRef = useRef<number[]>([]);
  const densitySwitchRequestRef = useRef<number | null>(null);
  const mediumBlockLayoutCacheRef = useRef<Map<string, MediumBlockBuildResult>>(new Map());
  const mediumTopBorrowRowsRef = useRef<TrendingPairRow[] | null>(null);
  const continuationFrozenRowsRef = useRef<number>(0);
  const discoveryFilterPanelRef = useRef<HTMLDivElement | null>(null);
  const discoverySearchInputRef = useRef<HTMLInputElement | null>(null);
  const compactSearchInputRef = useRef<HTMLInputElement | null>(null);
  const focusedDiscoveryRequestRef = useRef(0);
  const focusedDiscoveryVideoRef = useRef<HTMLVideoElement | null>(null);

  const fallbackAspectRatios = [1.6, 0.8, 1.5, 0.56, 1.78, 1.25, 1.33, 0.75];
  const collectionPalettes = [
    ['#d9edff', '#ead27e', '#88c1b2', '#6d97c8'],
    ['#f3dfbe', '#b7d0ff', '#d2d7de', '#a97d62'],
    ['#d6f1e4', '#ffd7b8', '#bdb37b', '#86b091']
  ];
  const densityTopRows: Record<FeedDensity, number> = {
    small: 3,
    medium: 4,
    large: 2
  };
  const densityLabel: Record<FeedDensity, string> = {
    small: 'Small',
    medium: 'Medium',
    large: 'Large'
  };
  const densityFadeOutMs = 130;
  const densityFadeInMs = 570;
  const densityOptions: FeedDensity[] = ['small', 'medium', 'large'];
  const disclosureFilters = {
    aiFilter: disclosureAiFilter,
    hideHeavyTopics,
    hidePoliticsPublicAffairs: hideHeavyTopics ? true : hidePoliticsPublicAffairs,
    hideCrimeDisastersTragedy: hideHeavyTopics ? true : hideCrimeDisastersTragedy
  };
  const heavyHidden = hideHeavyTopics || (hidePoliticsPublicAffairs && hideCrimeDisastersTragedy);
  const someHeavyHidden = !heavyHidden && (hidePoliticsPublicAffairs || hideCrimeDisastersTragedy);
  const mediaSummaryLabel = getDiscoveryMediaLabel({
    showImages: showImageMedia,
    showVideos: showVideoMedia,
    showPosts: showPostMedia
  });
  const heavySummaryLabel: DiscoveryDockSummary['heavyLabel'] = (
    densityViewport === 'mobile'
      ? (heavyHidden ? 'Heavy Hidden' : (someHeavyHidden ? 'Some Heavy' : 'Heavy Shown'))
      : (heavyHidden ? 'Heavy Topics Hidden' : (someHeavyHidden ? 'Some Heavy Topics' : 'Heavy Topics Shown'))
  );
  const artistSlugById = new Map(artists.map((artist) => [artist.artistId, artist.slug]));

  const clearDensityTransitionTimers = () => {
    if (typeof window === 'undefined') return;
    densityTransitionTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    densityTransitionTimersRef.current = [];
  };

  const applyHideAllHeavyTopics = (enabled: boolean) => {
    setHideHeavyTopics(enabled);
    setHidePoliticsPublicAffairs(enabled);
    setHideCrimeDisastersTragedy(enabled);
  };

  const applyHidePoliticsPublicAffairs = (enabled: boolean) => {
    setHidePoliticsPublicAffairs(enabled);
    setHideHeavyTopics(enabled && hideCrimeDisastersTragedy);
  };

  const applyHideCrimeDisastersTragedy = (enabled: boolean) => {
    setHideCrimeDisastersTragedy(enabled);
    setHideHeavyTopics(enabled && hidePoliticsPublicAffairs);
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const evaluate = () => {
      if (window.innerWidth < 700) {
        setShowCompactDiscoveryDock(window.scrollY > 260);
        return;
      }
      const panel = discoveryFilterPanelRef.current;
      if (!panel) {
        setShowCompactDiscoveryDock(false);
        return;
      }
      const topbarHeight = Number.parseInt(
        window.getComputedStyle(document.documentElement).getPropertyValue('--topbar-height') || '72',
        10
      ) || 72;
      const rect = panel.getBoundingClientRect();
      setShowCompactDiscoveryDock(rect.bottom <= topbarHeight + 14);
    };
    evaluate();
    const onScrollOrResize = () => {
      window.requestAnimationFrame(evaluate);
    };
    window.addEventListener('scroll', onScrollOrResize, { passive: true });
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => window.dispatchEvent(new Event('scroll')));
  }, [heavyTopicsExpanded, densityViewport, feedDensity, trendingPeriod, discoverySearch, showImageMedia, showVideoMedia, showPostMedia]);

  useEffect(() => {
    if (densityViewport !== 'mobile' && !showCompactDiscoveryDock) {
      setCompactFiltersOpen(false);
    }
  }, [showCompactDiscoveryDock, densityViewport]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleCompactFilterIntent = (rawEvent: Event) => {
      const detail = (rawEvent as CustomEvent<{ section?: DiscoveryFilterSection }>).detail || {};
      const requestedSection = detail.section || 'period';
      if (densityViewport === 'mobile') {
        setCompactFilterSection(requestedSection);
        if (requestedSection === 'heavy') {
          setCompactHeavyTopicsExpanded(true);
        }
        setCompactFiltersOpen(true);
        return;
      }
      if (!showCompactDiscoveryDock) {
        discoveryFilterPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (requestedSection === 'search') {
          window.setTimeout(() => discoverySearchInputRef.current?.focus(), 280);
        }
        if (requestedSection === 'heavy') {
          setHeavyTopicsExpanded(true);
        }
        return;
      }
      setCompactFilterSection(requestedSection);
      if (requestedSection === 'heavy') {
        setCompactHeavyTopicsExpanded(true);
      }
      setCompactFiltersOpen(true);
    };
    window.addEventListener(DISCOVERY_FILTER_EVENT_NAME, handleCompactFilterIntent as EventListener);
    return () => window.removeEventListener(DISCOVERY_FILTER_EVENT_NAME, handleCompactFilterIntent as EventListener);
  }, [showCompactDiscoveryDock, densityViewport]);

  useEffect(() => {
    if (!compactFiltersOpen || typeof window === 'undefined') return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCompactFiltersOpen(false);
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [compactFiltersOpen]);

  useEffect(() => {
    if (!compactFiltersOpen || compactFilterSection !== 'search' || typeof window === 'undefined') return;
    const timerId = window.setTimeout(() => {
      compactSearchInputRef.current?.focus();
    }, densityViewport === 'mobile' ? 240 : 120);
    return () => window.clearTimeout(timerId);
  }, [compactFiltersOpen, compactFilterSection, densityViewport]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const getViewport = (width: number): DensityViewport => {
      if (width >= 1100) return 'desktop';
      if (width >= 700) return 'tablet';
      return 'mobile';
    };
    const onResize = () => {
      const next = getViewport(window.innerWidth);
      setDensityViewport((prev) => (prev === next ? prev : next));
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    setDisclosureAiFilter(viewerProfile?.aiFilter || 'show-all');
    setHideHeavyTopics(Boolean(viewerProfile?.hideHeavyTopics));
    setHidePoliticsPublicAffairs(Boolean(viewerProfile?.hidePoliticsPublicAffairs));
    setHideCrimeDisastersTragedy(Boolean(viewerProfile?.hideCrimeDisastersTragedy));
  }, [
    viewerProfile?.aiFilter,
    viewerProfile?.hideHeavyTopics,
    viewerProfile?.hidePoliticsPublicAffairs,
    viewerProfile?.hideCrimeDisastersTragedy
  ]);

  useEffect(() => {
    onDiscoveryDockChange?.({
      active: showCompactDiscoveryDock,
      viewport: densityViewport,
      period: trendingPeriod,
      periodLabel: discoverySort === 'latest' ? 'Latest' : undefined,
      density: feedDensity,
      mediaLabel: mediaSummaryLabel,
      showImages: showImageMedia,
      showVideos: showVideoMedia,
      showPosts: showPostMedia,
      heavyLabel: heavySummaryLabel,
      searchActive: discoverySearch.trim().length > 0
    });
  }, [
    onDiscoveryDockChange,
    showCompactDiscoveryDock,
    densityViewport,
    discoverySort,
    trendingPeriod,
    feedDensity,
    mediaSummaryLabel,
    heavySummaryLabel,
    discoverySearch
  ]);

  useEffect(() => () => {
    onDiscoveryDockChange?.(null);
  }, [onDiscoveryDockChange]);

  useEffect(() => {
    const requestNonce = trendingReloadNonce;
    const loadTrending = async () => {
      try {
        setLoadingTrending(true);
        const trendingData = await api.getTrendingImagesFiltered(
          trendingPeriod,
          undefined,
          trendingBaseLimit,
          disclosureFilters
        ) as { items: TrendingImage[]; nextCursor?: string };
        const nextItems = discoverySort === 'latest'
          ? [...(trendingData.items || [])].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
          : (trendingData.items || []);
        setTrendingImages(nextItems);
        setTrendingCursor(trendingData.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoadingTrending(false);
        if (densitySwitchRequestRef.current === requestNonce) {
          densitySwitchRequestRef.current = null;
          setDensitySwitchLoading(false);
        }
      }
    };
    void loadTrending();
  }, [discoverySort, trendingPeriod, trendingReloadNonce, disclosureFilters.aiFilter, disclosureFilters.hideHeavyTopics, disclosureFilters.hidePoliticsPublicAffairs, disclosureFilters.hideCrimeDisastersTragedy]);

  useEffect(() => () => clearDensityTransitionTimers(), []);

  useEffect(() => {
    mediumBlockLayoutCacheRef.current.clear();
    mediumTopBorrowRowsRef.current = null;
    continuationFrozenRowsRef.current = 0;
  }, [
    trendingReloadNonce,
    discoverySort,
    trendingPeriod,
    disclosureFilters.aiFilter,
    disclosureFilters.hideHeavyTopics,
    disclosureFilters.hidePoliticsPublicAffairs,
    disclosureFilters.hideCrimeDisastersTragedy,
    feedDensity
  ]);

  useEffect(() => {
    if (deferredSectionsReady || loadingTrending) return;
    const schedule = (cb: () => void): number => {
      if (typeof window.requestIdleCallback === 'function') {
        return window.requestIdleCallback(cb, { timeout: 1200 }) as unknown as number;
      }
      return window.setTimeout(cb, 0);
    };
    const cancel = (id: number) => {
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(id as unknown as any);
      } else {
        window.clearTimeout(id);
      }
    };
    const id = schedule(() => setDeferredSectionsReady(true));
    return () => cancel(id);
  }, [deferredSectionsReady, loadingTrending]);

  useEffect(() => {
    if (!deferredSectionsReady) return;
    const loadLatest = async () => {
      try {
        setLoadingLatest(true);
        const [artistList, latestGalleries] = await Promise.all([
          api.getArtists() as Promise<Artist[]>,
          api.getLatestGalleries(12) as Promise<DiscoveryGallery[]>
        ]);
        setArtists(artistList);
        setGalleries(latestGalleries || []);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoadingLatest(false);
      }
    };
    void loadLatest();
  }, [deferredSectionsReady]);

  useEffect(() => {
    if (!deferredSectionsReady) return;
    const loadCollectionData = async () => {
      try {
        setLoadingCollections(true);
        const collectionData = await api.getCollections(undefined, 9, { order: 'popular', seed: dailySeed }) as { items: CollectionSummary[] };
        setCollections(collectionData.items || []);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoadingCollections(false);
      }
    };
    void loadCollectionData();
  }, [dailySeed, deferredSectionsReady]);

  useEffect(() => {
    if (!deferredSectionsReady) return;
    const loadUserContext = async () => {
      if (!currentUser) {
        setFollowedArtistIds(new Set());
        setManagedArtists([]);
        return;
      }
      try {
        const [follows, myArtists] = await Promise.all([
          api.myFollows() as Promise<Array<{ artistId: string }>>,
          api.getMyArtists() as Promise<ManagedArtist[]>
        ]);
        setFollowedArtistIds(new Set((follows || []).map((item) => item.artistId)));
        setManagedArtists(myArtists || []);
      } catch {
        setFollowedArtistIds(new Set());
        setManagedArtists([]);
      }
    };
    void loadUserContext();
  }, [currentUser?.username, deferredSectionsReady]);

  const loadMoreTrending = async () => {
    if (!trendingCursor) return;
    try {
      setLoadingMoreTrending(true);
      const response = await api.getTrendingImagesFiltered(
        trendingPeriod,
        trendingCursor,
        trendingBaseLimit,
        disclosureFilters
      ) as { items: TrendingImage[]; nextCursor?: string };
      setTrendingImages((prev) => {
        const merged = [...prev, ...(response.items || [])];
        if (discoverySort !== 'latest') return merged;
        return [...merged].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      });
      setTrendingCursor(response.nextCursor);
    } catch {
      // no-op
    } finally {
      setLoadingMoreTrending(false);
    }
  };

  const ratioFromImageId = (id: string): number => {
    let hash = 2166136261;
    for (let i = 0; i < id.length; i += 1) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const unit = (hash >>> 0) / 4294967296;
    return 0.58 + unit * 1.52;
  };

  const getTrendingRatio = (item: TrendingImage, index: number): number => {
    const width = Number(item.width || 0);
    const height = Number(item.height || 0);
    const aspectRatio = Number(item.aspectRatio || 0);
    if (Number.isFinite(aspectRatio) && aspectRatio > 0) {
      return aspectRatio;
    }
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return width / height;
    }
    if (item.imageId) return ratioFromImageId(item.imageId);
    return fallbackAspectRatios[index % fallbackAspectRatios.length];
  };

  const buildPairRows = (items: TrendingImage[]): TrendingPairRow[] => {
    const rows: TrendingPairRow[] = [];
    for (let i = 0; i < items.length; i += 2) {
      rows.push({ left: items[i], right: items[i + 1], startIndex: i });
    }
    return rows;
  };

  const pairTemplateColumns = (row: TrendingPairRow, density: FeedDensity): string => {
    if (!row.right) return '1fr';
    if (density === 'small') return '1fr 1fr';
    if (density === 'large') return '1fr';
    const leftRatio = getTrendingRatio(row.left, row.startIndex);
    const rightRatio = getTrendingRatio(row.right, row.startIndex + 1);
    const total = leftRatio + rightRatio;
    if (!total) return '1fr 1fr';
    const leftShare = Math.max(0.34, Math.min(0.66, leftRatio / total));
    const rightShare = 1 - leftShare;
    return `${(leftShare * 100).toFixed(2)}fr ${(rightShare * 100).toFixed(2)}fr`;
  };

  const rowsToEntries = (rows: TrendingPairRow[]): TrendingCardEntry[] => {
    const entries: TrendingCardEntry[] = [];
    rows.forEach((row) => {
      entries.push({ item: row.left, index: row.startIndex });
      if (row.right) entries.push({ item: row.right, index: row.startIndex + 1 });
    });
    return entries;
  };

  const buildMediumMixedBlocks = (
    rows: TrendingPairRow[],
    options?: { borrowedEntries?: TrendingCardEntry[] }
  ): MediumBlockBuildResult => {
    const primaryEntries = rowsToEntries(rows);
    const queue: Array<{ entry: TrendingCardEntry; borrowed: boolean }> = [
      ...primaryEntries.map((entry) => ({ entry, borrowed: false })),
      ...((options?.borrowedEntries || []).map((entry) => ({ entry, borrowed: true })))
    ];
    const blocks: TrendingMediumBlock[] = [];
    const consumedBorrowedImageIds = new Set<string>();
    let remainingPrimaryEntries = primaryEntries.length;
    const maxLayoutPromotionOffset = 100;
    const isSquareEligible = (entry: TrendingCardEntry): boolean => (
      entry.item.discoverSquareCropEnabled !== false && getTrendingRatio(entry.item, entry.index) <= 0.95
    );
    const canPromoteWithinWindow = (entry: TrendingCardEntry, baseIndex: number): boolean => (
      entry.index - baseIndex <= maxLayoutPromotionOffset
    );
    const consumeAt = (index: number): TrendingCardEntry | null => {
      const [removed] = queue.splice(index, 1);
      if (!removed) return null;
      if (removed.borrowed) {
        consumedBorrowedImageIds.add(removed.entry.item.imageId);
      } else {
        remainingPrimaryEntries = Math.max(0, remainingPrimaryEntries - 1);
      }
      return removed.entry;
    };

    while (remainingPrimaryEntries > 0 && queue.length > 0) {
      if (queue.length >= 3) {
        const left = queue[0]?.entry;
        const right = queue[1]?.entry;
        if (!left || !right) break;
        const leftRatio = getTrendingRatio(left.item, left.index);
        const rightRatio = getTrendingRatio(right.item, right.index);
        const oneVeryTallPortrait = (leftRatio <= 0.62 && rightRatio >= 1.05) || (rightRatio <= 0.62 && leftRatio >= 1.05);
        const ratioGapLarge = Math.abs(leftRatio - rightRatio) >= 0.85;

        if (oneVeryTallPortrait && ratioGapLarge) {
          const insetIndices: number[] = [];
          for (let i = 2; i < queue.length; i += 1) {
            const entry = queue[i]?.entry;
            if (!entry) continue;
            if (!isSquareEligible(entry)) continue;
            if (!canPromoteWithinWindow(entry, left.index)) continue;
            insetIndices.push(i);
            if (insetIndices.length === 2) break;
          }
          if (insetIndices.length >= 2) {
            const insets = insetIndices
              .slice(0, 2)
              .map((idx) => queue[idx]?.entry)
              .filter((entry): entry is TrendingCardEntry => Boolean(entry))
              .sort((a, b) => a.index - b.index);
            [...insetIndices].sort((a, b) => b - a).forEach((idx) => void consumeAt(idx));
            consumeAt(1);
            consumeAt(0);
            blocks.push({
              kind: 'pair-with-insets',
              row: {
                left: left.item,
                right: right.item,
                startIndex: left.index
              },
              insets,
              insetOn: leftRatio <= rightRatio ? 'right' : 'left'
            });
            continue;
          }
        }
      }

      const left = consumeAt(0);
      if (!left) break;
      const right = remainingPrimaryEntries > 0 ? consumeAt(0) : null;
      blocks.push({
        kind: 'pair',
        row: {
          left: left.item,
          right: right?.item,
          startIndex: left.index
        }
      });
    }

    return {
      blocks,
      consumedBorrowedImageIds
    };
  };

  const stableMediumBlockBuild = (
    rows: TrendingPairRow[],
    options?: { borrowedEntries?: TrendingCardEntry[] }
  ): MediumBlockBuildResult => {
    const serializeRows = (inputRows: TrendingPairRow[]): string => inputRows
      .map((row) => `${row.left.imageId}:${row.startIndex}:${row.right?.imageId || '-'}`)
      .join('|');
    const serializeBorrowed = (entries?: TrendingCardEntry[]): string => (entries || [])
      .slice(0, 60)
      .map((entry) => `${entry.item.imageId}:${entry.index}`)
      .join('|');
    const cacheKey = `${feedDensity}::${serializeRows(rows)}::${serializeBorrowed(options?.borrowedEntries)}`;
    const cached = mediumBlockLayoutCacheRef.current.get(cacheKey);
    if (cached) return cached;
    const built = buildMediumMixedBlocks(rows, options);
    mediumBlockLayoutCacheRef.current.set(cacheKey, built);
    return built;
  };

  const displayAspectRatio = (item: TrendingImage, index: number): number => {
    const base = getTrendingRatio(item, index);
    return Math.max(0.52, Math.min(2.8, base));
  };

  const trendingViewCount = (index: number): string => `${(1.8 + ((index % 9) * 0.17)).toFixed(1)}k`;

  const applyDensityChange = (nextDensity: FeedDensity, markDensityRequest = false) => {
    setFeedDensity(nextDensity);
    setTrendingImages([]);
    setTrendingCursor(undefined);
    setLoadingMoreTrending(false);
    setTrendingReloadNonce((value) => {
      const next = value + 1;
      if (markDensityRequest) {
        densitySwitchRequestRef.current = next;
      }
      return next;
    });
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        document.getElementById('trending')?.scrollIntoView({ behavior: 'auto', block: 'start' });
      });
    }
  };

  const resetTrendingViewForDensity = (nextDensity: FeedDensity) => {
    if (nextDensity === feedDensity || typeof window === 'undefined') return;
    clearDensityTransitionTimers();
    setDensitySwitchLoading(true);
    setDensityFadeState('fading-out');
    const fadeOutTimer = window.setTimeout(() => {
      applyDensityChange(nextDensity, true);
      setDensityFadeState('fading-in');
      const fadeInTimer = window.setTimeout(() => {
        setDensityFadeState('idle');
      }, densityFadeInMs);
      densityTransitionTimersRef.current.push(fadeInTimer);
    }, densityFadeOutMs);
    densityTransitionTimersRef.current.push(fadeOutTimer);
  };

  const searchNeedle = discoverySearch.trim().toLowerCase();
  const trendingAfterSearch = searchNeedle.length > 0
    ? trendingImages.filter((item) => {
      const haystack = [
        item.title,
        item.artistName,
        item.gallerySlug,
        item.galleryId,
        item.displayedContentRating,
        item.displayedAiDisclosure,
        ...(item.displayedHeavyTopics || [])
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(searchNeedle);
    })
    : trendingImages;
  const trendingAfterMediaType = trendingAfterSearch.filter((item) => passesDiscoveryMediaFilter(item, {
    showImages: showImageMedia,
    showVideos: showVideoMedia,
    showPosts: showPostMedia
  }));
  const trendingRenderable = trendingAfterMediaType.filter((item) => Boolean(item.previewUrl));
  const smallTopItemCount = densityTopRows.small * 4;
  const smallTopItems = trendingRenderable.slice(0, smallTopItemCount);
  const smallContinuationItems = trendingRenderable.slice(smallTopItemCount);
  const allTrendingRows = buildPairRows(trendingRenderable);
  const topRows = allTrendingRows.slice(0, densityTopRows[feedDensity]);
  const continuationRowsSeed = allTrendingRows.slice(densityTopRows[feedDensity]);
  const dynamicTopBorrowRows = continuationRowsSeed.slice(0, 5);
  if (feedDensity === 'medium' && !mediumTopBorrowRowsRef.current && dynamicTopBorrowRows.length > 0) {
    mediumTopBorrowRowsRef.current = dynamicTopBorrowRows;
  }
  const topBorrowRows = feedDensity === 'medium'
    ? (mediumTopBorrowRowsRef.current || dynamicTopBorrowRows)
    : dynamicTopBorrowRows;
  const continuationEntriesSeed = rowsToEntries(topBorrowRows);
  const mediumTopBuild = feedDensity === 'medium'
    ? stableMediumBlockBuild(topRows, { borrowedEntries: continuationEntriesSeed })
    : null;
  const borrowedTopImageIds = mediumTopBuild?.consumedBorrowedImageIds || new Set<string>();
  const filterRowsByExcludedImageIds = (rows: TrendingPairRow[], excluded: Set<string>): TrendingPairRow[] => {
    if (excluded.size === 0) return rows;
    const filtered: TrendingPairRow[] = [];
    rows.forEach((row) => {
      const keptEntries = [
        { item: row.left, index: row.startIndex },
        ...(row.right ? [{ item: row.right, index: row.startIndex + 1 }] : [])
      ].filter((entry) => !excluded.has(entry.item.imageId));
      if (keptEntries.length === 0) return;
      if (keptEntries.length === 1) {
        filtered.push({
          left: keptEntries[0].item,
          right: undefined,
          startIndex: keptEntries[0].index
        });
        return;
      }
      const sorted = [...keptEntries].sort((a, b) => a.index - b.index);
      filtered.push({
        left: sorted[0].item,
        right: sorted[1].item,
        startIndex: sorted[0].index
      });
    });
    return filtered;
  };
  const continuationRows = feedDensity === 'medium'
    ? filterRowsByExcludedImageIds(continuationRowsSeed, borrowedTopImageIds)
    : continuationRowsSeed;
  const continuationBlockRowsByDensity: Record<FeedDensity, number> = {
    small: 3,
    medium: 2,
    large: 1
  };
  const continuationSmallBlockSize = continuationBlockRowsByDensity.small * 4;
  const continuationRowsBlockSize = continuationBlockRowsByDensity[feedDensity];

  const smallContinuationBlockOne = smallContinuationItems.slice(0, continuationSmallBlockSize);
  const smallContinuationBlockTwo = smallContinuationItems.slice(continuationSmallBlockSize, continuationSmallBlockSize * 2);
  const smallContinuationBlockThree = smallContinuationItems.slice(continuationSmallBlockSize * 2);

  const continuationBlockOneRows = continuationRows.slice(0, continuationRowsBlockSize);
  const continuationBlockTwoRows = continuationRows.slice(continuationRowsBlockSize, continuationRowsBlockSize * 2);
  const continuationBlockThreeRows = continuationRows.slice(continuationRowsBlockSize * 2);
  const continuationChunkSize = Math.max(1, continuationRowsBlockSize);
  let continuationFrozenRowsCount = 0;
  if (feedDensity !== 'small') {
    const fullChunkRows = Math.floor(continuationBlockThreeRows.length / continuationChunkSize) * continuationChunkSize;
    if (fullChunkRows > continuationFrozenRowsRef.current) {
      continuationFrozenRowsRef.current = fullChunkRows;
    }
    if (!trendingCursor && continuationBlockThreeRows.length > continuationFrozenRowsRef.current) {
      continuationFrozenRowsRef.current = continuationBlockThreeRows.length;
    }
    continuationFrozenRowsCount = Math.min(continuationFrozenRowsRef.current, continuationBlockThreeRows.length);
  }
  const continuationFrozenRows = feedDensity === 'small'
    ? []
    : continuationBlockThreeRows.slice(0, continuationFrozenRowsCount);
  const continuationTailRows = feedDensity === 'small'
    ? []
    : continuationBlockThreeRows.slice(continuationFrozenRowsCount);
  const continuationFrozenChunks: TrendingPairRow[][] = [];
  if (feedDensity !== 'small') {
    for (let i = 0; i < continuationFrozenRows.length; i += continuationChunkSize) {
      const chunk = continuationFrozenRows.slice(i, i + continuationChunkSize);
      if (chunk.length > 0) continuationFrozenChunks.push(chunk);
    }
  }

  const continuationBlockOneHasItems = feedDensity === 'small' ? smallContinuationBlockOne.length > 0 : continuationBlockOneRows.length > 0;
  const continuationBlockTwoHasItems = feedDensity === 'small' ? smallContinuationBlockTwo.length > 0 : continuationBlockTwoRows.length > 0;
  const continuationBlockThreeHasItems = feedDensity === 'small'
    ? (smallContinuationBlockThree.length > 0 || Boolean(trendingCursor))
    : (continuationBlockThreeRows.length > 0 || Boolean(trendingCursor));
  const densityTransitionClass = densityFadeState === 'idle' ? '' : ` ${densityFadeState}`;
  const isDensityTransitioning = densityFadeState !== 'idle';
  const densitySliderValue = feedDensity === 'small' ? 0 : (feedDensity === 'medium' ? 1 : 2);
  const densityRangeStyle = getDensityRangeStyle(densitySliderValue);

  const latest = galleries
    .filter((gallery) => Boolean((gallery.stackPreviewUrls && gallery.stackPreviewUrls[0]) || gallery.galleryThumbnailUrl))
    .slice(0, 8);
  const latestItems: DiscoveryGallery[] = latest;
  const risingArtists = artists.slice(0, 4);
  const trendingCollections = collections.slice(0, 3);
  const discoveryTopics = ['For you', 'Challenges', 'Following', 'Photography', 'Design', 'Stories', 'Places'];
  const challengeRows = [
    {
      id: 'sun-faded',
      endsIn: '6d',
      title: 'Sun Faded',
      description: 'Capture the beauty of faded signs and colors.',
      joinedLabel: '1.2k joined',
      preview: trendingRenderable[0]?.previewPosterUrl || trendingRenderable[0]?.previewUrl || latestItems[0]?.galleryThumbnailUrl || ''
    },
    {
      id: 'blue-hour',
      endsIn: '12d',
      title: 'Blue Hour',
      description: 'Show us the magic of twilight and transition.',
      joinedLabel: '856 joined',
      preview: trendingRenderable[1]?.previewPosterUrl || trendingRenderable[1]?.previewUrl || latestItems[1]?.galleryThumbnailUrl || ''
    },
    {
      id: 'roadside-reflections',
      endsIn: '3d',
      title: 'Roadside Reflections',
      description: 'Reflections found in unexpected places.',
      joinedLabel: '643 joined',
      preview: trendingRenderable[2]?.previewPosterUrl || trendingRenderable[2]?.previewUrl || latestItems[2]?.galleryThumbnailUrl || ''
    }
  ];
  const risingNowRows = [
    {
      id: 'neon-dreams',
      title: 'Neon Dreams',
      posts: 348,
      preview: trendingRenderable[3]?.previewPosterUrl || trendingRenderable[3]?.previewUrl || latestItems[3]?.galleryThumbnailUrl || ''
    },
    {
      id: 'roadside-icons',
      title: 'Roadside Icons',
      posts: 512,
      preview: trendingRenderable[4]?.previewPosterUrl || trendingRenderable[4]?.previewUrl || latestItems[4]?.galleryThumbnailUrl || ''
    },
    {
      id: 'forgotten-places',
      title: 'Forgotten Places',
      posts: 201,
      preview: trendingRenderable[5]?.previewPosterUrl || trendingRenderable[5]?.previewUrl || latestItems[5]?.galleryThumbnailUrl || ''
    },
    {
      id: 'midday-light',
      title: 'Midday Light',
      posts: 309,
      preview: trendingRenderable[6]?.previewPosterUrl || trendingRenderable[6]?.previewUrl || latestItems[6]?.galleryThumbnailUrl || ''
    },
    {
      id: 'backroad-america',
      title: 'Backroad America',
      posts: 621,
      preview: trendingRenderable[7]?.previewPosterUrl || trendingRenderable[7]?.previewUrl || latestItems[7]?.galleryThumbnailUrl || ''
    }
  ];
  const discoverySpotlightRows = trendingRenderable.slice(8, 12).map((item, index) => ({
    id: item.imageId || `spotlight-${index}`,
    title: item.title || item.postTitle || 'Untitled spotlight',
    subtitle: item.artistName || 'Creator',
    preview: item.previewPosterUrl || item.previewUrl
  }));
  const showRisingArtistsSection = risingArtists.length >= 2;
  const showTrendingCollectionsSection = trendingCollections.length >= 2;

  const toggleFollow = async (artistId?: string) => {
    if (!artistId) return;
    try {
      if (followedArtistIds.has(artistId)) {
        await api.unfollowArtist(artistId);
        setFollowedArtistIds((prev) => {
          const next = new Set(prev);
          next.delete(artistId);
          return next;
        });
      } else {
        await api.followArtist(artistId);
        setFollowedArtistIds((prev) => new Set(prev).add(artistId));
      }
    } catch {
      // no-op
    }
  };

  const favoriteAsProfile = favoriteIdentity.startsWith('artist:')
    ? { ownerProfileType: 'artist' as const, ownerProfileId: favoriteIdentity.slice('artist:'.length) }
    : { ownerProfileType: 'user' as const };

  useEffect(() => {
    const loadFavorites = async () => {
      if (!deferredSectionsReady) return;
      if (!currentUser) {
        setFavoriteImageIds(new Set());
        setFavoriteGalleryIds(new Set());
        return;
      }
      try {
        const favorites = await api.myFavorites(favoriteAsProfile) as ManagedFavorite[];
        setFavoriteImageIds(new Set(favorites.filter((item) => item.targetType === 'image').map((item) => item.targetId)));
        setFavoriteGalleryIds(new Set(favorites.filter((item) => item.targetType === 'gallery').map((item) => item.targetId)));
      } catch {
        setFavoriteImageIds(new Set());
        setFavoriteGalleryIds(new Set());
      }
    };
    void loadFavorites();
  }, [currentUser?.username, favoriteIdentity, deferredSectionsReady]);

  const toggleImageFavorite = async (imageId: string) => {
    const wasFavorited = favoriteImageIds.has(imageId);
    setFavoriteImageIds((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(imageId);
      else next.add(imageId);
      return next;
    });
    setTrendingImages((prev) => prev.map((item) => (
      item.imageId === imageId
        ? { ...item, favoriteCount: Math.max(0, (item.favoriteCount || 0) + (wasFavorited ? -1 : 1)) }
        : item
    )));
    try {
      if (wasFavorited) {
        await api.unfavorite('image', imageId, favoriteAsProfile);
      } else {
        await api.favorite('image', imageId, 'public', favoriteAsProfile);
      }
    } catch {
      setFavoriteImageIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(imageId);
        else next.delete(imageId);
        return next;
      });
      setTrendingImages((prev) => prev.map((item) => (
        item.imageId === imageId
          ? { ...item, favoriteCount: Math.max(0, (item.favoriteCount || 0) + (wasFavorited ? 1 : -1)) }
          : item
      )));
    }
  };

  const toggleGalleryFavorite = async (galleryId: string) => {
    const wasFavorited = favoriteGalleryIds.has(galleryId);
    setFavoriteGalleryIds((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(galleryId);
      else next.add(galleryId);
      return next;
    });
    try {
      if (wasFavorited) {
        await api.unfavorite('gallery', galleryId, favoriteAsProfile);
      } else {
        await api.favorite('gallery', galleryId, 'public', favoriteAsProfile);
      }
    } catch {
      setFavoriteGalleryIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(galleryId);
        else next.delete(galleryId);
        return next;
      });
    }
  };

  const openFocusedDiscovery = async (item: TrendingImage) => {
    setFocusedDiscoveryOpen(true);
    setFocusedDiscoveryError('');
    const activeFeed = trendingAfterMediaType.length > 0 ? trendingAfterMediaType : [item];
    const focusedIndex = Math.max(
      0,
      activeFeed.findIndex((entry) => (
        entry.imageId === item.imageId
        && entry.surfaceType === item.surfaceType
        && (entry.postId || '') === (item.postId || '')
      ))
    );
    setFocusedDiscoveryContextItems(activeFeed);
    setFocusedDiscoveryContextIndex(focusedIndex);
  };

  const closeFocusedDiscovery = () => {
    setFocusedDiscoveryOpen(false);
    setFocusedDiscoveryPost(null);
    setFocusedDiscoveryLoading(false);
    setFocusedDiscoveryError('');
    focusedDiscoveryRequestRef.current += 1;
  };

  const focusedDiscoveryItem = focusedDiscoveryContextItems[focusedDiscoveryContextIndex] || null;
  const focusedDiscoveryHasPrevious = focusedDiscoveryContextIndex > 0;
  const focusedDiscoveryHasNext = focusedDiscoveryContextIndex >= 0 && focusedDiscoveryContextIndex < focusedDiscoveryContextItems.length - 1;
  const focusedOverlayItem: DiscoveryOverlayItem | null = focusedDiscoveryItem
    ? {
      imageId: focusedDiscoveryItem.imageId,
      assetType: focusedDiscoveryItem.assetType === 'video' ? 'video' : 'image',
      surfaceType: focusedDiscoveryItem.surfaceType,
      postId: focusedDiscoveryItem.postId,
      postSlug: focusedDiscoveryItem.postSlug,
      postTitle: focusedDiscoveryItem.postTitle,
      postSummary: focusedDiscoveryItem.postSummary,
      artistId: focusedDiscoveryItem.artistId,
      artistName: focusedDiscoveryItem.artistName,
      creatorSlug: artistSlugById.get(focusedDiscoveryItem.artistId),
      gallerySlug: focusedDiscoveryItem.gallerySlug,
      title: focusedDiscoveryItem.title,
      previewUrl: focusedDiscoveryItem.previewUrl,
      previewPosterUrl: focusedDiscoveryItem.previewPosterUrl,
      displayedContentRating: focusedDiscoveryItem.displayedContentRating,
      displayedAiDisclosure: focusedDiscoveryItem.displayedAiDisclosure,
      displayedHeavyTopics: focusedDiscoveryItem.displayedHeavyTopics,
      blurred: focusedDiscoveryItem.blurred
    }
    : null;
  const focusedRelatedItems: DiscoveryOverlayItem[] = focusedDiscoveryContextItems
    .filter((entry, index) => index !== focusedDiscoveryContextIndex)
    .slice(0, 8)
    .map((entry) => ({
      imageId: entry.imageId,
      assetType: entry.assetType === 'video' ? 'video' : 'image',
      surfaceType: entry.surfaceType,
      postId: entry.postId,
      postSlug: entry.postSlug,
      postTitle: entry.postTitle,
      postSummary: entry.postSummary,
      artistId: entry.artistId,
      artistName: entry.artistName,
      creatorSlug: artistSlugById.get(entry.artistId),
      gallerySlug: entry.gallerySlug,
      title: entry.title,
      previewUrl: entry.previewUrl,
      previewPosterUrl: entry.previewPosterUrl,
      displayedContentRating: entry.displayedContentRating,
      displayedAiDisclosure: entry.displayedAiDisclosure,
      displayedHeavyTopics: entry.displayedHeavyTopics,
      blurred: entry.blurred
    }));

  useEffect(() => {
    if (!focusedDiscoveryOpen || !focusedDiscoveryItem) return;
    const isPostSurface = focusedDiscoveryItem.surfaceType === 'post' || Boolean(focusedDiscoveryItem.postId);
    if (!isPostSurface || !focusedDiscoveryItem.postId) {
      setFocusedDiscoveryPost(null);
      setFocusedDiscoveryLoading(false);
      setFocusedDiscoveryError('');
      return;
    }
    const requestId = focusedDiscoveryRequestRef.current + 1;
    focusedDiscoveryRequestRef.current = requestId;
    setFocusedDiscoveryLoading(true);
    setFocusedDiscoveryError('');
    void (async () => {
      try {
        const post = await api.getPostById(focusedDiscoveryItem.postId || '') as PostDetailPayload;
        if (focusedDiscoveryRequestRef.current !== requestId) return;
        setFocusedDiscoveryPost(post);
      } catch (e) {
        if (focusedDiscoveryRequestRef.current !== requestId) return;
        setFocusedDiscoveryPost(null);
        setFocusedDiscoveryError((e as Error).message || 'Could not load post');
      } finally {
        if (focusedDiscoveryRequestRef.current === requestId) {
          setFocusedDiscoveryLoading(false);
        }
      }
    })();
  }, [focusedDiscoveryOpen, focusedDiscoveryItem?.imageId, focusedDiscoveryItem?.postId, focusedDiscoveryItem?.surfaceType]);

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
        setFocusedDiscoveryContextIndex((index) => Math.max(0, index - 1));
      }
      if (event.key === 'ArrowRight' && focusedDiscoveryHasNext) {
        setFocusedDiscoveryContextIndex((index) => Math.min(focusedDiscoveryContextItems.length - 1, index + 1));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [
    focusedDiscoveryOpen,
    focusedDiscoveryHasPrevious,
    focusedDiscoveryHasNext,
    focusedDiscoveryContextItems.length
  ]);

  const renderTrendingCard = (
    item: TrendingImage,
    cardIndex: number,
    options?: { forceSquareFrame?: boolean; compactCard?: boolean; preload?: boolean }
  ) => {
    const isPostSurface = item.surfaceType === 'post' || Boolean(item.postId);
    const assetType = item.assetType === 'video' ? 'video' : 'image';
    const effectivePosterUrl = item.previewPosterUrl
      || (assetType === 'video' && isLikelyImageUrl(item.previewUrl) ? item.previewUrl : undefined);
    const visibilityPill = item.galleryVisibility === 'preview'
      ? 'Preview'
      : item.galleryVisibility === 'premium'
        ? 'Premium'
        : null;
    const isFavorite = favoriteImageIds.has(item.imageId);
    const displayedRating = item.displayedContentRating || 'General';
    const cardTitle = isPostSurface ? (item.postTitle || item.title || 'Untitled post') : (item.title || 'Artwork title');
    const cardSummary = isPostSurface ? (item.postSummary || '') : '';
    const disclosureLine = formatDisclosureLine(item);
    const isBlurredByRating = item.blurred === true;
    const ratio = displayAspectRatio(item, cardIndex);
    const allowDiscoverSquareCrop = item.discoverSquareCropEnabled !== false;
    const forceSquareFrame = Boolean(options?.forceSquareFrame);
    const compactCard = Boolean(options?.compactCard);
    const preload = Boolean(options?.preload);
    const shouldSquareCrop = (feedDensity === 'small' || forceSquareFrame) && allowDiscoverSquareCrop;
    const shouldLargeCrop = false;
    const frameRatio = shouldSquareCrop ? 1 : ratio;
    const isSmallLandscape = feedDensity === 'small' && !shouldSquareCrop && ratio >= 1.25;
    const largeCardClass = feedDensity === 'large' ? ' density-large-card' : '';
    const compactCardClass = compactCard ? ' is-compact' : '';
    const largeCropClass = shouldLargeCrop ? ' large-crop' : '';
    const nonCropClass = !shouldSquareCrop && !shouldLargeCrop ? ' no-crop' : '';
    const imageSrcSet = assetType === 'image' ? buildImageSrcSet(item.thumbnailUrls) : undefined;
    const imageSizes = feedDensity === 'large'
      ? '(min-width: 1100px) min(100vw, 1280px), 100vw'
      : feedDensity === 'medium'
        ? '(min-width: 1100px) 50vw, 100vw'
        : '(min-width: 1100px) 33vw, 50vw';
    const imageSrc = item.thumbnailUrls?.w1280 || item.thumbnailUrls?.w640 || item.previewUrl;

    return (
      <article
        key={item.imageId}
        className={`discovery-feature-card${isSmallLandscape ? ' is-landscape' : ''}${largeCardClass}${compactCardClass}`}
        style={{ '--media-aspect': frameRatio.toFixed(4) } as any}
      >
        <button
          type="button"
          className="discovery-feature-link discovery-feature-link-btn no-underline"
          onClick={() => void openFocusedDiscovery(item)}
        >
          <div
            className={`discovery-feature-media${shouldSquareCrop ? ' can-square-crop' : ''}${largeCropClass}${nonCropClass}`}
            style={{
              aspectRatio: `${frameRatio.toFixed(3)} / 1`
            }}
          >
            {(assetType === 'video' && !effectivePosterUrl) ? (
              <video
                src={item.previewUrl}
                muted
                playsInline
                preload="metadata"
                aria-label={item.title || 'Video preview'}
                style={{
                  objectPosition: 'center center',
                  filter: isBlurredByRating ? 'blur(28px)' : undefined
                }}
              />
            ) : (
              <img
                src={assetType === 'video' ? (effectivePosterUrl || '') : imageSrc}
                srcSet={assetType === 'image' ? imageSrcSet : undefined}
                sizes={assetType === 'image' ? imageSizes : undefined}
                alt={item.title || 'Artwork preview'}
                loading={preload || cardIndex < 2 ? 'eager' : 'lazy'}
                decoding="async"
                style={{
                  objectPosition: 'center center',
                  filter: isBlurredByRating ? 'blur(28px)' : undefined
                }}
              />
            )}
            {visibilityPill && <span className="discovery-chip">{visibilityPill}</span>}
            {isPostSurface && (
              <span
                className="discovery-chip"
                style={{ left: visibilityPill ? '6.1rem' : '1rem' }}
              >
                POST
              </span>
            )}
            {assetType === 'video' && (
              <span
                className="discovery-chip"
                style={{ left: 'unset', right: visibilityPill ? '8.2rem' : (isPostSurface ? '6rem' : '1rem') }}
              >
                Video
              </span>
            )}
            {isBlurredByRating && <span className="discovery-chip" style={{ left: 'unset', right: '1rem' }}>Mature Content</span>}
          </div>
        </button>
        <div className="discovery-feature-footer">
          <div className="discovery-feature-text">
            <h3 className="discovery-feature-title">
              {item.gallerySlug ? (
                <Link to={`/gallery/${item.gallerySlug}?image=${encodeURIComponent(item.imageId)}`} className="no-underline">
                  {cardTitle}
                </Link>
              ) : cardTitle}
            </h3>
            <p className="discovery-feature-subtitle">
              by {artistSlugById.get(item.artistId)
                ? (
                  <Link to={`/creators/${artistSlugById.get(item.artistId)}`} className="no-underline">
                    {item.artistName || 'Creator Name'}
                  </Link>
                )
                : (item.artistName || 'Creator Name')}
            </p>
            {cardSummary && !compactCard && (
              <p className="discovery-feature-summary">{cardSummary}</p>
            )}
            {disclosureLine && !compactCard && <p className="discovery-feature-subtitle">{disclosureLine}</p>}
          </div>
          {!compactCard && (
            <div className="discovery-feature-stats">
              <span>❤ {item.favoriteCount || 0}</span>
              <span>👁 {trendingViewCount(cardIndex)}</span>
              <span>{visibilityPill === 'Preview' ? 'Follower preview' : visibilityPill === 'Premium' ? 'Premium' : 'Public'}</span>
              <span>{displayedRating}</span>
            </div>
          )}
          {currentUser && !compactCard && (
            <div className="discovery-feature-actions">
              <button
                className="auth-secondary-btn discovery-inline-btn"
                onClick={() => void toggleImageFavorite(item.imageId)}
              >
                {isFavorite ? 'Unfavorite' : 'Favorite'}
              </button>
            </div>
          )}
        </div>
      </article>
    );
  };

  const renderTrendingBlockContent = (
    smallItems: TrendingImage[],
    smallStartIndex: number,
    rows: TrendingPairRow[],
    preparedMediumBlocks?: TrendingMediumBlock[],
    options?: { preloadAll?: boolean }
  ) => {
    const preloadAll = Boolean(options?.preloadAll);
    if (feedDensity === 'small') {
      return (
        <div className="discovery-small-grid">
          {smallItems.map((item, index) => renderTrendingCard(item, smallStartIndex + index, { preload: preloadAll }))}
        </div>
      );
    }
    if (feedDensity === 'medium') {
      const mediumBlocks = preparedMediumBlocks || stableMediumBlockBuild(rows).blocks;
      return (
        <div className="discovery-pair-feed density-medium-mixed">
          {mediumBlocks.map((block, blockIndex) => (
            block.kind === 'pair' ? (
              <div
                key={`medium-pair-${block.row.left.imageId}-${block.row.right?.imageId || 'single'}`}
                className={`discovery-pair-row density-medium${block.row.right ? '' : ' single'}`}
                style={{
                  '--pair-cols-mobile': '1fr 1fr',
                  '--pair-cols': pairTemplateColumns(block.row, 'medium')
                } as any}
              >
                {renderTrendingCard(block.row.left, block.row.startIndex, { preload: preloadAll })}
                {block.row.right && renderTrendingCard(block.row.right, block.row.startIndex + 1, { preload: preloadAll })}
              </div>
            ) : (
              <div
                key={`medium-pair-inset-${block.row.left.imageId}-${block.row.right?.imageId || 'single'}-${block.insets.map((entry) => entry.item.imageId).join('-')}`}
                className="discovery-pair-row density-medium discovery-pair-row-with-inset"
                style={{
                  '--pair-cols-mobile': '1fr 1fr',
                  '--pair-cols': pairTemplateColumns(block.row, 'medium')
                } as any}
              >
                {block.insetOn === 'left' ? (
                  <>
                    <div className="discovery-pair-column-with-inset">
                      {renderTrendingCard(block.row.left, block.row.startIndex, { preload: preloadAll })}
                      {block.insets.map((entry) => renderTrendingCard(entry.item, entry.index, { forceSquareFrame: true, compactCard: true, preload: preloadAll }))}
                    </div>
                    {block.row.right && renderTrendingCard(block.row.right, block.row.startIndex + 1, { preload: preloadAll })}
                  </>
                ) : (
                  <>
                    {renderTrendingCard(block.row.left, block.row.startIndex, { preload: preloadAll })}
                    <div className="discovery-pair-column-with-inset">
                      {block.row.right && renderTrendingCard(block.row.right, block.row.startIndex + 1, { preload: preloadAll })}
                      {block.insets.map((entry) => renderTrendingCard(entry.item, entry.index, { forceSquareFrame: true, compactCard: true, preload: preloadAll }))}
                    </div>
                  </>
                )}
              </div>
            )
          ))}
        </div>
      );
    }
    return (
      <div className={`discovery-pair-feed density-${feedDensity}`}>
        {rows.map((row) => (
          <div
            key={`row-${row.left.imageId}-${row.right?.imageId || 'single'}`}
            className={`discovery-pair-row density-${feedDensity}${row.right ? '' : ' single'}`}
            style={{
              '--pair-cols-mobile': feedDensity === 'large' ? '1fr' : '1fr 1fr',
              '--pair-cols': pairTemplateColumns(row, feedDensity)
            } as any}
          >
            {renderTrendingCard(row.left, row.startIndex, { preload: preloadAll })}
            {row.right && renderTrendingCard(row.right, row.startIndex + 1, { preload: preloadAll })}
          </div>
        ))}
      </div>
    );
  };

  const renderTrendingSimpleRows = (
    rows: TrendingPairRow[],
    options?: { preloadAll?: boolean }
  ) => {
    const preloadAll = Boolean(options?.preloadAll);
    if (rows.length === 0) return null;
    return (
      <div className={`discovery-pair-feed density-${feedDensity}`}>
        {rows.map((row) => (
          <div
            key={`simple-row-${row.left.imageId}-${row.right?.imageId || 'single'}`}
            className={`discovery-pair-row density-${feedDensity}${row.right ? '' : ' single'}`}
            style={{
              '--pair-cols-mobile': feedDensity === 'large' ? '1fr' : '1fr 1fr',
              '--pair-cols': pairTemplateColumns(row, feedDensity)
            } as any}
          >
            {renderTrendingCard(row.left, row.startIndex, { preload: preloadAll })}
            {row.right && renderTrendingCard(row.right, row.startIndex + 1, { preload: preloadAll })}
          </div>
        ))}
      </div>
    );
  };

  const setCompactSection = (section: DiscoveryFilterSection) => {
    setCompactFilterSection(section);
    if (section === 'heavy') {
      setCompactHeavyTopicsExpanded(true);
    }
  };

  const closeCompactFilters = () => setCompactFiltersOpen(false);

  const compactTabs: Array<{ section: DiscoveryFilterSection; label: string }> = [
    { section: 'period', label: discoverySort === 'latest' ? 'Latest' : (trendingPeriod === 'daily' ? 'Daily' : 'Hourly') },
    { section: 'media', label: mediaSummaryLabel },
    { section: 'density', label: `Density: ${densityLabel[feedDensity]}` },
    { section: 'heavy', label: heavySummaryLabel },
    { section: 'search', label: discoverySearch.trim().length > 0 ? 'Search active' : 'Search' }
  ];

  const renderCompactFilterBody = () => {
    if (compactFilterSection === 'period') {
      return (
        <div className="discovery-compact-section discovery-compact-period-section">
          <div className="discovery-filter-label">Trending period</div>
          <div className="discovery-trending-filter">
            <button
              className={`discovery-pill-btn${discoverySort === 'latest' ? ' is-active' : ''}`}
              onClick={() => setDiscoverySort('latest')}
            >
              Latest
            </button>
            <button
              className={`discovery-pill-btn${discoverySort === 'trending' && trendingPeriod === 'hourly' ? ' is-active' : ''}`}
              onClick={() => {
                setDiscoverySort('trending');
                setTrendingPeriod('hourly');
              }}
            >
              Hourly
            </button>
            <button
              className={`discovery-pill-btn${discoverySort === 'trending' && trendingPeriod === 'daily' ? ' is-active' : ''}`}
              onClick={() => {
                setDiscoverySort('trending');
                setTrendingPeriod('daily');
              }}
            >
              Daily
            </button>
          </div>
        </div>
      );
    }

    if (compactFilterSection === 'media') {
      return (
        <div className="discovery-compact-section discovery-compact-period-section">
          <div className="discovery-filter-label">Media types</div>
          <div className="discovery-trending-filter">
            <button className={`discovery-pill-btn discovery-media-toggle-btn${showImageMedia ? ' is-active' : ''}`} onClick={() => setShowImageMedia((prev) => !prev)}>
              <span className={`discovery-media-toggle-check${showImageMedia ? ' is-checked' : ''}`} aria-hidden="true" />
              <DiscoveryMediaIcon kind="image" className="discovery-media-icon" />
              <span>Images</span>
            </button>
            <button className={`discovery-pill-btn discovery-media-toggle-btn${showVideoMedia ? ' is-active' : ''}`} onClick={() => setShowVideoMedia((prev) => !prev)}>
              <span className={`discovery-media-toggle-check${showVideoMedia ? ' is-checked' : ''}`} aria-hidden="true" />
              <DiscoveryMediaIcon kind="video" className="discovery-media-icon" />
              <span>Videos</span>
            </button>
            <button className={`discovery-pill-btn discovery-media-toggle-btn${showPostMedia ? ' is-active' : ''}`} onClick={() => setShowPostMedia((prev) => !prev)}>
              <span className={`discovery-media-toggle-check${showPostMedia ? ' is-checked' : ''}`} aria-hidden="true" />
              <DiscoveryMediaIcon kind="post" className="discovery-media-icon" />
              <span>Posts</span>
            </button>
          </div>
        </div>
      );
    }

    if (compactFilterSection === 'heavy') {
      return (
        <div className="discovery-heavy-card">
          <div className="discovery-heavy-head">
            <label className="discovery-heavy-row is-primary">
              <input
                type="checkbox"
                checked={hideHeavyTopics || (hidePoliticsPublicAffairs && hideCrimeDisastersTragedy)}
                onChange={(e) => applyHideAllHeavyTopics(e.target.checked)}
              />
              <span>Hide all heavy topics</span>
            </label>
            <button
              type="button"
              className={`discovery-heavy-toggle${compactHeavyTopicsExpanded ? ' is-expanded' : ''}`}
              onClick={() => setCompactHeavyTopicsExpanded((prev) => !prev)}
              aria-label={compactHeavyTopicsExpanded ? 'Collapse heavy topics options' : 'Expand heavy topics options'}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M6 12L10 8L14 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          {compactHeavyTopicsExpanded && (
            <div className="discovery-heavy-body">
              <label className="discovery-heavy-row">
                <input
                  type="checkbox"
                  checked={hidePoliticsPublicAffairs}
                  onChange={(e) => applyHidePoliticsPublicAffairs(e.target.checked)}
                />
                <span>{heavyTopicLabels['politics-public-affairs']}</span>
              </label>
              <label className="discovery-heavy-row">
                <input
                  type="checkbox"
                  checked={hideCrimeDisastersTragedy}
                  onChange={(e) => applyHideCrimeDisastersTragedy(e.target.checked)}
                />
                <span>{heavyTopicLabels['crime-disasters-tragedy']}</span>
              </label>
            </div>
          )}
        </div>
      );
    }

    if (compactFilterSection === 'density') {
      return (
        <div className="discovery-density-card">
          <div className="discovery-density-head">
            <span>Feed density</span>
            <strong>{densityLabel[feedDensity]}</strong>
          </div>
          {densityViewport === 'desktop' && (
            <input
              className="discovery-density-range"
              type="range"
              min={0}
              max={2}
              step={1}
              value={densitySliderValue}
              style={densityRangeStyle}
              disabled={isDensityTransitioning}
              onChange={(e) => {
                const next = Number(e.target.value);
                resetTrendingViewForDensity(next <= 0 ? 'small' : next === 1 ? 'medium' : 'large');
              }}
            />
          )}
          <div className={`discovery-density-options${densityOptions.length === 2 ? ' is-two' : ''}`}>
            {densityOptions.map((option) => (
              <button
                key={`compact-density-option-${option}`}
                type="button"
                disabled={isDensityTransitioning}
                className={feedDensity === option ? 'is-active' : ''}
                onClick={() => resetTrendingViewForDensity(option)}
              >
                {densityLabel[option]}
              </button>
            ))}
          </div>
          <p className="small m-0 pt-4">
            Small shows more items. Large makes each item bigger.
          </p>
        </div>
      );
    }

    return (
      <div className="discovery-search-card is-compact">
        <div className="discovery-filter-label">Search</div>
        <div className="discovery-search-input-wrap">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M9 4.25a4.75 4.75 0 103.78 7.64l2.16 2.16a.75.75 0 101.06-1.06l-2.16-2.16A4.75 4.75 0 009 4.25z" fill="currentColor" />
          </svg>
          <input
            ref={compactSearchInputRef}
            type="text"
            value={discoverySearch}
            onChange={(e) => setDiscoverySearch(e.target.value)}
            placeholder="Search titles, creators, groupings, tags..."
          />
        </div>
      </div>
    );
  };

  return (
    <div className="layout discovery-layout">
      <section className="panel discovery-hero">
        <div className="discovery-hero-copy">
          <span className="discovery-hero-kicker">Welcome to Ubeeq</span>
          <h1>Creativity. <span>Everywhere.</span></h1>
          <p>Explore original perspectives from creators around the world. Curated by humans, powered by openness.</p>
          <div className="discovery-hero-topics" role="tablist" aria-label="Discovery topics">
            {discoveryTopics.map((topic, index) => (
              <button
                key={`discovery-topic-${topic}`}
                type="button"
                className={`discovery-hero-topic-pill${index === 0 ? ' is-active' : ''}`}
              >
                {topic}
              </button>
            ))}
          </div>
        </div>
        <div className="discovery-hero-actions">
          <a href="#rising-artists" className="auth-primary-btn no-underline">Browse Creators</a>
          <a href="#trending" className="auth-secondary-btn no-underline">Keep discovering</a>
        </div>
      </section>

      {showCompactDiscoveryDock && densityViewport !== 'mobile' && compactFiltersOpen && (
        <div className="discovery-compact-popover-layer" onClick={closeCompactFilters}>
          <div className="discovery-compact-popover" role="dialog" aria-label="Discovery filters" onClick={(e) => e.stopPropagation()}>
            <div className="discovery-compact-popover-toolbar">
              <button type="button" className="discovery-compact-close-btn" onClick={closeCompactFilters} aria-label="Close discovery filters">
                ✕
              </button>
            </div>
            <div className="discovery-compact-tabs discovery-compact-tabs-tablet">
              {compactTabs.map((tab) => (
                <button
                  key={`compact-tab-desktop-${tab.section}`}
                  type="button"
                  className={`topbar-discovery-chip topbar-discovery-chip-interactive${compactFilterSection === tab.section ? ' is-active' : ''}`}
                  onClick={() => setCompactSection(tab.section)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="discovery-compact-body">
              {renderCompactFilterBody()}
            </div>
          </div>
        </div>
      )}

      {showCompactDiscoveryDock && densityViewport === 'mobile' && compactFiltersOpen && (
        <div className="discovery-compact-sheet-layer" onClick={closeCompactFilters}>
          <div className="discovery-compact-sheet" role="dialog" aria-label="Discovery filters" onClick={(e) => e.stopPropagation()}>
            <div className="discovery-compact-sheet-handle" />
            <div className="discovery-compact-header">
              <div className="discovery-filter-label">Discovery controls</div>
              <button type="button" className="discovery-compact-close-btn" onClick={closeCompactFilters} aria-label="Close discovery filters">
                ✕
              </button>
            </div>
            <div className="discovery-compact-tabs">
              {compactTabs.map((tab) => (
                <button
                  key={`compact-tab-mobile-${tab.section}`}
                  type="button"
                  className={`topbar-discovery-chip topbar-discovery-chip-interactive${compactFilterSection === tab.section ? ' is-active' : ''}`}
                  onClick={() => setCompactSection(tab.section)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="discovery-compact-body">
              {renderCompactFilterBody()}
            </div>
          </div>
        </div>
      )}

      <section id="trending" aria-busy={densitySwitchLoading}>        
        <div id="discovery-filter-panel" ref={discoveryFilterPanelRef} className="discovery-filter-shell">
          <div className="discovery-filter-grid">
            <div className="discovery-filter-left">
              <div>
                <div className="discovery-filter-label">Trending period</div>
                <div className="discovery-trending-filter">
                  <button
                    className={`discovery-pill-btn${discoverySort === 'latest' ? ' is-active' : ''}`}
                    onClick={() => setDiscoverySort('latest')}
                  >
                    Latest
                  </button>
                  <button
                    className={`discovery-pill-btn${discoverySort === 'trending' && trendingPeriod === 'hourly' ? ' is-active' : ''}`}
                    onClick={() => {
                      setDiscoverySort('trending');
                      setTrendingPeriod('hourly');
                    }}
                  >
                    Hourly
                  </button>
                  <button
                    className={`discovery-pill-btn${discoverySort === 'trending' && trendingPeriod === 'daily' ? ' is-active' : ''}`}
                    onClick={() => {
                      setDiscoverySort('trending');
                      setTrendingPeriod('daily');
                    }}
                  >
                    Daily
                  </button>
                </div>
              </div>

              <div>
                <div className="discovery-filter-label">Media types</div>
                <div className="discovery-trending-filter">
                  <button className={`discovery-pill-btn discovery-media-toggle-btn${showImageMedia ? ' is-active' : ''}`} onClick={() => setShowImageMedia((prev) => !prev)}>
                    <span className={`discovery-media-toggle-check${showImageMedia ? ' is-checked' : ''}`} aria-hidden="true" />
                    <DiscoveryMediaIcon kind="image" className="discovery-media-icon" />
                    <span>Images</span>
                  </button>
                  <button className={`discovery-pill-btn discovery-media-toggle-btn${showVideoMedia ? ' is-active' : ''}`} onClick={() => setShowVideoMedia((prev) => !prev)}>
                    <span className={`discovery-media-toggle-check${showVideoMedia ? ' is-checked' : ''}`} aria-hidden="true" />
                    <DiscoveryMediaIcon kind="video" className="discovery-media-icon" />
                    <span>Videos</span>
                  </button>
                  <button className={`discovery-pill-btn discovery-media-toggle-btn${showPostMedia ? ' is-active' : ''}`} onClick={() => setShowPostMedia((prev) => !prev)}>
                    <span className={`discovery-media-toggle-check${showPostMedia ? ' is-checked' : ''}`} aria-hidden="true" />
                    <DiscoveryMediaIcon kind="post" className="discovery-media-icon" />
                    <span>Posts</span>
                  </button>
                </div>
              </div>

              <div className="discovery-heavy-card">
                <div className="discovery-heavy-head">
                  <label className="discovery-heavy-row is-primary">
                    <input
                      type="checkbox"
                      checked={hideHeavyTopics || (hidePoliticsPublicAffairs && hideCrimeDisastersTragedy)}
                      onChange={(e) => applyHideAllHeavyTopics(e.target.checked)}
                    />
                    <span>Hide all heavy topics</span>
                  </label>
                  <button
                    type="button"
                    className={`discovery-heavy-toggle${heavyTopicsExpanded ? ' is-expanded' : ''}`}
                    onClick={() => setHeavyTopicsExpanded((prev) => !prev)}
                    aria-label={heavyTopicsExpanded ? 'Collapse heavy topics options' : 'Expand heavy topics options'}
                  >
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path d="M6 12L10 8L14 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
                {heavyTopicsExpanded && (
                  <div className="discovery-heavy-body">
                    <label className="discovery-heavy-row">
                      <input
                        type="checkbox"
                        checked={hidePoliticsPublicAffairs}
                        onChange={(e) => applyHidePoliticsPublicAffairs(e.target.checked)}
                      />
                      <span>{heavyTopicLabels['politics-public-affairs']}</span>
                    </label>
                    <label className="discovery-heavy-row">
                      <input
                        type="checkbox"
                        checked={hideCrimeDisastersTragedy}
                        onChange={(e) => applyHideCrimeDisastersTragedy(e.target.checked)}
                      />
                      <span>{heavyTopicLabels['crime-disasters-tragedy']}</span>
                    </label>
                  </div>
                )}
              </div>
            </div>

            <div className="discovery-filter-right">
              <div className="discovery-density-card">
                <div className="discovery-density-head">
                  <span>Feed density</span>
                  <strong>{densityLabel[feedDensity]}</strong>
                </div>
                {densityViewport === 'desktop' && (
                  <input
                    className="discovery-density-range"
                    type="range"
                    min={0}
                    max={2}
                    step={1}
                    value={densitySliderValue}
                    style={densityRangeStyle}
                    disabled={isDensityTransitioning}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      resetTrendingViewForDensity(next <= 0 ? 'small' : next === 1 ? 'medium' : 'large');
                    }}
                  />
                )}
                <div className={`discovery-density-options${densityOptions.length === 2 ? ' is-two' : ''}`}>
                  {densityOptions.map((option) => (
                    <button
                      key={`density-option-${option}`}
                      type="button"
                      disabled={isDensityTransitioning}
                      className={feedDensity === option ? 'is-active' : ''}
                      onClick={() => resetTrendingViewForDensity(option)}
                    >
                      {densityLabel[option]}
                    </button>
                  ))}
                </div>
                <p className="small m-0 pt-4">
                  Small shows more items. Large makes each item bigger.
                </p>
              </div>

              <div className="discovery-search-card">
                <div className="discovery-filter-label">Search</div>
                <div className="discovery-search-input-wrap">
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M9 4.25a4.75 4.75 0 103.78 7.64l2.16 2.16a.75.75 0 101.06-1.06l-2.16-2.16A4.75 4.75 0 009 4.25z" fill="currentColor" />
                  </svg>
                  <input
                    ref={discoverySearchInputRef}
                    type="text"
                    value={discoverySearch}
                    onChange={(e) => setDiscoverySearch(e.target.value)}
                    placeholder="Search titles, creators, groupings, tags..."
                  />
                </div>
                {currentUser && (
                  <div className="discovery-favorite-context">
                    <label className="small">Favorite as</label>
                    <select
                      className="settings-select"
                      value={favoriteIdentity}
                      onChange={(e) => setFavoriteIdentity(e.target.value)}
                    >
                      <option value="user">User Profile</option>
                      {managedArtists.map((artist) => (
                        <option key={`home-favorite-${artist.artistId}`} value={`artist:${artist.artistId}`}>
                          Creator: {artist.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {densitySwitchLoading && densityViewport !== 'mobile' && (
          <div className="discovery-density-fold-loader" role="status" aria-live="polite">
            <div className="discovery-density-fold-loader-label">Updating feed layout…</div>
            <div className="discovery-density-fold-loader-grid">
              <div />
              <div />
              <div />
            </div>
          </div>
        )}
        <div className={`discovery-density-transition${densityTransitionClass}`}>
          {renderTrendingBlockContent(smallTopItems, 0, topRows, mediumTopBuild?.blocks, { preloadAll: true })}
        </div>
        {loadingTrending && !densitySwitchLoading && (feedDensity === 'small' ? smallTopItems.length === 0 : topRows.length === 0) && <p className="small">Loading trending artwork...</p>}
        {!loadingTrending && (feedDensity === 'small' ? smallTopItems.length === 0 : topRows.length === 0) && <p className="small">No trending artwork yet.</p>}
      </section>

      <section id="active-challenges" className="discovery-editorial-section discovery-special-row">
        <div className="discovery-section-header">
          <h2>Active challenges</h2>
          <span className="text-sm font-semibold">Timed themes to spark creativity and connection.</span>
        </div>
        <div className="discovery-challenge-grid">
          {challengeRows.map((challenge) => (
            <article key={challenge.id} className="discovery-challenge-card">
              <span className="discovery-challenge-kicker">ENDS IN {challenge.endsIn}</span>
              <h3>{challenge.title}</h3>
              <p>{challenge.description}</p>
              <div className="discovery-challenge-footer">
                <span>{challenge.joinedLabel}</span>
                {challenge.preview && <img src={challenge.preview} alt="" loading="lazy" decoding="async" aria-hidden="true" />}
              </div>
            </article>
          ))}
        </div>
      </section>

      {continuationBlockOneHasItems && (
        <section id="trending-block-three" className="discovery-trending-flow-section">
          <div className={`discovery-density-transition${densityTransitionClass}`}>
            {renderTrendingBlockContent(
              smallContinuationBlockOne,
              smallTopItemCount,
              continuationBlockOneRows,
              undefined,
              { preloadAll: true }
            )}
          </div>
        </section>
      )}

      {showRisingArtistsSection && (
        <section id="rising-artists" className="discovery-editorial-section discovery-special-row">
          <div className="discovery-section-header">
            <h2>Rising Together</h2>
            <span className="text-sm font-semibold">Fresh voices. Growing communities.</span>
          </div>
          <div className="discovery-rising-row">
            {risingArtists.map((artist, i) => (
              <article key={artist.artistId || artist.name || `artist-special-${i}`} className="discovery-rising-pill">
                <div className="discovery-rising-avatar">
                  {artist.artistThumbnailUrl
                    ? <img src={artist.artistThumbnailUrl} alt={artist.name || 'Creator'} loading="lazy" decoding="async" />
                    : <span>{(artist.name || 'Creator').split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('')}</span>}
                </div>
                <div className="discovery-rising-meta">
                  <div className="discovery-card-title">
                    {artist.slug ? <Link to={`/creators/${artist.slug}`} className="no-underline">{artist.name || 'Creator Name'}</Link> : (artist.name || 'Creator Name')}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {continuationBlockTwoHasItems && (
        <section id="trending-block-four" className="discovery-trending-flow-section">
          <div className={`discovery-density-transition${densityTransitionClass}`}>
            {renderTrendingBlockContent(
              smallContinuationBlockTwo,
              smallTopItemCount + smallContinuationBlockOne.length,
              continuationBlockTwoRows,
              undefined,
              { preloadAll: true }
            )}
          </div>
        </section>
      )}

      <section id="rising-now" className="discovery-editorial-section discovery-special-row">
        <div className="discovery-section-header">
          <h2>Rising Now</h2>
          <span className="text-sm font-semibold">Fast-moving themes from the discovery stream.</span>
        </div>
        <div className="discovery-rising-now-row">
          {risingNowRows.map((row) => (
            <article key={row.id} className="discovery-rising-now-pill">
              <div className="discovery-rising-now-avatar">
                {row.preview
                  ? <img src={row.preview} alt="" loading="lazy" decoding="async" aria-hidden="true" />
                  : <div className="discovery-rising-now-placeholder" aria-hidden="true" />}
              </div>
              <div>
                <div className="discovery-card-title">{row.title}</div>
                <div className="discovery-card-subtitle">{row.posts} posts</div>
              </div>
            </article>
          ))}
          <button type="button" className="discovery-rising-now-next" aria-label="See more rising now rows">›</button>
        </div>
      </section>

      <section id="discovery-spotlight" className="discovery-editorial-section discovery-special-row">
        <div className="discovery-section-header">
          <h2>Discovery spotlight</h2>
          <span className="text-sm font-semibold">Fresh picks between rising trends and gallery drops.</span>
        </div>
        <div className="discovery-spotlight-grid">
          {discoverySpotlightRows.map((row, index) => (
            <article key={row.id} className="discovery-spotlight-card">
              <div className="discovery-spotlight-media">
                {row.preview
                  ? <img src={row.preview} alt={row.title} loading={index === 0 ? 'eager' : 'lazy'} decoding="async" />
                  : <div className="discovery-rising-now-placeholder" aria-hidden="true" />}
              </div>
              <div className="discovery-spotlight-meta">
                <div className="discovery-card-title">{row.title}</div>
                <div className="discovery-card-subtitle">by {row.subtitle}</div>
              </div>
            </article>
          ))}
          {discoverySpotlightRows.length === 0 && (
            <article className="discovery-spotlight-card is-placeholder" aria-hidden="true">
              <div className="discovery-spotlight-media"><div className="discovery-rising-now-placeholder" /></div>
              <div className="discovery-spotlight-meta">
                <div className="discovery-card-title">More discovery cards coming soon</div>
              </div>
            </article>
          )}
        </div>
      </section>

      <section id="latest-galleries" className="discovery-editorial-section">
        <div className="discovery-section-header">
          <h2>Latest Galleries</h2>
          <a href="#latest-galleries" className="text-sm font-semibold no-underline">Browse all</a>
        </div>

        <div className="discovery-latest-row">
          {latestItems.map((gallery, i) => (
            <article key={gallery.galleryId} className="discovery-gallery-stack-card">
              <Link to={gallery.slug ? `/gallery/${gallery.slug}` : '/'} className="no-underline">
                {(() => {
                  const layerSet = gallery.stackPreviewUrls || [];
                  const frontImage = layerSet[0] || gallery.galleryThumbnailUrl;
                  const midImage = layerSet[1] || layerSet[0] || gallery.galleryThumbnailUrl;
                  const backImage = layerSet[2] || layerSet[1] || layerSet[0] || gallery.galleryThumbnailUrl;
                  return (
                    <div className="discovery-stack discovery-stack-tall">
                      <div className="discovery-stack-layer discovery-stack-layer-back">
                        <img src={backImage} alt="" loading="lazy" decoding="async" aria-hidden="true" />
                      </div>
                      <div className="discovery-stack-layer discovery-stack-layer-mid">
                        <img src={midImage} alt="" loading="lazy" decoding="async" aria-hidden="true" />
                      </div>
                      <div className="discovery-stack-layer discovery-stack-layer-front">
                        <img
                          src={frontImage}
                          alt={gallery.title || 'Gallery cover'}
                          loading={i < 2 ? 'eager' : 'lazy'}
                          decoding="async"
                        />
                      </div>
                    </div>
                  );
                })()}
                <div className="discovery-gallery-stack-meta">
                  <div className="discovery-card-title">{gallery.title || 'Gallery title'}</div>
                  <div className="discovery-card-subtitle">by {gallery.artistName || 'Creator Name'}</div>
                </div>
              </Link>
              {currentUser && gallery.galleryId && (
                <div className="mt-3">
                  <button
                    className="auth-secondary-btn discovery-inline-btn"
                    onClick={() => void toggleGalleryFavorite(gallery.galleryId)}
                  >
                    {favoriteGalleryIds.has(gallery.galleryId) ? 'Unfavorite gallery' : 'Favorite gallery'}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
        {loadingLatest && latestItems.length === 0 && <p className="small">Loading latest galleries...</p>}
        {!loadingLatest && latestItems.length === 0 && <p className="small">No galleries yet.</p>}
      </section>

      {showRisingArtistsSection && (
        <section id="rising-artists-grid" className="discovery-editorial-section">
          <div className="discovery-section-header">
            <h2>Rising Creators</h2>
            <a href="#rising-artists-grid" className="text-sm font-semibold no-underline">More creators</a>
          </div>
          <div className="discovery-artists-grid discovery-artists-grid-wide">
            {risingArtists.map((artist, i) => (
              <article key={artist.artistId || artist.name || `artist-${i}`} className="discovery-artist-card">
                <div className="discovery-artist-avatar">
                  {artist.artistThumbnailUrl
                    ? <img src={artist.artistThumbnailUrl} alt={artist.name || 'Creator'} loading="lazy" decoding="async" />
                    : <span className="discovery-artist-initials">{(artist.name || 'Creator').split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('')}</span>}
                </div>
                <div className="discovery-artist-meta">
                  <div className="discovery-card-title">
                    {artist.slug ? <Link to={`/creators/${artist.slug}`} className="no-underline">{artist.name || 'Creator Name'}</Link> : (artist.name || 'Creator Name')}
                  </div>
                  <div className="discovery-card-subtitle">1.2k followers</div>
                </div>
                <button className="auth-secondary-btn discovery-inline-btn" onClick={() => void toggleFollow(artist.artistId)}>
                  {artist.artistId && followedArtistIds.has(artist.artistId) ? 'Following' : 'Follow'}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      {showTrendingCollectionsSection && (
        <section id="trending-collections" className="discovery-editorial-section">
          <div className="discovery-section-header">
            <h2>Trending Collections</h2>
            <Link to="/collections" className="text-sm font-semibold no-underline">View all</Link>
          </div>
          <div className="discovery-collection-grid">
            {trendingCollections.map((collection, index) => (
              <Link key={collection.collectionId} to={`/collections/${collection.collectionId}`} className="discovery-collection-card no-underline">
                <div className="discovery-collection-squares">
                  {(collectionPalettes[index % collectionPalettes.length] || collectionPalettes[0]).map((color, swatchIndex) => (
                    <div key={`${collection.collectionId}-sw-${swatchIndex}`} style={{ backgroundColor: color }} />
                  ))}
                </div>
                <div className="discovery-collection-meta">
                  <div className="discovery-card-title">{collection.title}</div>
                  <div className="discovery-card-subtitle">{collection.imageCount} images • {collection.favoriteCount} favorites</div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {continuationBlockThreeHasItems && (
        <section id="trending-continuation" className="discovery-trending-flow-section">
          {feedDensity === 'small' ? (
            <div className={`discovery-density-transition${densityTransitionClass}`}>
              {renderTrendingBlockContent(
                smallContinuationBlockThree,
                smallTopItemCount + smallContinuationBlockOne.length + smallContinuationBlockTwo.length,
                continuationBlockThreeRows
              )}
            </div>
          ) : (
            <>
              {continuationFrozenChunks.map((chunkRows, chunkIndex) => (
                <div key={`continuation-frozen-${feedDensity}-${chunkIndex}`} className={`discovery-density-transition${densityTransitionClass}`}>
                  {feedDensity === 'medium'
                    ? renderTrendingBlockContent([], 0, chunkRows, stableMediumBlockBuild(chunkRows).blocks)
                    : renderTrendingSimpleRows(chunkRows)}
                </div>
              ))}
              {continuationTailRows.length > 0 && (
                <div className={`discovery-density-transition${densityTransitionClass}`}>
                  {renderTrendingSimpleRows(continuationTailRows)}
                </div>
              )}
            </>
          )}
          <AutoLoadSentinel
            enabled={Boolean(trendingCursor)}
            loading={loadingMoreTrending}
            rootMargin="1200px 0px"
            onLoadMore={() => loadMoreTrending()}
          />
        </section>
      )}

      <DiscoveryQuickReadOverlay
        open={focusedDiscoveryOpen}
        item={focusedOverlayItem}
        itemIndex={focusedDiscoveryContextIndex}
        itemsCount={focusedDiscoveryContextItems.length}
        hasPrevious={focusedDiscoveryHasPrevious}
        hasNext={focusedDiscoveryHasNext}
        loading={focusedDiscoveryLoading}
        error={focusedDiscoveryError}
        post={focusedDiscoveryPost}
        moreFromStream={focusedRelatedItems}
        videoMuted={focusedDiscoveryVideoMuted}
        videoRef={focusedDiscoveryVideoRef}
        onClose={closeFocusedDiscovery}
        onPrevious={() => setFocusedDiscoveryContextIndex((index) => Math.max(0, index - 1))}
        onNext={() => setFocusedDiscoveryContextIndex((index) => Math.min(focusedDiscoveryContextItems.length - 1, index + 1))}
        onSelectStreamItem={(selectedItem) => {
          const nextIndex = focusedDiscoveryContextItems.findIndex((entry) => (
            entry.imageId === selectedItem.imageId
            && entry.surfaceType === selectedItem.surfaceType
            && (entry.postId || '') === (selectedItem.postId || '')
          ));
          if (nextIndex >= 0) setFocusedDiscoveryContextIndex(nextIndex);
        }}
        onVideoVolumeChange={(video) => {
          setFocusedDiscoveryVideoMuted(video.muted);
          setFocusedDiscoveryVideoVolume(Math.max(0, Math.min(1, video.volume)));
        }}
      />

      {error && (
        <section className="panel">
          <p className="error">Discovery data error: {error}</p>
        </section>
      )}
    </div>
  );
}
function GalleryPage({
  viewerProfile,
  onDiscoveryDockChange
}: {
  viewerProfile?: UserProfile | null;
  onDiscoveryDockChange?: (state: DiscoveryDockSummary | null) => void;
}) {
  const { slug = '' } = useParams();
  const location = useLocation();
  const currentUser = getCurrentUser();
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const [managedArtists, setManagedArtists] = useState<ManagedArtist[]>([]);
  const [favoriteIdentity, setFavoriteIdentity] = useState<string>('user');
  const [favoriteGallerySelected, setFavoriteGallerySelected] = useState(false);
  const [favoriteImageIds, setFavoriteImageIds] = useState<Set<string>>(new Set());
  const [profileCollections, setProfileCollections] = useState<ManagedCollection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>('');
  const [commentIdentity, setCommentIdentity] = useState<string>('user');
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const [password, setPassword] = useState('');
  const [unlockToken, setUnlockToken] = useState<string>('');
  const [rememberToken, setRememberToken] = useState<string>(() => getStoredGalleryAccessToken(slug) || '');
  const [hasPremiumAccess, setHasPremiumAccess] = useState(false);
  const [teaserLimit, setTeaserLimit] = useState(9);
  const [premiumImages, setPremiumImages] = useState<Array<{
    imageId: string;
    title?: string;
    assetType: 'image' | 'video';
    effectiveContentRating?: ContentRating;
    displayedContentRating?: string;
    blurred?: boolean;
    effectiveAiDisclosure?: AiDisclosure;
    displayedAiDisclosure?: string;
    effectiveHeavyTopics?: HeavyTopic[];
    displayedHeavyTopics?: string[];
    premiumUrl: string;
    premiumPosterUrl?: string;
  }>>([]);
  const [feedDensity, setFeedDensity] = useState<FeedDensity>('large');
  const [densityViewport, setDensityViewport] = useState<DensityViewport>(() => {
    if (typeof window === 'undefined') return 'desktop';
    if (window.innerWidth >= 1100) return 'desktop';
    if (window.innerWidth >= 700) return 'tablet';
    return 'mobile';
  });
  const [discoverySearch, setDiscoverySearch] = useState('');
  const [showImageMedia, setShowImageMedia] = useState(true);
  const [showVideoMedia, setShowVideoMedia] = useState(true);
  const [showPostMedia, setShowPostMedia] = useState(true);
  const [disclosureAiFilter, setDisclosureAiFilter] = useState<AiFilterPreference>(viewerProfile?.aiFilter || 'show-all');
  const [hideHeavyTopics, setHideHeavyTopics] = useState<boolean>(Boolean(viewerProfile?.hideHeavyTopics));
  const [hidePoliticsPublicAffairs, setHidePoliticsPublicAffairs] = useState<boolean>(Boolean(viewerProfile?.hidePoliticsPublicAffairs));
  const [hideCrimeDisastersTragedy, setHideCrimeDisastersTragedy] = useState<boolean>(Boolean(viewerProfile?.hideCrimeDisastersTragedy));
  const [heavyTopicsExpanded, setHeavyTopicsExpanded] = useState(true);
  const [galleryScope, setGalleryScope] = useState<'all' | 'public'>('all');
  const [showCompactDiscoveryDock, setShowCompactDiscoveryDock] = useState(false);
  const [compactFiltersOpen, setCompactFiltersOpen] = useState(false);
  const [compactFilterSection, setCompactFilterSection] = useState<DiscoveryFilterSection>('period');
  const [compactHeavyTopicsExpanded, setCompactHeavyTopicsExpanded] = useState(true);
  const [focusedOpen, setFocusedOpen] = useState(false);
  const [focusedItems, setFocusedItems] = useState<GalleryAsset[]>([]);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [focusedSectionTitle, setFocusedSectionTitle] = useState('Gallery');
  const [focusedVideoMuted, setFocusedVideoMuted] = useState(true);
  const [focusedVideoVolume, setFocusedVideoVolume] = useState(1);
  const focusedVideoRef = useRef<HTMLVideoElement | null>(null);
  const discoveryFilterPanelRef = useRef<HTMLDivElement | null>(null);
  const discoverySearchInputRef = useRef<HTMLInputElement | null>(null);
  const compactSearchInputRef = useRef<HTMLInputElement | null>(null);
  const deepLinkHandledRef = useRef<string>('');
  const [error, setError] = useState<string>('');

  const densityLabel: Record<FeedDensity, string> = { small: 'Small', medium: 'Medium', large: 'Large' };
  const densityOptions: FeedDensity[] = ['small', 'medium', 'large'];
  const densitySliderValue = feedDensity === 'small' ? 0 : (feedDensity === 'medium' ? 1 : 2);
  const densityRangeStyle = getDensityRangeStyle(densitySliderValue);
  const heavyHidden = hideHeavyTopics || (hidePoliticsPublicAffairs && hideCrimeDisastersTragedy);
  const someHeavyHidden = !heavyHidden && (hidePoliticsPublicAffairs || hideCrimeDisastersTragedy);
  const mediaSummaryLabel = getDiscoveryMediaLabel({
    showImages: showImageMedia,
    showVideos: showVideoMedia,
    showPosts: showPostMedia
  });
  const heavySummaryLabel: DiscoveryDockSummary['heavyLabel'] = (
    densityViewport === 'mobile'
      ? (heavyHidden ? 'Heavy Hidden' : (someHeavyHidden ? 'Some Heavy' : 'Heavy Shown'))
      : (heavyHidden ? 'Heavy Topics Hidden' : (someHeavyHidden ? 'Some Heavy Topics' : 'Heavy Topics Shown'))
  );

  const load = async () => {
    try {
      setError('');
      const stored = getStoredGalleryAccessToken(slug);
      if (stored && stored !== rememberToken) {
        setRememberToken(stored);
      }
      const [galleryData, commentData] = await Promise.all([api.getGallery(slug, stored || rememberToken), api.getGalleryComments(slug)]);
      setGallery(galleryData);
      setComments(commentData);
      const serverAccess = galleryData.visibility !== 'premium' ? Boolean(galleryData.hasAccess ?? true) : Boolean(galleryData.hasAccess);
      setHasPremiumAccess(serverAccess);
      if (galleryData.visibility === 'premium' && serverAccess) {
        try {
          if (stored || rememberToken) {
            const premium = await api.getPremiumImagesWithRemember(slug, stored || rememberToken);
            setPremiumImages(premium);
          } else {
            const premium = await api.getPremiumImages(slug, unlockToken);
            setPremiumImages(premium);
          }
        } catch {
          setPremiumImages([]);
          setHasPremiumAccess(false);
        }
      } else {
        setPremiumImages([]);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    setUnlockToken('');
    setPremiumImages([]);
    setHasPremiumAccess(false);
    setFocusedOpen(false);
    setRememberToken(getStoredGalleryAccessToken(slug) || '');
  }, [slug]);

  useEffect(() => {
    const applyResponsiveState = () => {
      const width = window.innerWidth;
      if (width >= 1280) setTeaserLimit(9);
      else if (width >= 768) setTeaserLimit(6);
      else setTeaserLimit(3);
      if (width >= 1100) setDensityViewport('desktop');
      else if (width >= 700) setDensityViewport('tablet');
      else setDensityViewport('mobile');
    };
    applyResponsiveState();
    window.addEventListener('resize', applyResponsiveState);
    return () => window.removeEventListener('resize', applyResponsiveState);
  }, []);

  useEffect(() => {
    void load();
  }, [slug, rememberToken]);

  useEffect(() => {
    setDisclosureAiFilter(viewerProfile?.aiFilter || 'show-all');
    setHideHeavyTopics(Boolean(viewerProfile?.hideHeavyTopics));
    setHidePoliticsPublicAffairs(Boolean(viewerProfile?.hidePoliticsPublicAffairs));
    setHideCrimeDisastersTragedy(Boolean(viewerProfile?.hideCrimeDisastersTragedy));
  }, [
    viewerProfile?.aiFilter,
    viewerProfile?.hideHeavyTopics,
    viewerProfile?.hidePoliticsPublicAffairs,
    viewerProfile?.hideCrimeDisastersTragedy
  ]);

  useEffect(() => {
    if (!currentUser) {
      setManagedArtists([]);
      setCommentIdentity('user');
      setFavoriteIdentity('user');
      setFavoriteGallerySelected(false);
      setFavoriteImageIds(new Set());
      setProfileCollections([]);
      return;
    }
    const loadArtists = async () => {
      try {
        const myArtists = await api.getMyArtists() as ManagedArtist[];
        setManagedArtists(myArtists);
      } catch {
        setManagedArtists([]);
      }
    };
    void loadArtists();
  }, [currentUser?.username]);

  const favoriteAsProfile = favoriteIdentity.startsWith('artist:')
    ? { ownerProfileType: 'artist' as const, ownerProfileId: favoriteIdentity.slice('artist:'.length) }
    : { ownerProfileType: 'user' as const };

  useEffect(() => {
    const loadFavoritesAndCollections = async () => {
      if (!currentUser || !gallery) return;
      try {
        const [favorites, collections] = await Promise.all([
          api.myFavorites(favoriteAsProfile) as Promise<ManagedFavorite[]>,
          api.myCollections(favoriteAsProfile) as Promise<ManagedCollection[]>
        ]);
        setFavoriteGallerySelected((favorites || []).some((item) => item.targetType === 'gallery' && item.targetId === gallery.galleryId));
        setFavoriteImageIds(new Set((favorites || []).filter((item) => item.targetType === 'image').map((item) => item.targetId)));
        setProfileCollections(collections || []);
      } catch {
        setFavoriteGallerySelected(false);
        setFavoriteImageIds(new Set());
        setProfileCollections([]);
      }
    };
    void loadFavoritesAndCollections();
  }, [currentUser?.username, favoriteIdentity, gallery?.galleryId]);

  const submitComment = async () => {
    try {
      setError('');
      if (commentIdentity.startsWith('artist:')) {
        await api.postGalleryCommentAsProfile(slug, commentBody, {
          authorProfileType: 'artist',
          authorProfileId: commentIdentity.slice('artist:'.length)
        });
      } else {
        await api.postGalleryCommentAsProfile(slug, commentBody, { authorProfileType: 'user' });
      }
      setCommentBody('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const unlock = async () => {
    try {
      setError('');
      const response = await api.unlockGallery(slug, password);
      setUnlockToken(response.unlockToken);
      if (response.rememberToken) {
        setRememberToken(response.rememberToken);
        setStoredGalleryAccessToken(slug, response.rememberToken, response.rememberExpiresInSeconds || 60 * 60 * 24 * 30);
      }
      const premium = await api.getPremiumImages(slug, response.unlockToken);
      setPremiumImages(premium);
      setHasPremiumAccess(true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const favoriteGallery = async () => {
    if (!gallery) return;
    const wasFavorited = favoriteGallerySelected;
    setFavoriteGallerySelected(!wasFavorited);
    setGallery((prev) => prev ? { ...prev, favoriteCount: Math.max(0, prev.favoriteCount + (wasFavorited ? -1 : 1)) } : prev);
    try {
      if (wasFavorited) await api.unfavorite('gallery', gallery.galleryId, favoriteAsProfile);
      else await api.favorite('gallery', gallery.galleryId, 'public', favoriteAsProfile);
    } catch (e) {
      setFavoriteGallerySelected(wasFavorited);
      setGallery((prev) => prev ? { ...prev, favoriteCount: Math.max(0, prev.favoriteCount + (wasFavorited ? 1 : -1)) } : prev);
      setError((e as Error).message);
    }
  };

  const toggleImageFavorite = async (imageId: string) => {
    const wasFavorited = favoriteImageIds.has(imageId);
    setFavoriteImageIds((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(imageId);
      else next.add(imageId);
      return next;
    });
    setGallery((prev) => prev ? ({
      ...prev,
      media: prev.media.map((item) => item.imageId === imageId ? { ...item, favoriteCount: Math.max(0, item.favoriteCount + (wasFavorited ? -1 : 1)) } : item)
    }) : prev);
    try {
      if (wasFavorited) await api.unfavorite('image', imageId, favoriteAsProfile);
      else await api.favorite('image', imageId, 'public', favoriteAsProfile);
    } catch (e) {
      setFavoriteImageIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(imageId);
        else next.delete(imageId);
        return next;
      });
      setGallery((prev) => prev ? ({
        ...prev,
        media: prev.media.map((item) => item.imageId === imageId ? { ...item, favoriteCount: Math.max(0, item.favoriteCount + (wasFavorited ? 1 : -1)) } : item)
      }) : prev);
      setError((e as Error).message);
    }
  };

  const addImageToCollection = async (imageId: string) => {
    try {
      if (!selectedCollectionId) throw new Error('Select a collection first');
      await api.addImageToCollection(selectedCollectionId, imageId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const applyHideAllHeavyTopics = (enabled: boolean) => {
    setHideHeavyTopics(enabled);
    setHidePoliticsPublicAffairs(enabled);
    setHideCrimeDisastersTragedy(enabled);
  };

  const applyHidePoliticsPublicAffairs = (enabled: boolean) => {
    setHidePoliticsPublicAffairs(enabled);
    setHideHeavyTopics(enabled && hideCrimeDisastersTragedy);
  };

  const applyHideCrimeDisastersTragedy = (enabled: boolean) => {
    setHideCrimeDisastersTragedy(enabled);
    setHideHeavyTopics(enabled && hidePoliticsPublicAffairs);
  };

  const previewItems = gallery?.media || [];
  const teaserItems: GalleryAsset[] = (gallery?.premiumTeaserMedia || []).map((item) => ({
    imageId: item.imageId,
    title: item.title,
    assetType: item.assetType,
    effectiveContentRating: item.effectiveContentRating,
    displayedContentRating: item.displayedContentRating,
    blurred: item.blurred,
    effectiveAiDisclosure: item.effectiveAiDisclosure,
    displayedAiDisclosure: item.displayedAiDisclosure,
    effectiveHeavyTopics: item.effectiveHeavyTopics,
    displayedHeavyTopics: item.displayedHeavyTopics,
    previewUrl: item.previewUrl,
    previewPosterUrl: item.previewPosterUrl,
    favoriteCount: 0
  }));
  const premiumItems: GalleryAsset[] = premiumImages.map((item) => ({
    imageId: item.imageId,
    title: item.title,
    assetType: item.assetType,
    effectiveContentRating: item.effectiveContentRating,
    displayedContentRating: item.displayedContentRating,
    blurred: item.blurred,
    effectiveAiDisclosure: item.effectiveAiDisclosure,
    displayedAiDisclosure: item.displayedAiDisclosure,
    effectiveHeavyTopics: item.effectiveHeavyTopics,
    displayedHeavyTopics: item.displayedHeavyTopics,
    previewUrl: item.premiumUrl,
    previewPosterUrl: item.premiumPosterUrl,
    favoriteCount: 0
  }));

  const filterItems = (items: GalleryAsset[]): GalleryAsset[] => items.filter((item) => (
    passesDiscoveryMediaFilter(item, {
      showImages: showImageMedia,
      showVideos: showVideoMedia,
      showPosts: showPostMedia
    })
    && passesAiDisclosureFilter(item.effectiveAiDisclosure, disclosureAiFilter)
    && passesHeavyTopicFilter(item.effectiveHeavyTopics, {
      hideHeavyTopics,
      hidePoliticsPublicAffairs,
      hideCrimeDisastersTragedy
    })
    && matchesDiscoverySearch(discoverySearch, [
      item.title,
      item.imageId,
      item.displayedContentRating,
      item.displayedAiDisclosure,
      ...(item.displayedHeavyTopics || [])
    ])
  ));

  const filteredPreviewItems = filterItems(previewItems);
  const filteredTeaserItems = filterItems(teaserItems).slice(0, teaserLimit);
  const filteredPremiumItems = filterItems(premiumItems);

  const mediaColumns = (() => {
    if (feedDensity === 'large') return 1;
    if (feedDensity === 'medium') return densityViewport === 'mobile' ? 1 : 2;
    if (densityViewport === 'desktop') return 3;
    if (densityViewport === 'tablet') return 2;
    return 1;
  })();
  const mediaAspect = feedDensity === 'small' ? 1 : (feedDensity === 'medium' ? 1.05 : 1.28);
  const pseudoViewCount = (index: number): string => `${(1.8 + (index % 8) * 0.19).toFixed(1)}k`;
  const hasPremiumSegments = gallery ? (gallery.visibility !== 'free' || teaserItems.length > 0 || premiumItems.length > 0) : false;
  const showPreviewSection = true;
  const showPremiumSection = galleryScope === 'all' && hasPremiumSegments;
  const galleryScopeLabel = galleryScope === 'public' ? 'Free and previews' : 'All media';

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const evaluate = () => {
      if (window.innerWidth < 700) {
        setShowCompactDiscoveryDock(window.scrollY > 260);
        return;
      }
      const panel = discoveryFilterPanelRef.current;
      if (!panel) {
        setShowCompactDiscoveryDock(false);
        return;
      }
      const topbarHeight = Number.parseInt(
        window.getComputedStyle(document.documentElement).getPropertyValue('--topbar-height') || '72',
        10
      ) || 72;
      const rect = panel.getBoundingClientRect();
      setShowCompactDiscoveryDock(rect.bottom <= topbarHeight + 14);
    };
    evaluate();
    const onScrollOrResize = () => {
      window.requestAnimationFrame(evaluate);
    };
    window.addEventListener('scroll', onScrollOrResize, { passive: true });
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => window.dispatchEvent(new Event('scroll')));
  }, [galleryScope, heavyTopicsExpanded, densityViewport, feedDensity, discoverySearch, showImageMedia, showVideoMedia, showPostMedia]);

  useEffect(() => {
    if (densityViewport !== 'mobile' && !showCompactDiscoveryDock) {
      setCompactFiltersOpen(false);
    }
  }, [showCompactDiscoveryDock, densityViewport]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleCompactFilterIntent = (rawEvent: Event) => {
      const detail = (rawEvent as CustomEvent<{ section?: DiscoveryFilterSection }>).detail || {};
      const requestedSection = detail.section || 'period';
      if (densityViewport === 'mobile') {
        setCompactFilterSection(requestedSection);
        if (requestedSection === 'heavy') {
          setCompactHeavyTopicsExpanded(true);
        }
        setCompactFiltersOpen(true);
        return;
      }
      if (!showCompactDiscoveryDock) {
        discoveryFilterPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (requestedSection === 'search') {
          window.setTimeout(() => discoverySearchInputRef.current?.focus(), 280);
        }
        if (requestedSection === 'heavy') {
          setHeavyTopicsExpanded(true);
        }
        return;
      }
      setCompactFilterSection(requestedSection);
      if (requestedSection === 'heavy') {
        setCompactHeavyTopicsExpanded(true);
      }
      setCompactFiltersOpen(true);
    };
    window.addEventListener(DISCOVERY_FILTER_EVENT_NAME, handleCompactFilterIntent as EventListener);
    return () => window.removeEventListener(DISCOVERY_FILTER_EVENT_NAME, handleCompactFilterIntent as EventListener);
  }, [showCompactDiscoveryDock, densityViewport]);

  useEffect(() => {
    if (!compactFiltersOpen || typeof window === 'undefined') return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCompactFiltersOpen(false);
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [compactFiltersOpen]);

  useEffect(() => {
    if (!compactFiltersOpen || compactFilterSection !== 'search' || typeof window === 'undefined') return;
    const timerId = window.setTimeout(() => {
      compactSearchInputRef.current?.focus();
    }, densityViewport === 'mobile' ? 240 : 120);
    return () => window.clearTimeout(timerId);
  }, [compactFiltersOpen, compactFilterSection, densityViewport]);

  useEffect(() => {
    onDiscoveryDockChange?.({
      active: showCompactDiscoveryDock,
      viewport: densityViewport,
      period: 'daily',
      periodLabel: galleryScopeLabel,
      density: feedDensity,
      mediaLabel: mediaSummaryLabel,
      showImages: showImageMedia,
      showVideos: showVideoMedia,
      showPosts: showPostMedia,
      heavyLabel: heavySummaryLabel,
      searchActive: discoverySearch.trim().length > 0
    });
  }, [
    onDiscoveryDockChange,
    showCompactDiscoveryDock,
    densityViewport,
    galleryScopeLabel,
    feedDensity,
    mediaSummaryLabel,
    heavySummaryLabel,
    discoverySearch
  ]);

  useEffect(() => () => {
    onDiscoveryDockChange?.(null);
  }, [onDiscoveryDockChange]);

  useEffect(() => {
    if (typeof window === 'undefined' || !gallery) return;
    const imageId = new URLSearchParams(location.search).get('image')?.trim();
    if (!imageId) {
      deepLinkHandledRef.current = '';
      return;
    }
    const deepLinkKey = `${slug}:${imageId}`;
    if (deepLinkHandledRef.current === deepLinkKey) return;
    const inPreview = previewItems.some((item) => item.imageId === imageId) || teaserItems.some((item) => item.imageId === imageId);
    const inPremium = premiumItems.some((item) => item.imageId === imageId);
    if (!inPreview && !inPremium) {
      deepLinkHandledRef.current = deepLinkKey;
      return;
    }
    if (inPremium && galleryScope !== 'all') {
      setGalleryScope('all');
      return;
    }
    if (discoverySearch.trim()) {
      setDiscoverySearch('');
    }
    let cancelled = false;
    let attempt = 0;
    const maxAttempts = 14;
    const focusCard = () => {
      if (cancelled) return;
      const element = document.getElementById(`gallery-media-${imageId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.classList.add('is-focus-target');
        window.setTimeout(() => element.classList.remove('is-focus-target'), 1800);
        deepLinkHandledRef.current = deepLinkKey;
        return;
      }
      attempt += 1;
      if (attempt >= maxAttempts) return;
      window.setTimeout(() => window.requestAnimationFrame(focusCard), 90);
    };
    window.requestAnimationFrame(focusCard);
    return () => {
      cancelled = true;
    };
  }, [
    location.search,
    slug,
    gallery?.galleryId,
    galleryScope,
    discoverySearch,
    previewItems,
    teaserItems,
    premiumItems
  ]);

  const openFocusedViewer = (items: GalleryAsset[], imageId: string, sectionTitle: string) => {
    const available = items.filter((item) => Boolean(item.previewUrl));
    if (available.length === 0) return;
    setFocusedItems(available);
    setFocusedSectionTitle(sectionTitle);
    setFocusedIndex(Math.max(0, available.findIndex((item) => item.imageId === imageId)));
    setFocusedOpen(true);
  };

  const closeFocusedViewer = () => setFocusedOpen(false);
  const scrollToGalleryFilters = () => {
    document.getElementById('gallery-discovery-filters')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    closeFocusedViewer();
  };
  const focusedItem = focusedItems[focusedIndex] || null;
  const focusedHasPrevious = focusedIndex > 0;
  const focusedHasNext = focusedIndex >= 0 && focusedIndex < focusedItems.length - 1;

  useEffect(() => {
    const video = focusedVideoRef.current;
    if (!video || focusedItem?.assetType !== 'video') return;
    const clamped = Math.max(0, Math.min(1, focusedVideoVolume));
    if (Math.abs(video.volume - clamped) > 0.001) video.volume = clamped;
    if (video.muted !== focusedVideoMuted) video.muted = focusedVideoMuted;
  }, [focusedItem?.assetType, focusedItem?.imageId, focusedVideoMuted, focusedVideoVolume]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const video = focusedVideoRef.current;
    if (!focusedOpen || !video || focusedItem?.assetType !== 'video') return undefined;
    let disposed = false;
    const safePlay = () => {
      if (disposed) return;
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => undefined);
    };
    const observer = new window.IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
        safePlay();
      } else if (!video.paused) {
        video.pause();
      }
    }, { threshold: [0.2, 0.6, 0.9] });
    observer.observe(video);
    safePlay();
    return () => {
      disposed = true;
      observer.disconnect();
      if (!video.paused) video.pause();
    };
  }, [focusedOpen, focusedItem?.assetType, focusedItem?.imageId]);

  useEffect(() => {
    if (!focusedOpen || typeof window === 'undefined') return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeFocusedViewer();
        return;
      }
      if (event.key === 'ArrowLeft' && focusedHasPrevious) {
        setFocusedIndex((index) => Math.max(0, index - 1));
      }
      if (event.key === 'ArrowRight' && focusedHasNext) {
        setFocusedIndex((index) => Math.min(focusedItems.length - 1, index + 1));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [focusedOpen, focusedHasPrevious, focusedHasNext, focusedItems.length]);

  if (!gallery) return <div className="layout">Loading...</div>;
  const galleryArtistName = (gallery.artistName || '').trim() || guessArtistNameFromSlug(gallery.artistSlug) || 'Unknown Creator';
  const discoverGalleryHeadingText = `Discover ${gallery.title} from ${galleryArtistName}`;
  const discoverGalleryHeading = (
    <>
      Discover {gallery.title} from {gallery.artistSlug
        ? <Link to={`/creators/${gallery.artistSlug}`} className="no-underline">{galleryArtistName}</Link>
        : galleryArtistName}
    </>
  );

  const renderGalleryCard = (
    item: GalleryAsset,
    cardIndex: number,
    sourceItems: GalleryAsset[],
    sectionTitle: string,
    sectionVisibility: 'free' | 'preview' | 'premium'
  ) => {
    const fallbackPosterUrl = item.previewPosterUrl || (item.assetType === 'video' && isLikelyImageUrl(item.previewUrl) ? item.previewUrl : undefined);
    const disclosureLine = formatDisclosureLine(item);
    const visibilityPill = sectionVisibility === 'preview'
      ? 'Preview'
      : sectionVisibility === 'premium'
        ? 'Premium'
        : null;
    return (
      <article
        id={`gallery-media-${item.imageId}`}
        key={`${sectionTitle}-${item.imageId}`}
        className="discovery-feature-card gallery-discovery-card"
        style={{ '--media-aspect': mediaAspect.toFixed(3) } as any}
      >
        <button
          type="button"
          className="discovery-feature-link discovery-feature-link-btn no-underline"
          onClick={() => openFocusedViewer(sourceItems, item.imageId, sectionTitle)}
        >
          <div className="discovery-feature-media no-crop" style={{ aspectRatio: `${mediaAspect} / 1` }}>
            {(item.assetType === 'video' && !fallbackPosterUrl)
              ? (
                <video
                  src={item.previewUrl}
                  muted
                  playsInline
                  preload="metadata"
                  style={{
                    objectPosition: 'center center',
                    filter: item.blurred ? 'blur(28px)' : undefined
                  }}
                />
              )
              : (
                <img
                  src={item.assetType === 'video' ? (fallbackPosterUrl || '') : item.previewUrl}
                  alt={item.title || item.imageId}
                  loading={cardIndex < 2 ? 'eager' : 'lazy'}
                  decoding="async"
                  style={{
                    objectPosition: 'center center',
                    filter: item.blurred ? 'blur(28px)' : undefined
                  }}
                />
              )}
            {visibilityPill && <span className="discovery-chip">{visibilityPill}</span>}
            {item.assetType === 'video' && <span className="discovery-chip" style={{ left: 'unset', right: visibilityPill ? '8.2rem' : '1rem' }}>Video</span>}
            {item.blurred && <span className="discovery-chip" style={{ left: 'unset', right: '1rem' }}>Mature Content</span>}
          </div>
        </button>
        <div className="discovery-feature-footer">
          <div className="discovery-feature-text">
            <h3 className="discovery-feature-title">{item.title || item.imageId}</h3>
            <p className="discovery-feature-subtitle">{item.displayedContentRating || 'General'}</p>
            {disclosureLine && <p className="discovery-feature-subtitle">{disclosureLine}</p>}
          </div>
          <div className="discovery-feature-stats">
            <span>❤ {item.favoriteCount || 0}</span>
            <span>👁 {pseudoViewCount(cardIndex)}</span>
            <span>{visibilityPill || 'Public'}</span>
          </div>
          {(currentUser || selectedCollectionId) && (
            <div className="discovery-feature-actions">
              {currentUser && (
                <button
                  className="auth-secondary-btn discovery-inline-btn"
                  onClick={() => void toggleImageFavorite(item.imageId)}
                >
                  {favoriteImageIds.has(item.imageId) ? 'Unfavorite' : 'Favorite'}
                </button>
              )}
              {selectedCollectionId && (
                <button className="auth-secondary-btn discovery-inline-btn" onClick={() => void addImageToCollection(item.imageId)}>
                  Add to collection
                </button>
              )}
            </div>
          )}
        </div>
      </article>
    );
  };

  const setCompactSection = (section: DiscoveryFilterSection) => {
    setCompactFilterSection(section);
    if (section === 'heavy') {
      setCompactHeavyTopicsExpanded(true);
    }
  };

  const closeCompactFilters = () => setCompactFiltersOpen(false);

  const compactTabs: Array<{ section: DiscoveryFilterSection; label: string }> = [
    { section: 'period', label: galleryScopeLabel },
    { section: 'media', label: mediaSummaryLabel },
    { section: 'density', label: `Density: ${densityLabel[feedDensity]}` },
    { section: 'heavy', label: heavySummaryLabel },
    { section: 'search', label: discoverySearch.trim().length > 0 ? 'Search active' : 'Search' }
  ];

  const renderCompactFilterBody = () => {
    if (compactFilterSection === 'period') {
      return (
        <div className="discovery-compact-section discovery-compact-period-section">
          <div className="discovery-filter-label">Gallery media</div>
          <div className="discovery-trending-filter">
            <button className={`discovery-pill-btn${galleryScope === 'all' ? ' is-active' : ''}`} onClick={() => setGalleryScope('all')}>All</button>
            <button className={`discovery-pill-btn${galleryScope === 'public' ? ' is-active' : ''}`} onClick={() => setGalleryScope('public')}>Free and previews only</button>
          </div>
        </div>
      );
    }

    if (compactFilterSection === 'media') {
      return (
        <div className="discovery-compact-section discovery-compact-period-section">
          <div className="discovery-filter-label">Media types</div>
          <div className="discovery-trending-filter">
            <button className={`discovery-pill-btn discovery-media-toggle-btn${showImageMedia ? ' is-active' : ''}`} onClick={() => setShowImageMedia((prev) => !prev)}>
              <span className={`discovery-media-toggle-check${showImageMedia ? ' is-checked' : ''}`} aria-hidden="true" />
              <DiscoveryMediaIcon kind="image" className="discovery-media-icon" />
              <span>Images</span>
            </button>
            <button className={`discovery-pill-btn discovery-media-toggle-btn${showVideoMedia ? ' is-active' : ''}`} onClick={() => setShowVideoMedia((prev) => !prev)}>
              <span className={`discovery-media-toggle-check${showVideoMedia ? ' is-checked' : ''}`} aria-hidden="true" />
              <DiscoveryMediaIcon kind="video" className="discovery-media-icon" />
              <span>Videos</span>
            </button>
            <button className={`discovery-pill-btn discovery-media-toggle-btn${showPostMedia ? ' is-active' : ''}`} onClick={() => setShowPostMedia((prev) => !prev)}>
              <span className={`discovery-media-toggle-check${showPostMedia ? ' is-checked' : ''}`} aria-hidden="true" />
              <DiscoveryMediaIcon kind="post" className="discovery-media-icon" />
              <span>Posts</span>
            </button>
          </div>
        </div>
      );
    }

    if (compactFilterSection === 'heavy') {
      return (
        <div className="discovery-heavy-card">
          <div className="discovery-heavy-head">
            <label className="discovery-heavy-row is-primary">
              <input
                type="checkbox"
                checked={hideHeavyTopics || (hidePoliticsPublicAffairs && hideCrimeDisastersTragedy)}
                onChange={(e) => applyHideAllHeavyTopics(e.target.checked)}
              />
              <span>Hide all heavy topics</span>
            </label>
            <button
              type="button"
              className={`discovery-heavy-toggle${compactHeavyTopicsExpanded ? ' is-expanded' : ''}`}
              onClick={() => setCompactHeavyTopicsExpanded((prev) => !prev)}
              aria-label={compactHeavyTopicsExpanded ? 'Collapse heavy topics options' : 'Expand heavy topics options'}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M6 12L10 8L14 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          {compactHeavyTopicsExpanded && (
            <div className="discovery-heavy-body">
              <label className="discovery-heavy-row">
                <input
                  type="checkbox"
                  checked={hidePoliticsPublicAffairs}
                  onChange={(e) => applyHidePoliticsPublicAffairs(e.target.checked)}
                />
                <span>{heavyTopicLabels['politics-public-affairs']}</span>
              </label>
              <label className="discovery-heavy-row">
                <input
                  type="checkbox"
                  checked={hideCrimeDisastersTragedy}
                  onChange={(e) => applyHideCrimeDisastersTragedy(e.target.checked)}
                />
                <span>{heavyTopicLabels['crime-disasters-tragedy']}</span>
              </label>
            </div>
          )}
        </div>
      );
    }

    if (compactFilterSection === 'density') {
      return (
        <div className="discovery-density-card">
          <div className="discovery-density-head">
            <span>Feed density</span>
            <strong>{densityLabel[feedDensity]}</strong>
          </div>
          {densityViewport === 'desktop' && (
            <input
              className="discovery-density-range"
              type="range"
              min={0}
              max={2}
              step={1}
              value={densitySliderValue}
              style={densityRangeStyle}
              onChange={(e) => {
                const next = Number(e.target.value);
                setFeedDensity(next <= 0 ? 'small' : next === 1 ? 'medium' : 'large');
              }}
            />
          )}
          <div className={`discovery-density-options${densityOptions.length === 2 ? ' is-two' : ''}`}>
            {densityOptions.map((option) => (
              <button
                key={`gallery-compact-density-option-${option}`}
                type="button"
                className={feedDensity === option ? 'is-active' : ''}
                onClick={() => setFeedDensity(option)}
              >
                {densityLabel[option]}
              </button>
            ))}
          </div>
          <p className="small m-0">
            Gallery and artist pages use fixed discovery frames, not dynamic aspect-ratio pair rows.
          </p>
        </div>
      );
    }

    return (
      <div className="discovery-search-card is-compact">
        <div className="discovery-filter-label">Search</div>
        <div className="discovery-search-input-wrap">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M9 4.25a4.75 4.75 0 103.78 7.64l2.16 2.16a.75.75 0 101.06-1.06l-2.16-2.16A4.75 4.75 0 009 4.25z" fill="currentColor" />
          </svg>
          <input
            ref={compactSearchInputRef}
            type="text"
            value={discoverySearch}
            onChange={(e) => setDiscoverySearch(e.target.value)}
            placeholder="Search media IDs and disclosures..."
          />
        </div>
      </div>
    );
  };

  return (
    <div className="layout discovery-layout">
      <section className="panel discovery-hero">
        <div>
          <h1>{gallery.title}</h1>
          <p>
            Discovery-style gallery browsing with focused view modal, filtering, and separate preview/premium media sections.
          </p>
        </div>
        <div className="discovery-hero-actions">
          <Link to="/" className="auth-secondary-btn no-underline">Back to discovery</Link>
          <button className="auth-primary-btn" onClick={favoriteGallery}>
            {favoriteGallerySelected ? 'Unfavorite gallery' : 'Favorite gallery'} ({gallery.favoriteCount})
          </button>
        </div>
      </section>

      {showCompactDiscoveryDock && densityViewport !== 'mobile' && compactFiltersOpen && (
        <div className="discovery-compact-popover-layer" onClick={closeCompactFilters}>
          <div className="discovery-compact-popover" role="dialog" aria-label="Gallery filters" onClick={(e) => e.stopPropagation()}>
            <div className="discovery-compact-popover-toolbar">
              <button type="button" className="discovery-compact-close-btn" onClick={closeCompactFilters} aria-label="Close gallery filters">
                ✕
              </button>
            </div>
            <div className="discovery-compact-tabs discovery-compact-tabs-tablet">
              {compactTabs.map((tab) => (
                <button
                  key={`gallery-compact-tab-desktop-${tab.section}`}
                  type="button"
                  className={`topbar-discovery-chip topbar-discovery-chip-interactive${compactFilterSection === tab.section ? ' is-active' : ''}`}
                  onClick={() => setCompactSection(tab.section)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="discovery-compact-body">
              {renderCompactFilterBody()}
            </div>
          </div>
        </div>
      )}

      {showCompactDiscoveryDock && densityViewport === 'mobile' && compactFiltersOpen && (
        <div className="discovery-compact-sheet-layer" onClick={closeCompactFilters}>
          <div className="discovery-compact-sheet" role="dialog" aria-label="Gallery filters" onClick={(e) => e.stopPropagation()}>
            <div className="discovery-compact-sheet-handle" />
            <div className="discovery-compact-header">
              <div className="discovery-filter-label">Gallery controls</div>
              <button type="button" className="discovery-compact-close-btn" onClick={closeCompactFilters} aria-label="Close gallery filters">
                ✕
              </button>
            </div>
            <div className="discovery-compact-tabs">
              {compactTabs.map((tab) => (
                <button
                  key={`gallery-compact-tab-mobile-${tab.section}`}
                  type="button"
                  className={`topbar-discovery-chip topbar-discovery-chip-interactive${compactFilterSection === tab.section ? ' is-active' : ''}`}
                  onClick={() => setCompactSection(tab.section)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="discovery-compact-body">
              {renderCompactFilterBody()}
            </div>
          </div>
        </div>
      )}

      <section className="discovery-editorial-section">
        <div className="discovery-section-header">
          <h2>{discoverGalleryHeading}</h2>
        </div>
        <div id="gallery-discovery-filters" ref={discoveryFilterPanelRef} className="discovery-filter-shell">
          <div className="discovery-filter-grid">
            <div className="discovery-filter-left">
              <div>
                <div className="discovery-filter-label">Gallery media</div>
                <div className="discovery-trending-filter">
                  <button className={`discovery-pill-btn${galleryScope === 'all' ? ' is-active' : ''}`} onClick={() => setGalleryScope('all')}>All</button>
                  <button className={`discovery-pill-btn${galleryScope === 'public' ? ' is-active' : ''}`} onClick={() => setGalleryScope('public')}>Free and previews only</button>
                </div>
              </div>
              <div>
                <div className="discovery-filter-label">Media types</div>
                <div className="discovery-trending-filter">
                  <button className={`discovery-pill-btn discovery-media-toggle-btn${showImageMedia ? ' is-active' : ''}`} onClick={() => setShowImageMedia((prev) => !prev)}>
                    <span className={`discovery-media-toggle-check${showImageMedia ? ' is-checked' : ''}`} aria-hidden="true" />
                    <DiscoveryMediaIcon kind="image" className="discovery-media-icon" />
                    <span>Images</span>
                  </button>
                  <button className={`discovery-pill-btn discovery-media-toggle-btn${showVideoMedia ? ' is-active' : ''}`} onClick={() => setShowVideoMedia((prev) => !prev)}>
                    <span className={`discovery-media-toggle-check${showVideoMedia ? ' is-checked' : ''}`} aria-hidden="true" />
                    <DiscoveryMediaIcon kind="video" className="discovery-media-icon" />
                    <span>Videos</span>
                  </button>
                  <button className={`discovery-pill-btn discovery-media-toggle-btn${showPostMedia ? ' is-active' : ''}`} onClick={() => setShowPostMedia((prev) => !prev)}>
                    <span className={`discovery-media-toggle-check${showPostMedia ? ' is-checked' : ''}`} aria-hidden="true" />
                    <DiscoveryMediaIcon kind="post" className="discovery-media-icon" />
                    <span>Posts</span>
                  </button>
                </div>
              </div>
              <div className="discovery-heavy-card">
                <div className="discovery-heavy-head">
                  <label className="discovery-heavy-row is-primary">
                    <input
                      type="checkbox"
                      checked={hideHeavyTopics || (hidePoliticsPublicAffairs && hideCrimeDisastersTragedy)}
                      onChange={(e) => applyHideAllHeavyTopics(e.target.checked)}
                    />
                    <span>Hide all heavy topics</span>
                  </label>
                  <button
                    type="button"
                    className={`discovery-heavy-toggle${heavyTopicsExpanded ? ' is-expanded' : ''}`}
                    onClick={() => setHeavyTopicsExpanded((prev) => !prev)}
                    aria-label={heavyTopicsExpanded ? 'Collapse heavy topics options' : 'Expand heavy topics options'}
                  >
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path d="M6 12L10 8L14 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
                {heavyTopicsExpanded && (
                  <div className="discovery-heavy-body">
                    <label className="discovery-heavy-row">
                      <input
                        type="checkbox"
                        checked={hidePoliticsPublicAffairs}
                        onChange={(e) => applyHidePoliticsPublicAffairs(e.target.checked)}
                      />
                      <span>{heavyTopicLabels['politics-public-affairs']}</span>
                    </label>
                    <label className="discovery-heavy-row">
                      <input
                        type="checkbox"
                        checked={hideCrimeDisastersTragedy}
                        onChange={(e) => applyHideCrimeDisastersTragedy(e.target.checked)}
                      />
                      <span>{heavyTopicLabels['crime-disasters-tragedy']}</span>
                    </label>
                  </div>
                )}
              </div>
            </div>

            <div className="discovery-filter-right">
              <div className="discovery-density-card">
                <div className="discovery-density-head">
                  <span>Feed density</span>
                  <strong>{densityLabel[feedDensity]}</strong>
                </div>
                {densityViewport === 'desktop' && (
                  <input
                    className="discovery-density-range"
                    type="range"
                    min={0}
                    max={2}
                    step={1}
                    value={densitySliderValue}
                    style={densityRangeStyle}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setFeedDensity(next <= 0 ? 'small' : next === 1 ? 'medium' : 'large');
                    }}
                  />
                )}
                <div className={`discovery-density-options${densityOptions.length === 2 ? ' is-two' : ''}`}>
                  {densityOptions.map((option) => (
                    <button
                      key={`gallery-density-${option}`}
                      type="button"
                      className={feedDensity === option ? 'is-active' : ''}
                      onClick={() => setFeedDensity(option)}
                    >
                      {densityLabel[option]}
                    </button>
                  ))}
                </div>
                <p className="small m-0">
                  Gallery and artist pages use fixed discovery frames, not dynamic aspect-ratio pair rows.
                </p>
              </div>

              <div className="discovery-search-card">
                <div className="discovery-filter-label">Search</div>
                <div className="discovery-search-input-wrap">
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M9 4.25a4.75 4.75 0 103.78 7.64l2.16 2.16a.75.75 0 101.06-1.06l-2.16-2.16A4.75 4.75 0 009 4.25z" fill="currentColor" />
                  </svg>
                  <input
                    ref={discoverySearchInputRef}
                    type="text"
                    value={discoverySearch}
                    onChange={(e) => setDiscoverySearch(e.target.value)}
                    placeholder="Search media IDs and disclosures..."
                  />
                </div>
                {currentUser && (
                  <div className="discovery-favorite-context">
                    <label className="small">Favorite as</label>
                    <select
                      className="settings-select"
                      value={favoriteIdentity}
                      onChange={(e) => setFavoriteIdentity(e.target.value)}
                    >
                      <option value="user">User Profile</option>
                      {managedArtists.map((artist) => (
                        <option key={`favorite-${artist.artistId}`} value={`artist:${artist.artistId}`}>
                          Creator: {artist.name}
                        </option>
                      ))}
                    </select>
                    <label className="small">Add to collection</label>
                    <select
                      className="settings-select"
                      value={selectedCollectionId}
                      onChange={(e) => setSelectedCollectionId(e.target.value)}
                    >
                      <option value="">Select collection</option>
                      {profileCollections.map((item) => (
                        <option key={`gallery-collection-${item.collectionId}`} value={item.collectionId}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {showPreviewSection && (
        <section className="discovery-editorial-section">
          <div className="discovery-section-header">
            <h2>{discoverGalleryHeading}</h2>
          </div>
          <div className="gallery-discovery-grid" style={{ '--gallery-grid-columns': mediaColumns } as any}>
            {filteredPreviewItems.map((item, index) => renderGalleryCard(
              item,
              index,
              filteredPreviewItems,
              discoverGalleryHeadingText,
              gallery.visibility === 'preview' ? 'preview' : 'free'
            ))}
          </div>
          {filteredPreviewItems.length === 0 && <p className="small">No preview media matches your filters.</p>}
        </section>
      )}

      {showPremiumSection && gallery.visibility === 'preview' && !gallery.hasAccess && (
        <section className="discovery-editorial-section">
          <div className="discovery-section-header">
            <h2>Premium Preview</h2>
          </div>
          <div className="premium-preview-cta">
            <a href={gallery.purchaseUrl || '#'} target="_blank" rel="noreferrer" className="inline-block rounded-xl bg-black/80 px-8 py-4 text-white no-underline">
              Purchase Premium Access
            </a>
          </div>
          <div className="gallery-discovery-grid" style={{ '--gallery-grid-columns': mediaColumns } as any}>
            {filteredTeaserItems.map((item, index) => renderGalleryCard(item, index, filteredTeaserItems, 'Premium Preview', 'preview'))}
          </div>
          {filteredTeaserItems.length === 0 && <p className="small">No premium preview media matches your filters.</p>}
        </section>
      )}

      {showPremiumSection && gallery.visibility === 'premium' && (
        <section className="discovery-editorial-section">
          <div className="discovery-section-header">
            <h2>Premium Content</h2>
          </div>
          {!hasPremiumAccess && (
            <div className="inline-form">
              <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter gallery password" />
              <button onClick={unlock}>Unlock</button>
            </div>
          )}
          {hasPremiumAccess && (
            <>
              <div className="gallery-discovery-grid" style={{ '--gallery-grid-columns': mediaColumns } as any}>
                {filteredPremiumItems.map((item, index) => renderGalleryCard(item, index, filteredPremiumItems, 'Premium Content', 'premium'))}
              </div>
              {filteredPremiumItems.length === 0 && <p className="small">No premium media matches your filters.</p>}
            </>
          )}
          {premiumItems.some((item) => item.blurred) && <p className="small">Some items are blurred due to content rating settings.</p>}
        </section>
      )}

      <section className="panel">
        <h2>Comments</h2>
        <div className="inline-form">
          {currentUser && (
            <select
              className="settings-select"
              value={commentIdentity}
              onChange={(e) => setCommentIdentity(e.target.value)}
            >
              <option value="user">Comment as User</option>
              {managedArtists.map((artist) => (
                <option key={artist.artistId} value={`artist:${artist.artistId}`}>
                  Comment as {artist.name}
                </option>
              ))}
            </select>
          )}
          <input value={commentBody} onChange={(e) => setCommentBody(e.target.value)} placeholder="Add a comment" />
          <button onClick={submitComment}>Post</button>
        </div>
        {comments.map((comment) => (
          <article key={comment.commentId} className="comment">
            <strong>{comment.displayName}</strong>
            <p>{comment.body}</p>
            <small>{new Date(comment.createdAt).toLocaleString()}</small>
          </article>
        ))}
      </section>

      {focusedOpen && (
        <div className="discovery-focus-modal-layer" onClick={closeFocusedViewer}>
          <div className="discovery-focus-modal" role="dialog" aria-modal="true" aria-label="Focused media viewer" onClick={(e) => e.stopPropagation()}>
            <div className="discovery-focus-modal-header">
              <div className="discovery-focus-modal-title-wrap">
                <span className="discovery-focus-modal-title-id">{focusedItem?.title || focusedItem?.imageId || gallery.title}</span>
                <span className="discovery-focus-modal-title-gallery">{focusedSectionTitle}</span>
              </div>
              <div className="discovery-focus-modal-meta">
                <span>{focusedItem?.displayedContentRating || 'General'}</span>
                {focusedItem && formatDisclosureLine(focusedItem) && <span>{formatDisclosureLine(focusedItem)}</span>}
                <span>{Math.max(1, focusedIndex + 1)} / {Math.max(1, focusedItems.length)}</span>
              </div>
              <div className="discovery-focus-modal-actions">
                <button
                  type="button"
                  className="auth-secondary-btn"
                  disabled={!focusedHasPrevious}
                  onClick={() => setFocusedIndex((index) => Math.max(0, index - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="auth-secondary-btn"
                  disabled={!focusedHasNext}
                  onClick={() => setFocusedIndex((index) => Math.min(focusedItems.length - 1, index + 1))}
                >
                  Next
                </button>
                <button type="button" className="auth-secondary-btn" onClick={scrollToGalleryFilters}>
                  Back to top
                </button>
              </div>
              <button type="button" className="discovery-focus-modal-close" onClick={closeFocusedViewer} aria-label="Close focused viewer">
                ✕
              </button>
            </div>
            <div className="discovery-focus-modal-media">
              {focusedItem && (
                focusedItem.assetType === 'video'
                  ? (
                    <video
                      key={focusedItem.imageId}
                      ref={focusedVideoRef}
                      autoPlay
                      controls
                      playsInline
                      muted={focusedVideoMuted}
                      poster={focusedItem.previewPosterUrl}
                      style={{ filter: focusedItem.blurred ? 'blur(28px)' : undefined }}
                      onVolumeChange={(event) => {
                        const target = event.currentTarget;
                        setFocusedVideoMuted(target.muted);
                        setFocusedVideoVolume(Math.max(0, Math.min(1, target.volume)));
                      }}
                    >
                      <source src={focusedItem.previewUrl} />
                    </video>
                  )
                  : (
                    <img
                      src={focusedItem.thumbnailUrls?.w1280 || focusedItem.thumbnailUrls?.w640 || focusedItem.previewUrl}
                      alt={focusedItem.title || focusedItem.imageId || 'Focused media'}
                      style={{ filter: focusedItem.blurred ? 'blur(28px)' : undefined }}
                    />
                  )
              )}
              {!focusedItem && <div className="small">No media selected.</div>}
            </div>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {heavyHidden && <p className="small">Heavy topics are hidden by your filter settings.</p>}
    </div>
  );
}

function CollectionsPage() {
  const [items, setItems] = useState<CollectionSummary[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [order, setOrder] = useState<'random' | 'latest' | 'popular'>('random');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dailySeed = new Date().toISOString().slice(0, 10);

  const loadMore = async (reset = false) => {
    try {
      setLoading(true);
      setError('');
      const response = await api.getCollections(reset ? undefined : cursor, 24, { order, seed: dailySeed }) as { items: CollectionSummary[]; nextCursor?: string };
      setItems((prev) => reset ? (response.items || []) : [...prev, ...(response.items || [])]);
      setCursor(response.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMore(true);
  }, [order, dailySeed]);

  return (
    <div className="layout">
      <div className="discovery-section-header">
        <h1>All Collections</h1>
        <div className="discovery-trending-filter">
          <button className={order === 'random' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setOrder('random')}>Random</button>
          <button className={order === 'popular' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setOrder('popular')}>Popular</button>
          <button className={order === 'latest' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setOrder('latest')}>Latest</button>
        </div>
      </div>
      <div className="discovery-latest-grid">
        {items.map((item) => (
          <Link key={item.collectionId} to={`/collections/${item.collectionId}`} className="discovery-latest-item no-underline">
            <div className="discovery-stack">
              <div className="discovery-stack-layer discovery-stack-layer-back"><div className="discovery-swatch" /></div>
              <div className="discovery-stack-layer discovery-stack-layer-mid"><div className="discovery-swatch" /></div>
              <div className="discovery-stack-layer discovery-stack-layer-front"><div className="discovery-swatch" /></div>
            </div>
            <div className="discovery-latest-meta">
              <div className="discovery-card-title">{item.title}</div>
              <div className="discovery-card-subtitle">{item.imageCount} images • {item.favoriteCount} favorites</div>
            </div>
          </Link>
        ))}
      </div>
      <AutoLoadSentinel enabled={Boolean(cursor)} loading={loading} onLoadMore={() => loadMore(false)} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function CollectionDetailPage() {
  const { collectionId = '' } = useParams();
  const currentUser = getCurrentUser();
  const [managedArtists, setManagedArtists] = useState<ManagedArtist[]>([]);
  const [favoriteIdentity, setFavoriteIdentity] = useState<string>('user');
  const [isFavorited, setIsFavorited] = useState(false);
  const [collection, setCollection] = useState<(CollectionSummary & { imageIds?: string[] }) | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        setError('');
        const result = await api.getCollection(collectionId) as CollectionSummary & { imageIds?: string[] };
        setCollection(result);
      } catch (e) {
        setError((e as Error).message);
      }
    };
    void load();
  }, [collectionId]);

  useEffect(() => {
    if (!currentUser) {
      setManagedArtists([]);
      setFavoriteIdentity('user');
      return;
    }
    const loadArtists = async () => {
      try {
        const artists = await api.getMyArtists() as ManagedArtist[];
        setManagedArtists(artists);
      } catch {
        setManagedArtists([]);
      }
    };
    void loadArtists();
  }, [currentUser?.username]);

  const favoriteAsProfile = favoriteIdentity.startsWith('artist:')
    ? { ownerProfileType: 'artist' as const, ownerProfileId: favoriteIdentity.slice('artist:'.length) }
    : { ownerProfileType: 'user' as const };

  useEffect(() => {
    const loadFavoriteState = async () => {
      if (!currentUser || !collection) {
        setIsFavorited(false);
        return;
      }
      try {
        const favorites = await api.myFavorites(favoriteAsProfile) as ManagedFavorite[];
        setIsFavorited((favorites || []).some((item) => item.targetType === 'collection' && item.targetId === collection.collectionId));
      } catch {
        setIsFavorited(false);
      }
    };
    void loadFavoriteState();
  }, [currentUser?.username, favoriteIdentity, collection?.collectionId]);

  const toggleCollectionFavorite = async () => {
    if (!collection) return;
    const wasFavorited = isFavorited;
    setIsFavorited(!wasFavorited);
    setCollection((prev) => prev ? { ...prev, favoriteCount: Math.max(0, prev.favoriteCount + (wasFavorited ? -1 : 1)) } : prev);
    try {
      if (wasFavorited) await api.unfavorite('collection', collection.collectionId, favoriteAsProfile);
      else await api.favorite('collection', collection.collectionId, 'public', favoriteAsProfile);
    } catch (e) {
      setIsFavorited(wasFavorited);
      setCollection((prev) => prev ? { ...prev, favoriteCount: Math.max(0, prev.favoriteCount + (wasFavorited ? 1 : -1)) } : prev);
      setError((e as Error).message);
    }
  };

  if (!collection) return <div className="layout">Loading...</div>;

  return (
    <div className="layout">
      <Link to="/collections">Back to collections</Link>
      <h1>{collection.title}</h1>
      <p>{collection.description || 'No description yet.'}</p>
      <p className="small">{collection.imageCount} images • {collection.favoriteCount} favorites</p>
      {currentUser && (
        <div className="inline-form">
          <label className="small">Favorite as</label>
          <select
            className="settings-select"
            value={favoriteIdentity}
            onChange={(e) => setFavoriteIdentity(e.target.value)}
          >
            <option value="user">User Profile</option>
            {managedArtists.map((artist) => (
              <option key={`favorite-${artist.artistId}`} value={`artist:${artist.artistId}`}>
                Creator: {artist.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <button
        onClick={() => void toggleCollectionFavorite()}
      >
        {isFavorited ? 'Unfavorite Collection' : 'Favorite Collection'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function TrendingPage({ viewerProfile }: { viewerProfile?: UserProfile | null }) {
  const currentUser = getCurrentUser();
  const [managedArtists, setManagedArtists] = useState<ManagedArtist[]>([]);
  const [favoriteIdentity, setFavoriteIdentity] = useState<string>('user');
  const [favoriteImageIds, setFavoriteImageIds] = useState<Set<string>>(new Set());
  const [period, setPeriod] = useState<'hourly' | 'daily'>('daily');
  const [items, setItems] = useState<TrendingImage[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [aiFilter, setAiFilter] = useState<AiFilterPreference>(viewerProfile?.aiFilter || 'show-all');
  const [hideHeavyTopics, setHideHeavyTopics] = useState<boolean>(Boolean(viewerProfile?.hideHeavyTopics));
  const [hidePoliticsPublicAffairs, setHidePoliticsPublicAffairs] = useState<boolean>(Boolean(viewerProfile?.hidePoliticsPublicAffairs));
  const [hideCrimeDisastersTragedy, setHideCrimeDisastersTragedy] = useState<boolean>(Boolean(viewerProfile?.hideCrimeDisastersTragedy));
  const swatches = ['#fda4af', '#7dd3fc', '#6ee7b7', '#a5b4fc', '#fcd34d', '#e9a8f4', '#5eead4', '#fdba74'];
  const masonryHeights = [220, 260, 300, 340, 380];
  const disclosureFilters = {
    aiFilter,
    hideHeavyTopics,
    hidePoliticsPublicAffairs: hideHeavyTopics ? true : hidePoliticsPublicAffairs,
    hideCrimeDisastersTragedy: hideHeavyTopics ? true : hideCrimeDisastersTragedy
  };

  useEffect(() => {
    setAiFilter(viewerProfile?.aiFilter || 'show-all');
    setHideHeavyTopics(Boolean(viewerProfile?.hideHeavyTopics));
    setHidePoliticsPublicAffairs(Boolean(viewerProfile?.hidePoliticsPublicAffairs));
    setHideCrimeDisastersTragedy(Boolean(viewerProfile?.hideCrimeDisastersTragedy));
  }, [
    viewerProfile?.aiFilter,
    viewerProfile?.hideHeavyTopics,
    viewerProfile?.hidePoliticsPublicAffairs,
    viewerProfile?.hideCrimeDisastersTragedy
  ]);

  const loadTrending = async (append = false) => {
    try {
      setLoading(true);
      setError('');
      const response = await api.getTrendingImagesFiltered(
        period,
        append ? cursor : undefined,
        36,
        disclosureFilters
      ) as { items: TrendingImage[]; nextCursor?: string };
      setItems((prev) => append ? [...prev, ...(response.items || [])] : (response.items || []));
      setCursor(response.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTrending(false);
  }, [period, disclosureFilters.aiFilter, disclosureFilters.hideHeavyTopics, disclosureFilters.hidePoliticsPublicAffairs, disclosureFilters.hideCrimeDisastersTragedy]);

  useEffect(() => {
    const loadArtists = async () => {
      if (!currentUser) {
        setManagedArtists([]);
        return;
      }
      try {
        const myArtists = await api.getMyArtists() as ManagedArtist[];
        setManagedArtists(myArtists || []);
      } catch {
        setManagedArtists([]);
      }
    };
    void loadArtists();
  }, [currentUser?.username]);

  const favoriteAsProfile = favoriteIdentity.startsWith('artist:')
    ? { ownerProfileType: 'artist' as const, ownerProfileId: favoriteIdentity.slice('artist:'.length) }
    : { ownerProfileType: 'user' as const };

  useEffect(() => {
    const loadFavorites = async () => {
      if (!currentUser) {
        setFavoriteImageIds(new Set());
        return;
      }
      try {
        const favorites = await api.myFavorites(favoriteAsProfile) as ManagedFavorite[];
        setFavoriteImageIds(new Set(favorites.filter((item) => item.targetType === 'image').map((item) => item.targetId)));
      } catch {
        setFavoriteImageIds(new Set());
      }
    };
    void loadFavorites();
  }, [currentUser?.username, favoriteIdentity]);

  const toggleImageFavorite = async (imageId: string) => {
    const wasFavorited = favoriteImageIds.has(imageId);
    setFavoriteImageIds((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(imageId);
      else next.add(imageId);
      return next;
    });
    setItems((prev) => prev.map((item) => (
      item.imageId === imageId
        ? { ...item, favoriteCount: Math.max(0, (item.favoriteCount || 0) + (wasFavorited ? -1 : 1)) }
        : item
    )));
    try {
      if (wasFavorited) {
        await api.unfavorite('image', imageId, favoriteAsProfile);
      } else {
        await api.favorite('image', imageId, 'public', favoriteAsProfile);
      }
    } catch {
      setFavoriteImageIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(imageId);
        else next.delete(imageId);
        return next;
      });
      setItems((prev) => prev.map((item) => (
        item.imageId === imageId
          ? { ...item, favoriteCount: Math.max(0, (item.favoriteCount || 0) + (wasFavorited ? 1 : -1)) }
          : item
      )));
    }
  };

  return (
    <div className="layout discovery-layout">
      <section className="discovery-section-header">
        <h1>Trending Images</h1>
        <div className="discovery-trending-filter">
          <button className={period === 'hourly' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setPeriod('hourly')}>Hourly</button>
          <button className={period === 'daily' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setPeriod('daily')}>Daily</button>
        </div>
        {currentUser && (
          <div className="inline-form">
            <label className="small">Favorite as</label>
            <select
              className="settings-select"
              value={favoriteIdentity}
              onChange={(e) => setFavoriteIdentity(e.target.value)}
            >
              <option value="user">User Profile</option>
              {managedArtists.map((artist) => (
                <option key={`trending-favorite-${artist.artistId}`} value={`artist:${artist.artistId}`}>
                  Creator: {artist.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>
      <div className="discovery-masonry">
        {items.map((item, i) => (
          <article key={item.imageId} className="discovery-card">
            <Link to={item.gallerySlug ? `/gallery/${item.gallerySlug}?image=${encodeURIComponent(item.imageId)}` : '/'} className="no-underline">
              <div className="discovery-card-media" style={{ height: masonryHeights[i % masonryHeights.length] }}>
                {item.previewUrl ? (
                  (item.assetType === 'video' && !item.previewPosterUrl && !isLikelyImageUrl(item.previewUrl))
                    ? (
                      <video
                        src={item.previewUrl}
                        muted
                        playsInline
                        preload="metadata"
                        style={{ filter: item.blurred ? 'blur(24px)' : undefined }}
                      />
                    )
                    : (
                      <img
                        src={item.assetType === 'video' ? (item.previewPosterUrl || item.previewUrl) : item.previewUrl}
                        alt={item.title || 'Artwork preview'}
                        loading="lazy"
                        style={{ filter: item.blurred ? 'blur(24px)' : undefined }}
                      />
                    )
                ) : <div className="discovery-swatch" style={{ backgroundColor: swatches[i % swatches.length] }} />}
                {(item.galleryVisibility === 'preview' || item.galleryVisibility === 'premium') && (
                  <span className="discovery-chip">{item.galleryVisibility === 'premium' ? 'Premium' : 'Preview'}</span>
                )}
                {item.blurred && <span className="discovery-chip" style={{ left: 'unset', right: '0.75rem' }}>Mature Content</span>}
              </div>
              <div className="discovery-card-body">
                <div className="discovery-card-title">{item.title || 'Artwork title'}</div>
                <div className="discovery-card-subtitle">by {item.artistName}</div>
                {formatDisclosureLine(item) && <div className="discovery-card-subtitle">{formatDisclosureLine(item)}</div>}
                <div className="discovery-card-stats">
                  <span>❤ {item.favoriteCount || 0}</span>
                  <span>👁 {(2.1 + (i % 7) * 0.2).toFixed(1)}k</span>
                  <span>{item.displayedContentRating || 'General'}</span>
                </div>
              </div>
            </Link>
            {currentUser && (
              <div className="p-3 pt-0">
                <button
                  className="auth-secondary-btn"
                  onClick={() => void toggleImageFavorite(item.imageId)}
                >
                  {favoriteImageIds.has(item.imageId) ? 'Unfavorite image' : 'Favorite image'}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      <AutoLoadSentinel enabled={Boolean(cursor)} loading={loading} onLoadMore={() => loadTrending(true)} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function CreatorProfilePage({
  viewerProfile,
  onDiscoveryDockChange
}: {
  viewerProfile?: UserProfile | null;
  onDiscoveryDockChange?: (state: DiscoveryDockSummary | null) => void;
}) {
  const { slug = '' } = useParams();
  const [profile, setProfile] = useState<CreatorProfilePayload | null>(null);
  const [creatorPosts, setCreatorPosts] = useState<CreatorPostSummary[]>([]);
  const [artistTab, setArtistTab] = useState<'feed' | 'galleries'>('feed');
  const [feedItems, setFeedItems] = useState<TrendingImage[]>([]);
  const [feedCursor, setFeedCursor] = useState<string | undefined>(undefined);
  const [artistFeedSort, setArtistFeedSort] = useState<'latest' | 'trending'>('latest');
  const [feedLoading, setFeedLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [feedDensity, setFeedDensity] = useState<FeedDensity>('large');
  const [densityViewport, setDensityViewport] = useState<DensityViewport>(() => {
    if (typeof window === 'undefined') return 'desktop';
    if (window.innerWidth >= 1100) return 'desktop';
    if (window.innerWidth >= 700) return 'tablet';
    return 'mobile';
  });
  const [discoverySearch, setDiscoverySearch] = useState('');
  const [showImageMedia, setShowImageMedia] = useState(true);
  const [showVideoMedia, setShowVideoMedia] = useState(true);
  const [showPostMedia, setShowPostMedia] = useState(true);
  const [disclosureAiFilter, setDisclosureAiFilter] = useState<AiFilterPreference>(viewerProfile?.aiFilter || 'show-all');
  const [hideHeavyTopics, setHideHeavyTopics] = useState<boolean>(Boolean(viewerProfile?.hideHeavyTopics));
  const [hidePoliticsPublicAffairs, setHidePoliticsPublicAffairs] = useState<boolean>(Boolean(viewerProfile?.hidePoliticsPublicAffairs));
  const [hideCrimeDisastersTragedy, setHideCrimeDisastersTragedy] = useState<boolean>(Boolean(viewerProfile?.hideCrimeDisastersTragedy));
  const [heavyTopicsExpanded, setHeavyTopicsExpanded] = useState(true);
  const [showCompactDiscoveryDock, setShowCompactDiscoveryDock] = useState(false);
  const [compactFiltersOpen, setCompactFiltersOpen] = useState(false);
  const [compactFilterSection, setCompactFilterSection] = useState<DiscoveryFilterSection>('period');
  const [compactHeavyTopicsExpanded, setCompactHeavyTopicsExpanded] = useState(true);
  const [focusedOpen, setFocusedOpen] = useState(false);
  const [focusedItems, setFocusedItems] = useState<GalleryAsset[]>([]);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [focusedGallerySlug, setFocusedGallerySlug] = useState('');
  const [focusedGalleryTitle, setFocusedGalleryTitle] = useState('');
  const [focusedLoading, setFocusedLoading] = useState(false);
  const [focusedError, setFocusedError] = useState('');
  const [focusedVideoMuted, setFocusedVideoMuted] = useState(true);
  const [focusedVideoVolume, setFocusedVideoVolume] = useState(1);
  const [galleryStackLayersById, setGalleryStackLayersById] = useState<Record<string, string[]>>({});
  const focusedVideoRef = useRef<HTMLVideoElement | null>(null);
  const focusedRequestRef = useRef(0);
  const discoveryFilterPanelRef = useRef<HTMLDivElement | null>(null);
  const discoverySearchInputRef = useRef<HTMLInputElement | null>(null);
  const compactSearchInputRef = useRef<HTMLInputElement | null>(null);
  const swatches = ['#fda4af', '#7dd3fc', '#6ee7b7', '#a5b4fc', '#fcd34d', '#e9a8f4', '#5eead4', '#fdba74'];
  const creatorPostByMediaId = creatorPosts.reduce<Record<string, { slug: string; title: string }>>((acc, post) => {
    const ids = [
      ...(post.discoveryMediaIds || []),
      ...(post.primaryMediaId ? [post.primaryMediaId] : [])
    ];
    for (const mediaId of ids) {
      if (!mediaId || acc[mediaId]) continue;
      acc[mediaId] = { slug: post.slug, title: post.title };
    }
    return acc;
  }, {});

  const densityLabel: Record<FeedDensity, string> = { small: 'Small', medium: 'Medium', large: 'Large' };
  const densityOptions: FeedDensity[] = ['small', 'medium', 'large'];
  const densitySliderValue = feedDensity === 'small' ? 0 : (feedDensity === 'medium' ? 1 : 2);
  const densityRangeStyle = getDensityRangeStyle(densitySliderValue);
  const cardAspect = feedDensity === 'small' ? 1 : (feedDensity === 'medium' ? 1.05 : 1.28);
  const mediaColumns = (() => {
    if (feedDensity === 'large') return 1;
    if (feedDensity === 'medium') return densityViewport === 'mobile' ? 1 : 2;
    if (densityViewport === 'desktop') return 3;
    if (densityViewport === 'tablet') return 2;
    return 1;
  })();
  const heavyHidden = hideHeavyTopics || (hidePoliticsPublicAffairs && hideCrimeDisastersTragedy);
  const someHeavyHidden = !heavyHidden && (hidePoliticsPublicAffairs || hideCrimeDisastersTragedy);
  const mediaSummaryLabel = getDiscoveryMediaLabel({
    showImages: showImageMedia,
    showVideos: showVideoMedia,
    showPosts: showPostMedia
  });
  const heavySummaryLabel: DiscoveryDockSummary['heavyLabel'] = (
    densityViewport === 'mobile'
      ? (heavyHidden ? 'Heavy Hidden' : (someHeavyHidden ? 'Some Heavy' : 'Heavy Shown'))
      : (heavyHidden ? 'Heavy Topics Hidden' : (someHeavyHidden ? 'Some Heavy Topics' : 'Heavy Topics Shown'))
  );

  const mapFeedItemToTrendingShape = (
    item: any,
    artistName: string,
    artistId: string
  ): TrendingImage => {
    const primaryGallery = item?.primaryGallery || (Array.isArray(item?.galleryRefs) ? item.galleryRefs[0] : undefined);
    const gallerySlug = primaryGallery?.gallerySlug || '';
    const galleryId = primaryGallery?.galleryId || item?.galleryId || '';
    return {
      imageId: item.imageId,
      assetType: item.assetType === 'video' ? 'video' : 'image',
      artistId: item.artistId || artistId,
      artistName: item.artistName || artistName,
      galleryId,
      gallerySlug,
      galleryVisibility: primaryGallery?.galleryVisibility || item.galleryVisibility || 'free',
      discoverSquareCropEnabled: item.discoverSquareCropEnabled !== false,
      effectiveContentRating: item.effectiveContentRating,
      displayedContentRating: item.displayedContentRating,
      blurred: item.blurred,
      effectiveAiDisclosure: item.effectiveAiDisclosure,
      displayedAiDisclosure: item.displayedAiDisclosure,
      effectiveHeavyTopics: item.effectiveHeavyTopics,
      displayedHeavyTopics: item.displayedHeavyTopics,
      title: item.title || item.imageId,
      previewUrl: item.previewUrl || '',
      previewPosterUrl: item.previewPosterUrl,
      width: item.width,
      height: item.height,
      aspectRatio: item.aspectRatio,
      favoriteCount: item.favoriteCount || 0,
      createdAt: item.createdAt || new Date().toISOString()
    };
  };

  const loadProfile = async () => {
    try {
      setLoading(true);
      setError('');
      const response = normalizeCreatorProfilePayload(await api.getCreatorProfile(slug) as CreatorProfilePayload);
      const creatorId = response.artistId || response.creatorId || '';
      setProfile(response);
      setArtistTab('feed');
      const initialFeed = (response.feedItems || []).map((item) => mapFeedItemToTrendingShape(item, response.name, creatorId));
      setFeedItems(initialFeed);
      setFeedCursor(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const loadCreatorPosts = async () => {
    try {
      const response = await api.getCreatorPosts(slug) as { items?: CreatorPostSummary[] };
      setCreatorPosts(response.items || []);
    } catch {
      setCreatorPosts([]);
    }
  };

  const loadFeed = async (append = false) => {
    try {
      setFeedLoading(true);
      setError('');
      const artistName = profile?.name || guessArtistNameFromSlug(slug) || 'Creator';
      const artistId = profile?.artistId || '';
      let mapped: TrendingImage[] = [];
      let nextCursor: string | undefined;
      if (artistFeedSort === 'trending') {
        const response = await api.getCreatorTrendingImages(slug, 'daily', append ? feedCursor : undefined, 24) as {
          items: TrendingImage[];
          nextCursor?: string;
        };
        mapped = (response.items || []).map((item) => ({
          ...item,
          artistName: item.artistName || artistName,
          artistId: item.artistId || artistId,
          discoverSquareCropEnabled: item.discoverSquareCropEnabled !== false
        }));
        nextCursor = response.nextCursor;
      } else {
        const response = await api.getCreatorFeed(slug, append ? feedCursor : undefined, 24) as {
          artistId: string;
          artistSlug: string;
          items: any[];
          nextCursor?: string;
        };
        const responseArtistId = artistId || response.artistId || '';
        mapped = (response.items || []).map((item) => mapFeedItemToTrendingShape(item, artistName, responseArtistId));
        nextCursor = response.nextCursor;
      }
      setFeedItems((prev) => append ? [...prev, ...mapped] : mapped);
      setFeedCursor(nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFeedLoading(false);
    }
  };

  useEffect(() => {
    setArtistTab('feed');
    setArtistFeedSort('latest');
    setFeedItems([]);
    setFeedCursor(undefined);
    void loadProfile();
    void loadCreatorPosts();
  }, [slug]);

  useEffect(() => {
    if (!profile) return;
    void loadFeed(false);
  }, [slug, profile?.artistId, artistFeedSort]);

  useEffect(() => {
    const applyViewport = () => {
      const width = window.innerWidth;
      if (width >= 1100) setDensityViewport('desktop');
      else if (width >= 700) setDensityViewport('tablet');
      else setDensityViewport('mobile');
    };
    applyViewport();
    window.addEventListener('resize', applyViewport);
    return () => window.removeEventListener('resize', applyViewport);
  }, []);

  useEffect(() => {
    setDisclosureAiFilter(viewerProfile?.aiFilter || 'show-all');
    setHideHeavyTopics(Boolean(viewerProfile?.hideHeavyTopics));
    setHidePoliticsPublicAffairs(Boolean(viewerProfile?.hidePoliticsPublicAffairs));
    setHideCrimeDisastersTragedy(Boolean(viewerProfile?.hideCrimeDisastersTragedy));
  }, [
    viewerProfile?.aiFilter,
    viewerProfile?.hideHeavyTopics,
    viewerProfile?.hidePoliticsPublicAffairs,
    viewerProfile?.hideCrimeDisastersTragedy
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const evaluate = () => {
      if (artistTab !== 'feed') {
        setShowCompactDiscoveryDock(false);
        return;
      }
      if (window.innerWidth < 700) {
        setShowCompactDiscoveryDock(window.scrollY > 260);
        return;
      }
      const panel = discoveryFilterPanelRef.current;
      if (!panel) {
        setShowCompactDiscoveryDock(false);
        return;
      }
      const topbarHeight = Number.parseInt(
        window.getComputedStyle(document.documentElement).getPropertyValue('--topbar-height') || '72',
        10
      ) || 72;
      const rect = panel.getBoundingClientRect();
      setShowCompactDiscoveryDock(rect.bottom <= topbarHeight + 14);
    };
    evaluate();
    const onScrollOrResize = () => {
      window.requestAnimationFrame(evaluate);
    };
    window.addEventListener('scroll', onScrollOrResize, { passive: true });
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [artistTab]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => window.dispatchEvent(new Event('scroll')));
  }, [artistTab, artistFeedSort, heavyTopicsExpanded, densityViewport, feedDensity, discoverySearch, showImageMedia, showVideoMedia, showPostMedia]);

  useEffect(() => {
    if (densityViewport !== 'mobile' && !showCompactDiscoveryDock) {
      setCompactFiltersOpen(false);
    }
  }, [showCompactDiscoveryDock, densityViewport]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleCompactFilterIntent = (rawEvent: Event) => {
      if (artistTab !== 'feed') return;
      const detail = (rawEvent as CustomEvent<{ section?: DiscoveryFilterSection }>).detail || {};
      const requestedSection = detail.section || 'period';
      if (densityViewport === 'mobile') {
        setCompactFilterSection(requestedSection);
        if (requestedSection === 'heavy') {
          setCompactHeavyTopicsExpanded(true);
        }
        setCompactFiltersOpen(true);
        return;
      }
      if (!showCompactDiscoveryDock) {
        discoveryFilterPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (requestedSection === 'search') {
          window.setTimeout(() => discoverySearchInputRef.current?.focus(), 280);
        }
        if (requestedSection === 'heavy') {
          setHeavyTopicsExpanded(true);
        }
        return;
      }
      setCompactFilterSection(requestedSection);
      if (requestedSection === 'heavy') {
        setCompactHeavyTopicsExpanded(true);
      }
      setCompactFiltersOpen(true);
    };
    window.addEventListener(DISCOVERY_FILTER_EVENT_NAME, handleCompactFilterIntent as EventListener);
    return () => window.removeEventListener(DISCOVERY_FILTER_EVENT_NAME, handleCompactFilterIntent as EventListener);
  }, [showCompactDiscoveryDock, densityViewport, artistTab]);

  useEffect(() => {
    if (!compactFiltersOpen || typeof window === 'undefined') return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCompactFiltersOpen(false);
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [compactFiltersOpen]);

  useEffect(() => {
    if (!compactFiltersOpen || compactFilterSection !== 'search' || typeof window === 'undefined') return;
    const timerId = window.setTimeout(() => {
      compactSearchInputRef.current?.focus();
    }, densityViewport === 'mobile' ? 240 : 120);
    return () => window.clearTimeout(timerId);
  }, [compactFiltersOpen, compactFilterSection, densityViewport]);

  useEffect(() => {
    onDiscoveryDockChange?.(null);
  }, [onDiscoveryDockChange]);

  useEffect(() => () => {
    onDiscoveryDockChange?.(null);
  }, [onDiscoveryDockChange]);

  useEffect(() => {
    if (artistTab !== 'galleries' || !profile?.galleries?.length) return;
    let cancelled = false;

    setGalleryStackLayersById((prev) => {
      const next = { ...prev };
      for (const gallery of (profile.galleries || [])) {
        if (!next[gallery.galleryId] && gallery.galleryThumbnailUrl) {
          next[gallery.galleryId] = [gallery.galleryThumbnailUrl];
        }
      }
      return next;
    });

    const loadGalleryLayers = async () => {
      const updates: Record<string, string[]> = {};
      await Promise.all((profile.galleries || []).map(async (gallery) => {
        try {
          const response = await api.getGallery(gallery.slug) as Gallery;
          const cover = gallery.galleryThumbnailUrl || response.coverPreviewUrl || '';
          const candidateUrls = [
            ...(cover ? [cover] : []),
            ...((response.media || []).map((item) => (
              item.assetType === 'video'
                ? (item.previewPosterUrl || item.previewUrl)
                : item.previewUrl
            )).filter((url): url is string => Boolean(url)))
          ];
          const unique = Array.from(new Set(candidateUrls));
          const front = unique[0] || cover;
          if (!front) return;
          const remaining = unique.filter((url) => url !== front);
          const mid = remaining[0] || front;
          const back = remaining[1] || mid;
          updates[gallery.galleryId] = [front, mid, back];
        } catch {
          // Keep existing fallback layer when a single gallery request fails.
        }
      }));
      if (cancelled || !Object.keys(updates).length) return;
      setGalleryStackLayersById((prev) => ({ ...prev, ...updates }));
    };

    void loadGalleryLayers();
    return () => {
      cancelled = true;
    };
  }, [artistTab, profile?.artistId, profile?.galleries]);

  const applyHideAllHeavyTopics = (enabled: boolean) => {
    setHideHeavyTopics(enabled);
    setHidePoliticsPublicAffairs(enabled);
    setHideCrimeDisastersTragedy(enabled);
  };
  const applyHidePoliticsPublicAffairs = (enabled: boolean) => {
    setHidePoliticsPublicAffairs(enabled);
    setHideHeavyTopics(enabled && hideCrimeDisastersTragedy);
  };
  const applyHideCrimeDisastersTragedy = (enabled: boolean) => {
    setHideCrimeDisastersTragedy(enabled);
    setHideHeavyTopics(enabled && hidePoliticsPublicAffairs);
  };

  const toFocusedAsset = (item: TrendingImage): GalleryAsset => ({
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

  const openFocusedViewer = async (item: TrendingImage) => {
    const fallback = toFocusedAsset(item);
    setFocusedOpen(true);
    setFocusedGallerySlug(item.gallerySlug || '');
    setFocusedGalleryTitle(item.title || 'Artwork');
    setFocusedItems([fallback]);
    setFocusedIndex(0);
    setFocusedError('');
    if (!item.gallerySlug) {
      setFocusedLoading(false);
      return;
    }
    const requestId = focusedRequestRef.current + 1;
    focusedRequestRef.current = requestId;
    setFocusedLoading(true);
    try {
      const response = await api.getGallery(item.gallerySlug) as Gallery;
      if (focusedRequestRef.current !== requestId) return;
      const media = (response.media || []).filter((asset) => Boolean(asset.previewUrl));
      const nextItems = media.length > 0 ? media : [fallback];
      const focusedAssetIndex = Math.max(0, nextItems.findIndex((asset) => asset.imageId === item.imageId));
      setFocusedGalleryTitle(response.title || item.title || 'Artwork');
      setFocusedItems(nextItems);
      setFocusedIndex(focusedAssetIndex);
      setFocusedError('');
    } catch (e) {
      if (focusedRequestRef.current !== requestId) return;
      setFocusedError((e as Error).message || 'Could not load gallery media');
    } finally {
      if (focusedRequestRef.current === requestId) {
        setFocusedLoading(false);
      }
    }
  };

  const closeFocusedViewer = () => {
    setFocusedOpen(false);
    setFocusedLoading(false);
    setFocusedError('');
    focusedRequestRef.current += 1;
  };
  const scrollToArtistFilters = () => {
    document.getElementById('artist-discovery-filters')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    closeFocusedViewer();
  };

  const filteredFeedItems = feedItems.filter((item) => (
    passesDiscoveryMediaFilter(item, {
      showImages: showImageMedia,
      showVideos: showVideoMedia,
      showPosts: showPostMedia
    })
    && passesAiDisclosureFilter(item.effectiveAiDisclosure, disclosureAiFilter)
    && passesHeavyTopicFilter(item.effectiveHeavyTopics, {
      hideHeavyTopics,
      hidePoliticsPublicAffairs,
      hideCrimeDisastersTragedy
    })
    && matchesDiscoverySearch(discoverySearch, [
      item.title,
      item.artistName,
      item.gallerySlug,
      item.displayedContentRating,
      item.displayedAiDisclosure,
      ...(item.displayedHeavyTopics || [])
    ])
  ));

  const focusedItem = focusedItems[focusedIndex] || null;
  const focusedHasPrevious = focusedIndex > 0;
  const focusedHasNext = focusedIndex >= 0 && focusedIndex < focusedItems.length - 1;

  useEffect(() => {
    const video = focusedVideoRef.current;
    if (!video || focusedItem?.assetType !== 'video') return;
    const clamped = Math.max(0, Math.min(1, focusedVideoVolume));
    if (Math.abs(video.volume - clamped) > 0.001) video.volume = clamped;
    if (video.muted !== focusedVideoMuted) video.muted = focusedVideoMuted;
  }, [focusedItem?.assetType, focusedItem?.imageId, focusedVideoMuted, focusedVideoVolume]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const video = focusedVideoRef.current;
    if (!focusedOpen || !video || focusedItem?.assetType !== 'video') return undefined;
    let disposed = false;
    const safePlay = () => {
      if (disposed) return;
      const playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => undefined);
    };
    const observer = new window.IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
        safePlay();
      } else if (!video.paused) {
        video.pause();
      }
    }, { threshold: [0.2, 0.6, 0.9] });
    observer.observe(video);
    safePlay();
    return () => {
      disposed = true;
      observer.disconnect();
      if (!video.paused) video.pause();
    };
  }, [focusedOpen, focusedItem?.assetType, focusedItem?.imageId]);

  useEffect(() => {
    if (!focusedOpen || typeof window === 'undefined') return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeFocusedViewer();
        return;
      }
      if (event.key === 'ArrowLeft' && focusedHasPrevious) {
        setFocusedIndex((index) => Math.max(0, index - 1));
      }
      if (event.key === 'ArrowRight' && focusedHasNext) {
        setFocusedIndex((index) => Math.min(focusedItems.length - 1, index + 1));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [focusedOpen, focusedHasPrevious, focusedHasNext, focusedItems.length]);

  if (loading && !profile) return <div className="layout">Loading...</div>;
  if (!profile) return <div className="layout">{error || 'Creator not found'}</div>;

  const followerLabel = `${profile.followerCount} ${profile.followerCount === 1 ? 'follower' : 'followers'}`;
  const galleryLabel = `${profile.galleryCount} ${profile.galleryCount === 1 ? 'gallery' : 'galleries'}`;
  const imageLabel = `${profile.imageCount} ${profile.imageCount === 1 ? 'image' : 'images'}`;
  const creatorGroupings = profile.galleries || [];
  const latestPosts = [...creatorPosts].sort((a, b) => {
    const lhs = Date.parse(a.publishedAt || a.updatedAt || a.createdAt || '');
    const rhs = Date.parse(b.publishedAt || b.updatedAt || b.createdAt || '');
    return (Number.isFinite(rhs) ? rhs : 0) - (Number.isFinite(lhs) ? lhs : 0);
  });

  const renderArtistCard = (item: TrendingImage, index: number) => {
    const fallbackPosterUrl = item.previewPosterUrl || (item.assetType === 'video' && isLikelyImageUrl(item.previewUrl) ? item.previewUrl : undefined);
    const disclosureLine = formatDisclosureLine(item);
    const visibilityPill = item.galleryVisibility === 'preview'
      ? 'Preview'
      : item.galleryVisibility === 'premium'
        ? 'Premium'
        : null;
    const linkedPost = creatorPostByMediaId[item.imageId];
    return (
      <article key={item.imageId} className="discovery-feature-card gallery-discovery-card" style={{ '--media-aspect': cardAspect.toFixed(3) } as any}>
        <button
          type="button"
          className="discovery-feature-link discovery-feature-link-btn no-underline"
          onClick={() => void openFocusedViewer(item)}
        >
          <div className="discovery-feature-media no-crop" style={{ aspectRatio: `${cardAspect} / 1` }}>
            {(item.assetType === 'video' && !fallbackPosterUrl)
              ? (
                <video
                  src={item.previewUrl}
                  muted
                  playsInline
                  preload="metadata"
                  style={{ objectPosition: 'center center', filter: item.blurred ? 'blur(28px)' : undefined }}
                />
              )
              : (
                <img
                  src={item.assetType === 'video' ? (fallbackPosterUrl || '') : item.previewUrl}
                  alt={item.title || 'Artwork preview'}
                  loading={index < 2 ? 'eager' : 'lazy'}
                  decoding="async"
                  style={{ objectPosition: 'center center', filter: item.blurred ? 'blur(28px)' : undefined }}
                />
              )}
            {visibilityPill && <span className="discovery-chip">{visibilityPill}</span>}
            {item.assetType === 'video' && <span className="discovery-chip" style={{ left: 'unset', right: visibilityPill ? '8.2rem' : '1rem' }}>Video</span>}
            {item.blurred && <span className="discovery-chip" style={{ left: 'unset', right: '1rem' }}>Mature Content</span>}
          </div>
        </button>
        <div className="discovery-feature-footer">
          <div className="discovery-feature-text">
            <h3 className="discovery-feature-title">
              {linkedPost ? <Link to={`/posts/${linkedPost.slug}`} className="no-underline">{item.title || item.imageId}</Link> : (item.title || item.imageId)}
            </h3>
            <p className="discovery-feature-subtitle">by {item.artistName || profile.name}</p>
            {disclosureLine && <p className="discovery-feature-subtitle">{disclosureLine}</p>}
          </div>
          <div className="discovery-feature-stats">
            <span>❤ {item.favoriteCount || 0}</span>
            <span>👁 {(2.0 + (index % 8) * 0.2).toFixed(1)}k</span>
            <span>{item.displayedContentRating || 'General'}</span>
          </div>
        </div>
      </article>
    );
  };

  const setCompactSection = (section: DiscoveryFilterSection) => {
    setCompactFilterSection(section);
    if (section === 'heavy') {
      setCompactHeavyTopicsExpanded(true);
    }
  };

  const closeCompactFilters = () => setCompactFiltersOpen(false);

  const compactTabs: Array<{ section: DiscoveryFilterSection; label: string }> = [
    { section: 'period', label: artistFeedSort === 'latest' ? 'Latest' : 'Trending' },
    { section: 'media', label: mediaSummaryLabel },
    { section: 'density', label: `Density: ${densityLabel[feedDensity]}` },
    { section: 'heavy', label: heavySummaryLabel },
    { section: 'search', label: discoverySearch.trim().length > 0 ? 'Search active' : 'Search' }
  ];

  const renderCompactFilterBody = () => {
    if (compactFilterSection === 'period') {
      return (
        <div className="discovery-compact-section discovery-compact-period-section">
          <div className="discovery-filter-label">Creator feed</div>
          <div className="discovery-trending-filter">
            <button
              className={`discovery-pill-btn${artistFeedSort === 'latest' ? ' is-active' : ''}`}
              type="button"
              onClick={() => setArtistFeedSort('latest')}
            >
              Latest
            </button>
            <button
              className={`discovery-pill-btn${artistFeedSort === 'trending' ? ' is-active' : ''}`}
              type="button"
              onClick={() => setArtistFeedSort('trending')}
            >
              Trending
            </button>
          </div>
        </div>
      );
    }

    if (compactFilterSection === 'media') {
      return (
        <div className="discovery-compact-section discovery-compact-period-section">
          <div className="discovery-filter-label">Media types</div>
          <div className="discovery-trending-filter">
            <button className={`discovery-pill-btn discovery-media-toggle-btn${showImageMedia ? ' is-active' : ''}`} onClick={() => setShowImageMedia((prev) => !prev)}>
              <span className={`discovery-media-toggle-check${showImageMedia ? ' is-checked' : ''}`} aria-hidden="true" />
              <DiscoveryMediaIcon kind="image" className="discovery-media-icon" />
              <span>Images</span>
            </button>
            <button className={`discovery-pill-btn discovery-media-toggle-btn${showVideoMedia ? ' is-active' : ''}`} onClick={() => setShowVideoMedia((prev) => !prev)}>
              <span className={`discovery-media-toggle-check${showVideoMedia ? ' is-checked' : ''}`} aria-hidden="true" />
              <DiscoveryMediaIcon kind="video" className="discovery-media-icon" />
              <span>Videos</span>
            </button>
            <button className={`discovery-pill-btn discovery-media-toggle-btn${showPostMedia ? ' is-active' : ''}`} onClick={() => setShowPostMedia((prev) => !prev)}>
              <span className={`discovery-media-toggle-check${showPostMedia ? ' is-checked' : ''}`} aria-hidden="true" />
              <DiscoveryMediaIcon kind="post" className="discovery-media-icon" />
              <span>Posts</span>
            </button>
          </div>
        </div>
      );
    }

    if (compactFilterSection === 'heavy') {
      return (
        <div className="discovery-heavy-card">
          <div className="discovery-heavy-head">
            <label className="discovery-heavy-row is-primary">
              <input
                type="checkbox"
                checked={hideHeavyTopics || (hidePoliticsPublicAffairs && hideCrimeDisastersTragedy)}
                onChange={(e) => applyHideAllHeavyTopics(e.target.checked)}
              />
              <span>Hide all heavy topics</span>
            </label>
            <button
              type="button"
              className={`discovery-heavy-toggle${compactHeavyTopicsExpanded ? ' is-expanded' : ''}`}
              onClick={() => setCompactHeavyTopicsExpanded((prev) => !prev)}
              aria-label={compactHeavyTopicsExpanded ? 'Collapse heavy topics options' : 'Expand heavy topics options'}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M6 12L10 8L14 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          {compactHeavyTopicsExpanded && (
            <div className="discovery-heavy-body">
              <label className="discovery-heavy-row">
                <input
                  type="checkbox"
                  checked={hidePoliticsPublicAffairs}
                  onChange={(e) => applyHidePoliticsPublicAffairs(e.target.checked)}
                />
                <span>{heavyTopicLabels['politics-public-affairs']}</span>
              </label>
              <label className="discovery-heavy-row">
                <input
                  type="checkbox"
                  checked={hideCrimeDisastersTragedy}
                  onChange={(e) => applyHideCrimeDisastersTragedy(e.target.checked)}
                />
                <span>{heavyTopicLabels['crime-disasters-tragedy']}</span>
              </label>
            </div>
          )}
        </div>
      );
    }

    if (compactFilterSection === 'density') {
      return (
        <div className="discovery-density-card">
          <div className="discovery-density-head">
            <span>Feed density</span>
            <strong>{densityLabel[feedDensity]}</strong>
          </div>
          {densityViewport === 'desktop' && (
            <input
              className="discovery-density-range"
              type="range"
              min={0}
              max={2}
              step={1}
              value={densitySliderValue}
              style={densityRangeStyle}
              onChange={(e) => {
                const next = Number(e.target.value);
                setFeedDensity(next <= 0 ? 'small' : next === 1 ? 'medium' : 'large');
              }}
            />
          )}
          <div className={`discovery-density-options${densityOptions.length === 2 ? ' is-two' : ''}`}>
            {densityOptions.map((option) => (
              <button
                key={`artist-compact-density-option-${option}`}
                type="button"
                className={feedDensity === option ? 'is-active' : ''}
                onClick={() => setFeedDensity(option)}
              >
                {densityLabel[option]}
              </button>
            ))}
          </div>
          <p className="small m-0">
            This view uses fixed discovery cards rather than variable aspect-ratio rows.
          </p>
        </div>
      );
    }

    return (
      <div className="discovery-search-card is-compact">
        <div className="discovery-filter-label">Search</div>
        <div className="discovery-search-input-wrap">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M9 4.25a4.75 4.75 0 103.78 7.64l2.16 2.16a.75.75 0 101.06-1.06l-2.16-2.16A4.75 4.75 0 009 4.25z" fill="currentColor" />
          </svg>
          <input
            ref={compactSearchInputRef}
            type="text"
            value={discoverySearch}
            onChange={(e) => setDiscoverySearch(e.target.value)}
            placeholder="Search titles, galleries, and disclosures..."
          />
        </div>
      </div>
    );
  };

  return (
    <div className="layout discovery-layout">
      <section className="panel discovery-hero">
        <div>
          <h1>{profile.name}</h1>
          <p>
            {followerLabel}
            {' • '}
            <span>{galleryLabel}</span>
            {' • '}
            <span>{imageLabel}</span>
          </p>
        </div>
        <div className="discovery-hero-actions">
          <button className="auth-primary-btn">Follow creator</button>
          <Link className="auth-secondary-btn no-underline" to="/">Back to discovery</Link>
        </div>
      </section>

      <section id="creator-groupings-section" className="discovery-editorial-section">
        <div className="discovery-section-header">
          <h2>{profile.name} Groupings</h2>
        </div>
        {creatorGroupings.length > 0 ? (
          <div style={{ display: 'flex', gap: '1rem', overflowX: 'auto', paddingBottom: '0.5rem' }}>
            {creatorGroupings.map((grouping, i) => (
              <article key={`${grouping.galleryId}-grouping-${i}`} className="discovery-latest-item" style={{ minWidth: '280px', maxWidth: '340px' }}>
                <Link to={`/gallery/${grouping.slug}`} className="no-underline">
                  <div className="discovery-stack discovery-stack-tall">
                    {(() => {
                      const layers = galleryStackLayersById[grouping.galleryId] || [];
                      const front = layers[0] || grouping.galleryThumbnailUrl;
                      const mid = layers[1];
                      const back = layers[2];
                      return (
                        <>
                          <div className="discovery-stack-layer discovery-stack-layer-back">
                            {back
                              ? <img src={back} alt="" loading="lazy" aria-hidden="true" />
                              : <div className="discovery-stack-placeholder" aria-hidden="true" />}
                          </div>
                          <div className="discovery-stack-layer discovery-stack-layer-mid">
                            {mid
                              ? <img src={mid} alt="" loading="lazy" aria-hidden="true" />
                              : <div className="discovery-stack-placeholder" aria-hidden="true" />}
                          </div>
                          <div className="discovery-stack-layer discovery-stack-layer-front">
                            {front
                              ? <img src={front} alt={grouping.title || 'Grouping cover'} loading="lazy" />
                              : <div className="discovery-swatch" style={{ backgroundColor: swatches[(i + 2) % swatches.length] }} />}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  <div className="discovery-latest-meta">
                    <div className="discovery-card-title">{grouping.title}</div>
                    <div className="discovery-card-subtitle">{grouping.imageCount} images • ❤ {grouping.favoriteCount}</div>
                  </div>
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <p className="small">No published groupings yet.</p>
        )}
      </section>

      <section className="discovery-editorial-section">
        <div className="discovery-section-header">
          <h2>{latestPosts.length > 0 ? `Latest Posts by ${profile.name}` : `Latest Media by ${profile.name}`}</h2>
        </div>
        {latestPosts.length > 0 ? (
          <div className="discovery-latest-grid">
            {latestPosts.map((post, idx) => {
              const preview = post.primaryMedia || post.discoveryMedia?.[0];
              return (
                <article key={post.postId} className="discovery-latest-item">
                  <Link to={`/posts/${post.slug}`} className="no-underline">
                    <div className="discovery-feature-media" style={{ aspectRatio: `${cardAspect} / 1` }}>
                      {preview ? (
                        preview.assetType === 'video'
                          ? (
                            <img
                              src={preview.previewPosterUrl || preview.previewUrl}
                              alt={post.title}
                              loading={idx < 2 ? 'eager' : 'lazy'}
                              decoding="async"
                              style={{ objectPosition: 'center center' }}
                            />
                          )
                          : (
                            <img
                              src={preview.previewUrl}
                              alt={post.title}
                              loading={idx < 2 ? 'eager' : 'lazy'}
                              decoding="async"
                              style={{ objectPosition: 'center center' }}
                            />
                          )
                      ) : <div className="discovery-swatch" style={{ backgroundColor: swatches[idx % swatches.length] }} />}
                      <span className="discovery-chip">{post.discovery.mode}</span>
                    </div>
                    <div className="discovery-latest-meta">
                      <div className="discovery-card-title">{post.title}</div>
                      <div className="discovery-card-subtitle">{post.mediaCount} media • {post.blockCount} blocks</div>
                      {post.summary && <p className="small">{post.summary}</p>}
                    </div>
                  </Link>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="gallery-discovery-grid" style={{ '--gallery-grid-columns': mediaColumns } as any}>
            {filteredFeedItems.map((item, i) => renderArtistCard(item, i))}
          </div>
        )}
        {latestPosts.length === 0 && filteredFeedItems.length === 0 && (
          <p className="small">No published posts or media yet.</p>
        )}
        {latestPosts.length === 0 && <AutoLoadSentinel enabled={Boolean(feedCursor)} loading={feedLoading} onLoadMore={() => loadFeed(true)} />}
      </section>

      {focusedOpen && (
        <div className="discovery-focus-modal-layer" onClick={closeFocusedViewer}>
          <div className="discovery-focus-modal" role="dialog" aria-modal="true" aria-label="Focused media viewer" onClick={(e) => e.stopPropagation()}>
            <div className="discovery-focus-modal-header">
              <div className="discovery-focus-modal-title-wrap">
                <span className="discovery-focus-modal-title-id">{focusedItem?.imageId || 'Focused view'}</span>
                <span className="discovery-focus-modal-title-gallery">{focusedGalleryTitle || profile.name}</span>
              </div>
              <div className="discovery-focus-modal-meta">
                <span>{focusedItem?.displayedContentRating || 'General'}</span>
                {focusedItem && formatDisclosureLine(focusedItem) && <span>{formatDisclosureLine(focusedItem)}</span>}
                <span>{Math.max(1, focusedIndex + 1)} / {Math.max(1, focusedItems.length)}</span>
                {focusedLoading && <span className="discovery-focus-modal-status-chip">Loading…</span>}
                {focusedError && <span className="discovery-focus-modal-error-chip">{focusedError}</span>}
              </div>
              <div className="discovery-focus-modal-actions">
                <button
                  type="button"
                  className="auth-secondary-btn"
                  disabled={!focusedHasPrevious}
                  onClick={() => setFocusedIndex((index) => Math.max(0, index - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="auth-secondary-btn"
                  disabled={!focusedHasNext}
                  onClick={() => setFocusedIndex((index) => Math.min(focusedItems.length - 1, index + 1))}
                >
                  Next
                </button>
                {focusedGallerySlug && (
                  <Link
                    className="auth-primary-btn no-underline"
                    to={`/gallery/${focusedGallerySlug}?image=${encodeURIComponent(focusedItem?.imageId || '')}`}
                    onClick={closeFocusedViewer}
                  >
                    Open in Gallery
                  </Link>
                )}
                <button type="button" className="auth-secondary-btn" onClick={scrollToArtistFilters}>
                  Back to top
                </button>
              </div>
              <button type="button" className="discovery-focus-modal-close" onClick={closeFocusedViewer} aria-label="Close focused viewer">
                ✕
              </button>
            </div>
            <div className="discovery-focus-modal-media">
              {focusedItem && (
                focusedItem.assetType === 'video'
                  ? (
                    <video
                      key={focusedItem.imageId}
                      ref={focusedVideoRef}
                      autoPlay
                      controls
                      playsInline
                      muted={focusedVideoMuted}
                      poster={focusedItem.previewPosterUrl}
                      style={{ filter: focusedItem.blurred ? 'blur(28px)' : undefined }}
                      onVolumeChange={(event) => {
                        const target = event.currentTarget;
                        setFocusedVideoMuted(target.muted);
                        setFocusedVideoVolume(Math.max(0, Math.min(1, target.volume)));
                      }}
                    >
                      <source src={focusedItem.previewUrl} />
                    </video>
                  )
                  : (
                    <img
                      src={focusedItem.thumbnailUrls?.w1280 || focusedItem.thumbnailUrls?.w640 || focusedItem.previewUrl}
                      alt={focusedItem.imageId || 'Focused media'}
                      style={{ filter: focusedItem.blurred ? 'blur(28px)' : undefined }}
                    />
                  )
              )}
              {!focusedItem && <div className="small">No media selected.</div>}
            </div>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}

function PostPage() {
  const { slug = '' } = useParams();
  const [post, setPost] = useState<PostDetailPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        setError('');
        const response = await api.getPostBySlug(slug) as PostDetailPayload;
        if (cancelled) return;
        setPost(response);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (loading && !post) return <div className="layout">Loading...</div>;
  if (!post) return <div className="layout">{error || 'Post not found'}</div>;

  const mediaById = new Map(post.media.map((item) => [item.mediaId, item]));
  const orderedMedia = [...post.media].sort((a, b) => (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER));
  const relatedSidebarMedia = orderedMedia.slice(0, 6);
  const destinationLabel = post.destination?.type === 'pdf'
    ? 'Open PDF'
    : post.destination?.type === 'external'
      ? 'Open external link'
      : post.destination?.type === 'internal'
        ? 'Open internal destination'
        : 'Open destination';

  const renderMediaPreview = (mediaId?: string, title?: string, caption?: string) => {
    if (!mediaId) return null;
    const media = mediaById.get(mediaId);
    if (!media) return null;
    return (
      <figure className="panel">
        {media.assetType === 'video'
          ? (
            <video controls playsInline poster={media.previewPosterUrl} style={{ width: '100%', borderRadius: '1rem' }}>
              <source src={media.previewUrl} />
            </video>
          )
          : <img src={media.previewUrl} alt={title || media.title || media.mediaId} style={{ width: '100%', borderRadius: '1rem' }} />}
        {(caption || media.caption) && <figcaption className="small mt-2">{caption || media.caption}</figcaption>}
      </figure>
    );
  };

  const renderBlock = (block: PostBlock, index: number) => {
    switch (block.type) {
      case 'heading': {
        const level = Math.max(1, Math.min(6, block.level || 2));
        if (level === 1) return <h1 key={block.blockId || index}>{block.text || ''}</h1>;
        if (level === 2) return <h2 key={block.blockId || index}>{block.text || ''}</h2>;
        if (level === 3) return <h3 key={block.blockId || index}>{block.text || ''}</h3>;
        if (level === 4) return <h4 key={block.blockId || index}>{block.text || ''}</h4>;
        if (level === 5) return <h5 key={block.blockId || index}>{block.text || ''}</h5>;
        return <h6 key={block.blockId || index}>{block.text || ''}</h6>;
      }
      case 'paragraph':
        return <p key={block.blockId || index}>{block.text || ''}</p>;
      case 'quote':
        return (
          <blockquote key={block.blockId || index} className="panel">
            <p>{block.quote || block.text || ''}</p>
            {block.author && <footer className="small">— {block.author}</footer>}
          </blockquote>
        );
      case 'divider':
        return <hr key={block.blockId || index} />;
      case 'image':
      case 'video':
        return (
          <div key={block.blockId || index}>
            {renderMediaPreview(block.mediaId, block.title || block.text, block.caption)}
          </div>
        );
      case 'audio': {
        const audio = block.mediaId ? mediaById.get(block.mediaId) : undefined;
        return (
          <div key={block.blockId || index} className="panel">
            {audio ? (
              <audio controls style={{ width: '100%' }}>
                <source src={audio.previewUrl} />
              </audio>
            ) : <p className="small">Audio media not found.</p>}
          </div>
        );
      }
      case 'link':
      case 'embed':
      case 'file':
      case 'pdf_preview':
        return (
          <div key={block.blockId || index} className="panel">
            <a href={block.url || '#'} target="_blank" rel="noreferrer" className="no-underline">
              {block.title || block.url || 'Open link'}
            </a>
            {block.text && <p className="small mt-2">{block.text}</p>}
          </div>
        );
      case 'html_fragment':
        return (
          <pre key={block.blockId || index} className="panel small" style={{ overflowX: 'auto' }}>
            {block.html || ''}
          </pre>
        );
      case 'gallery':
      case 'carousel':
      default:
        return (
          <div key={block.blockId || index} className="panel">
            <p>{block.text || block.title || `Block: ${block.type}`}</p>
          </div>
        );
    }
  };

  return (
    <div className="layout post-detail-layout">
      <div className="post-detail-main">
        <section className="panel">
          <h1>{post.title}</h1>
          <p className="small">
            By {(post.creator || post.artist)
              ? (
                <Link
                  to={`/creators/${encodeURIComponent((post.creator || post.artist)!.slug)}`}
                  className="no-underline"
                >
                  {(post.creator || post.artist)!.name}
                </Link>
              )
              : 'Unknown creator'}
            {' · '}
            {post.status}
            {' · '}
            {post.discovery.mode}
          </p>
          {post.summary && <p>{post.summary}</p>}
          {post.destination?.url && (
            <p className="mt-3">
              <a className="auth-primary-btn no-underline" href={post.destination.url} target="_blank" rel="noreferrer">
                {destinationLabel}
              </a>
            </p>
          )}
        </section>

        {orderedMedia.length > 0 && (
          <section className="panel mt-4">
            <h2>Media</h2>
            <div className="gallery-discovery-grid" style={{ '--gallery-grid-columns': 2 } as any}>
              {orderedMedia.map((media) => (
                <article key={media.mediaId} className="discovery-feature-card gallery-discovery-card">
                  <div className="discovery-feature-media" style={{ aspectRatio: '1.15 / 1' }}>
                    {media.assetType === 'video'
                      ? <img src={media.previewPosterUrl || media.previewUrl} alt={media.title || media.mediaId} />
                      : <img src={media.previewUrl} alt={media.title || media.mediaId} />}
                  </div>
                  <div className="discovery-feature-footer">
                    <div className="discovery-feature-text">
                      <h3 className="discovery-feature-title">{media.title || media.mediaId}</h3>
                      {media.caption && <p className="discovery-feature-subtitle">{media.caption}</p>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {post.blocks.length > 0 && (
          <section className="panel mt-4">
            <h2>Post Content</h2>
            <div className="mt-3" style={{ display: 'grid', gap: '1rem' }}>
              {post.blocks.map((block, idx) => renderBlock(block, idx))}
            </div>
          </section>
        )}
      </div>

      <aside className="post-detail-sidebar">
        <section className="panel">
          <h3 className="m-0">Discover related</h3>
          <p className="small mt-2 mb-0">More media and discovery context connected to this post.</p>
        </section>
        <section className="panel mt-4">
          <h4 className="m-0">From this post</h4>
          <div className="post-detail-sidebar-list mt-3">
            {relatedSidebarMedia.length > 0 ? relatedSidebarMedia.map((media) => (
              <article key={`related-media-${media.mediaId}`} className="post-detail-sidebar-card">
                <div className="post-detail-sidebar-thumb">
                  {media.assetType === 'video'
                    ? <img src={media.previewPosterUrl || media.previewUrl} alt={media.title || media.mediaId} loading="lazy" decoding="async" />
                    : <img src={media.previewUrl} alt={media.title || media.mediaId} loading="lazy" decoding="async" />}
                </div>
                <div>
                  <div className="discovery-card-title">{media.title || media.mediaId}</div>
                  <div className="discovery-card-subtitle">{media.assetType === 'video' ? 'Video' : 'Image'}</div>
                </div>
              </article>
            )) : (
              <p className="small m-0">No related media yet.</p>
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}

function StudioDashboardPage({
  user,
  managedArtists,
  roleNotificationCounts
}: {
  user: CurrentUser;
  managedArtists: ManagedArtist[];
  roleNotificationCounts: RoleNotificationCounts;
}) {
  if (!user) return <Navigate to="/auth/signin" replace />;
  const normalizedGroups = (user.groups || []).map((group) => group.toLowerCase());
  const isAdmin = normalizedGroups.includes('admin') || normalizedGroups.includes('admins');
  const hasCreatorProfiles = managedArtists.length > 0;
  const studioCount = sanitizeNotificationCount(roleNotificationCounts.studio);
  const adminCount = sanitizeNotificationCount(roleNotificationCounts.admin);
  const [studioMetrics, setStudioMetrics] = useState<{
    totalUsers: number;
    creators: number;
    posts: number;
    files: number;
    mediaItems: number;
    pendingEntries: number;
    adminReviewItems: number;
    contributors: number;
  } | null>(null);
  const [crudCreators, setCrudCreators] = useState<Array<{ artistId: string; creatorId?: string; name: string; slug: string }>>([]);
  const [crudPosts, setCrudPosts] = useState<Array<{ postId: string; title: string; status: string; artistId: string }>>([]);
  const [crudGalleries, setCrudGalleries] = useState<Array<{ galleryId: string; title: string; artistId: string }>>([]);
  const [crudFiles, setCrudFiles] = useState<Array<{ fileId: string; creatorId: string; sourceKind: string; originalFilename?: string; storageKey: string }>>([]);
  const [crudError, setCrudError] = useState<string>('');
  const [newCreatorName, setNewCreatorName] = useState('');
  const [newCreatorSlug, setNewCreatorSlug] = useState('');
  const [newFileCreatorId, setNewFileCreatorId] = useState('');
  const [newFileName, setNewFileName] = useState('');
  const [newFileMimeType, setNewFileMimeType] = useState('image/jpeg');
  const [selectedGalleryId, setSelectedGalleryId] = useState('');
  const totalUsers = studioMetrics?.totalUsers || 0;
  const beekerCount = studioMetrics?.contributors || 0;
  const creatorCount = studioMetrics?.creators || Math.max(0, managedArtists.length);
  const reviewCount = studioMetrics?.adminReviewItems || adminCount;
  const quickLinks = [
    { label: 'Files & Media', section: 'files-media' },
    { label: 'Posts', section: 'posts' },
    { label: 'Creator Groupings', section: 'creator-groupings' },
    { label: 'Collections', section: 'collections' },
    { label: 'Creators', section: 'creators' },
    { label: 'Challenges', section: 'challenges' },
    { label: 'Entries', section: 'entries' },
    { label: 'Users', section: 'users' },
    { label: 'Moderation', section: 'moderation' }
  ];
  const queueItems = [
    { title: 'Review approved challenge entries', detail: '12 items · promotes User to Beeker', tone: 'success' },
    { title: 'Confirm bulk media deletion', detail: '2-step admin action · 41 assets', tone: 'warning' },
    { title: 'Resolve flagged user collection', detail: 'Mature-tag mismatch', tone: 'danger' },
    { title: 'Publish scheduled creator posts', detail: '6 items due today', tone: 'info' }
  ] as const;
  const loadCrudData = async () => {
    try {
      setCrudError('');
      const [metrics, creators, posts, galleries, files] = await Promise.all([
        api.studioMetrics(),
        api.adminListCreators(),
        api.adminListPosts(),
        api.adminListGalleries(),
        api.adminListFiles()
      ]);
      setStudioMetrics(metrics as any);
      setCrudCreators((creators as any[]) || []);
      setCrudPosts((posts as any[]) || []);
      setCrudGalleries((galleries as any[]) || []);
      setCrudFiles((files as any[]) || []);
      if (!newFileCreatorId && Array.isArray(creators) && creators[0]?.artistId) {
        setNewFileCreatorId(creators[0].artistId);
      }
      if (!selectedGalleryId && Array.isArray(galleries) && galleries[0]?.galleryId) {
        setSelectedGalleryId(galleries[0].galleryId);
      }
    } catch (error) {
      setCrudError(error instanceof Error ? error.message : 'Failed to load Studio resources');
    }
  };

  useEffect(() => {
    void loadCrudData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createCreator = async () => {
    if (!newCreatorName.trim()) return;
    try {
      await api.adminCreateArtist({
        name: newCreatorName.trim(),
        slug: newCreatorSlug.trim() || newCreatorName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
      });
      setNewCreatorName('');
      setNewCreatorSlug('');
      await loadCrudData();
    } catch (error) {
      setCrudError(error instanceof Error ? error.message : 'Failed to create creator');
    }
  };

  const createFile = async () => {
    if (!newFileCreatorId.trim() || !newFileName.trim()) return;
    try {
      await api.adminCreateFile({
        creatorId: newFileCreatorId,
        originalFilename: newFileName.trim(),
        mimeType: newFileMimeType,
        storageKey: `uploads/${newFileName.trim().replace(/\s+/g, '-').toLowerCase()}`
      });
      setNewFileName('');
      await loadCrudData();
    } catch (error) {
      setCrudError(error instanceof Error ? error.message : 'Failed to create file');
    }
  };

  return (
    <div className="layout studio-dashboard-shell">
      <aside className="studio-sidebar panel">
        <div className="studio-brand-card">
          <strong>Ubeeq</strong>
          <span>STUDIO</span>
        </div>
        <div className="studio-contributor-label">
          <strong>Contributor label</strong>
          <p>System name: Contributor.</p>
          <p>Visual name: {roleDisplayLabel('contributor')}.</p>
        </div>
        <nav className="studio-sidebar-nav">
          <Link className="studio-nav-item studio-nav-item-active no-underline" to="/studio">
            <span>Dashboard</span><span aria-hidden="true">›</span>
          </Link>
          {quickLinks.map((link) => (
            <Link
              key={link.section}
              className="studio-nav-item no-underline"
              to={`/studio/workspace?section=${encodeURIComponent(link.section)}`}
            >
              <span>{link.label}</span><span aria-hidden="true">›</span>
            </Link>
          ))}
        </nav>
        <div className="studio-user-card">
          <strong>{user.displayName || user.username}</strong>
          <span>{isAdmin ? 'Admin' : 'Creator'} · {managedArtists.length} creator accounts</span>
        </div>
      </aside>

      <section className="studio-main">
        <section className="panel studio-hero">
          <div>
            <div className="studio-pills">
              <span>Admin controls inside Studio</span>
              <span>Creators can manage multiple creators</span>
              <span>Approved entry = {roleDisplayLabel('contributor')}</span>
            </div>
            <h2>Studio dashboard</h2>
            <p className="small">
              A unified control surface for contribution, publishing, moderation, and challenge workflows.
              The separate Admin area is removed; elevated actions appear contextually with stronger protections.
            </p>
          </div>
          <div className="studio-hero-actions">
            <Link to="/settings#notifications" className="auth-secondary-btn no-underline">Notifications</Link>
            <Link to="/settings#preferences" className="auth-secondary-btn no-underline">Preferences</Link>
            <Link to="/studio/workspace" className="auth-primary-btn no-underline">+ Quick create</Link>
          </div>
        </section>

        <section className="studio-stat-grid">
          <article className="panel"><p>Total users</p><h3>{totalUsers.toLocaleString()}</h3><span>live from `/studio/metrics`</span></article>
          <article className="panel"><p>Beekers</p><h3>{beekerCount.toLocaleString()}</h3><span>contributor role count</span></article>
          <article className="panel"><p>Creators</p><h3>{creatorCount.toLocaleString()}</h3><span>live creator accounts</span></article>
          <article className="panel"><p>Admin review items</p><h3>{reviewCount.toLocaleString()}</h3><span>entries + moderation queue</span></article>
        </section>

        <section className="studio-detail-grid">
          <article className="panel">
            <div className="studio-title-row">
              <h3>Studio overview</h3>
              <button type="button" className="auth-secondary-btn">+ New item</button>
            </div>
            <p className="small">A single contribution surface for users, Beekers, Creators, and Admins. No separate admin area.</p>
            <div className="studio-overview-cards">
              <div className="studio-overview-card success">
                <h4>Beeker onboarding</h4>
                <p>Approved challenge entries automatically unlock the Beeker role and contributor tools.</p>
                <span>12 awaiting review</span>
              </div>
              <div className="studio-overview-card info">
                <h4>Multi-creator accounts</h4>
                <p>Creators and Admins can manage multiple creator identities under one user account.</p>
                <span>48 users manage 2+ creators</span>
              </div>
              <div className="studio-overview-card warning">
                <h4>Admin protections</h4>
                <p>Destructive actions require typed confirmation, a reason, and dependency checks.</p>
                <span>7 pending destructive confirmations</span>
              </div>
            </div>
          </article>
          <article className="panel">
            <h3>Action queue</h3>
            <p className="small">Prioritized items across moderation, approvals, and publishing.</p>
            <div className="studio-queue-list">
              {queueItems.map((item) => (
                <div key={item.title} className={`studio-queue-item ${item.tone}`}>
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                  <Link className="no-underline" to="/studio/workspace?section=entries">Open</Link>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="studio-detail-grid">
          <article className="panel">
            <div className="studio-title-row">
              <h3>Your creator accounts</h3>
              <button type="button" className="auth-primary-btn">+ New creator</button>
            </div>
            {hasCreatorProfiles ? (
              <div className="studio-creator-list">
                {managedArtists.map((artist) => (
                  <article key={artist.artistId} className="studio-creator-card">
                    <h4>{artist.name}</h4>
                    <p>/{artist.slug}</p>
                    <span className="studio-creator-role">Creator</span>
                    <Link to={`/creators/${artist.slug}`} className="auth-secondary-btn no-underline">Open profile</Link>
                  </article>
                ))}
              </div>
            ) : (
              <p className="small">No creator accounts yet. Admins can assign creator ownership from Users in Studio.</p>
            )}
          </article>
          <article className="panel">
            <h3>Role model</h3>
            <p className="small">Clear progression and management rules.</p>
            <ul className="studio-role-list">
              <li><strong>User</strong> — create collections, enter challenges, manage profile settings.</li>
              <li><strong>{roleDisplayLabel('contributor')}</strong> — contributor role for approved challenge workflows.</li>
              <li><strong>Creator</strong> — publish content and manage creator groupings.</li>
              <li><strong>Admin</strong> — moderation, challenge management, and destructive approvals.</li>
            </ul>
            <p className="small">Studio notifications: {studioCount > 0 ? formatNotificationBadge(studioCount) : '0'}.</p>
          </article>
        </section>

        <section className="panel">
          <div className="studio-title-row">
            <h3>Resource CRUD workbench</h3>
            <button type="button" className="auth-secondary-btn" onClick={() => void loadCrudData()}>Refresh data</button>
          </div>
          <p className="small">This mirrors the prototype resource model with live API-backed forms for Creators, Files, Posts, and Media Items.</p>
          {crudError && <p className="error">{crudError}</p>}
          <div className="studio-crud-grid">
            <article className="studio-crud-card">
              <h4>Creators</h4>
              <input placeholder="Creator name" value={newCreatorName} onChange={(e) => setNewCreatorName(e.target.value)} />
              <input placeholder="creator-slug" value={newCreatorSlug} onChange={(e) => setNewCreatorSlug(e.target.value)} />
              <button type="button" className="auth-primary-btn" onClick={() => void createCreator()}>Create creator</button>
              <ul>
                {crudCreators.slice(0, 6).map((creator) => <li key={creator.artistId}>{creator.name} / {creator.slug}</li>)}
              </ul>
            </article>
            <article className="studio-crud-card">
              <h4>Files</h4>
              <select value={newFileCreatorId} onChange={(e) => setNewFileCreatorId(e.target.value)}>
                <option value="">Select creator</option>
                {crudCreators.map((creator) => <option key={`file-creator-${creator.artistId}`} value={creator.artistId}>{creator.name}</option>)}
              </select>
              <input placeholder="original-filename.jpg" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} />
              <input placeholder="mime type" value={newFileMimeType} onChange={(e) => setNewFileMimeType(e.target.value)} />
              <button type="button" className="auth-primary-btn" onClick={() => void createFile()}>Create file</button>
              <ul>
                {crudFiles.slice(0, 6).map((file) => <li key={file.fileId}>{file.originalFilename || file.fileId} ({file.sourceKind})</li>)}
              </ul>
            </article>
            <article className="studio-crud-card">
              <h4>Posts</h4>
              <p className="small">{crudPosts.length} posts loaded via `/admin/posts`.</p>
              <ul>
                {crudPosts.slice(0, 6).map((post) => <li key={post.postId}>{post.title} ({post.status})</li>)}
              </ul>
            </article>
            <article className="studio-crud-card">
              <h4>Media items</h4>
              <select value={selectedGalleryId} onChange={(e) => setSelectedGalleryId(e.target.value)}>
                <option value="">Select gallery</option>
                {crudGalleries.map((gallery) => <option key={`gallery-${gallery.galleryId}`} value={gallery.galleryId}>{gallery.title}</option>)}
              </select>
              <p className="small">
                Media CRUD is powered by `/admin/images` endpoints and requires a gallery context.
                Selected gallery: {selectedGalleryId || 'none'}.
              </p>
            </article>
          </div>
        </section>
      </section>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<CurrentUser>(() => getCurrentUser());
  const [myProfile, setMyProfile] = useState<UserProfile | null>(null);
  const [managedArtists, setManagedArtists] = useState<ManagedArtist[]>([]);
  const [roleNotificationCounts, setRoleNotificationCounts] = useState<RoleNotificationCounts>({ studio: 0, admin: 0 });
  const [settings, setSettings] = useState<SiteSettings>({ siteName: 'Ubeeq', theme: 'ubeeq' });
  const [discoveryDock, setDiscoveryDock] = useState<DiscoveryDockSummary | null>(null);

  const handleSignOut = async () => {
    await signOut();
    setUser(null);
    setMyProfile(null);
  };

  useEffect(() => {
    api.getSiteSettings().then((data) => setSettings(data)).catch(console.error);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!user) return;
    api.getMyProfile()
      .then((profile) => {
        if (!cancelled) setMyProfile(profile as UserProfile);
      })
      .catch((error) => {
        if (cancelled) return;
        if (isUnauthorizedError(error)) {
          clearStoredAuthSession();
          setUser(null);
          setMyProfile(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user?.username]);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setManagedArtists([]);
      setRoleNotificationCounts({ studio: 0, admin: 0 });
      return;
    }
    const loadHeaderNav = async () => {
      try {
        const myArtists = await api.getMyArtists() as ManagedArtist[];
        if (cancelled) return;
        const normalizedArtists = myArtists || [];
        const studioCountFromArtists = normalizedArtists.reduce((total, artist) => total + extractStudioNotificationCount(artist), 0);
        const storedCounts = readRoleNotificationCounts();
        setManagedArtists(normalizedArtists);
        setRoleNotificationCounts({
          studio: sanitizeNotificationCount(storedCounts.studio ?? studioCountFromArtists),
          admin: sanitizeNotificationCount(storedCounts.admin)
        });
      } catch (error) {
        if (cancelled) return;
        const storedCounts = readRoleNotificationCounts();
        setManagedArtists([]);
        setRoleNotificationCounts({
          studio: sanitizeNotificationCount(storedCounts.studio),
          admin: sanitizeNotificationCount(storedCounts.admin)
        });
        if (isUnauthorizedError(error)) {
          clearStoredAuthSession();
          setUser(null);
          setMyProfile(null);
        }
      }
    };
    void loadHeaderNav();
    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== ROLE_NOTIFICATION_STORAGE_KEY) return;
      const storedCounts = readRoleNotificationCounts();
      setRoleNotificationCounts((current) => ({
        studio: sanitizeNotificationCount(storedCounts.studio ?? current.studio),
        admin: sanitizeNotificationCount(storedCounts.admin ?? current.admin)
      }));
    };
    window.addEventListener('storage', handleStorage);
    return () => {
      cancelled = true;
      window.removeEventListener('storage', handleStorage);
    };
  }, [user?.username]);

  return (
    <div className="app-shell" data-theme={settings.theme || 'ubeeq'}>
      <HeaderAuth
        user={user}
        onSignOut={handleSignOut}
        settings={settings}
        profile={myProfile}
        discoveryDock={discoveryDock}
        managedArtists={managedArtists}
        roleNotificationCounts={roleNotificationCounts}
      />
      <Routes>
        <Route path="/" element={<HomePage viewerProfile={myProfile} onDiscoveryDockChange={setDiscoveryDock} />} />
        <Route path="/trending" element={<TrendingPage viewerProfile={myProfile} />} />
        <Route path="/creators/:slug" element={<CreatorProfilePage viewerProfile={myProfile} onDiscoveryDockChange={setDiscoveryDock} />} />
        <Route path="/gallery/:slug" element={<GalleryPage viewerProfile={myProfile} onDiscoveryDockChange={setDiscoveryDock} />} />
        <Route path="/posts/:slug" element={<PostPage />} />
        <Route path="/collections" element={<CollectionsPage />} />
        <Route path="/for-creators" element={<ForCreatorsPage />} />
        <Route path="/collections/:collectionId" element={<CollectionDetailPage />} />
        <Route path="/auth/:mode" element={<AuthPage user={user} setUser={setUser} />} />
        <Route path="/settings" element={<SettingsPage user={user} onProfileChanged={setMyProfile} />} />
        <Route path="/studio" element={<StudioDashboardPage user={user} managedArtists={managedArtists} roleNotificationCounts={roleNotificationCounts} />} />
        <Route path="/studio/workspace" element={user ? <StudioWorkspace /> : <Navigate to="/auth/signin" replace />} />
        <Route path="/admin" element={<Navigate to="/studio" replace />} />
        <Route path="/artist-area" element={<LegacyArtistAreaRedirect />} />
        <Route path="/artist-area/admin" element={<LegacyArtistAreaWorkspaceRedirect />} />
      </Routes>
    </div>
  );
}
