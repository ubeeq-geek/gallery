import { getValidIdToken } from './cognitoAuth';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
let myProfileInFlight: Promise<unknown> | null = null;
const withDevCacheBypass = (url: string): string => {
  if (!import.meta.env.DEV) return url;
  const delimiter = url.includes('?') ? '&' : '?';
  return `${url}${delimiter}__cb=${Date.now()}`;
};

const authHeaders = async (): Promise<Record<string, string>> => {
  const idToken = await getValidIdToken();
  return idToken ? { Authorization: `Bearer ${idToken}` } : {};
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchAuthGetWithRetry = async (url: string, baseHeaders?: Record<string, string>): Promise<Response> => {
  const attempt = async (): Promise<Response> => fetch(url, { headers: { ...(baseHeaders || {}), ...(await authHeaders()) } });
  try {
    let response = await attempt();
    if (response.status >= 500 && response.status < 600) {
      await sleep(250);
      response = await attempt();
    }
    return response;
  } catch (error) {
    if (error instanceof TypeError) {
      await sleep(250);
      return attempt();
    }
    throw error;
  }
};

const handleJson = async (response: Response) => {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || 'Request failed');
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
};

export const api = {
  async checkUsername(username: string) {
    const response = await fetch(`${API_BASE}/auth/username/check?username=${encodeURIComponent(username)}`);
    return handleJson(response);
  },
  async registerAccount(email: string, password: string, username: string) {
    const response = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, username })
    });
    return handleJson(response);
  },
  async getSiteSettings() {
    const response = await fetch(withDevCacheBypass(`${API_BASE}/site-settings`));
    return handleJson(response);
  },
  async getArtists() {
    const response = await fetch(withDevCacheBypass(`${API_BASE}/artists`));
    return handleJson(response);
  },
  async getLatestGalleries(limit = 12) {
    const response = await fetch(withDevCacheBypass(`${API_BASE}/discovery/latest-galleries?limit=${encodeURIComponent(String(limit))}`));
    return handleJson(response);
  },
  async getGalleriesByArtist(artistSlug: string, galleryAccessToken?: string) {
    const headers: Record<string, string> = {};
    if (galleryAccessToken) headers['x-gallery-access-token'] = galleryAccessToken;
    const response = await fetch(`${API_BASE}/artists/${artistSlug}/galleries`, { headers });
    return handleJson(response);
  },
  async getGallery(slug: string, galleryAccessToken?: string) {
    const headers: Record<string, string> = {};
    if (galleryAccessToken) headers['x-gallery-access-token'] = galleryAccessToken;
    const response = await fetch(`${API_BASE}/galleries/${slug}`, { headers });
    return handleJson(response);
  },
  async unlockGallery(slug: string, password: string) {
    const response = await fetch(`${API_BASE}/galleries/${slug}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ password })
    });
    return handleJson(response);
  },
  async getPremiumImages(slug: string, unlockToken: string) {
    const headers: Record<string, string> = { ...(await authHeaders()) };
    if (unlockToken) headers['x-unlock-token'] = unlockToken;
    const response = await fetch(`${API_BASE}/galleries/${slug}/premium-images`, {
      headers
    });
    return handleJson(response);
  },
  async getPremiumImagesWithRemember(slug: string, galleryAccessToken: string) {
    const response = await fetch(`${API_BASE}/galleries/${slug}/premium-images`, {
      headers: { 'x-gallery-access-token': galleryAccessToken, ...(await authHeaders()) }
    });
    return handleJson(response);
  },
  async getGalleryComments(slug: string) {
    const response = await fetch(`${API_BASE}/galleries/${slug}/comments`);
    return handleJson(response);
  },
  async postGalleryComment(slug: string, body: string) {
    const response = await fetch(`${API_BASE}/galleries/${slug}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ body })
    });
    return handleJson(response);
  },
  async postGalleryCommentAsProfile(
    slug: string,
    body: string,
    profile: { authorProfileType: 'user' | 'artist'; authorProfileId?: string }
  ) {
    const response = await fetch(`${API_BASE}/galleries/${slug}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ body, ...profile })
    });
    return handleJson(response);
  },
  async getTrendingImages(
    period: 'hourly' | 'daily' = 'daily',
    cursor?: string,
    limit = 24,
    source: 'combined' | 'media' | 'post' = 'combined'
  ) {
    const qs = new URLSearchParams();
    qs.set('period', period);
    qs.set('limit', String(limit));
    qs.set('source', source);
    if (cursor) qs.set('cursor', cursor);
    const response = await fetch(withDevCacheBypass(`${API_BASE}/discovery/trending-images?${qs.toString()}`));
    return handleJson(response);
  },
  async getTrendingImagesFiltered(
    period: 'hourly' | 'daily' = 'daily',
    cursor?: string,
    limit = 24,
    filters?: {
      aiFilter?: 'show-all' | 'hide-ai-generated' | 'hide-all-ai';
      hideHeavyTopics?: boolean;
      hidePoliticsPublicAffairs?: boolean;
      hideCrimeDisastersTragedy?: boolean;
    },
    source: 'combined' | 'media' | 'post' = 'combined'
  ) {
    const qs = new URLSearchParams();
    qs.set('period', period);
    qs.set('limit', String(limit));
    qs.set('source', source);
    if (cursor) qs.set('cursor', cursor);
    if (filters?.aiFilter) qs.set('aiFilter', filters.aiFilter);
    if (filters?.hideHeavyTopics !== undefined) qs.set('hideHeavyTopics', String(Boolean(filters.hideHeavyTopics)));
    if (filters?.hidePoliticsPublicAffairs !== undefined) qs.set('hidePoliticsPublicAffairs', String(Boolean(filters.hidePoliticsPublicAffairs)));
    if (filters?.hideCrimeDisastersTragedy !== undefined) qs.set('hideCrimeDisastersTragedy', String(Boolean(filters.hideCrimeDisastersTragedy)));
    const response = await fetch(withDevCacheBypass(`${API_BASE}/discovery/trending-images?${qs.toString()}`));
    return handleJson(response);
  },
  async getArtistProfile(slug: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/artists/${slug}/profile`);
    return handleJson(response);
  },
  async getArtistFeed(slug: string, cursor?: string, limit = 24) {
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    const response = await fetchAuthGetWithRetry(`${API_BASE}/artists/${slug}/feed?${qs.toString()}`);
    return handleJson(response);
  },
  async getArtistFeatured(slug: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/artists/${slug}/featured`);
    return handleJson(response);
  },
  async getArtistTrendingImages(
    slug: string,
    period: 'hourly' | 'daily' = 'daily',
    cursor?: string,
    limit = 24,
    source: 'combined' | 'media' | 'post' = 'combined'
  ) {
    const qs = new URLSearchParams();
    qs.set('period', period);
    qs.set('limit', String(limit));
    qs.set('source', source);
    if (cursor) qs.set('cursor', cursor);
    const response = await fetchAuthGetWithRetry(`${API_BASE}/artists/${slug}/trending-images?${qs.toString()}`);
    return handleJson(response);
  },
  async getImageComments(imageId: string) {
    const response = await fetch(`${API_BASE}/images/${imageId}/comments`);
    return handleJson(response);
  },
  async postImageComment(imageId: string, body: string) {
    const response = await fetch(`${API_BASE}/images/${imageId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ body })
    });
    return handleJson(response);
  },
  async postImageCommentAsProfile(
    imageId: string,
    body: string,
    profile: { authorProfileType: 'user' | 'artist'; authorProfileId?: string }
  ) {
    const response = await fetch(`${API_BASE}/images/${imageId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ body, ...profile })
    });
    return handleJson(response);
  },
  async favorite(
    targetType: 'gallery' | 'image' | 'collection',
    targetId: string,
    visibility: 'public' | 'private' = 'public',
    ownerProfile?: { ownerProfileType: 'user' | 'artist'; ownerProfileId?: string }
  ) {
    const response = await fetch(`${API_BASE}/favorites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ targetType, targetId, visibility, ...ownerProfile })
    });
    return handleJson(response);
  },
  async unfavorite(
    targetType: 'gallery' | 'image' | 'collection',
    targetId: string,
    ownerProfile?: { ownerProfileType: 'user' | 'artist'; ownerProfileId?: string }
  ) {
    const response = await fetch(`${API_BASE}/favorites`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ targetType, targetId, ...ownerProfile })
    });
    return handleJson(response);
  },
  async myFavorites(ownerProfile?: { ownerProfileType: 'user' | 'artist'; ownerProfileId?: string }) {
    const page = await this.myFavoritesPage(ownerProfile);
    return page.items;
  },
  async myFavoritesPage(
    ownerProfile?: { ownerProfileType: 'user' | 'artist'; ownerProfileId?: string },
    cursor?: string,
    limit = 24
  ) {
    const qs = new URLSearchParams();
    if (ownerProfile?.ownerProfileType) qs.set('ownerProfileType', ownerProfile.ownerProfileType);
    if (ownerProfile?.ownerProfileId) qs.set('ownerProfileId', ownerProfile.ownerProfileId);
    qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const response = await fetchAuthGetWithRetry(`${API_BASE}/me/favorites${suffix}`);
    const result = await handleJson(response);
    if (Array.isArray(result)) return { items: result, nextCursor: undefined as string | undefined };
    return result as { items: unknown[]; nextCursor?: string };
  },
  async myFollows() {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/me/follows`);
    return handleJson(response);
  },
  async followArtist(artistId: string, notificationsEnabled = false) {
    const response = await fetch(`${API_BASE}/artists/${artistId}/follow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ notificationsEnabled })
    });
    return handleJson(response);
  },
  async unfollowArtist(artistId: string) {
    const response = await fetch(`${API_BASE}/artists/${artistId}/follow`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async getCollections(cursor?: string, limit = 24, options?: { order?: 'random' | 'latest' | 'popular'; seed?: string }) {
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    if (options?.order) qs.set('order', options.order);
    if (options?.seed) qs.set('seed', options.seed);
    const response = await fetch(withDevCacheBypass(`${API_BASE}/collections?${qs.toString()}`));
    return handleJson(response);
  },
  async getCollection(collectionId: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/collections/${collectionId}`);
    return handleJson(response);
  },
  async myCollections(ownerProfile?: { ownerProfileType: 'user' | 'artist'; ownerProfileId?: string }) {
    const page = await this.myCollectionsPage(ownerProfile);
    return page.items;
  },
  async myCollectionsPage(
    ownerProfile?: { ownerProfileType: 'user' | 'artist'; ownerProfileId?: string },
    cursor?: string,
    limit = 24
  ) {
    const qs = new URLSearchParams();
    if (ownerProfile?.ownerProfileType) qs.set('ownerProfileType', ownerProfile.ownerProfileType);
    if (ownerProfile?.ownerProfileId) qs.set('ownerProfileId', ownerProfile.ownerProfileId);
    qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const response = await fetchAuthGetWithRetry(`${API_BASE}/me/collections${suffix}`);
    const result = await handleJson(response);
    if (Array.isArray(result)) return { items: result, nextCursor: undefined as string | undefined };
    return result as { items: unknown[]; nextCursor?: string };
  },
  async createCollection(payload: {
    title: string;
    description?: string;
    visibility?: 'public' | 'private';
    coverImageId?: string;
    ownerProfileType?: 'user' | 'artist';
    ownerProfileId?: string;
  }) {
    const response = await fetch(`${API_BASE}/me/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async updateCollection(collectionId: string, payload: {
    title?: string;
    description?: string;
    visibility?: 'public' | 'private';
    coverImageId?: string;
  }) {
    const response = await fetch(`${API_BASE}/me/collections/${collectionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async deleteCollection(collectionId: string) {
    const response = await fetch(`${API_BASE}/me/collections/${collectionId}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async addImageToCollection(collectionId: string, imageId: string, sortOrder?: number) {
    const response = await fetch(`${API_BASE}/me/collections/${collectionId}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ imageId, sortOrder })
    });
    return handleJson(response);
  },
  async removeImageFromCollection(collectionId: string, imageId: string) {
    const response = await fetch(`${API_BASE}/me/collections/${collectionId}/images/${imageId}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async getMyProfile() {
    if (!myProfileInFlight) {
      myProfileInFlight = (async () => {
        const response = await fetchAuthGetWithRetry(`${API_BASE}/me/profile`);
        return handleJson(response);
      })().finally(() => {
        myProfileInFlight = null;
      });
    }
    return myProfileInFlight;
  },
  async updateMyProfile(payload: {
    displayName?: string;
    bio?: string;
    location?: string;
    website?: string;
    matureContentEnabled?: boolean;
    maxAllowedContentRating?: 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
    aiFilter?: 'show-all' | 'hide-ai-generated' | 'hide-all-ai';
    hideHeavyTopics?: boolean;
    hidePoliticsPublicAffairs?: boolean;
    hideCrimeDisastersTragedy?: boolean;
  }) {
    const response = await fetch(`${API_BASE}/me/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    myProfileInFlight = null;
    return handleJson(response);
  },
  async updateMyUsername(username: string) {
    const response = await fetch(`${API_BASE}/me/username`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ username })
    });
    myProfileInFlight = null;
    return handleJson(response);
  },
  async getMyArtists() {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/me/artists`);
    return handleJson(response);
  },
  async getArtistPosts(artistSlug: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/artists/${encodeURIComponent(artistSlug)}/posts`);
    return handleJson(response);
  },
  async getPostBySlug(slug: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/posts/${encodeURIComponent(slug)}`);
    return handleJson(response);
  },
  async adminListPosts(artistId?: string) {
    const qs = new URLSearchParams();
    if (artistId) qs.set('artistId', artistId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const response = await fetchAuthGetWithRetry(`${API_BASE}/admin/posts${suffix}`);
    return handleJson(response);
  },
  async adminCreatePost(payload: {
    artistId: string;
    title: string;
    slug?: string;
    summary?: string;
    status?: 'draft' | 'published' | 'archived';
    blocks?: Array<Record<string, unknown>>;
    media?: Array<{ mediaId: string; discoverable?: boolean; sortOrder?: number; caption?: string }>;
    primaryMediaId?: string;
    discoveryMode?: 'primary' | 'all' | 'selected';
    destination?: { type: 'post' | 'pdf' | 'external' | 'internal'; url: string } | null;
    metadata?: Record<string, string>;
  }) {
    const response = await fetch(`${API_BASE}/admin/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async adminUpdatePost(postId: string, payload: {
    title?: string;
    slug?: string;
    summary?: string;
    status?: 'draft' | 'published' | 'archived';
    blocks?: Array<Record<string, unknown>>;
    media?: Array<{ mediaId: string; discoverable?: boolean; sortOrder?: number; caption?: string }>;
    primaryMediaId?: string;
    discoveryMode?: 'primary' | 'all' | 'selected';
    destination?: { type: 'post' | 'pdf' | 'external' | 'internal'; url: string } | null;
    metadata?: Record<string, string>;
  }) {
    const response = await fetch(`${API_BASE}/admin/posts/${encodeURIComponent(postId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async adminDeletePost(postId: string) {
    const response = await fetch(`${API_BASE}/admin/posts/${encodeURIComponent(postId)}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async adminListArtistMembers(artistId: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/admin/artists/${encodeURIComponent(artistId)}/members`);
    return handleJson(response);
  },
  async adminAddArtistMember(artistId: string, payload: { userId: string; role?: 'owner' | 'editor' | 'manager' }) {
    const response = await fetch(`${API_BASE}/admin/artists/${encodeURIComponent(artistId)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async adminRemoveArtistMember(artistId: string, userId: string) {
    const response = await fetch(`${API_BASE}/admin/artists/${encodeURIComponent(artistId)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async updateArtist(artistId: string, payload: {
    name?: string;
    slug?: string;
    status?: 'active' | 'inactive';
    sortOrder?: number;
    discoverSquareCropEnabled?: boolean;
    defaultAiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
    defaultHeavyTopics?: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
  }) {
    const response = await fetch(`${API_BASE}/admin/artists/${artistId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async adminListArtists() {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/admin/artists`);
    return handleJson(response);
  },
  async adminListGalleries() {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/admin/galleries`);
    return handleJson(response);
  },
  async adminCreateArtist(payload: {
    name: string;
    slug: string;
    status?: 'active' | 'inactive';
    sortOrder?: number;
    discoverSquareCropEnabled?: boolean;
    defaultAiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
    defaultHeavyTopics?: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
  }) {
    const response = await fetch(`${API_BASE}/admin/artists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async adminCreateGallery(payload: {
    artistId: string;
    artistSlug?: string;
    title: string;
    slug: string;
    visibility?: 'free' | 'preview' | 'premium';
    status?: 'draft' | 'published';
    coverImageId?: string;
    pairedPremiumGalleryId?: string;
    purchaseUrl?: string;
    premiumPassword?: string;
    discoverSquareCropEnabled?: boolean;
    defaultPreviewMaxWidth?: number;
    defaultAiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
    defaultHeavyTopics?: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
  }) {
    const response = await fetch(`${API_BASE}/admin/galleries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },

  async adminUpdateGallery(galleryId: string, payload: {
    artistId?: string;
    artistSlug?: string;
    title?: string;
    slug?: string;
    visibility?: 'free' | 'preview' | 'premium';
    status?: 'draft' | 'published';
    coverImageId?: string;
    pairedPremiumGalleryId?: string;
    purchaseUrl?: string;
    premiumPassword?: string;
    discoverSquareCropEnabled?: boolean;
    defaultPreviewMaxWidth?: number;
    defaultAiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
    defaultHeavyTopics?: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
  }) {
    const response = await fetch(`${API_BASE}/admin/galleries/${encodeURIComponent(galleryId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async adminListGalleryMedia(galleryId: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/admin/galleries/${encodeURIComponent(galleryId)}/images`);
    return handleJson(response);
  },
  async adminCreateMedia(payload: {
    galleryId: string;
    assetType?: 'image' | 'video';
    title?: string;
    originalFilename?: string;
    previewKey: string;
    premiumKey?: string;
    previewPosterKey?: string;
    premiumPosterKey?: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
    sortOrder?: number;
    contentRating?: 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
    moderatorContentRating?: 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
    aiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
    moderatorAiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
    heavyTopics?: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
    moderatorHeavyTopics?: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
    discoverSquareCropEnabled?: boolean;
    isPreview?: boolean;
    previewMaxWidth?: number;
    squareCrop?: { x: number; y: number; size: number };
  }) {
    const response = await fetch(`${API_BASE}/admin/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },

  async adminGenerateMediaRenditions(galleryId: string, imageId: string, payload?: { squareCrop?: { x: number; y: number; size: number } }) {
    const response = await fetch(`${API_BASE}/admin/images/${encodeURIComponent(galleryId)}/${encodeURIComponent(imageId)}/renditions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload || {})
    });
    return handleJson(response);
  },
  async adminUpdateMedia(galleryId: string, imageId: string, payload: {
    assetType?: 'image' | 'video';
    title?: string;
    originalFilename?: string;
    previewKey?: string;
    premiumKey?: string;
    previewPosterKey?: string;
    premiumPosterKey?: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
    sortOrder?: number;
    contentRating?: 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
    moderatorContentRating?: 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
    aiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
    moderatorAiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
    heavyTopics?: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
    moderatorHeavyTopics?: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
    discoverSquareCropEnabled?: boolean;
    isPreview?: boolean;
    previewMaxWidth?: number;
    squareCrop?: { x: number; y: number; size: number };
  }) {
    const response = await fetch(`${API_BASE}/admin/images/${encodeURIComponent(galleryId)}/${encodeURIComponent(imageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async adminDeleteArtist(artistId: string) {
    const response = await fetch(`${API_BASE}/admin/artists/${encodeURIComponent(artistId)}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async adminDeleteGallery(galleryId: string) {
    const response = await fetch(`${API_BASE}/admin/galleries/${encodeURIComponent(galleryId)}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async adminDeleteMedia(galleryId: string, imageId: string, sortOrder = 0) {
    const response = await fetch(`${API_BASE}/admin/images/${encodeURIComponent(galleryId)}/${encodeURIComponent(imageId)}?sortOrder=${encodeURIComponent(String(sortOrder))}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },

  async adminUpdateSiteSettings(payload: { siteName?: string; theme?: 'ubeeq' | 'sand' | 'forest' | 'slate'; logoKey?: string }) {
    const response = await fetch(`${API_BASE}/admin/site-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async adminCreateSiteSettingsLogoUploadUrl(contentType: string) {
    const response = await fetch(`${API_BASE}/admin/site-settings/logo-upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ contentType })
    });
    return handleJson(response);
  },
  async adminSetCommentStatus(commentId: string, payload: { hidden: boolean }) {
    const response = await fetch(`${API_BASE}/admin/comments/${encodeURIComponent(commentId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async adminDeleteComment(commentId: string) {
    const response = await fetch(`${API_BASE}/admin/comments/${encodeURIComponent(commentId)}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async adminBlockUser(userId: string, reason?: string) {
    const response = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(userId)}/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ reason })
    });
    return handleJson(response);
  },
  async adminUnblockUser(userId: string) {
    const response = await fetch(`${API_BASE}/admin/users/${encodeURIComponent(userId)}/block`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async adminGetAudit(limit = 50, cursor?: string, filters?: { action?: string; actorUserId?: string }) {
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    if (filters?.action) qs.set('action', filters.action);
    if (filters?.actorUserId) qs.set('actorUserId', filters.actorUserId);
    const response = await fetchAuthGetWithRetry(`${API_BASE}/admin/audit?${qs.toString()}`);
    return handleJson(response) as Promise<{ items: unknown[]; nextCursor?: string }>;
  },
  async adminRebuildTrending() {
    const response = await fetch(`${API_BASE}/admin/trending/rebuild`, {
      method: 'POST',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
};
