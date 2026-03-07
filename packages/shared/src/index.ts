export type Visibility = 'free' | 'premium';
export type CommentTargetType = 'gallery' | 'image';

export interface Artist {
  artistId: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive';
  sortOrder: number;
  createdAt: string;
}

export interface Gallery {
  galleryId: string;
  artistId: string;
  artistSlug?: string;
  title: string;
  slug: string;
  visibility: Visibility;
  status: 'draft' | 'published';
  premiumPasswordHash?: string;
  coverImageId?: string;
  createdAt: string;
}

export interface Image {
  imageId: string;
  galleryId: string;
  assetType?: 'image' | 'video';
  previewKey: string;
  premiumKey?: string;
  previewPosterKey?: string;
  premiumPosterKey?: string;
  width: number;
  height: number;
  durationSeconds?: number;
  sortOrder: number;
  altText?: string;
  createdAt: string;
}

export interface Comment {
  commentId: string;
  userId: string;
  displayName: string;
  targetType: CommentTargetType;
  targetId: string;
  body: string;
  hidden: boolean;
  createdAt: string;
}

export interface Favorite {
  userId: string;
  targetType: 'gallery' | 'image';
  targetId: string;
  createdAt: string;
}

export interface BlockedUser {
  userId: string;
  reason?: string;
  blockedAt: string;
}

export interface UnlockSession {
  galleryId: string;
  userId?: string;
  expiresAt: string;
}

export const isPremiumGallery = (gallery: Gallery): boolean => gallery.visibility === 'premium';

export const assertNonEmpty = (value: string, fieldName: string): string => {
  if (!value || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
};
