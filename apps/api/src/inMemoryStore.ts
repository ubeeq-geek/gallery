import type { Artist, Gallery, Image, Comment, Favorite, BlockedUser } from './domain';
import type { DataStore } from './store';

export class InMemoryStore implements DataStore {
  artists: Artist[] = [];
  galleries: Gallery[] = [];
  images: Image[] = [];
  comments: Comment[] = [];
  favorites: Favorite[] = [];
  blockedUsers: BlockedUser[] = [];

  async listArtists(): Promise<Artist[]> { return this.artists; }
  async listAllGalleries(): Promise<Gallery[]> { return this.galleries; }

  async listGalleriesByArtistSlug(artistSlug: string): Promise<Gallery[]> {
    return this.galleries.filter((g) => g.artistSlug === artistSlug && g.status === 'published');
  }

  async getGalleryBySlug(slug: string): Promise<Gallery | null> {
    return this.galleries.find((g) => g.slug === slug) || null;
  }

  async getImagesByGallery(galleryId: string): Promise<Image[]> {
    return this.images.filter((i) => i.galleryId === galleryId);
  }

  async createArtist(artist: Artist): Promise<void> { this.artists.push(artist); }
  async createGallery(gallery: Gallery): Promise<void> { this.galleries.push(gallery); }
  async createImage(image: Image): Promise<void> { this.images.push(image); }
  async updateArtist(artist: Artist): Promise<void> {
    this.artists = this.artists.map((item) => (item.artistId === artist.artistId ? artist : item));
  }
  async updateGallery(gallery: Gallery): Promise<void> {
    this.galleries = this.galleries.map((item) => (item.galleryId === gallery.galleryId ? gallery : item));
  }
  async updateImage(image: Image): Promise<void> {
    this.images = this.images.map((item) => (
      item.galleryId === image.galleryId && item.imageId === image.imageId ? image : item
    ));
  }
  async deleteArtist(artistId: string): Promise<void> { this.artists = this.artists.filter((a) => a.artistId !== artistId); }
  async deleteGallery(galleryId: string): Promise<void> {
    this.galleries = this.galleries.filter((g) => g.galleryId !== galleryId);
    this.images = this.images.filter((i) => i.galleryId !== galleryId);
  }
  async deleteImage(galleryId: string, imageId: string): Promise<void> {
    this.images = this.images.filter((i) => !(i.galleryId === galleryId && i.imageId === imageId));
  }

  async listComments(targetType: 'gallery' | 'image', targetId: string): Promise<Comment[]> {
    return this.comments.filter((c) => c.targetType === targetType && c.targetId === targetId && !c.hidden);
  }

  async createComment(comment: Comment): Promise<void> { this.comments.push(comment); }

  async updateCommentVisibility(commentId: string, hidden: boolean): Promise<void> {
    const comment = this.comments.find((c) => c.commentId === commentId);
    if (comment) comment.hidden = hidden;
  }

  async deleteComment(commentId: string): Promise<void> {
    this.comments = this.comments.filter((c) => c.commentId !== commentId);
  }

  async addFavorite(favorite: Favorite): Promise<void> {
    this.favorites = this.favorites.filter((f) => !(f.userId === favorite.userId && f.targetId === favorite.targetId && f.targetType === favorite.targetType));
    this.favorites.push(favorite);
  }

  async removeFavorite(userId: string, targetType: 'gallery' | 'image', targetId: string): Promise<void> {
    this.favorites = this.favorites.filter((f) => !(f.userId === userId && f.targetType === targetType && f.targetId === targetId));
  }

  async listFavoritesByUser(userId: string): Promise<Favorite[]> {
    return this.favorites.filter((f) => f.userId === userId);
  }

  async countFavorites(targetType: 'gallery' | 'image', targetId: string): Promise<number> {
    return this.favorites.filter((f) => f.targetType === targetType && f.targetId === targetId).length;
  }

  async blockUser(blockedUser: BlockedUser): Promise<void> {
    this.blockedUsers = this.blockedUsers.filter((u) => u.userId !== blockedUser.userId);
    this.blockedUsers.push(blockedUser);
  }

  async unblockUser(userId: string): Promise<void> {
    this.blockedUsers = this.blockedUsers.filter((u) => u.userId !== userId);
  }

  async isUserBlocked(userId: string): Promise<boolean> {
    return this.blockedUsers.some((u) => u.userId === userId);
  }
}
