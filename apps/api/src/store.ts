import type {
  Artist,
  ArtistMember,
  Gallery,
  Media,
  GalleryMediaView,
  Comment,
  Favorite,
  BlockedUser,
  SiteSettings,
  UserProfile,
  Collection,
  Follow,
  IdempotencyRecord,
  AuditEvent,
  TrendingFeedItem,
  TrendingPeriod
} from './domain';

export interface DataStore {
  getSiteSettings(): Promise<SiteSettings>;
  updateSiteSettings(settings: SiteSettings): Promise<void>;

  listArtists(): Promise<Artist[]>;
  listAllGalleries(): Promise<Gallery[]>;
  listGalleriesByArtistSlug(artistSlug: string): Promise<Gallery[]>;
  getGalleryBySlug(slug: string): Promise<Gallery | null>;
  getMediaByGallery(galleryId: string): Promise<GalleryMediaView[]>;

  createArtist(artist: Artist): Promise<void>;
  createGallery(gallery: Gallery): Promise<void>;
  createMedia(media: Media, galleryId: string, position: number): Promise<void>;
  updateArtist(artist: Artist): Promise<void>;
  updateGallery(gallery: Gallery): Promise<void>;
  updateMedia(media: Media): Promise<void>;
  moveMediaInGallery(galleryId: string, mediaId: string, position: number): Promise<void>;
  deleteArtist(artistId: string): Promise<void>;
  deleteGallery(galleryId: string): Promise<void>;
  deleteMediaFromGallery(galleryId: string, mediaId: string): Promise<void>;
  addArtistMember(member: ArtistMember): Promise<void>;
  removeArtistMember(artistId: string, userId: string): Promise<void>;
  listArtistMembers(artistId: string): Promise<ArtistMember[]>;
  listArtistsByUserId(userId: string): Promise<Artist[]>;
  hasArtistAccess(userId: string, artistId: string): Promise<boolean>;
  listPublicCollections(limit?: number, cursor?: string): Promise<{ items: Collection[]; nextCursor?: string }>;
  listPublicCollectionsByProfile(profileType: 'user' | 'artist', profileId: string, limit?: number): Promise<Collection[]>;
  listCollectionsByProfile(profileType: 'user' | 'artist', profileId: string): Promise<Collection[]>;
  listCollectionsByOwner(ownerUserId: string): Promise<Collection[]>;
  getCollectionById(collectionId: string): Promise<Collection | null>;
  createCollection(collection: Collection): Promise<void>;
  updateCollection(collection: Collection): Promise<void>;
  deleteCollection(collectionId: string): Promise<void>;
  addImageToCollection(collectionId: string, imageId: string, sortOrder: number): Promise<void>;
  removeImageFromCollection(collectionId: string, imageId: string): Promise<void>;
  listCollectionImageIds(collectionId: string): Promise<string[]>;
  followArtist(follow: Follow): Promise<void>;
  unfollowArtist(followerUserId: string, artistId: string): Promise<void>;
  listFollowsByUser(followerUserId: string): Promise<Follow[]>;
  isFollowingArtist(followerUserId: string, artistId: string): Promise<boolean>;
  countFollowersByArtist(artistId: string): Promise<number>;

  listComments(targetType: 'gallery' | 'image', targetId: string): Promise<Comment[]>;
  createComment(comment: Comment): Promise<void>;
  updateCommentVisibility(commentId: string, hidden: boolean): Promise<void>;
  deleteComment(commentId: string): Promise<void>;

  addFavorite(favorite: Favorite): Promise<void>;
  removeFavorite(
    userId: string,
    targetType: 'gallery' | 'image' | 'collection',
    targetId: string,
    ownerProfileType?: 'user' | 'artist',
    ownerProfileId?: string
  ): Promise<void>;
  listFavoritesByUser(userId: string): Promise<Favorite[]>;
  listFavoritesByProfile(profileType: 'user' | 'artist', profileId: string): Promise<Favorite[]>;
  listPublicFavoritesByProfile(profileType: 'user' | 'artist', profileId: string): Promise<Favorite[]>;
  countFavorites(targetType: 'gallery' | 'image' | 'collection', targetId: string): Promise<number>;
  getImageFavoriteCounts(imageIds: string[]): Promise<Record<string, number>>;
  incrementImageFavoriteCount(imageId: string, delta: number): Promise<void>;
  listTrendingFeed(period: TrendingPeriod, limit?: number, cursor?: string): Promise<{ items: TrendingFeedItem[]; nextCursor?: string }>;
  replaceTrendingFeed(period: TrendingPeriod, items: TrendingFeedItem[]): Promise<void>;

  blockUser(blockedUser: BlockedUser): Promise<void>;
  unblockUser(userId: string): Promise<void>;
  isUserBlocked(userId: string): Promise<boolean>;
  grantGalleryAccess(userId: string, galleryId: string): Promise<void>;
  hasGalleryAccess(userId: string, galleryId: string): Promise<boolean>;

  isUsernameAvailable(normalizedUsername: string): Promise<boolean>;
  reserveUsername(normalizedUsername: string, username: string, email: string): Promise<void>;
  releaseUsername(normalizedUsername: string): Promise<void>;
  getUserProfileBySlug(slug: string): Promise<UserProfile | null>;
  getUserProfile(userId: string): Promise<UserProfile | null>;
  upsertUserProfile(profile: UserProfile): Promise<void>;

  getIdempotencyRecord(scopeKey: string, idempotencyKey: string): Promise<IdempotencyRecord | null>;
  putIdempotencyRecord(record: IdempotencyRecord): Promise<void>;
  appendAuditEvent(event: AuditEvent): Promise<void>;
  listAuditEvents(limit?: number, cursor?: string): Promise<{ items: AuditEvent[]; nextCursor?: string }>;
}
