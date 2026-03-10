import { BatchGetCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import type { Artist, ArtistMember, AuditEvent, Collection, Follow, Gallery, IdempotencyRecord, Media, GalleryMediaView, UserProfile } from './domain';

const stripEntityFields = <T>(item: Record<string, unknown>): T => {
  const clean = { ...item };
  delete clean.PK;
  delete clean.SK;
  delete clean.GSI1PK;
  delete clean.GSI1SK;
  delete clean.GSI2PK;
  delete clean.GSI2SK;
  delete clean.entityType;
  return clean as T;
};

const positionKey = (position: number): string => position.toString().padStart(8, '0');
const uniqueValues = (values: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

export class GalleryCoreRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  async listArtists(): Promise<Artist[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: {
          ':pk': 'ENTITY#ARTIST'
        }
      })
    );

    return (response.Items || []).map((item) => stripEntityFields<Artist>(item));
  }

  async listPublicCollections(limit = 24, cursor?: string): Promise<{ items: Collection[]; nextCursor?: string }> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': 'ENTITY#COLLECTION',
          ':prefix': 'INSERTED#'
        },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: cursor ? JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) : undefined
      })
    );

    const items = (response.Items || [])
      .filter((item) => item.entityType === 'COLLECTION' && item.visibility === 'public')
      .map((item) => stripEntityFields<Collection>(item));
    const nextCursor = response.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString('base64')
      : undefined;
    return { items, nextCursor };
  }

  async listPublicCollectionsByProfile(profileType: 'user' | 'artist', profileId: string, limit = 24): Promise<Collection[]> {
    const response = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'entityType = :entityType AND visibility = :visibility',
        ExpressionAttributeValues: {
          ':entityType': 'COLLECTION',
          ':visibility': 'public'
        }
      })
    );
    return (response.Items || [])
      .map((item) => stripEntityFields<Collection>(item))
      .filter((item) => (item.ownerProfileType || 'user') === profileType)
      .filter((item) => (item.ownerProfileId || item.ownerUserId) === profileId)
      .sort((a, b) => b.updatedDate.localeCompare(a.updatedDate))
      .slice(0, limit);
  }

  async listCollectionsByOwner(ownerUserId: string): Promise<Collection[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `USER_COLLECTION#${ownerUserId}`,
          ':prefix': 'COLLECTION#'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'COLLECTION')
      .map((item) => stripEntityFields<Collection>(item))
      .sort((a, b) => b.updatedDate.localeCompare(a.updatedDate));
  }

  async listCollectionsByProfile(profileType: 'user' | 'artist', profileId: string): Promise<Collection[]> {
    if (profileType === 'user') {
      return (await this.listCollectionsByOwner(profileId))
        .filter((item) => (item.ownerProfileType || 'user') === 'user')
        .filter((item) => (item.ownerProfileId || item.ownerUserId) === profileId);
    }
    const response = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'entityType = :entityType',
        ExpressionAttributeValues: {
          ':entityType': 'COLLECTION'
        }
      })
    );
    return (response.Items || [])
      .map((item) => stripEntityFields<Collection>(item))
      .filter((item) => (item.ownerProfileType || 'user') === 'artist')
      .filter((item) => (item.ownerProfileId || item.ownerUserId) === profileId)
      .sort((a, b) => b.updatedDate.localeCompare(a.updatedDate));
  }

  async getCollectionById(collectionId: string): Promise<Collection | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `COLLECTION#${collectionId}`,
          SK: 'PROFILE'
        }
      })
    );
    return response.Item ? stripEntityFields<Collection>(response.Item) : null;
  }

  async createCollection(collection: Collection): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `COLLECTION#${collection.collectionId}`,
          SK: 'PROFILE',
          GSI1PK: `USER_COLLECTION#${collection.ownerUserId}`,
          GSI1SK: `COLLECTION#${collection.updatedDate}#${collection.collectionId}`,
          GSI2PK: 'ENTITY#COLLECTION',
          GSI2SK: `INSERTED#${collection.insertedDate}#${collection.collectionId}`,
          entityType: 'COLLECTION',
          ...collection
        }
      })
    );
  }

  async updateCollection(collection: Collection): Promise<void> {
    await this.createCollection(collection);
  }

  async deleteCollection(collectionId: string): Promise<void> {
    const imageIds = await this.listCollectionImageIds(collectionId);
    for (const imageId of imageIds) {
      await this.removeImageFromCollection(collectionId, imageId);
    }
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `COLLECTION#${collectionId}`,
          SK: 'PROFILE'
        }
      })
    );
  }

  async addImageToCollection(collectionId: string, imageId: string, sortOrder: number): Promise<void> {
    const collectionImageId = randomUUID();
    const insertedDate = new Date().toISOString();
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `COLLECTION#${collectionId}`,
          SK: `ITEM#${collectionImageId}`,
          GSI1PK: `IMAGE_COLLECTION#${imageId}`,
          GSI1SK: `COLLECTION#${collectionId}#ITEM#${collectionImageId}`,
          GSI2PK: `COLLECTION#${collectionId}`,
          GSI2SK: `POS#${positionKey(sortOrder)}#ITEM#${collectionImageId}`,
          entityType: 'COLLECTION_IMAGE',
          collectionImageId,
          collectionId,
          imageId,
          sortOrder,
          insertedDate
        }
      })
    );
  }

  async removeImageFromCollection(collectionId: string, imageId: string): Promise<void> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `COLLECTION#${collectionId}`,
          ':prefix': 'ITEM#'
        }
      })
    );
    const found = (response.Items || []).find((item) => item.entityType === 'COLLECTION_IMAGE' && item.imageId === imageId);
    if (!found) return;
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `COLLECTION#${collectionId}`,
          SK: String(found.SK)
        }
      })
    );
  }

  async listCollectionImageIds(collectionId: string): Promise<string[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `COLLECTION#${collectionId}`,
          ':prefix': 'POS#'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'COLLECTION_IMAGE' && typeof item.imageId === 'string')
      .map((item) => String(item.imageId));
  }

  async followArtist(follow: Follow): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `USER#${follow.followerUserId}`,
          SK: `FOLLOW#ARTIST#${follow.artistId}`,
          GSI1PK: `ARTIST_FOLLOWERS#${follow.artistId}`,
          GSI1SK: `USER#${follow.followerUserId}`,
          GSI2PK: `USER_FOLLOWS#${follow.followerUserId}`,
          GSI2SK: `ARTIST#${follow.artistId}`,
          entityType: 'FOLLOW',
          ...follow
        }
      })
    );
  }

  async unfollowArtist(followerUserId: string, artistId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `USER#${followerUserId}`,
          SK: `FOLLOW#ARTIST#${artistId}`
        }
      })
    );
  }

  async listFollowsByUser(followerUserId: string): Promise<Follow[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `USER#${followerUserId}`,
          ':prefix': 'FOLLOW#ARTIST#'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'FOLLOW')
      .map((item) => stripEntityFields<Follow>(item));
  }

  async isFollowingArtist(followerUserId: string, artistId: string): Promise<boolean> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `USER#${followerUserId}`,
          SK: `FOLLOW#ARTIST#${artistId}`
        }
      })
    );
    return Boolean(response.Item);
  }

  async countFollowersByArtist(artistId: string): Promise<number> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `ARTIST_FOLLOWERS#${artistId}`
        },
        Select: 'COUNT'
      })
    );
    return response.Count || 0;
  }

  async listAllGalleries(): Promise<Gallery[]> {
    const response = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'entityType = :entityType',
        ExpressionAttributeValues: {
          ':entityType': 'GALLERY'
        }
      })
    );
    return (response.Items || []).map((item) => stripEntityFields<Gallery>(item));
  }

  async getArtistBySlug(slug: string): Promise<Artist | null> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :slugPk',
        ExpressionAttributeValues: {
          ':slugPk': `ARTIST_SLUG#${slug}`
        },
        Limit: 1
      })
    );

    const item = response.Items?.[0];
    if (!item) return null;
    if (item.entityType === 'ARTIST') {
      return stripEntityFields<Artist>(item);
    }
    if (item.entityType === 'ARTIST_SLUG_ALIAS' && typeof item.artistId === 'string') {
      return this.getArtistProfileById(item.artistId);
    }
    return null;
  }

  async listGalleriesByArtistSlug(artistSlug: string): Promise<Gallery[]> {
    const artist = await this.getArtistBySlug(artistSlug);
    if (!artist) {
      return [];
    }

    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `ARTIST#${artist.artistId}`,
          ':prefix': 'GALLERY#'
        }
      })
    );

    return (response.Items || []).map((item) => stripEntityFields<Gallery>(item));
  }

  async getGalleryBySlug(slug: string): Promise<Gallery | null> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :slugPk',
        ExpressionAttributeValues: {
          ':slugPk': `GALLERY_SLUG#${slug}`
        },
        Limit: 1
      })
    );

    const item = response.Items?.[0];
    if (!item) return null;
    if (item.entityType === 'GALLERY') {
      return stripEntityFields<Gallery>(item);
    }
    if (item.entityType === 'GALLERY_SLUG' && typeof item.galleryId === 'string') {
      const profile = await this.getGalleryProfileById(item.galleryId);
      return profile;
    }
    return null;
  }

  async getMediaByGalleryId(galleryId: string): Promise<GalleryMediaView[]> {
    const placementResponse = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `GALLERY#${galleryId}`,
          ':prefix': 'POS#'
        }
      })
    );

    const placements = (placementResponse.Items || [])
      .filter((item) => item.entityType === 'GALLERY_MEDIA' && typeof item.mediaId === 'string')
      .map((item) => stripEntityFields<{ galleryMediaId: string; galleryId: string; mediaId: string; position: number }>(item));

    if (placements.length === 0) {
      return [];
    }

    const mediaKeys = placements.map((item) => ({ PK: `MEDIA#${item.mediaId}`, SK: 'PROFILE' }));
    const mediaResponse = await this.client.send(
      new BatchGetCommand({
        RequestItems: {
          [this.tableName]: {
            Keys: mediaKeys
          }
        }
      })
    );

    const mediaItems = (mediaResponse.Responses?.[this.tableName] || [])
      .filter((item) => item.entityType === 'MEDIA_OBJECT')
      .map((item) => stripEntityFields<Media>(item));

    const mediaById = new Map<string, Media>(mediaItems.map((item) => [item.mediaId, item]));

    return placements
      .sort((a, b) => a.position - b.position)
      .map((placement) => {
        const media = mediaById.get(placement.mediaId);
        if (!media) return null;
        return {
          ...media,
          galleryId: placement.galleryId,
          galleryMediaId: placement.galleryMediaId,
          position: placement.position
        } as GalleryMediaView;
      })
      .filter((item): item is GalleryMediaView => Boolean(item));
  }

  async createArtist(artist: Artist): Promise<void> {
    const slugHistory = uniqueValues([...(artist.slugHistory || []), artist.slug]);
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `ARTIST#${artist.artistId}`,
          SK: 'PROFILE',
          GSI1PK: `ARTIST_SLUG#${artist.slug}`,
          GSI1SK: `ARTIST#${artist.artistId}`,
          GSI2PK: 'ENTITY#ARTIST',
          GSI2SK: `ARTIST#${artist.sortOrder.toString().padStart(8, '0')}#${artist.artistId}`,
          entityType: 'ARTIST',
          ...artist,
          slugHistory
        }
      })
    );
    for (const slug of slugHistory) {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: `ARTIST#${artist.artistId}`,
            SK: `SLUG#${slug}`,
            GSI1PK: `ARTIST_SLUG#${slug}`,
            GSI1SK: `ARTIST#${artist.artistId}`,
            entityType: 'ARTIST_SLUG_ALIAS',
            artistId: artist.artistId,
            slug
          }
        })
      );
    }
  }

  private async putGallerySlugAlias(galleryId: string, slug: string): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `GALLERY#${galleryId}`,
          SK: `SLUG#${slug}`,
          GSI1PK: `GALLERY_SLUG#${slug}`,
          GSI1SK: `GALLERY#${galleryId}`,
          entityType: 'GALLERY_SLUG',
          galleryId,
          slug
        }
      })
    );
  }

  private async getGalleryProfileById(galleryId: string): Promise<Gallery | null> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: {
          ':pk': `GALLERY#${galleryId}`,
          ':sk': 'PROFILE'
        },
        Limit: 1
      })
    );
    const item = response.Items?.[0];
    return item ? stripEntityFields<Gallery>(item) : null;
  }

  async createGallery(gallery: Gallery): Promise<void> {
    const slugHistory = Array.from(new Set([...(gallery.slugHistory || []), gallery.slug]));
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `GALLERY#${gallery.galleryId}`,
          SK: 'PROFILE',
          GSI1PK: `GALLERY_SLUG#${gallery.slug}`,
          GSI1SK: `GALLERY#${gallery.galleryId}`,
          GSI2PK: `ARTIST#${gallery.artistId}`,
          GSI2SK: `GALLERY#${gallery.status}#${gallery.title}#${gallery.galleryId}`,
          entityType: 'GALLERY',
          ...gallery,
          slugHistory
        }
      })
    );
    for (const slug of slugHistory) {
      await this.putGallerySlugAlias(gallery.galleryId, slug);
    }
  }

  private async putGalleryPlacement(galleryId: string, mediaId: string, position: number, galleryMediaId?: string, createdAt?: string): Promise<void> {
    const resolvedGalleryMediaId = galleryMediaId || randomUUID();
    const resolvedCreatedAt = createdAt || new Date().toISOString();
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `GALLERY#${galleryId}`,
          SK: `ITEM#${resolvedGalleryMediaId}`,
          GSI1PK: `MEDIA#${mediaId}`,
          GSI1SK: `GALLERY#${galleryId}#ITEM#${resolvedGalleryMediaId}`,
          GSI2PK: `GALLERY#${galleryId}`,
          GSI2SK: `POS#${positionKey(position)}#ITEM#${resolvedGalleryMediaId}`,
          entityType: 'GALLERY_MEDIA',
          galleryMediaId: resolvedGalleryMediaId,
          galleryId,
          mediaId,
          position,
          createdAt: resolvedCreatedAt
        }
      })
    );
  }

  async createMedia(media: Media, galleryId: string, position: number): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `MEDIA#${media.mediaId}`,
          SK: 'PROFILE',
          GSI1PK: `MEDIA_SLUG#${media.slug || media.mediaId}`,
          GSI1SK: `MEDIA#${media.mediaId}`,
          GSI2PK: `ARTIST#${media.artistId}`,
          GSI2SK: `MEDIA#${media.createdAt}#${media.mediaId}`,
          entityType: 'MEDIA_OBJECT',
          ...media
        }
      })
    );

    await this.putGalleryPlacement(galleryId, media.mediaId, position);
  }

  async addArtistMember(member: ArtistMember): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `ARTIST#${member.artistId}`,
          SK: `MEMBER#USER#${member.userId}`,
          GSI1PK: `USER_ARTIST_MEMBER#${member.userId}`,
          GSI1SK: `ARTIST#${member.artistId}`,
          GSI2PK: `ARTIST#${member.artistId}`,
          GSI2SK: `MEMBER#${member.role}#USER#${member.userId}`,
          entityType: 'ARTIST_MEMBER',
          ...member
        }
      })
    );
  }

  async removeArtistMember(artistId: string, userId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `ARTIST#${artistId}`,
          SK: `MEMBER#USER#${userId}`
        }
      })
    );
  }

  async listArtistMembers(artistId: string): Promise<ArtistMember[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `ARTIST#${artistId}`,
          ':prefix': 'MEMBER#USER#'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'ARTIST_MEMBER')
      .map((item) => stripEntityFields<ArtistMember>(item));
  }

  async hasArtistAccess(userId: string, artistId: string): Promise<boolean> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `ARTIST#${artistId}`,
          SK: `MEMBER#USER#${userId}`
        }
      })
    );
    return Boolean(response.Item);
  }

  async listArtistsByUserId(userId: string): Promise<Artist[]> {
    const memberships = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `USER_ARTIST_MEMBER#${userId}`
        }
      })
    );

    const artistIds = Array.from(
      new Set(
        (memberships.Items || [])
          .filter((item) => item.entityType === 'ARTIST_MEMBER' && typeof item.artistId === 'string')
          .map((item) => String(item.artistId))
      )
    );
    if (artistIds.length === 0) {
      return [];
    }

    const artistResponse = await this.client.send(
      new BatchGetCommand({
        RequestItems: {
          [this.tableName]: {
            Keys: artistIds.map((artistId) => ({ PK: `ARTIST#${artistId}`, SK: 'PROFILE' }))
          }
        }
      })
    );

    return (artistResponse.Responses?.[this.tableName] || [])
      .filter((item) => item.entityType === 'ARTIST')
      .map((item) => stripEntityFields<Artist>(item));
  }

  async isUsernameAvailable(normalizedUsername: string): Promise<boolean> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `USERNAME#${normalizedUsername}`,
          SK: 'PROFILE'
        }
      })
    );
    return !response.Item;
  }

  async reserveUsername(normalizedUsername: string, username: string, email: string): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `USERNAME#${normalizedUsername}`,
          SK: 'PROFILE',
          GSI1PK: `USERNAME#${normalizedUsername}`,
          GSI1SK: 'PROFILE',
          GSI2PK: 'ENTITY#USERNAME',
          GSI2SK: `USERNAME#${normalizedUsername}`,
          entityType: 'USERNAME',
          normalizedUsername,
          username,
          email,
          createdAt: new Date().toISOString()
        },
        ConditionExpression: 'attribute_not_exists(PK)'
      })
    );
  }

  async releaseUsername(normalizedUsername: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `USERNAME#${normalizedUsername}`,
          SK: 'PROFILE'
        }
      })
    );
  }

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `USER#${userId}`,
          SK: 'PROFILE'
        }
      })
    );
    return response.Item ? stripEntityFields<UserProfile>(response.Item) : null;
  }

  async getUserProfileBySlug(slug: string): Promise<UserProfile | null> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :slugPk',
        ExpressionAttributeValues: {
          ':slugPk': `USER_SLUG#${slug}`
        },
        Limit: 1
      })
    );
    const item = response.Items?.[0];
    if (!item || typeof item.userId !== 'string') return null;
    return this.getUserProfile(item.userId);
  }

  async upsertUserProfile(profile: UserProfile): Promise<void> {
    const usernameHistory = uniqueValues([...(profile.usernameHistory || []), profile.username]);
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `USER#${profile.userId}`,
          SK: 'PROFILE',
          GSI1PK: `USER_PROFILE#${profile.userId}`,
          GSI1SK: 'PROFILE',
          GSI2PK: 'ENTITY#USER_PROFILE',
          GSI2SK: `USER#${profile.userId}`,
          entityType: 'USER_PROFILE',
          ...profile,
          usernameHistory
        }
      })
    );
    for (const username of usernameHistory) {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: `USER#${profile.userId}`,
            SK: `SLUG#${username}`,
            GSI1PK: `USER_SLUG#${username}`,
            GSI1SK: `USER#${profile.userId}`,
            entityType: 'USER_SLUG_ALIAS',
            userId: profile.userId,
            username
          }
        })
      );
    }
  }

  private async getGalleryPlacement(galleryId: string, mediaId: string): Promise<{ galleryMediaId: string; galleryId: string; mediaId: string; position: number; createdAt: string } | null> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `GALLERY#${galleryId}`,
          ':prefix': 'ITEM#'
        }
      })
    );

    const item = (response.Items || []).find((candidate) => candidate.entityType === 'GALLERY_MEDIA' && candidate.mediaId === mediaId);
    return item ? stripEntityFields<{ galleryMediaId: string; galleryId: string; mediaId: string; position: number; createdAt: string }>(item) : null;
  }

  async updateArtist(artist: Artist): Promise<void> {
    await this.createArtist(artist);
  }

  async updateGallery(gallery: Gallery): Promise<void> {
    await this.createGallery(gallery);
  }

  async updateMedia(media: Media): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `MEDIA#${media.mediaId}`,
          SK: 'PROFILE',
          GSI1PK: `MEDIA_SLUG#${media.slug || media.mediaId}`,
          GSI1SK: `MEDIA#${media.mediaId}`,
          GSI2PK: `ARTIST#${media.artistId}`,
          GSI2SK: `MEDIA#${media.createdAt}#${media.mediaId}`,
          entityType: 'MEDIA_OBJECT',
          ...media
        }
      })
    );
  }

  async moveMediaInGallery(galleryId: string, mediaId: string, position: number): Promise<void> {
    const placement = await this.getGalleryPlacement(galleryId, mediaId);
    if (!placement) return;

    await this.putGalleryPlacement(galleryId, mediaId, position, placement.galleryMediaId, placement.createdAt);
  }

  async deleteArtist(artistId: string): Promise<void> {
    const profile = await this.getArtistProfileById(artistId);
    for (const slug of profile?.slugHistory || (profile?.slug ? [profile.slug] : [])) {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: {
            PK: `ARTIST#${artistId}`,
            SK: `SLUG#${slug}`
          }
        })
      );
    }

    const members = await this.listArtistMembers(artistId);
    for (const member of members) {
      await this.removeArtistMember(artistId, member.userId);
    }

    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `ARTIST#${artistId}`,
          SK: 'PROFILE'
        }
      })
    );
  }

  private async getArtistProfileById(artistId: string): Promise<Artist | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `ARTIST#${artistId}`,
          SK: 'PROFILE'
        }
      })
    );
    return response.Item ? stripEntityFields<Artist>(response.Item) : null;
  }

  async deleteGallery(galleryId: string): Promise<void> {
    const gallery = await this.getGalleryProfileById(galleryId);
    const media = await this.getMediaByGalleryId(galleryId);
    for (const item of media) {
      await this.deleteMediaFromGallery(galleryId, item.mediaId);
    }
    for (const slug of gallery?.slugHistory || (gallery?.slug ? [gallery.slug] : [])) {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: {
            PK: `GALLERY#${galleryId}`,
            SK: `SLUG#${slug}`
          }
        })
      );
    }
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `GALLERY#${galleryId}`,
          SK: 'PROFILE'
        }
      })
    );
  }

  private async countGalleryPlacementsForMedia(mediaId: string): Promise<number> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `MEDIA#${mediaId}`
        },
        Select: 'COUNT'
      })
    );
    return response.Count || 0;
  }

  async deleteMediaFromGallery(galleryId: string, mediaId: string): Promise<void> {
    const placement = await this.getGalleryPlacement(galleryId, mediaId);
    if (!placement) {
      return;
    }

    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `GALLERY#${galleryId}`,
          SK: `ITEM#${placement.galleryMediaId}`
        }
      })
    );

    const remainingPlacements = await this.countGalleryPlacementsForMedia(mediaId);
    if (remainingPlacements === 0) {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: {
            PK: `MEDIA#${mediaId}`,
            SK: 'PROFILE'
          }
        })
      );
    }
  }

  async grantGalleryAccess(userId: string, galleryId: string): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `USER#${userId}`,
          SK: `ACCESS#GALLERY#${galleryId}`,
          GSI1PK: `GALLERY_ACCESS#${galleryId}`,
          GSI1SK: `USER#${userId}`,
          entityType: 'USER_GALLERY_ACCESS',
          userId,
          galleryId,
          grantedAt: new Date().toISOString()
        }
      })
    );
  }

  async hasGalleryAccess(userId: string, galleryId: string): Promise<boolean> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `USER#${userId}`,
          SK: `ACCESS#GALLERY#${galleryId}`
        }
      })
    );
    return Boolean(response.Item);
  }

  async getIdempotencyRecord(scopeKey: string, idempotencyKey: string): Promise<IdempotencyRecord | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `IDEMPOTENCY#${scopeKey}`,
          SK: `KEY#${idempotencyKey}`
        }
      })
    );
    if (!response.Item) return null;
    const record = stripEntityFields<IdempotencyRecord>(response.Item);
    const expiresAtMs = Date.parse(record.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      return null;
    }
    return record;
  }

  async putIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `IDEMPOTENCY#${record.scopeKey}`,
          SK: `KEY#${record.idempotencyKey}`,
          entityType: 'IDEMPOTENCY',
          ttlEpochSeconds: Math.floor(Date.parse(record.expiresAt) / 1000),
          ...record
        }
      })
    );
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: 'AUDIT',
          SK: `TS#${event.createdAt}#${event.auditId}`,
          entityType: 'AUDIT',
          ...event
        }
      })
    );
  }

  async listAuditEvents(limit = 100, cursor?: string): Promise<{ items: AuditEvent[]; nextCursor?: string }> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': 'AUDIT',
          ':prefix': 'TS#'
        },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: cursor ? JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) : undefined
      })
    );
    const items = (response.Items || [])
      .filter((item) => item.entityType === 'AUDIT')
      .map((item) => stripEntityFields<AuditEvent>(item));
    const nextCursor = response.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(response.LastEvaluatedKey), 'utf8').toString('base64')
      : undefined;
    return { items, nextCursor };
  }
}
