import { randomUUID } from 'crypto';
import type {
  Artist,
  ArtistMember,
  Gallery,
  Media,
  GalleryMedia,
  GalleryMediaView,
  Comment,
  Favorite,
  BlockedUser,
  SiteSettings,
  UserProfile,
  Collection,
  Follow,
  CollectionImage,
  IdempotencyRecord,
  AuditEvent,
  TrendingFeedItem,
  TrendingPeriod
} from './domain';
import type { DataStore } from './store';

export class InMemoryStore implements DataStore {
  siteSettings: SiteSettings = {
    settingId: 'SITE',
    siteName: 'Ubeeq',
    theme: 'ubeeq',
    updatedAt: new Date().toISOString()
  };
  artists: Artist[] = [];
  galleries: Gallery[] = [];
  media: Media[] = [];
  galleryMedia: GalleryMedia[] = [];
  comments: Comment[] = [];
  favorites: Favorite[] = [];
  blockedUsers: BlockedUser[] = [];
  galleryAccess: Array<{ userId: string; galleryId: string }> = [];
  artistMembers: ArtistMember[] = [];
  usernames: Array<{ normalized: string; username: string; email: string }> = [];
  userProfiles: UserProfile[] = [];
  collections: Collection[] = [];
  collectionImages: CollectionImage[] = [];
  follows: Follow[] = [];
  idempotency: IdempotencyRecord[] = [];
  auditEvents: AuditEvent[] = [];
  imageFavoriteCounts = new Map<string, number>();
  trendingFeed = new Map<TrendingPeriod, TrendingFeedItem[]>([
    ['hourly', []],
    ['daily', []]
  ]);

  async getSiteSettings(): Promise<SiteSettings> { return this.siteSettings; }
  async updateSiteSettings(settings: SiteSettings): Promise<void> { this.siteSettings = settings; }

  async listArtists(): Promise<Artist[]> { return this.artists; }
  async listAllGalleries(): Promise<Gallery[]> { return this.galleries; }

  async listGalleriesByArtistSlug(artistSlug: string): Promise<Gallery[]> {
    return this.galleries.filter((g) => g.artistSlug === artistSlug && g.status === 'published');
  }

  async getGalleryBySlug(slug: string): Promise<Gallery | null> {
    return this.galleries.find((g) => (g.slugHistory || [g.slug]).includes(slug)) || null;
  }

  async getMediaByGallery(galleryId: string): Promise<GalleryMediaView[]> {
    return this.galleryMedia
      .filter((item) => item.galleryId === galleryId)
      .sort((a, b) => a.position - b.position)
      .map((placement) => {
        const media = this.media.find((item) => item.mediaId === placement.mediaId);
        if (!media) return null;
        return {
          ...media,
          galleryId,
          galleryMediaId: placement.galleryMediaId,
          position: placement.position
        };
      })
      .filter((item): item is GalleryMediaView => Boolean(item));
  }

  async createArtist(artist: Artist): Promise<void> { this.artists.push(artist); }
  async createGallery(gallery: Gallery): Promise<void> { this.galleries.push(gallery); }

  async createMedia(media: Media, galleryId: string, position: number): Promise<void> {
    this.media = this.media.filter((item) => item.mediaId !== media.mediaId);
    this.media.push(media);
    this.galleryMedia.push({
      galleryMediaId: randomUUID(),
      galleryId,
      mediaId: media.mediaId,
      position,
      createdAt: new Date().toISOString()
    });
  }

  async updateArtist(artist: Artist): Promise<void> {
    this.artists = this.artists.map((item) => (item.artistId === artist.artistId ? artist : item));
  }

  async updateGallery(gallery: Gallery): Promise<void> {
    this.galleries = this.galleries.map((item) => (item.galleryId === gallery.galleryId ? gallery : item));
  }

  async updateMedia(media: Media): Promise<void> {
    this.media = this.media.map((item) => (item.mediaId === media.mediaId ? media : item));
  }

  async moveMediaInGallery(galleryId: string, mediaId: string, position: number): Promise<void> {
    this.galleryMedia = this.galleryMedia.map((item) => (
      item.galleryId === galleryId && item.mediaId === mediaId
        ? { ...item, position }
        : item
    ));
  }

  async deleteArtist(artistId: string): Promise<void> { this.artists = this.artists.filter((a) => a.artistId !== artistId); }

  async deleteGallery(galleryId: string): Promise<void> {
    this.galleries = this.galleries.filter((g) => g.galleryId !== galleryId);
    const removedMediaIds = new Set(this.galleryMedia.filter((item) => item.galleryId === galleryId).map((item) => item.mediaId));
    this.galleryMedia = this.galleryMedia.filter((item) => item.galleryId !== galleryId);
    this.media = this.media.filter((item) => !removedMediaIds.has(item.mediaId) || this.galleryMedia.some((p) => p.mediaId === item.mediaId));
  }

  async deleteMediaFromGallery(galleryId: string, mediaId: string): Promise<void> {
    this.galleryMedia = this.galleryMedia.filter((item) => !(item.galleryId === galleryId && item.mediaId === mediaId));
    if (!this.galleryMedia.some((item) => item.mediaId === mediaId)) {
      this.media = this.media.filter((item) => item.mediaId !== mediaId);
    }
  }

  async addArtistMember(member: ArtistMember): Promise<void> {
    this.artistMembers = this.artistMembers.filter((item) => !(item.artistId === member.artistId && item.userId === member.userId));
    this.artistMembers.push(member);
  }

  async removeArtistMember(artistId: string, userId: string): Promise<void> {
    this.artistMembers = this.artistMembers.filter((item) => !(item.artistId === artistId && item.userId === userId));
  }

  async listArtistMembers(artistId: string): Promise<ArtistMember[]> {
    return this.artistMembers.filter((item) => item.artistId === artistId);
  }

  async listArtistsByUserId(userId: string): Promise<Artist[]> {
    const ids = new Set(this.artistMembers.filter((item) => item.userId === userId).map((item) => item.artistId));
    return this.artists.filter((artist) => ids.has(artist.artistId));
  }

  async hasArtistAccess(userId: string, artistId: string): Promise<boolean> {
    return this.artistMembers.some((item) => item.userId === userId && item.artistId === artistId);
  }

  async listPublicCollections(limit = 24, cursor?: string): Promise<{ items: Collection[]; nextCursor?: string }> {
    const sorted = this.collections
      .filter((item) => item.visibility === 'public')
      .sort((a, b) => b.insertedDate.localeCompare(a.insertedDate));
    const start = cursor ? Number(cursor) || 0 : 0;
    const items = sorted.slice(start, start + limit);
    const nextCursor = start + items.length < sorted.length ? String(start + items.length) : undefined;
    return { items, nextCursor };
  }

  async listPublicCollectionsByProfile(profileType: 'user' | 'artist', profileId: string, limit = 24): Promise<Collection[]> {
    const ownerType = profileType;
    return this.collections
      .filter((item) => item.visibility === 'public')
      .filter((item) => {
        const itemType = item.ownerProfileType || 'user';
        const itemProfileId = item.ownerProfileId || item.ownerUserId;
        return itemType === ownerType && itemProfileId === profileId;
      })
      .sort((a, b) => b.updatedDate.localeCompare(a.updatedDate))
      .slice(0, limit);
  }

  async listCollectionsByOwner(ownerUserId: string): Promise<Collection[]> {
    return this.collections
      .filter((item) => item.ownerUserId === ownerUserId)
      .sort((a, b) => b.updatedDate.localeCompare(a.updatedDate));
  }

  async listCollectionsByProfile(profileType: 'user' | 'artist', profileId: string): Promise<Collection[]> {
    return this.collections
      .filter((item) => {
        const itemType = item.ownerProfileType || 'user';
        const itemId = item.ownerProfileId || item.ownerUserId;
        return itemType === profileType && itemId === profileId;
      })
      .sort((a, b) => b.updatedDate.localeCompare(a.updatedDate));
  }

  async getCollectionById(collectionId: string): Promise<Collection | null> {
    return this.collections.find((item) => item.collectionId === collectionId) || null;
  }

  async createCollection(collection: Collection): Promise<void> {
    this.collections = this.collections.filter((item) => item.collectionId !== collection.collectionId);
    this.collections.push(collection);
  }

  async updateCollection(collection: Collection): Promise<void> {
    this.collections = this.collections.map((item) => (item.collectionId === collection.collectionId ? collection : item));
  }

  async deleteCollection(collectionId: string): Promise<void> {
    this.collections = this.collections.filter((item) => item.collectionId !== collectionId);
    this.collectionImages = this.collectionImages.filter((item) => item.collectionId !== collectionId);
  }

  async addImageToCollection(collectionId: string, imageId: string, sortOrder: number): Promise<void> {
    this.collectionImages = this.collectionImages.filter((item) => !(item.collectionId === collectionId && item.imageId === imageId));
    this.collectionImages.push({
      collectionImageId: randomUUID(),
      collectionId,
      imageId,
      sortOrder,
      insertedDate: new Date().toISOString()
    });
  }

  async removeImageFromCollection(collectionId: string, imageId: string): Promise<void> {
    this.collectionImages = this.collectionImages.filter((item) => !(item.collectionId === collectionId && item.imageId === imageId));
  }

  async listCollectionImageIds(collectionId: string): Promise<string[]> {
    return this.collectionImages
      .filter((item) => item.collectionId === collectionId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item) => item.imageId);
  }

  async followArtist(follow: Follow): Promise<void> {
    this.follows = this.follows.filter((item) => !(item.followerUserId === follow.followerUserId && item.artistId === follow.artistId));
    this.follows.push(follow);
  }

  async unfollowArtist(followerUserId: string, artistId: string): Promise<void> {
    this.follows = this.follows.filter((item) => !(item.followerUserId === followerUserId && item.artistId === artistId));
  }

  async listFollowsByUser(followerUserId: string): Promise<Follow[]> {
    return this.follows.filter((item) => item.followerUserId === followerUserId);
  }

  async isFollowingArtist(followerUserId: string, artistId: string): Promise<boolean> {
    return this.follows.some((item) => item.followerUserId === followerUserId && item.artistId === artistId);
  }

  async countFollowersByArtist(artistId: string): Promise<number> {
    return this.follows.filter((item) => item.artistId === artistId).length;
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
    const existed = this.favorites.some((f) => (
      f.userId === favorite.userId &&
      f.targetId === favorite.targetId &&
      f.targetType === favorite.targetType &&
      (f.ownerProfileType || 'user') === (favorite.ownerProfileType || 'user') &&
      (f.ownerProfileId || f.userId) === (favorite.ownerProfileId || favorite.userId)
    ));
    this.favorites = this.favorites.filter((f) => !(f.userId === favorite.userId && f.targetId === favorite.targetId && f.targetType === favorite.targetType));
    this.favorites.push(favorite);
    if (!existed && favorite.targetType === 'image') {
      this.imageFavoriteCounts.set(favorite.targetId, Math.max(0, (this.imageFavoriteCounts.get(favorite.targetId) || 0) + 1));
    }
  }

  async removeFavorite(
    userId: string,
    targetType: 'gallery' | 'image' | 'collection',
    targetId: string,
    ownerProfileType: 'user' | 'artist' = 'user',
    ownerProfileId?: string
  ): Promise<void> {
    const resolvedProfileId = ownerProfileId || userId;
    const existed = this.favorites.some((f) => {
      const itemProfileType = f.ownerProfileType || 'user';
      const itemProfileId = f.ownerProfileId || f.userId;
      return (
        f.userId === userId &&
        itemProfileType === ownerProfileType &&
        itemProfileId === resolvedProfileId &&
        f.targetType === targetType &&
        f.targetId === targetId
      );
    });
    this.favorites = this.favorites.filter((f) => {
      const itemProfileType = f.ownerProfileType || 'user';
      const itemProfileId = f.ownerProfileId || f.userId;
      return !(
        f.userId === userId &&
        itemProfileType === ownerProfileType &&
        itemProfileId === resolvedProfileId &&
        f.targetType === targetType &&
        f.targetId === targetId
      );
    });
    if (existed && targetType === 'image') {
      this.imageFavoriteCounts.set(targetId, Math.max(0, (this.imageFavoriteCounts.get(targetId) || 0) - 1));
    }
  }

  async listFavoritesByUser(userId: string): Promise<Favorite[]> {
    return this.favorites
      .filter((f) => f.userId === userId)
      .filter((f) => (f.ownerProfileType || 'user') === 'user' && (f.ownerProfileId || f.userId) === userId);
  }

  async listFavoritesByProfile(profileType: 'user' | 'artist', profileId: string): Promise<Favorite[]> {
    return this.favorites.filter((f) => {
      const ownerType = f.ownerProfileType || 'user';
      const ownerId = f.ownerProfileId || f.userId;
      return ownerType === profileType && ownerId === profileId;
    });
  }

  async listPublicFavoritesByProfile(profileType: 'user' | 'artist', profileId: string): Promise<Favorite[]> {
    return this.favorites.filter((f) => {
      const ownerType = f.ownerProfileType || 'user';
      const ownerId = f.ownerProfileId || f.userId;
      return ownerType === profileType && ownerId === profileId && (f.visibility || 'public') === 'public';
    });
  }

  async countFavorites(targetType: 'gallery' | 'image' | 'collection', targetId: string): Promise<number> {
    return this.favorites.filter((f) => f.targetType === targetType && f.targetId === targetId).length;
  }

  async getImageFavoriteCounts(imageIds: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    imageIds.forEach((imageId) => {
      out[imageId] = Math.max(0, this.imageFavoriteCounts.get(imageId) || 0);
    });
    return out;
  }

  async incrementImageFavoriteCount(imageId: string, delta: number): Promise<void> {
    this.imageFavoriteCounts.set(imageId, Math.max(0, (this.imageFavoriteCounts.get(imageId) || 0) + delta));
  }

  async listTrendingFeed(period: TrendingPeriod, limit = 24, cursor?: string): Promise<{ items: TrendingFeedItem[]; nextCursor?: string }> {
    const items = this.trendingFeed.get(period) || [];
    const offset = cursor ? Number(cursor) || 0 : 0;
    const page = items.slice(offset, offset + limit);
    const nextCursor = offset + page.length < items.length ? String(offset + page.length) : undefined;
    return { items: page, nextCursor };
  }

  async replaceTrendingFeed(period: TrendingPeriod, items: TrendingFeedItem[]): Promise<void> {
    this.trendingFeed.set(
      period,
      [...items]
        .sort((a, b) => a.rank - b.rank)
        .map((item, index) => ({ ...item, rank: index + 1 }))
    );
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

  async grantGalleryAccess(userId: string, galleryId: string): Promise<void> {
    if (!this.galleryAccess.some((item) => item.userId === userId && item.galleryId === galleryId)) {
      this.galleryAccess.push({ userId, galleryId });
    }
  }

  async hasGalleryAccess(userId: string, galleryId: string): Promise<boolean> {
    return this.galleryAccess.some((item) => item.userId === userId && item.galleryId === galleryId);
  }

  async isUsernameAvailable(normalizedUsername: string): Promise<boolean> {
    return !this.usernames.some((item) => item.normalized === normalizedUsername);
  }

  async reserveUsername(normalizedUsername: string, username: string, email: string): Promise<void> {
    const exists = this.usernames.some((item) => item.normalized === normalizedUsername);
    if (exists) {
      throw new Error('USERNAME_TAKEN');
    }
    this.usernames.push({ normalized: normalizedUsername, username, email });
  }

  async releaseUsername(normalizedUsername: string): Promise<void> {
    this.usernames = this.usernames.filter((item) => item.normalized !== normalizedUsername);
  }

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    return this.userProfiles.find((item) => item.userId === userId) || null;
  }

  async getUserProfileBySlug(slug: string): Promise<UserProfile | null> {
    const normalized = slug.trim().toLowerCase();
    return this.userProfiles.find((item) => item.username === normalized || (item.usernameHistory || []).includes(normalized)) || null;
  }

  async upsertUserProfile(profile: UserProfile): Promise<void> {
    this.userProfiles = this.userProfiles.filter((item) => item.userId !== profile.userId);
    this.userProfiles.push(profile);
  }

  async getIdempotencyRecord(scopeKey: string, idempotencyKey: string): Promise<IdempotencyRecord | null> {
    const found = this.idempotency.find((item) => item.scopeKey === scopeKey && item.idempotencyKey === idempotencyKey);
    if (!found) return null;
    if (Date.parse(found.expiresAt) <= Date.now()) {
      this.idempotency = this.idempotency.filter((item) => !(item.scopeKey === scopeKey && item.idempotencyKey === idempotencyKey));
      return null;
    }
    return found;
  }

  async putIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    this.idempotency = this.idempotency.filter((item) => !(item.scopeKey === record.scopeKey && item.idempotencyKey === record.idempotencyKey));
    this.idempotency.push(record);
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    this.auditEvents.push(event);
  }

  async listAuditEvents(limit = 100, cursor?: string): Promise<{ items: AuditEvent[]; nextCursor?: string }> {
    const ordered = [...this.auditEvents].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = cursor ? Number(cursor) || 0 : 0;
    const items = ordered.slice(offset, offset + limit);
    const nextCursor = offset + items.length < ordered.length ? String(offset + items.length) : undefined;
    return { items, nextCursor };
  }
}
