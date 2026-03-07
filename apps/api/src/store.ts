import type { Artist, Gallery, Image, Comment, Favorite, BlockedUser } from './domain';

export interface GalleryDetails {
  gallery: Gallery;
  images: Image[];
}

export interface DataStore {
  listArtists(): Promise<Artist[]>;
  listAllGalleries(): Promise<Gallery[]>;
  listGalleriesByArtistSlug(artistSlug: string): Promise<Gallery[]>;
  getGalleryBySlug(slug: string): Promise<Gallery | null>;
  getImagesByGallery(galleryId: string): Promise<Image[]>;

  createArtist(artist: Artist): Promise<void>;
  createGallery(gallery: Gallery): Promise<void>;
  createImage(image: Image): Promise<void>;
  updateArtist(artist: Artist): Promise<void>;
  updateGallery(gallery: Gallery): Promise<void>;
  updateImage(image: Image, oldSortOrder?: number): Promise<void>;
  deleteArtist(artistId: string): Promise<void>;
  deleteGallery(galleryId: string): Promise<void>;
  deleteImage(galleryId: string, imageId: string, sortOrder?: number): Promise<void>;

  listComments(targetType: 'gallery' | 'image', targetId: string): Promise<Comment[]>;
  createComment(comment: Comment): Promise<void>;
  updateCommentVisibility(commentId: string, hidden: boolean): Promise<void>;
  deleteComment(commentId: string): Promise<void>;

  addFavorite(favorite: Favorite): Promise<void>;
  removeFavorite(userId: string, targetType: 'gallery' | 'image', targetId: string): Promise<void>;
  listFavoritesByUser(userId: string): Promise<Favorite[]>;
  countFavorites(targetType: 'gallery' | 'image', targetId: string): Promise<number>;

  blockUser(blockedUser: BlockedUser): Promise<void>;
  unblockUser(userId: string): Promise<void>;
  isUserBlocked(userId: string): Promise<boolean>;
}
