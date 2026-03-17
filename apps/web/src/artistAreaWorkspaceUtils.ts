export type ArtistAreaPanel = 'overview' | 'artists' | 'galleries' | 'media' | 'operations';

export type StoredWorkspace = {
  activePanel?: ArtistAreaPanel;
  dangerMode?: boolean;
  galleryArtistFilter?: string;
  mediaTypeFilter?: 'all' | 'image' | 'video';
  mediaGalleryId?: string;
};

export const STORAGE_KEY = 'artistArea.workspace.v1';

export const slugify = (value: string) => value
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9\s-]/g, '')
  .replace(/\s+/g, '-')
  .replace(/-+/g, '-');

export const uniqueSlug = (base: string, taken: Set<string>) => {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
};

export const readStoredWorkspace = (): StoredWorkspace => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as StoredWorkspace;
  } catch {
    return {};
  }
};

export const writeStoredWorkspace = (payload: StoredWorkspace) => {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
};

export const clearStoredWorkspace = () => {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
};
