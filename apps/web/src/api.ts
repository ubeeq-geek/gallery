const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

const authHeaders = (): Record<string, string> => {
  const idToken = localStorage.getItem('idToken');
  return idToken ? { Authorization: `Bearer ${idToken}` } : {};
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
  async getArtists() {
    const response = await fetch(`${API_BASE}/artists`);
    return handleJson(response);
  },
  async getGalleriesByArtist(artistSlug: string) {
    const response = await fetch(`${API_BASE}/artists/${artistSlug}/galleries`);
    return handleJson(response);
  },
  async getGallery(slug: string) {
    const response = await fetch(`${API_BASE}/galleries/${slug}`);
    return handleJson(response);
  },
  async unlockGallery(slug: string, password: string) {
    const response = await fetch(`${API_BASE}/galleries/${slug}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ password })
    });
    return handleJson(response);
  },
  async getPremiumImages(slug: string, unlockToken: string) {
    const response = await fetch(`${API_BASE}/galleries/${slug}/premium-images`, {
      headers: { 'x-unlock-token': unlockToken, ...authHeaders() }
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
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ body })
    });
    return handleJson(response);
  },
  async getImageComments(imageId: string) {
    const response = await fetch(`${API_BASE}/images/${imageId}/comments`);
    return handleJson(response);
  },
  async postImageComment(imageId: string, body: string) {
    const response = await fetch(`${API_BASE}/images/${imageId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ body })
    });
    return handleJson(response);
  },
  async favorite(targetType: 'gallery' | 'image', targetId: string) {
    const response = await fetch(`${API_BASE}/favorites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ targetType, targetId })
    });
    return handleJson(response);
  },
  async unfavorite(targetType: 'gallery' | 'image', targetId: string) {
    const response = await fetch(`${API_BASE}/favorites`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ targetType, targetId })
    });
    return handleJson(response);
  },
  async myFavorites() {
    const response = await fetch(`${API_BASE}/me/favorites`, { headers: authHeaders() });
    return handleJson(response);
  }
};
