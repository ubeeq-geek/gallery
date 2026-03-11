import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchGetCommand,
  BatchWriteCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import type { AppConfig } from './config';
import type { DataStore } from './store';
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
import { GalleryCoreRepository } from './galleryCoreRepository';
import { normalizeContentRating } from './contentRating';

export class DynamoStore implements DataStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly coreRepo?: GalleryCoreRepository;
  private readonly localUsernameReservations = new Map<string, { username: string; email: string }>();
  private readonly localUserProfiles = new Map<string, UserProfile>();
  private readonly localArtistMembers = new Map<string, ArtistMember>();
  private readonly localCollections = new Map<string, Collection>();
  private readonly localCollectionImages = new Map<string, Array<{ imageId: string; sortOrder: number }>>();
  private readonly localFollows = new Map<string, Follow>();
  private readonly localIdempotency = new Map<string, IdempotencyRecord>();
  private readonly localAuditEvents: AuditEvent[] = [];

  constructor(private readonly config: AppConfig) {
    const lowLevel = new DynamoDBClient({ region: config.awsRegion });
    this.client = DynamoDBDocumentClient.from(lowLevel);
    if (config.useGalleryCoreTable) {
      this.coreRepo = new GalleryCoreRepository(this.client, config.galleryCoreTable);
    }
  }

  private profileUserKey(profileType: 'user' | 'artist', profileId: string): string {
    return `PROFILE#${profileType}#${profileId}`;
  }

  async getSiteSettings(): Promise<SiteSettings> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.config.siteSettingsTable,
        Key: { settingId: 'SITE' }
      })
    );
    if (!response.Item) {
      return {
        settingId: 'SITE',
        siteName: 'Ubeeq',
        theme: 'ubeeq',
        updatedAt: new Date().toISOString()
      };
    }
    return response.Item as SiteSettings;
  }

  async updateSiteSettings(settings: SiteSettings): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.config.siteSettingsTable,
        Item: settings
      })
    );
  }

  async listArtists(): Promise<Artist[]> {
    if (this.coreRepo) {
      return this.coreRepo.listArtists();
    }

    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.artistsTable,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'ARTIST' }
      })
    );
    return (response.Items || []) as Artist[];
  }

  async listAllGalleries(): Promise<Gallery[]> {
    if (this.coreRepo) {
      return this.coreRepo.listAllGalleries();
    }

    const response = await this.client.send(
      new ScanCommand({
        TableName: this.config.galleriesTable
      })
    );
    return (response.Items || []) as Gallery[];
  }

  async listGalleriesByArtistSlug(artistSlug: string): Promise<Gallery[]> {
    if (this.coreRepo) {
      return this.coreRepo.listGalleriesByArtistSlug(artistSlug);
    }

    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.galleriesTable,
        IndexName: 'artistSlugIndex',
        KeyConditionExpression: 'artistSlug = :artistSlug',
        ExpressionAttributeValues: { ':artistSlug': artistSlug }
      })
    );
    return (response.Items || []) as Gallery[];
  }

  async getGalleryBySlug(slug: string): Promise<Gallery | null> {
    if (this.coreRepo) {
      return this.coreRepo.getGalleryBySlug(slug);
    }

    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.galleriesTable,
        IndexName: 'slugIndex',
        KeyConditionExpression: 'slug = :slug',
        ExpressionAttributeValues: { ':slug': slug },
        Limit: 1
      })
    );
    return ((response.Items || [])[0] as Gallery) || null;
  }

  async getMediaByGallery(galleryId: string): Promise<GalleryMediaView[]> {
    if (this.coreRepo) {
      return this.coreRepo.getMediaByGalleryId(galleryId);
    }

    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.imagesTable,
        KeyConditionExpression: 'galleryId = :galleryId',
        ExpressionAttributeValues: { ':galleryId': galleryId }
      })
    );
    return ((response.Items || []) as Array<Media & { galleryId: string; sortOrder: number; imageId?: string }>)
      .map((item) => ({
        ...item,
        mediaId: item.mediaId || item.imageId || '',
        galleryMediaId: `${item.galleryId}:${item.mediaId || item.imageId || ''}`,
        position: item.sortOrder || 0
      }))
      .filter((item) => Boolean(item.mediaId));
  }

  async createArtist(artist: Artist): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createArtist(artist);
    }
    await this.client.send(new PutCommand({ TableName: this.config.artistsTable, Item: { ...artist, pk: 'ARTIST', sk: artist.artistId } }));
  }

  async createGallery(gallery: Gallery): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createGallery(gallery);
    }
    await this.client.send(new PutCommand({ TableName: this.config.galleriesTable, Item: gallery }));
  }

  async createMedia(media: Media, galleryId: string, position: number): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createMedia(media, galleryId, position);
      return;
    }
    await this.client.send(
      new PutCommand({
        TableName: this.config.imagesTable,
        Item: {
          ...media,
          imageId: media.mediaId,
          galleryId,
          sortOrder: position
        }
      })
    );
  }

  async updateArtist(artist: Artist): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateArtist(artist);
    }
    await this.client.send(new PutCommand({ TableName: this.config.artistsTable, Item: { ...artist, pk: 'ARTIST', sk: artist.artistId } }));
  }

  async updateGallery(gallery: Gallery): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateGallery(gallery);
    }
    await this.client.send(new PutCommand({ TableName: this.config.galleriesTable, Item: gallery }));
  }

  async updateMedia(media: Media): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateMedia(media);
      return;
    }
    await this.client.send(
      new PutCommand({
        TableName: this.config.imagesTable,
        Item: { ...media, imageId: media.mediaId }
      })
    );
  }

  async moveMediaInGallery(galleryId: string, mediaId: string, position: number): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.moveMediaInGallery(galleryId, mediaId, position);
      return;
    }

    const items = await this.getMediaByGallery(galleryId);
    const existing = items.find((item) => item.mediaId === mediaId);
    if (!existing) return;

    await this.client.send(
      new PutCommand({
        TableName: this.config.imagesTable,
        Item: {
          ...existing,
          imageId: existing.mediaId,
          sortOrder: position,
          galleryId
        }
      })
    );
  }

  async deleteArtist(artistId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.deleteArtist(artistId);
    }
    await this.client.send(new DeleteCommand({ TableName: this.config.artistsTable, Key: { pk: 'ARTIST', sk: artistId } }));
  }

  async deleteGallery(galleryId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.deleteGallery(galleryId);
    }
    await this.client.send(new DeleteCommand({ TableName: this.config.galleriesTable, Key: { galleryId } }));
  }

  async deleteMediaFromGallery(galleryId: string, mediaId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.deleteMediaFromGallery(galleryId, mediaId);
      return;
    }
    await this.client.send(new DeleteCommand({ TableName: this.config.imagesTable, Key: { galleryId, imageId: mediaId } }));
  }

  async addArtistMember(member: ArtistMember): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.addArtistMember(member);
      return;
    }
    this.localArtistMembers.set(`${member.artistId}:${member.userId}`, member);
  }

  async removeArtistMember(artistId: string, userId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.removeArtistMember(artistId, userId);
      return;
    }
    this.localArtistMembers.delete(`${artistId}:${userId}`);
  }

  async listArtistMembers(artistId: string): Promise<ArtistMember[]> {
    if (this.coreRepo) {
      return this.coreRepo.listArtistMembers(artistId);
    }
    return Array.from(this.localArtistMembers.values()).filter((item) => item.artistId === artistId);
  }

  async listArtistsByUserId(userId: string): Promise<Artist[]> {
    if (this.coreRepo) {
      return this.coreRepo.listArtistsByUserId(userId);
    }
    const allowedIds = new Set(
      Array.from(this.localArtistMembers.values())
        .filter((item) => item.userId === userId)
        .map((item) => item.artistId)
    );
    return (await this.listArtists()).filter((artist) => allowedIds.has(artist.artistId));
  }

  async hasArtistAccess(userId: string, artistId: string): Promise<boolean> {
    if (this.coreRepo) {
      return this.coreRepo.hasArtistAccess(userId, artistId);
    }
    return this.localArtistMembers.has(`${artistId}:${userId}`);
  }

  async listPublicCollections(limit = 24, cursor?: string): Promise<{ items: Collection[]; nextCursor?: string }> {
    if (this.coreRepo) {
      return this.coreRepo.listPublicCollections(limit, cursor);
    }
    const sorted = Array.from(this.localCollections.values())
      .filter((item) => item.visibility === 'public')
      .sort((a, b) => b.insertedDate.localeCompare(a.insertedDate));
    const start = cursor ? Number(cursor) || 0 : 0;
    const items = sorted.slice(start, start + limit);
    const nextCursor = start + items.length < sorted.length ? String(start + items.length) : undefined;
    return { items, nextCursor };
  }

  async listPublicCollectionsByProfile(profileType: 'user' | 'artist', profileId: string, limit = 24): Promise<Collection[]> {
    if (this.coreRepo) {
      return this.coreRepo.listPublicCollectionsByProfile(profileType, profileId, limit);
    }
    return Array.from(this.localCollections.values())
      .filter((item) => item.visibility === 'public')
      .filter((item) => (item.ownerProfileType || 'user') === profileType)
      .filter((item) => (item.ownerProfileId || item.ownerUserId) === profileId)
      .sort((a, b) => b.updatedDate.localeCompare(a.updatedDate))
      .slice(0, limit);
  }

  async listCollectionsByOwner(ownerUserId: string): Promise<Collection[]> {
    if (this.coreRepo) {
      return this.coreRepo.listCollectionsByOwner(ownerUserId);
    }
    return Array.from(this.localCollections.values())
      .filter((item) => item.ownerUserId === ownerUserId)
      .sort((a, b) => b.updatedDate.localeCompare(a.updatedDate));
  }

  async listCollectionsByProfile(profileType: 'user' | 'artist', profileId: string): Promise<Collection[]> {
    if (this.coreRepo) {
      return this.coreRepo.listCollectionsByProfile(profileType, profileId);
    }
    return Array.from(this.localCollections.values())
      .filter((item) => (item.ownerProfileType || 'user') === profileType)
      .filter((item) => (item.ownerProfileId || item.ownerUserId) === profileId)
      .sort((a, b) => b.updatedDate.localeCompare(a.updatedDate));
  }

  async getCollectionById(collectionId: string): Promise<Collection | null> {
    if (this.coreRepo) {
      return this.coreRepo.getCollectionById(collectionId);
    }
    return this.localCollections.get(collectionId) || null;
  }

  async createCollection(collection: Collection): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createCollection(collection);
      return;
    }
    this.localCollections.set(collection.collectionId, collection);
  }

  async updateCollection(collection: Collection): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateCollection(collection);
      return;
    }
    this.localCollections.set(collection.collectionId, collection);
  }

  async deleteCollection(collectionId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.deleteCollection(collectionId);
      return;
    }
    this.localCollections.delete(collectionId);
    this.localCollectionImages.delete(collectionId);
  }

  async addImageToCollection(collectionId: string, imageId: string, sortOrder: number): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.addImageToCollection(collectionId, imageId, sortOrder);
      return;
    }
    const items = this.localCollectionImages.get(collectionId) || [];
    const next = items.filter((item) => item.imageId !== imageId);
    next.push({ imageId, sortOrder });
    this.localCollectionImages.set(collectionId, next.sort((a, b) => a.sortOrder - b.sortOrder));
  }

  async removeImageFromCollection(collectionId: string, imageId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.removeImageFromCollection(collectionId, imageId);
      return;
    }
    const items = this.localCollectionImages.get(collectionId) || [];
    this.localCollectionImages.set(collectionId, items.filter((item) => item.imageId !== imageId));
  }

  async listCollectionImageIds(collectionId: string): Promise<string[]> {
    if (this.coreRepo) {
      return this.coreRepo.listCollectionImageIds(collectionId);
    }
    return (this.localCollectionImages.get(collectionId) || [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((item) => item.imageId);
  }

  async followArtist(follow: Follow): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.followArtist(follow);
      return;
    }
    this.localFollows.set(`${follow.followerUserId}:${follow.artistId}`, follow);
  }

  async unfollowArtist(followerUserId: string, artistId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.unfollowArtist(followerUserId, artistId);
      return;
    }
    this.localFollows.delete(`${followerUserId}:${artistId}`);
  }

  async listFollowsByUser(followerUserId: string): Promise<Follow[]> {
    if (this.coreRepo) {
      return this.coreRepo.listFollowsByUser(followerUserId);
    }
    return Array.from(this.localFollows.values()).filter((item) => item.followerUserId === followerUserId);
  }

  async isFollowingArtist(followerUserId: string, artistId: string): Promise<boolean> {
    if (this.coreRepo) {
      return this.coreRepo.isFollowingArtist(followerUserId, artistId);
    }
    return this.localFollows.has(`${followerUserId}:${artistId}`);
  }

  async countFollowersByArtist(artistId: string): Promise<number> {
    if (this.coreRepo) {
      return this.coreRepo.countFollowersByArtist(artistId);
    }
    return Array.from(this.localFollows.values()).filter((item) => item.artistId === artistId).length;
  }

  async listComments(targetType: 'gallery' | 'image', targetId: string): Promise<Comment[]> {
    const targetKey = `${targetType}#${targetId}`;
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.commentsTable,
        KeyConditionExpression: 'targetKey = :targetKey',
        ExpressionAttributeValues: { ':targetKey': targetKey }
      })
    );
    return ((response.Items || []) as Comment[]).filter((comment) => !comment.hidden);
  }

  async createComment(comment: Comment): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.config.commentsTable,
        Item: {
          ...comment,
          targetKey: `${comment.targetType}#${comment.targetId}`,
          createdSort: `${comment.createdAt}#${comment.commentId}`
        }
      })
    );
  }

  async updateCommentVisibility(commentId: string, hidden: boolean): Promise<void> {
    const existing = await this.client.send(
      new QueryCommand({
        TableName: this.config.commentsTable,
        IndexName: 'commentIdIndex',
        KeyConditionExpression: 'commentId = :commentId',
        ExpressionAttributeValues: { ':commentId': commentId },
        Limit: 1
      })
    );
    if (!existing.Items?.[0]) {
      return;
    }
    const comment = existing.Items[0];
    await this.client.send(
      new UpdateCommand({
        TableName: this.config.commentsTable,
        Key: { targetKey: comment.targetKey, createdSort: comment.createdSort },
        UpdateExpression: 'SET hidden = :hidden',
        ExpressionAttributeValues: { ':hidden': hidden }
      })
    );
  }

  async deleteComment(commentId: string): Promise<void> {
    const existing = await this.client.send(
      new QueryCommand({
        TableName: this.config.commentsTable,
        IndexName: 'commentIdIndex',
        KeyConditionExpression: 'commentId = :commentId',
        ExpressionAttributeValues: { ':commentId': commentId },
        Limit: 1
      })
    );
    if (!existing.Items?.[0]) {
      return;
    }
    const comment = existing.Items[0];
    await this.client.send(
      new DeleteCommand({
        TableName: this.config.commentsTable,
        Key: { targetKey: comment.targetKey, createdSort: comment.createdSort }
      })
    );
  }

  async addFavorite(favorite: Favorite): Promise<void> {
    const ownerProfileType = favorite.ownerProfileType || 'user';
    const ownerProfileId = favorite.ownerProfileId || favorite.userId;
    let inserted = false;
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.config.favoritesTable,
          Item: {
            ...favorite,
            ownerProfileType,
            ownerProfileId,
            userKey: this.profileUserKey(ownerProfileType, ownerProfileId),
            targetKey: `${favorite.targetType}#${favorite.targetId}`
          },
          ConditionExpression: 'attribute_not_exists(userKey) AND attribute_not_exists(targetKey)'
        })
      );
      inserted = true;
    } catch (error) {
      const message = (error as { name?: string; message?: string })?.name || (error as { message?: string })?.message || '';
      if (!String(message).includes('ConditionalCheckFailed')) {
        throw error;
      }
    }
    if (inserted && favorite.targetType === 'image') {
      await this.incrementImageFavoriteCount(favorite.targetId, 1);
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
    let removed = false;
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.config.favoritesTable,
          Key: { userKey: this.profileUserKey(ownerProfileType, resolvedProfileId), targetKey: `${targetType}#${targetId}` },
          ConditionExpression: 'attribute_exists(userKey) AND attribute_exists(targetKey)'
        })
      );
      removed = true;
    } catch (error) {
      const message = (error as { name?: string; message?: string })?.name || (error as { message?: string })?.message || '';
      if (!String(message).includes('ConditionalCheckFailed')) {
        throw error;
      }
    }
    if (ownerProfileType === 'user' && resolvedProfileId === userId) {
      await this.client.send(
        new DeleteCommand({
          TableName: this.config.favoritesTable,
          Key: { userKey: userId, targetKey: `${targetType}#${targetId}` }
        })
      ).catch(() => undefined);
    }
    if (removed && targetType === 'image') {
      await this.incrementImageFavoriteCount(targetId, -1);
    }
  }

  async listFavoritesByUser(userId: string): Promise<Favorite[]> {
    const [primary, legacy] = await Promise.all([
      this.client.send(
        new QueryCommand({
          TableName: this.config.favoritesTable,
          KeyConditionExpression: 'userKey = :userKey',
          ExpressionAttributeValues: { ':userKey': this.profileUserKey('user', userId) }
        })
      ),
      this.client.send(
        new QueryCommand({
          TableName: this.config.favoritesTable,
          KeyConditionExpression: 'userKey = :userKey',
          ExpressionAttributeValues: { ':userKey': userId }
        })
      ).catch(() => ({ Items: [] }))
    ]);
    const merged = [...(primary.Items || []), ...(legacy.Items || [])] as Favorite[];
    return merged
      .map((item) => ({
        ...item,
        ownerProfileType: item.ownerProfileType || 'user',
        ownerProfileId: item.ownerProfileId || item.userId
      }))
      .filter((item) => (item.ownerProfileType || 'user') === 'user')
      .filter((item) => (item.ownerProfileId || item.userId) === userId);
  }

  async listFavoritesByProfile(profileType: 'user' | 'artist', profileId: string): Promise<Favorite[]> {
    const responses: Favorite[][] = [((await this.client.send(
      new QueryCommand({
        TableName: this.config.favoritesTable,
        KeyConditionExpression: 'userKey = :userKey',
        ExpressionAttributeValues: { ':userKey': this.profileUserKey(profileType, profileId) }
      })
    )).Items || []) as Favorite[]];
    if (profileType === 'user') {
      const legacy = await this.client.send(
        new QueryCommand({
          TableName: this.config.favoritesTable,
          KeyConditionExpression: 'userKey = :userKey',
          ExpressionAttributeValues: { ':userKey': profileId }
        })
      ).catch(() => undefined);
      responses.push((legacy?.Items || []) as Favorite[]);
    }
    return responses.flat().map((item) => ({
      ...item,
      ownerProfileType: item.ownerProfileType || profileType,
      ownerProfileId: item.ownerProfileId || profileId
    }));
  }

  async listPublicFavoritesByProfile(profileType: 'user' | 'artist', profileId: string): Promise<Favorite[]> {
    const items = await this.listFavoritesByProfile(profileType, profileId);
    return items
      .filter((item) => (item.visibility || 'public') === 'public')
      .filter((item) => (item.ownerProfileType || 'user') === profileType)
      .filter((item) => (item.ownerProfileId || item.userId) === profileId);
  }

  async countFavorites(targetType: 'gallery' | 'image' | 'collection', targetId: string): Promise<number> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.favoritesTable,
        IndexName: 'targetKeyIndex',
        KeyConditionExpression: 'targetKey = :targetKey',
        ExpressionAttributeValues: { ':targetKey': `${targetType}#${targetId}` },
        Select: 'COUNT'
      })
    );
    return response.Count || 0;
  }

  async getImageFavoriteCounts(imageIds: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    if (!imageIds.length) return out;
    const uniqueIds = Array.from(new Set(imageIds.filter(Boolean)));
    const chunkSize = 100;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
      const slice = uniqueIds.slice(i, i + chunkSize);
      const response = await this.client.send(
        new BatchGetCommand({
          RequestItems: {
            [this.config.imageStatsTable]: {
              Keys: slice.map((imageId) => ({ imageId }))
            }
          }
        })
      );
      for (const item of (response.Responses?.[this.config.imageStatsTable] || [])) {
        const imageId = String((item as Record<string, unknown>).imageId || '');
        if (!imageId) continue;
        const favoriteCount = Number((item as Record<string, unknown>).favoriteCount || 0);
        out[imageId] = Math.max(0, Number.isFinite(favoriteCount) ? favoriteCount : 0);
      }
      const missing = slice.filter((imageId) => out[imageId] === undefined);
      for (let j = 0; j < missing.length; j += 25) {
        const batch = missing.slice(j, j + 25);
        const counts = await Promise.all(batch.map(async (imageId) => {
          const count = await this.countFavorites('image', imageId);
          return { imageId, count: Math.max(0, count) };
        }));
        await Promise.all(counts.map(async ({ imageId, count }) => {
          out[imageId] = count;
          await this.client.send(
            new PutCommand({
              TableName: this.config.imageStatsTable,
              Item: {
                imageId,
                favoriteCount: count,
                updatedAt: new Date().toISOString()
              }
            })
          );
        }));
      }
    }
    return out;
  }

  async incrementImageFavoriteCount(imageId: string, delta: number): Promise<void> {
    if (!imageId || !Number.isFinite(delta) || delta === 0) return;
    await this.client.send(
      new UpdateCommand({
        TableName: this.config.imageStatsTable,
        Key: { imageId },
        UpdateExpression: 'SET updatedAt = :updatedAt ADD favoriteCount :delta',
        ExpressionAttributeValues: {
          ':delta': delta,
          ':updatedAt': new Date().toISOString()
        }
      })
    );
  }

  async listTrendingFeed(period: TrendingPeriod, limit = 24, cursor?: string): Promise<{ items: TrendingFeedItem[]; nextCursor?: string }> {
    const decodedCursor = cursor
      ? JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'))
      : undefined;
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.trendingFeedTable,
        KeyConditionExpression: '#period = :period',
        ExpressionAttributeNames: { '#period': 'period' },
        ExpressionAttributeValues: { ':period': `PERIOD#${period}` },
        Limit: limit,
        ExclusiveStartKey: decodedCursor
      })
    );
    const items = (response.Items || []).map((item) => {
      const row = item as Record<string, unknown>;
      return {
        period,
        rank: Number(row.rank || 0),
        imageId: String(row.imageId || ''),
        artistId: String(row.artistId || ''),
        artistName: String(row.artistName || ''),
        galleryId: String(row.galleryId || ''),
        gallerySlug: String(row.gallerySlug || ''),
        galleryVisibility: row.galleryVisibility === 'preview' ? 'preview' : 'free',
        discoverSquareCropEnabled: row.discoverSquareCropEnabled !== false,
        effectiveContentRating: normalizeContentRating(row.effectiveContentRating),
        title: String(row.title || ''),
        previewKey: String(row.previewKey || ''),
        favoriteCount: Math.max(0, Number(row.favoriteCount || 0)),
        createdAt: String(row.createdAt || ''),
        score: Number(row.score || 0),
        updatedAt: String(row.updatedAt || '')
      } satisfies TrendingFeedItem;
    });
    const nextCursor = response.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(response.LastEvaluatedKey), 'utf8').toString('base64')
      : undefined;
    return { items, nextCursor };
  }

  async replaceTrendingFeed(period: TrendingPeriod, items: TrendingFeedItem[]): Promise<void> {
    const partitionKey = `PERIOD#${period}`;
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.config.trendingFeedTable,
          KeyConditionExpression: '#period = :period',
          ExpressionAttributeNames: { '#period': 'period' },
          ExpressionAttributeValues: { ':period': partitionKey },
          ExclusiveStartKey: cursor
        })
      );
      cursor = page.LastEvaluatedKey as Record<string, unknown> | undefined;
      const existing = (page.Items || []) as Array<{ period: string; rankKey: string }>;
      for (let i = 0; i < existing.length; i += 25) {
        const chunk = existing.slice(i, i + 25);
        await this.client.send(
          new BatchWriteCommand({
            RequestItems: {
              [this.config.trendingFeedTable]: chunk.map((item) => ({
                DeleteRequest: { Key: { period: item.period, rankKey: item.rankKey } }
              }))
            }
          })
        );
      }
    } while (cursor);

    const nowIso = new Date().toISOString();
    const normalized = [...items].sort((a, b) => a.rank - b.rank);
    for (let i = 0; i < normalized.length; i += 25) {
      const chunk = normalized.slice(i, i + 25);
      await this.client.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.config.trendingFeedTable]: chunk.map((item, index) => {
              const rank = i + index + 1;
              return {
                PutRequest: {
                  Item: {
                    ...item,
                    period: partitionKey,
                    rankKey: `RANK#${rank.toString().padStart(8, '0')}#IMAGE#${item.imageId}`,
                    rank,
                    updatedAt: item.updatedAt || nowIso
                  }
                }
              };
            })
          }
        })
      );
    }
  }

  async blockUser(blockedUser: BlockedUser): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.config.blockedUsersTable, Item: blockedUser }));
  }

  async unblockUser(userId: string): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.config.blockedUsersTable, Key: { userId } }));
  }

  async isUserBlocked(userId: string): Promise<boolean> {
    const response = await this.client.send(new GetCommand({ TableName: this.config.blockedUsersTable, Key: { userId } }));
    return Boolean(response.Item);
  }

  async grantGalleryAccess(userId: string, galleryId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.grantGalleryAccess(userId, galleryId);
    }
  }

  async hasGalleryAccess(userId: string, galleryId: string): Promise<boolean> {
    if (this.coreRepo) {
      return this.coreRepo.hasGalleryAccess(userId, galleryId);
    }
    return false;
  }

  async isUsernameAvailable(normalizedUsername: string): Promise<boolean> {
    if (this.coreRepo) {
      return this.coreRepo.isUsernameAvailable(normalizedUsername);
    }
    return !this.localUsernameReservations.has(normalizedUsername);
  }

  async reserveUsername(normalizedUsername: string, username: string, email: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.reserveUsername(normalizedUsername, username, email);
      return;
    }
    if (this.localUsernameReservations.has(normalizedUsername)) {
      throw new Error('USERNAME_TAKEN');
    }
    this.localUsernameReservations.set(normalizedUsername, { username, email });
  }

  async releaseUsername(normalizedUsername: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.releaseUsername(normalizedUsername);
      return;
    }
    this.localUsernameReservations.delete(normalizedUsername);
  }

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    if (this.coreRepo) {
      return this.coreRepo.getUserProfile(userId);
    }
    return this.localUserProfiles.get(userId) || null;
  }

  async getUserProfileBySlug(slug: string): Promise<UserProfile | null> {
    if (this.coreRepo) {
      return this.coreRepo.getUserProfileBySlug(slug);
    }
    const normalized = slug.trim().toLowerCase();
    for (const profile of this.localUserProfiles.values()) {
      if (profile.username === normalized) return profile;
      if ((profile.usernameHistory || []).includes(normalized)) return profile;
    }
    return null;
  }

  async upsertUserProfile(profile: UserProfile): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.upsertUserProfile(profile);
      return;
    }
    this.localUserProfiles.set(profile.userId, profile);
  }

  async getIdempotencyRecord(scopeKey: string, idempotencyKey: string): Promise<IdempotencyRecord | null> {
    if (this.coreRepo) {
      return this.coreRepo.getIdempotencyRecord(scopeKey, idempotencyKey);
    }
    const key = `${scopeKey}:${idempotencyKey}`;
    const record = this.localIdempotency.get(key);
    if (!record) return null;
    if (Date.parse(record.expiresAt) <= Date.now()) {
      this.localIdempotency.delete(key);
      return null;
    }
    return record;
  }

  async putIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.putIdempotencyRecord(record);
      return;
    }
    this.localIdempotency.set(`${record.scopeKey}:${record.idempotencyKey}`, record);
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.appendAuditEvent(event);
      return;
    }
    this.localAuditEvents.push(event);
  }

  async listAuditEvents(limit = 100, cursor?: string): Promise<{ items: AuditEvent[]; nextCursor?: string }> {
    if (this.coreRepo) {
      return this.coreRepo.listAuditEvents(limit, cursor);
    }
    const ordered = [...this.localAuditEvents].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = cursor ? Number(cursor) || 0 : 0;
    const items = ordered.slice(offset, offset + limit);
    const nextCursor = offset + items.length < ordered.length ? String(offset + items.length) : undefined;
    return { items, nextCursor };
  }
}
