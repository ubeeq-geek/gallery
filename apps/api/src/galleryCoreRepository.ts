import { PutCommand, QueryCommand, DynamoDBDocumentClient, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import type { Artist, Gallery, Image } from './domain';

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
    return item ? stripEntityFields<Artist>(item) : null;
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
    return item ? stripEntityFields<Gallery>(item) : null;
  }

  async getMediaByGalleryId(galleryId: string): Promise<Image[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `GALLERY#${galleryId}`,
          ':prefix': 'MEDIA#'
        }
      })
    );

    return (response.Items || []).map((item) => stripEntityFields<Image>(item));
  }

  async createArtist(artist: Artist): Promise<void> {
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
          ...artist
        }
      })
    );
  }

  async createGallery(gallery: Gallery): Promise<void> {
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
          ...gallery
        }
      })
    );
  }

  async createImage(image: Image): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `GALLERY#${image.galleryId}`,
          SK: `MEDIA#${image.sortOrder.toString().padStart(8, '0')}#${image.imageId}`,
          entityType: 'MEDIA',
          ...image
        }
      })
    );
  }

  async updateArtist(artist: Artist): Promise<void> {
    await this.createArtist(artist);
  }

  async updateGallery(gallery: Gallery): Promise<void> {
    await this.createGallery(gallery);
  }

  async updateImage(image: Image, oldSortOrder?: number): Promise<void> {
    if (typeof oldSortOrder === 'number' && oldSortOrder !== image.sortOrder) {
      await this.deleteImage(image.galleryId, image.imageId, oldSortOrder);
    }
    await this.createImage(image);
  }

  async deleteArtist(artistId: string): Promise<void> {
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

  async deleteGallery(galleryId: string): Promise<void> {
    const media = await this.getMediaByGalleryId(galleryId);
    for (const item of media) {
      await this.deleteImage(item.galleryId, item.imageId, item.sortOrder);
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

  async deleteImage(galleryId: string, imageId: string, sortOrder?: number): Promise<void> {
    if (typeof sortOrder === 'number') {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: {
            PK: `GALLERY#${galleryId}`,
            SK: `MEDIA#${sortOrder.toString().padStart(8, '0')}#${imageId}`
          }
        })
      );
      return;
    }

    const media = await this.getMediaByGalleryId(galleryId);
    const match = media.find((item) => item.imageId === imageId);
    if (!match) return;

    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `GALLERY#${galleryId}`,
          SK: `MEDIA#${match.sortOrder.toString().padStart(8, '0')}#${imageId}`
        }
      })
    );
  }
}
