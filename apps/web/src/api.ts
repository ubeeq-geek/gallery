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

type OwnerProfileType = 'user' | 'creator' | 'artist';
type FavoriteTargetType = 'grouping' | 'gallery' | 'image' | 'collection';

const normalizeOwnerProfile = (ownerProfile?: { ownerProfileType: OwnerProfileType; ownerProfileId?: string }) =>
  ownerProfile
    ? {
        ...ownerProfile,
        ownerProfileType: ownerProfile.ownerProfileType === 'artist' ? 'creator' : ownerProfile.ownerProfileType
      }
    : undefined;

const normalizeFavoriteTargetType = (targetType: FavoriteTargetType): 'grouping' | 'image' | 'collection' => (
  targetType === 'gallery' ? 'grouping' : targetType
);

export const api = {
  async checkUsername(username: string) {
    const response = await fetch(`${API_BASE}/auth/username/check?username=${encodeURIComponent(username)}`);
    return handleJson(response);
  },
  async registerAccount(email: string, password: string, username?: string) {
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
    const response = await fetch(withDevCacheBypass(`${API_BASE}/creators`));
    return handleJson(response);
  },
  async getCreators() {
    const response = await fetch(withDevCacheBypass(`${API_BASE}/creators`));
    return handleJson(response);
  },
  async getLatestGroupings(limit = 12) {
    const response = await fetch(withDevCacheBypass(`${API_BASE}/discovery/latest-groupings?limit=${encodeURIComponent(String(limit))}`));
    return handleJson(response);
  },
  async getGroupingsByArtist(creator: string, groupingAccessToken?: string) {
    const headers: Record<string, string> = {};
    if (groupingAccessToken) headers['x-grouping-access-token'] = groupingAccessToken;
    const response = await fetch(`${API_BASE}/creators/${creator}/groupings`, { headers });
    return handleJson(response);
  },
  async getGrouping(slug: string, groupingAccessToken?: string) {
    const headers: Record<string, string> = {};
    if (groupingAccessToken) headers['x-grouping-access-token'] = groupingAccessToken;
    const response = await fetch(`${API_BASE}/groupings/${slug}`, { headers });
    return handleJson(response);
  },
  async unlockGrouping(slug: string, password: string) {
    const response = await fetch(`${API_BASE}/groupings/${slug}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ password })
    });
    return handleJson(response);
  },
  async getPremiumImages(slug: string, unlockToken: string) {
    const headers: Record<string, string> = { ...(await authHeaders()) };
    if (unlockToken) headers['x-unlock-token'] = unlockToken;
    const response = await fetch(`${API_BASE}/groupings/${slug}/premium-images`, {
      headers
    });
    return handleJson(response);
  },
  async getPremiumImagesWithRemember(slug: string, groupingAccessToken: string) {
    const response = await fetch(`${API_BASE}/groupings/${slug}/premium-images`, {
      headers: { 'x-grouping-access-token': groupingAccessToken, ...(await authHeaders()) }
    });
    return handleJson(response);
  },
  async getGroupingComments(slug: string) {
    const response = await fetch(`${API_BASE}/groupings/${slug}/comments`);
    return handleJson(response);
  },
  async postGroupingComment(slug: string, body: string) {
    const response = await fetch(`${API_BASE}/groupings/${slug}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ body })
    });
    return handleJson(response);
  },
  async postGroupingCommentAsProfile(
    slug: string,
    body: string,
    profile: { authorProfileType: 'user' | 'creator'; authorProfileId?: string }
  ) {
    const response = await fetch(`${API_BASE}/groupings/${slug}/comments`, {
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
    const response = await fetch(withDevCacheBypass(`${API_BASE}/discovery/trending-content?${qs.toString()}`));
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
      itemTypes?: string[];
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
    if (filters?.itemTypes?.length) qs.set('itemTypes', filters.itemTypes.join(','));
    const response = await fetch(withDevCacheBypass(`${API_BASE}/discovery/trending-content?${qs.toString()}`));
    return handleJson(response);
  },
  async getCreatorProfile(slug: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/creators/${slug}/profile`);
    return handleJson(response);
  },
  async getCreatorFeed(slug: string, cursor?: string, limit = 24) {
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    const response = await fetchAuthGetWithRetry(`${API_BASE}/creators/${slug}/feed?${qs.toString()}`);
    return handleJson(response);
  },
  async getCreatorFeatured(slug: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/creators/${slug}/featured`);
    return handleJson(response);
  },
  async getCreatorTrendingImages(
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
    const response = await fetchAuthGetWithRetry(`${API_BASE}/creators/${slug}/trending-content?${qs.toString()}`);
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
    profile: { authorProfileType: 'user' | 'creator'; authorProfileId?: string }
  ) {
    const response = await fetch(`${API_BASE}/images/${imageId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ body, ...profile })
    });
    return handleJson(response);
  },
  async favorite(
    targetType: FavoriteTargetType,
    targetId: string,
    visibility: 'public' | 'private' = 'public',
    ownerProfile?: { ownerProfileType: OwnerProfileType; ownerProfileId?: string }
  ) {
    const normalizedOwnerProfile = normalizeOwnerProfile(ownerProfile);
    const response = await fetch(`${API_BASE}/favorites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({
        targetType: normalizeFavoriteTargetType(targetType),
        targetId,
        visibility,
        ...normalizedOwnerProfile
      })
    });
    return handleJson(response);
  },
  async unfavorite(
    targetType: FavoriteTargetType,
    targetId: string,
    ownerProfile?: { ownerProfileType: OwnerProfileType; ownerProfileId?: string }
  ) {
    const normalizedOwnerProfile = normalizeOwnerProfile(ownerProfile);
    const response = await fetch(`${API_BASE}/favorites`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({
        targetType: normalizeFavoriteTargetType(targetType),
        targetId,
        ...normalizedOwnerProfile
      })
    });
    return handleJson(response);
  },
  async myFavorites(ownerProfile?: { ownerProfileType: OwnerProfileType; ownerProfileId?: string }) {
    const page = await this.myFavoritesPage(ownerProfile);
    return page.items;
  },
  async myFavoritesPage(
    ownerProfile?: { ownerProfileType: OwnerProfileType; ownerProfileId?: string },
    cursor?: string,
    limit = 24
  ) {
    const normalizedOwnerProfile = normalizeOwnerProfile(ownerProfile);
    const qs = new URLSearchParams();
    if (normalizedOwnerProfile?.ownerProfileType) qs.set('ownerProfileType', normalizedOwnerProfile.ownerProfileType);
    if (normalizedOwnerProfile?.ownerProfileId) qs.set('ownerProfileId', normalizedOwnerProfile.ownerProfileId);
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
  async followCreator(creator: string, notificationsEnabled = false) {
    const response = await fetch(`${API_BASE}/creators/${creator}/follow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ notificationsEnabled })
    });
    return handleJson(response);
  },
  async unfollowCreator(creator: string) {
    const response = await fetch(`${API_BASE}/creators/${creator}/follow`, {
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
  async myCollections(ownerProfile?: { ownerProfileType: OwnerProfileType; ownerProfileId?: string }) {
    const page = await this.myCollectionsPage(ownerProfile);
    return page.items;
  },
  async myCollectionsPage(
    ownerProfile?: { ownerProfileType: OwnerProfileType; ownerProfileId?: string },
    cursor?: string,
    limit = 24
  ) {
    const normalizedOwnerProfile = normalizeOwnerProfile(ownerProfile);
    const qs = new URLSearchParams();
    if (normalizedOwnerProfile?.ownerProfileType) qs.set('ownerProfileType', normalizedOwnerProfile.ownerProfileType);
    if (normalizedOwnerProfile?.ownerProfileId) qs.set('ownerProfileId', normalizedOwnerProfile.ownerProfileId);
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
    ownerProfileType?: OwnerProfileType;
    ownerProfileId?: string;
  }) {
    const normalizedPayload = {
      ...payload,
      ownerProfileType: payload.ownerProfileType === 'artist' ? 'creator' : payload.ownerProfileType
    };
    const response = await fetch(`${API_BASE}/me/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(normalizedPayload)
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
  async getMyCreators() {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/me/creators`);
    return handleJson(response);
  },
  async getMyArtists() {
    return this.getMyCreators();
  },
  async getCreatorPosts(creator: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/creators/${encodeURIComponent(creator)}/posts`);
    return handleJson(response);
  },
  async getPostBySlug(slug: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/posts/${encodeURIComponent(slug)}`);
    return handleJson(response);
  },
  async getPostById(postId: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/posts/by-id/${encodeURIComponent(postId)}`);
    return handleJson(response);
  },
  async studioListPosts(creatorId?: string) {
    const qs = new URLSearchParams();
    if (creatorId) qs.set('creatorId', creatorId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/posts${suffix}`);
    return handleJson(response);
  },
  async studioCreatePost(payload: {
    creator: string;
    title: string;
    slug?: string;
    summary?: string;
    status?: 'draft' | 'published' | 'archived';
    blocks?: Array<Record<string, unknown>>;
    media?: Array<{ mediaId: string; discoverable?: boolean; sortOrder?: number; caption?: string }>;
    primaryMediaId?: string;
    postType?: 'image' | 'video' | 'story' | 'audio';
    postFormat?: 'single' | 'multi' | 'short' | 'long';
    discoveryMode?: 'primary' | 'all' | 'selected';
    destination?: { type: 'post' | 'pdf' | 'external' | 'internal'; url: string } | null;
    metadata?: Record<string, string>;
  }) {
    const response = await fetch(`${API_BASE}/studio/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioUpdatePost(postId: string, payload: {
    title?: string;
    slug?: string;
    summary?: string;
    status?: 'draft' | 'published' | 'archived';
    blocks?: Array<Record<string, unknown>>;
    media?: Array<{ mediaId: string; discoverable?: boolean; sortOrder?: number; caption?: string }>;
    primaryMediaId?: string;
    postType?: 'image' | 'video' | 'story' | 'audio';
    postFormat?: 'single' | 'multi' | 'short' | 'long';
    discoveryMode?: 'primary' | 'all' | 'selected';
    destination?: { type: 'post' | 'pdf' | 'external' | 'internal'; url: string } | null;
    metadata?: Record<string, string>;
  }) {
    const response = await fetch(`${API_BASE}/studio/posts/${encodeURIComponent(postId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioDeletePost(postId: string) {
    const response = await fetch(`${API_BASE}/studio/posts/${encodeURIComponent(postId)}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async studioListCreatorMembers(creator: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/creators/${encodeURIComponent(creator)}/members`);
    return handleJson(response);
  },
  async studioAddCreatorMember(creator: string, payload: { userId: string; role?: 'owner' | 'editor' | 'manager' }) {
    const response = await fetch(`${API_BASE}/studio/creators/${encodeURIComponent(creator)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioRemoveCreatorMember(creator: string, userId: string) {
    const response = await fetch(`${API_BASE}/studio/creators/${encodeURIComponent(creator)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async studioUpdateCreator(creator: string, payload: {
    name?: string;
    slug?: string;
    status?: 'active' | 'inactive';
    sortOrder?: number;
    discoverSquareCropEnabled?: boolean;
    defaultAiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
    defaultHeavyTopics?: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
  }) {
    const response = await fetch(`${API_BASE}/studio/creators/${creator}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioUploadCreatorProfileImage(creator: string, payload: {
    sourceKey: string;
    altText?: string;
    squareCrop?: { x: number; y: number; size: number };
  }) {
    const response = await fetch(`${API_BASE}/studio/creators/${encodeURIComponent(creator)}/branding/profile-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioCreateCreatorBrandingUploadUrl(creator: string, payload: { kind: 'profile' | 'cover'; contentType: string }) {
    const response = await fetch(`${API_BASE}/studio/creators/${encodeURIComponent(creator)}/branding/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response) as Promise<{ key: string; uploadUrl: string; contentType: string }>;
  },
  async studioUploadCreatorCoverImage(creator: string, payload: {
    sourceKey: string;
    altText?: string;
    focalPoint?: { x: number; y: number };
    crops?: {
      desktop?: { x: number; y: number; width: number; height: number };
      tablet?: { x: number; y: number; width: number; height: number };
      mobile?: { x: number; y: number; width: number; height: number };
    };
  }) {
    const response = await fetch(`${API_BASE}/studio/creators/${encodeURIComponent(creator)}/branding/cover-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioDeleteCreatorProfileImage(creator: string) {
    const response = await fetch(`${API_BASE}/studio/creators/${encodeURIComponent(creator)}/branding/profile-image`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async studioDeleteCreatorCoverImage(creator: string) {
    const response = await fetch(`${API_BASE}/studio/creators/${encodeURIComponent(creator)}/branding/cover-image`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async updateArtist(creatorId: string, payload: {
    name?: string;
    slug?: string;
    status?: 'active' | 'inactive';
    sortOrder?: number;
    discoverSquareCropEnabled?: boolean;
    defaultAiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
    defaultHeavyTopics?: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
  }) {
    return this.studioUpdateCreator(creatorId, payload);
  },
  async studioListCreators() {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/creators`);
    return handleJson(response);
  },
  async studioMetrics() {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/metrics`);
    return handleJson(response);
  },
  async studioListFiles() {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/files`);
    return handleJson(response);
  },
  async studioCreateFile(payload: {
    creatorId: string;
    sourceKind?: 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other';
    mimeType?: string;
    storageKey?: string;
    originalFilename?: string;
    sizeBytes?: number;
  }) {
    const response = await fetch(`${API_BASE}/studio/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioListGroupings() {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/groupings`);
    return handleJson(response);
  },
  async getLatestGalleries(limit = 12) {
    return this.getLatestGroupings(limit);
  },
  async studioCreateCreator(payload: {
    name: string;
    slug: string;
    status?: 'active' | 'inactive';
    sortOrder?: number;
    discoverSquareCropEnabled?: boolean;
    defaultAiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
    defaultHeavyTopics?: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
  }) {
    const response = await fetch(`${API_BASE}/studio/creators`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioListChallenges() {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/challenges`);
    return handleJson(response);
  },
  async studioListEntries() {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/entries`);
    return handleJson(response);
  },
  async studioListUsers() {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/users`);
    return handleJson(response);
  },
  async studioCreateGrouping(payload: {
    creatorId: string;
    title: string;
    slug: string;
    visibility?: 'free' | 'preview' | 'premium';
    status?: 'draft' | 'published';
    coverImageId?: string;
    pairedPremiumGroupingId?: string;
    purchaseUrl?: string;
    premiumPassword?: string;
    discoverSquareCropEnabled?: boolean;
    defaultPreviewMaxWidth?: number;
    defaultAiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
    defaultHeavyTopics?: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
  }) {
    const response = await fetch(`${API_BASE}/studio/groupings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },

  async studioUpdateGrouping(groupingId: string, payload: {
    creatorId?: string;
    title?: string;
    slug?: string;
    visibility?: 'free' | 'preview' | 'premium';
    status?: 'draft' | 'published';
    coverImageId?: string;
    pairedPremiumGroupingId?: string;
    purchaseUrl?: string;
    premiumPassword?: string;
    discoverSquareCropEnabled?: boolean;
    defaultPreviewMaxWidth?: number;
    defaultAiDisclosure?: 'none' | 'ai-assisted' | 'ai-generated';
    defaultHeavyTopics?: Array<'politics-public-affairs' | 'crime-disasters-tragedy'>;
  }) {
    const response = await fetch(`${API_BASE}/studio/groupings/${encodeURIComponent(groupingId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioListGroupingMedia(groupingId: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/groupings/${encodeURIComponent(groupingId)}/media`);
    return handleJson(response);
  },
  async studioCreateMedia(payload: {
    groupingId: string;
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
    const response = await fetch(`${API_BASE}/studio/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },

  async studioGenerateMediaRenditions(groupingId: string, imageId: string, payload?: { squareCrop?: { x: number; y: number; size: number } }) {
    const response = await fetch(`${API_BASE}/studio/groupings/${encodeURIComponent(groupingId)}/media/${encodeURIComponent(imageId)}/renditions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload || {})
    });
    return handleJson(response);
  },
  async studioUpdateMedia(groupingId: string, imageId: string, payload: {
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
    const response = await fetch(`${API_BASE}/studio/groupings/${encodeURIComponent(groupingId)}/media/${encodeURIComponent(imageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioDeleteCreator(creator: string) {
    const response = await fetch(`${API_BASE}/studio/creators/${encodeURIComponent(creator)}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async studioDeleteGrouping(groupingId: string) {
    const response = await fetch(`${API_BASE}/studio/groupings/${encodeURIComponent(groupingId)}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async studioDeleteMedia(groupingId: string, imageId: string, sortOrder = 0) {
    const response = await fetch(`${API_BASE}/studio/groupings/${encodeURIComponent(groupingId)}/media/${encodeURIComponent(imageId)}?sortOrder=${encodeURIComponent(String(sortOrder))}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },

  async studioUpdateSiteSettings(payload: { siteName?: string; theme?: 'ubeeq' | 'sand' | 'forest' | 'slate'; logoKey?: string }) {
    const response = await fetch(`${API_BASE}/studio/settings/site`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioCreateSiteSettingsLogoUploadUrl(contentType: string) {
    const response = await fetch(`${API_BASE}/studio/settings/site/logo-upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ contentType })
    });
    return handleJson(response);
  },
  async studioSetCommentStatus(commentId: string, payload: { hidden: boolean }) {
    const response = await fetch(`${API_BASE}/studio/moderation/comments/${encodeURIComponent(commentId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioDeleteComment(commentId: string) {
    const response = await fetch(`${API_BASE}/studio/moderation/comments/${encodeURIComponent(commentId)}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async studioBlockUser(userId: string, reason?: string) {
    const response = await fetch(`${API_BASE}/studio/moderation/users/${encodeURIComponent(userId)}/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ reason })
    });
    return handleJson(response);
  },
  async studioUnblockUser(userId: string) {
    const response = await fetch(`${API_BASE}/studio/moderation/users/${encodeURIComponent(userId)}/block`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async studioGetAudit(limit = 50, cursor?: string, filters?: { action?: string; actorUserId?: string }) {
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    if (filters?.action) qs.set('action', filters.action);
    if (filters?.actorUserId) qs.set('actorUserId', filters.actorUserId);
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/operations/audit?${qs.toString()}`);
    return handleJson(response) as Promise<{ items: unknown[]; nextCursor?: string }>;
  },
  async studioRebuildTrending() {
    const response = await fetch(`${API_BASE}/studio/operations/trending/rebuild`, {
      method: 'POST',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async studioGetDeviantArtConfiguration(creatorId?: string) {
    const query = creatorId ? `?creatorId=${encodeURIComponent(creatorId)}` : '';
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/integrations/deviantart/configuration${query}`);
    return handleJson(response) as Promise<{
      platform: 'deviantart';
      configured: boolean;
      callbackUrl?: string;
      requiredConfiguration: string[];
      credential: null | { externalPlatformCredentialId: string; applicationLabel?: string; clientId: string; redirectUri: string; updatedAt: string };
      credentials?: Array<{ externalPlatformCredentialId: string; applicationLabel?: string; clientId: string; redirectUri: string; updatedAt: string }>;
    }>;
  },
  async studioSaveDeviantArtCredentials(payload: { creatorId?: string; externalPlatformCredentialId?: string; createNew?: boolean; applicationLabel?: string; clientId: string; clientSecret?: string }) {
    const response = await fetch(`${API_BASE}/studio/integrations/deviantart/credentials`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response) as Promise<{ externalPlatformCredentialId: string; applicationLabel?: string; clientId: string; redirectUri: string; updatedAt: string }>;
  },
  async studioDeleteDeviantArtCredentials(externalPlatformCredentialId: string) {
    const response = await fetch(`${API_BASE}/studio/integrations/deviantart/credentials/${encodeURIComponent(externalPlatformCredentialId)}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async studioStartDeviantArtConnection(creatorId?: string, returnPath = '/studio/workspace?section=integrations', syncContentOnInitialImport = false, externalPlatformCredentialId?: string) {
    const response = await fetch(`${API_BASE}/studio/integrations/deviantart/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ ...(creatorId ? { creatorId } : {}), returnPath, syncContentOnInitialImport, ...(externalPlatformCredentialId ? { externalPlatformCredentialId } : {}) })
    });
    return handleJson(response) as Promise<{ authorizationUrl: string }>;
  },
  async studioListDeviantArtAccounts(creatorId?: string) {
    const query = creatorId ? `?creatorId=${encodeURIComponent(creatorId)}` : '';
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/integrations/deviantart/accounts${query}`);
    return handleJson(response);
  },

  async studioGetDeviantArtProfileHistory(externalAccountId: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/integrations/deviantart/accounts/${encodeURIComponent(externalAccountId)}/profile`);
    return handleJson(response);
  },
  async studioRemoveDeviantArtAccount(externalAccountId: string) {
    const response = await fetch(`${API_BASE}/studio/integrations/deviantart/accounts/${encodeURIComponent(externalAccountId)}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    if (!response.ok) return handleJson(response);
  },
  async studioAssignDeviantArtAccountCreators(externalAccountId: string, payload: { creatorIdentityIds: string[]; primaryCreatorIdentityId?: string }) {
    const response = await fetch(`${API_BASE}/studio/integrations/deviantart/accounts/${encodeURIComponent(externalAccountId)}/creators`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioSyncDeviantArtAccount(externalAccountId: string, syncContent = false) {
    const response = await fetch(`${API_BASE}/studio/integrations/deviantart/accounts/${encodeURIComponent(externalAccountId)}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ syncContent })
    });
    return handleJson(response);
  },
  async studioListDeviantArtSyncJobs(externalAccountId: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/integrations/deviantart/accounts/${encodeURIComponent(externalAccountId)}/jobs`);
    return handleJson(response);
  },
  async studioListDeviantArtComments(externalAccountId: string, externalContentId: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/integrations/deviantart/accounts/${encodeURIComponent(externalAccountId)}/publications/${encodeURIComponent(externalContentId)}/comments`);
    return handleJson(response);
  },
  async studioSyncDeviantArtComments(externalAccountId: string, externalContentId: string) {
    const response = await fetch(`${API_BASE}/studio/integrations/deviantart/accounts/${encodeURIComponent(externalAccountId)}/publications/${encodeURIComponent(externalContentId)}/comments/sync`, {
      method: 'POST', headers: await authHeaders()
    });
    return handleJson(response);
  },
  async studioReplyToDeviantArtComment(externalAccountId: string, externalContentId: string, externalCommentId: string, body: string) {
    const response = await fetch(`${API_BASE}/studio/integrations/deviantart/accounts/${encodeURIComponent(externalAccountId)}/publications/${encodeURIComponent(externalContentId)}/comments/${encodeURIComponent(externalCommentId)}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ body })
    });
    return handleJson(response);
  },
  async studioGetWorkActivity(assetId: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/integrations/activity/works/${encodeURIComponent(assetId)}`);
    return handleJson(response);
  },
  async studioSyncWorkActivity(assetId: string) {
    const response = await fetch(`${API_BASE}/studio/integrations/activity/works/${encodeURIComponent(assetId)}/sync`, {
      method: 'POST', headers: await authHeaders()
    });
    return handleJson(response);
  },
  async studioListActivity(creatorId: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/integrations/activity?creatorId=${encodeURIComponent(creatorId)}`);
    return handleJson(response);
  },
  async studioSyncActivity(creatorId: string) {
    const response = await fetch(`${API_BASE}/studio/integrations/activity/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ creatorId })
    });
    return handleJson(response);
  },
  async studioSetActivityRead(externalAccountId: string, remoteActivityId: string, read = true) {
    const response = await fetch(`${API_BASE}/studio/integrations/activity/accounts/${encodeURIComponent(externalAccountId)}/${encodeURIComponent(remoteActivityId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify({ read })
    });
    return handleJson(response);
  },
  async studioListDeviantArtCatalogue(creatorId: string, query = '') {
    const params = new URLSearchParams({ creatorId });
    if (query.trim()) params.set('query', query.trim());
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/integrations/deviantart/catalogue?${params.toString()}`);
    return handleJson(response);
  },
  async studioCreateWork(payload: { creatorId: string; originalFilename: string; title?: string; description?: string }) {
    const response = await fetch(`${API_BASE}/studio/works`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response) as Promise<{ asset: { assetId: string } }>;
  },
  async studioUploadWorkImage(assetId: string, file: File) {
    const params = new URLSearchParams({ originalFilename: file.name });
    const response = await fetch(`${API_BASE}/studio/works/${encodeURIComponent(assetId)}/image?${params.toString()}`, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'image/jpeg', ...(await authHeaders()) },
      body: file
    });
    return handleJson(response);
  },
  async studioAddDeviantArtWorkDestination(assetId: string, externalAccountId: string, targetStatus: 'draft' | 'published' = 'published') {
    const response = await fetch(`${API_BASE}/studio/works/${encodeURIComponent(assetId)}/destinations/deviantart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ externalAccountId, targetStatus })
    });
    return handleJson(response);
  },
  async studioRemoveDeviantArtWorkDestination(assetId: string, externalAccountId: string) {
    const response = await fetch(`${API_BASE}/studio/works/${encodeURIComponent(assetId)}/destinations/deviantart/${encodeURIComponent(externalAccountId)}`, {
      method: 'DELETE',
      headers: await authHeaders()
    });
    return handleJson(response);
  },
  async studioSyncDeviantArtWorkDestination(assetId: string, externalAccountId: string) {
    const response = await fetch(`${API_BASE}/studio/works/${encodeURIComponent(assetId)}/destinations/deviantart/${encodeURIComponent(externalAccountId)}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({})
    });
    return handleJson(response);
  },
  async studioUpdateExternalAsset(assetId: string, payload: {
    canonicalTitle?: string;
    canonicalDescription?: string;
    visibility?: 'private' | 'unlisted' | 'public';
    titleSyncPolicy?: 'mirrored' | 'independent' | 'initially_mirrored' | 'manual';
    descriptionSyncPolicy?: 'mirrored' | 'independent' | 'initially_mirrored' | 'manual';
    integrationMetadata?: {
      externalPublicationId?: string;
      title?: string;
      description?: string;
      tags?: string[];
      allowComments?: boolean;
      isMature?: boolean;
      matureLevel?: 'strict' | 'moderate';
      matureClassification?: Array<'nudity' | 'sexual' | 'gore' | 'language' | 'ideology'>;
      isAiGenerated?: boolean;
      noAi?: boolean;
    };
  }) {
    const response = await fetch(`${API_BASE}/studio/integrations/assets/${encodeURIComponent(assetId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioUpdateSpacePublication(assetId: string, payload: {
    published: boolean;
    hostingMode?: 'linked' | 'hosted';
    visibility?: 'private' | 'unlisted' | 'public';
  }) {
    const response = await fetch(`${API_BASE}/studio/integrations/assets/${encodeURIComponent(assetId)}/space-publication`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioListDeviantArtCollections(creatorId: string) {
    const response = await fetchAuthGetWithRetry(`${API_BASE}/studio/integrations/deviantart/collections?creatorId=${encodeURIComponent(creatorId)}`);
    return handleJson(response);
  },
  async studioCreateIntegrationCollection(payload: {
    creatorIdentityId: string;
    name: string;
    parentUbeeqCollectionId?: string;
    visibility?: 'private' | 'unlisted' | 'public';
    collectionType?: 'collection' | 'gallery' | 'series';
  }) {
    const response = await fetch(`${API_BASE}/studio/integrations/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioUpdateIntegrationCollection(collectionId: string, payload: {
    creatorIdentityId: string;
    visibility?: 'private' | 'unlisted' | 'public';
    collectionType?: 'collection' | 'gallery' | 'series';
  }) {
    const response = await fetch(`${API_BASE}/studio/integrations/collections/${encodeURIComponent(collectionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioReplaceIntegrationCollectionAssets(collectionId: string, payload: { creatorIdentityId: string; assetIds: string[] }) {
    const response = await fetch(`${API_BASE}/studio/integrations/collections/${encodeURIComponent(collectionId)}/assets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async studioSaveDeviantArtCollectionMapping(externalCollectionId: string, payload: {
    externalAccountId: string;
    ubeeqCollectionId: string;
    syncMode: 'continuous' | 'initial_only' | 'manual' | 'ignored';
  }) {
    const response = await fetch(`${API_BASE}/studio/integrations/deviantart/collection-mappings/${encodeURIComponent(externalCollectionId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(payload)
    });
    return handleJson(response);
  },
  async followArtist(creatorId: string, notificationsEnabled = false) {
    return this.followCreator(creatorId, notificationsEnabled);
  },
  async unfollowArtist(creatorId: string) {
    return this.unfollowCreator(creatorId);
  },
  async getGallery(slug: string, groupingAccessToken?: string) {
    return this.getGrouping(slug, groupingAccessToken);
  },
  async unlockGallery(slug: string, password: string) {
    return this.unlockGrouping(slug, password);
  },
  async getGalleryComments(slug: string) {
    return this.getGroupingComments(slug);
  },
  async postGalleryCommentAsProfile(
    slug: string,
    body: string,
    profile: { authorProfileType: 'user' | 'creator' | 'artist'; authorProfileId?: string }
  ) {
    return this.postGroupingCommentAsProfile(slug, body, {
      ...profile,
      authorProfileType: profile.authorProfileType === 'artist' ? 'creator' : profile.authorProfileType
    });
  },
  async adminListCreators() {
    return this.studioListCreators();
  },
  async adminListPosts() {
    return this.studioListPosts();
  },
  async adminListGalleries() {
    return this.studioListGroupings();
  },
  async adminListFiles() {
    return this.studioListFiles();
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
    return this.studioCreateCreator(payload);
  },
  async adminCreateFile(payload: {
    creatorId: string;
    sourceKind?: 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other';
    mimeType?: string;
    storageKey?: string;
    originalFilename?: string;
    sizeBytes?: number;
  }) {
    return this.studioCreateFile(payload);
  },
};
