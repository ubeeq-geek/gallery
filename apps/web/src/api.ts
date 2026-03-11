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
  async getTrendingImages(period: 'hourly' | 'daily' = 'daily', cursor?: string, limit = 24) {
    const qs = new URLSearchParams();
    qs.set('period', period);
    qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    const response = await fetch(withDevCacheBypass(`${API_BASE}/discovery/trending-images?${qs.toString()}`));
    return handleJson(response);
  },
  async getArtistProfile(slug: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/artists/${slug}/profile`);
    return handleJson(response);
  },
  async getArtistTrendingImages(slug: string, period: 'hourly' | 'daily' = 'daily', cursor?: string, limit = 24) {
    const qs = new URLSearchParams();
    qs.set('period', period);
    qs.set('limit', String(limit));
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
  async updateArtist(artistId: string, payload: { name?: string; slug?: string; status?: 'active' | 'inactive'; sortOrder?: number }) {
    const response = await fetch(`${API_BASE}/admin/artists/${artistId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  }
};
