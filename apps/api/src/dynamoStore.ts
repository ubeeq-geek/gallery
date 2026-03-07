import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import type { AppConfig } from './config';
import type { DataStore } from './store';
import type { Artist, Gallery, Image, Comment, Favorite, BlockedUser } from './domain';
import { GalleryCoreRepository } from './galleryCoreRepository';

export class DynamoStore implements DataStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly coreRepo?: GalleryCoreRepository;

  constructor(private readonly config: AppConfig) {
    const lowLevel = new DynamoDBClient({ region: config.awsRegion });
    this.client = DynamoDBDocumentClient.from(lowLevel);
    if (config.useGalleryCoreTable) {
      this.coreRepo = new GalleryCoreRepository(this.client, config.galleryCoreTable);
    }
  }

  async listArtists(): Promise<Artist[]> {
    if (this.coreRepo) {
      const coreArtists = await this.coreRepo.listArtists();
      if (coreArtists.length > 0) {
        return coreArtists;
      }
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
      const coreGalleries = await this.coreRepo.listAllGalleries();
      if (coreGalleries.length > 0) {
        return coreGalleries;
      }
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
      const coreGalleries = await this.coreRepo.listGalleriesByArtistSlug(artistSlug);
      if (coreGalleries.length > 0) {
        return coreGalleries;
      }
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
      const coreGallery = await this.coreRepo.getGalleryBySlug(slug);
      if (coreGallery) {
        return coreGallery;
      }
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

  async getImagesByGallery(galleryId: string): Promise<Image[]> {
    if (this.coreRepo) {
      const coreMedia = await this.coreRepo.getMediaByGalleryId(galleryId);
      if (coreMedia.length > 0) {
        return coreMedia;
      }
    }

    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.imagesTable,
        KeyConditionExpression: 'galleryId = :galleryId',
        ExpressionAttributeValues: { ':galleryId': galleryId }
      })
    );
    return (response.Items || []) as Image[];
  }

  async createArtist(artist: Artist): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createArtist(artist);
    }
    await this.client.send(new PutCommand({ TableName: this.config.artistsTable, Item: { ...artist, pk: 'ARTIST', sk: artist.artistId } }));
  }

  async createGallery(gallery: Gallery & { artistSlug?: string }): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createGallery(gallery);
    }
    await this.client.send(new PutCommand({ TableName: this.config.galleriesTable, Item: gallery }));
  }

  async createImage(image: Image): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createImage(image);
    }
    await this.client.send(new PutCommand({ TableName: this.config.imagesTable, Item: image }));
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

  async updateImage(image: Image, oldSortOrder?: number): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateImage(image, oldSortOrder);
    }
    if (typeof oldSortOrder === 'number' && oldSortOrder !== image.sortOrder) {
      await this.deleteImage(image.galleryId, image.imageId, oldSortOrder);
    }
    await this.client.send(new PutCommand({ TableName: this.config.imagesTable, Item: image }));
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

  async deleteImage(galleryId: string, imageId: string, sortOrder?: number): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.deleteImage(galleryId, imageId, sortOrder);
    }
    await this.client.send(new DeleteCommand({ TableName: this.config.imagesTable, Key: { galleryId, imageId } }));
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
    await this.client.send(
      new PutCommand({
        TableName: this.config.favoritesTable,
        Item: {
          ...favorite,
          userKey: favorite.userId,
          targetKey: `${favorite.targetType}#${favorite.targetId}`
        }
      })
    );
  }

  async removeFavorite(userId: string, targetType: 'gallery' | 'image', targetId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.config.favoritesTable,
        Key: { userKey: userId, targetKey: `${targetType}#${targetId}` }
      })
    );
  }

  async listFavoritesByUser(userId: string): Promise<Favorite[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.favoritesTable,
        KeyConditionExpression: 'userKey = :userKey',
        ExpressionAttributeValues: { ':userKey': userId }
      })
    );
    return (response.Items || []) as Favorite[];
  }

  async countFavorites(targetType: 'gallery' | 'image', targetId: string): Promise<number> {
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
}
