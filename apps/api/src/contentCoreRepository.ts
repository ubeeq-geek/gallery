import { BatchGetCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import type {
  Creator,
  CreatorMember,
  AuditEvent,
  ChallengePrize,
  Collection,
  ContextSubmission,
  ContextUnlockThreshold,
  ContributionContext,
  CreatorGroup,
  Follow,
  Grouping,
  IdempotencyRecord,
  Media,
  GroupingMediaView,
  PlatformRole,
  Post,
  PrizeAward,
  SourceFile,
  UserIdentity,
  UserProfile
} from './domain';
import { capabilitiesForRole } from './roleHelpers';

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

export class ContentCoreRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  async listCreators(): Promise<Creator[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: {
          ':pk': 'ENTITY#CREATOR'
        }
      })
    );

    return (response.Items || []).map((item) => stripEntityFields<Creator>(item));
  }

  async listAllSourceFiles(): Promise<SourceFile[]> {
    const response = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'entityType = :entityType',
        ExpressionAttributeValues: {
          ':entityType': 'SOURCE_FILE'
        }
      })
    );

    return (response.Items || [])
      .map((item) => stripEntityFields<SourceFile>(item))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listAllCreatorGroups(): Promise<CreatorGroup[]> {
    const response = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'entityType = :entityType',
        ExpressionAttributeValues: {
          ':entityType': 'CREATOR_GROUP'
        }
      })
    );

    return (response.Items || [])
      .map((item) => stripEntityFields<CreatorGroup>(item))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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

  async listPublicCollectionsByProfile(profileType: 'user' | 'creator', profileId: string, limit = 24): Promise<Collection[]> {
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

  async listCollectionsByProfile(profileType: 'user' | 'creator', profileId: string): Promise<Collection[]> {
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
      .filter((item) => (item.ownerProfileType || 'user') === 'creator')
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

  async followCreator(follow: Follow): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `USER#${follow.followerUserId}`,
          SK: `FOLLOW#CREATOR#${follow.creatorId}`,
          GSI1PK: `CREATOR#${follow.creatorId}`,
          GSI1SK: `USER#${follow.followerUserId}`,
          GSI2PK: `USER_FOLLOWS#${follow.followerUserId}`,
          GSI2SK: `CREATOR#${follow.creatorId}`,
          entityType: 'FOLLOW',
          ...follow
        }
      })
    );
  }

  async unfollowCreator(followerUserId: string, creator: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `USER#${followerUserId}`,
          SK: `FOLLOW#CREATOR#${creator}`
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
          ':prefix': 'FOLLOW#CREATOR'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'FOLLOW')
      .map((item) => stripEntityFields<Follow>(item));
  }

  async isFollowingCreator(followerUserId: string, creator: string): Promise<boolean> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `USER#${followerUserId}`,
          SK: `FOLLOW#CREATOR#${creator}`
        }
      })
    );
    return Boolean(response.Item);
  }

  async countFollowersByCreator(creator: string): Promise<number> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `CREATOR#${creator}`
        },
        Select: 'COUNT'
      })
    );
    return response.Count || 0;
  }

  async listAllGroupings(): Promise<Grouping[]> {
    const response = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'entityType = :entityType',
        ExpressionAttributeValues: {
          ':entityType': 'GROUPING'
        }
      })
    );
    return (response.Items || []).map((item) => stripEntityFields<Grouping>(item));
  }

  async listAllPosts(): Promise<Post[]> {
    const response = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: 'entityType = :entityType',
        ExpressionAttributeValues: {
          ':entityType': 'POST'
        }
      })
    );
    return (response.Items || []).map((item) => stripEntityFields<Post>(item));
  }

  async getCreatorBySlug(slug: string): Promise<Creator | null> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :slugPk',
        ExpressionAttributeValues: {
          ':slugPk': `CREATOR#${slug}`
        },
        Limit: 1
      })
    );

    const item = response.Items?.[0];
    if (!item) return null;
    if (item.entityType === 'CREATOR') {
      return stripEntityFields<Creator>(item);
    }
    if (item.entityType === 'CREATOR' && typeof item.creatorId === 'string') {
      return this.getCreatorProfileById(item.creatorId);
    }
    return null;
  }

  async listGroupingsByCreatorSlug(creatorSlug: string): Promise<Grouping[]> {
    const creator = await this.getCreatorBySlug(creatorSlug);
    if (!creator) {
      return [];
    }

    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `CREATOR#${creator.creatorId}`,
          ':prefix': 'GROUPING#'
        }
      })
    );

    return (response.Items || []).map((item) => stripEntityFields<Grouping>(item));
  }

  async listPostsByCreatorSlug(creatorSlug: string): Promise<Post[]> {
    const creator = await this.getCreatorBySlug(creatorSlug);
    if (!creator) {
      return [];
    }
    return this.listPostsByCreatorId(creator.creatorId);
  }

  async listPostsByCreatorId(creator: string): Promise<Post[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `CREATOR#${creator}`,
          ':prefix': 'POST#'
        }
      })
    );
    return (response.Items || []).map((item) => stripEntityFields<Post>(item));
  }

  async getGroupingBySlug(slug: string): Promise<Grouping | null> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :slugPk',
        ExpressionAttributeValues: {
          ':slugPk': `GROUPING_SLUG#${slug}`
        },
        Limit: 1
      })
    );

    const item = response.Items?.[0];
    if (!item) return null;
    if (item.entityType === 'GROUPING') {
      return stripEntityFields<Grouping>(item);
    }
    if (item.entityType === 'GROUPING_SLUG' && typeof item.groupingId === 'string') {
      const profile = await this.getGroupingProfileById(item.groupingId);
      return profile;
    }
    return null;
  }

  async getPostBySlug(slug: string): Promise<Post | null> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :slugPk',
        ExpressionAttributeValues: {
          ':slugPk': `POST_SLUG#${slug}`
        },
        Limit: 1
      })
    );

    const item = response.Items?.[0];
    if (!item) return null;
    if (item.entityType === 'POST') {
      return stripEntityFields<Post>(item);
    }
    if (item.entityType === 'POST_SLUG' && typeof item.postId === 'string') {
      return this.getPostById(item.postId);
    }
    return null;
  }

  async getPostById(postId: string): Promise<Post | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `POST#${postId}`,
          SK: 'PROFILE'
        }
      })
    );
    return response.Item ? stripEntityFields<Post>(response.Item) : null;
  }

  async getMediaByGroupingId(groupingId: string): Promise<GroupingMediaView[]> {
    const placementResponse = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `GROUPING#${groupingId}`,
          ':prefix': 'POS#'
        }
      })
    );

    const placements = (placementResponse.Items || [])
      .filter((item) => item.entityType === 'GROUPING_MEDIA' && typeof item.mediaId === 'string')
      .map((item) =>
        stripEntityFields<{
          groupingMediaId: string;
          groupingId: string;
          mediaId: string;
          position: number;
          isPreview?: boolean;
          previewMaxWidth?: number;
        }>(item)
      );

    if (placements.length === 0) {
      return [];
    }

    const mediaKeys = Array.from(new Set(placements.map((item) => item.mediaId)))
      .map((mediaId) => ({ PK: `MEDIA#${mediaId}`, SK: 'PROFILE' }));
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
          groupingId: placement.groupingId,
          groupingMediaId: placement.groupingMediaId,
          position: placement.position,
          isPreview: placement.isPreview,
          previewMaxWidth: placement.previewMaxWidth
        } as GroupingMediaView;
      })
      .filter((item): item is GroupingMediaView => Boolean(item));
  }

  async listMediaByCreator(creator: string): Promise<Media[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `CREATOR#${creator}`,
          ':prefix': 'MEDIA#'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'MEDIA_OBJECT')
      .map((item) => stripEntityFields<Media>(item));
  }

  async listCreatorGroupsByCreatorId(creatorId: string): Promise<CreatorGroup[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `CREATOR#${creatorId}`,
          ':prefix': 'GROUP#'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'CREATOR_GROUP')
      .map((item) => stripEntityFields<CreatorGroup>(item));
  }

  async listSourceFilesByCreatorId(creatorId: string): Promise<SourceFile[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `CREATOR#${creatorId}`,
          ':prefix': 'FILE#'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'SOURCE_FILE')
      .map((item) => stripEntityFields<SourceFile>(item));
  }

  async getSourceFileById(fileId: string): Promise<SourceFile | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `FILE#${fileId}`,
          SK: 'PROFILE'
        }
      })
    );
    return response.Item ? stripEntityFields<SourceFile>(response.Item) : null;
  }

  async listMediaGroupingPlacements(mediaId: string): Promise<Array<{
    groupingMediaId: string;
    groupingId: string;
    mediaId: string;
    position: number;
    isPreview?: boolean;
    previewMaxWidth?: number;
    createdAt: string;
  }>> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `MEDIA#${mediaId}`,
          ':prefix': 'GROUPING#'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'GROUPING_MEDIA')
      .map((item) => stripEntityFields<{
        groupingMediaId: string;
        groupingId: string;
        mediaId: string;
        position: number;
        isPreview?: boolean;
        previewMaxWidth?: number;
        createdAt: string;
      }>(item))
      .sort((a, b) => a.position - b.position);
  }

  async createCreator(creator: Creator): Promise<void> {
    const slugHistory = uniqueValues([...(creator.slugHistory || []), creator.slug]);
    const featuredItemIds = uniqueValues(creator.featuredItemIds || []);
    const featuredGroupingIds = uniqueValues(creator.featuredGroupingIds || []);
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `CREATOR#${creator.creatorId}`,
          SK: 'PROFILE',
          GSI1PK: `CREATOR#${creator.slug}`,
          GSI1SK: `CREATOR#${creator.creatorId}`,
          GSI2PK: 'ENTITY#CREATOR',
          GSI2SK: `CREATOR#${creator.sortOrder.toString().padStart(8, '0')}#${creator.creatorId}`,
          entityType: 'CREATOR',
          ...creator,
          slugHistory,
          defaultProfileTab: creator.defaultProfileTab === 'groupings' ? 'groupings' : 'feed',
          featuredItemIds,
          featuredGroupingIds
        }
      })
    );
    for (const slug of slugHistory) {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            PK: `CREATOR#${creator.creatorId}`,
            SK: `SLUG#${slug}`,
            GSI1PK: `CREATOR#${slug}`,
            GSI1SK: `CREATOR#${creator.creatorId}`,
            entityType: 'CREATOR',
            creatorId: creator.creatorId,
            slug
          }
        })
      );
    }
  }

  private async putGroupingSlugAlias(groupingId: string, slug: string): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `GROUPING#${groupingId}`,
          SK: `SLUG#${slug}`,
          GSI1PK: `GROUPING_SLUG#${slug}`,
          GSI1SK: `GROUPING#${groupingId}`,
          entityType: 'GROUPING_SLUG',
          groupingId,
          slug
        }
      })
    );
  }

  private async getGroupingProfileById(groupingId: string): Promise<Grouping | null> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: {
          ':pk': `GROUPING#${groupingId}`,
          ':sk': 'PROFILE'
        },
        Limit: 1
      })
    );
    const item = response.Items?.[0];
    return item ? stripEntityFields<Grouping>(item) : null;
  }

  async createGrouping(grouping: Grouping): Promise<void> {
    const slugHistory = Array.from(new Set([...(grouping.slugHistory || []), grouping.slug]));
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `GROUPING#${grouping.groupingId}`,
          SK: 'PROFILE',
          GSI1PK: `GROUPING_SLUG#${grouping.slug}`,
          GSI1SK: `GROUPING#${grouping.groupingId}`,
          GSI2PK: `CREATOR#${grouping.creatorId}`,
          GSI2SK: `GROUPING#${grouping.status}#${grouping.title}#${grouping.groupingId}`,
          entityType: 'GROUPING',
          ...grouping,
          slugHistory
        }
      })
    );
    for (const slug of slugHistory) {
      await this.putGroupingSlugAlias(grouping.groupingId, slug);
    }
  }

  private async putPostSlugAlias(postId: string, slug: string): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `POST#${postId}`,
          SK: `SLUG#${slug}`,
          GSI1PK: `POST_SLUG#${slug}`,
          GSI1SK: `POST#${postId}`,
          entityType: 'POST_SLUG',
          postId,
          slug
        }
      })
    );
  }

  async createPost(post: Post): Promise<void> {
    const slugHistory = uniqueValues([...(post.slugHistory || []), post.slug]);
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `POST#${post.postId}`,
          SK: 'PROFILE',
          GSI1PK: `POST_SLUG#${post.slug}`,
          GSI1SK: `POST#${post.postId}`,
          GSI2PK: `CREATOR#${post.creatorId}`,
          GSI2SK: `POST#${post.createdAt}#${post.postId}`,
          entityType: 'POST',
          ...post,
          slugHistory
        }
      })
    );
    for (const slug of slugHistory) {
      await this.putPostSlugAlias(post.postId, slug);
    }
  }

  async updatePost(post: Post): Promise<void> {
    await this.createPost(post);
  }

  async createSourceFile(file: SourceFile): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `FILE#${file.fileId}`,
          SK: 'PROFILE',
          GSI1PK: `FILE#${file.fileId}`,
          GSI1SK: 'PROFILE',
          GSI2PK: `CREATOR#${file.creatorId}`,
          GSI2SK: `FILE#${file.createdAt}#${file.fileId}`,
          entityType: 'SOURCE_FILE',
          ...file
        }
      })
    );
  }

  async updateSourceFile(file: SourceFile): Promise<void> {
    await this.createSourceFile(file);
  }

  async deleteSourceFile(fileId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `FILE#${fileId}`,
          SK: 'PROFILE'
        }
      })
    );
  }

  async createCreatorGroup(group: CreatorGroup): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `GROUP#${group.groupId}`,
          SK: 'PROFILE',
          GSI1PK: `GROUP_SLUG#${group.slug}`,
          GSI1SK: `GROUP#${group.groupId}`,
          GSI2PK: `CREATOR#${group.creatorId}`,
          GSI2SK: `GROUP#${group.createdAt}#${group.groupId}`,
          entityType: 'CREATOR_GROUP',
          ...group
        }
      })
    );
  }

  async updateCreatorGroup(group: CreatorGroup): Promise<void> {
    await this.createCreatorGroup(group);
  }

  async deleteCreatorGroup(groupId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `GROUP#${groupId}`,
          SK: 'PROFILE'
        }
      })
    );
  }

  private async putGroupingPlacement(
    groupingId: string,
    mediaId: string,
    position: number,
    groupingMediaId?: string,
    createdAt?: string,
    placement?: {
      isPreview?: boolean;
      previewMaxWidth?: number;
    }
  ): Promise<void> {
    const resolvedGroupingMediaId = groupingMediaId || randomUUID();
    const resolvedCreatedAt = createdAt || new Date().toISOString();
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `GROUPING#${groupingId}`,
          SK: `ITEM#${resolvedGroupingMediaId}`,
          GSI1PK: `MEDIA#${mediaId}`,
          GSI1SK: `GROUPING#${groupingId}#ITEM#${resolvedGroupingMediaId}`,
          GSI2PK: `GROUPING#${groupingId}`,
          GSI2SK: `POS#${positionKey(position)}#ITEM#${resolvedGroupingMediaId}`,
          entityType: 'GROUPING_MEDIA',
          groupingMediaId: resolvedGroupingMediaId,
          groupingId,
          mediaId,
          position,
          isPreview: placement?.isPreview,
          previewMaxWidth: placement?.previewMaxWidth,
          createdAt: resolvedCreatedAt
        }
      })
    );
  }

  async createMedia(
    media: Media,
    groupingId?: string,
    position = 0,
    placement?: {
      isPreview?: boolean;
      previewMaxWidth?: number;
    }
  ): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `MEDIA#${media.mediaId}`,
          SK: 'PROFILE',
          GSI1PK: `MEDIA_SLUG#${media.slug || media.mediaId}`,
          GSI1SK: `MEDIA#${media.mediaId}`,
          GSI2PK: `CREATOR#${media.creatorId}`,
          GSI2SK: `MEDIA#${media.createdAt}#${media.mediaId}`,
          entityType: 'MEDIA_OBJECT',
          ...media,
          appearsInFeed: media.appearsInFeed !== false
        }
      })
    );

    if (groupingId) {
      await this.putGroupingPlacement(groupingId, media.mediaId, position, undefined, undefined, placement);
    }
  }

  async addMediaToGrouping(
    groupingId: string,
    mediaId: string,
    position: number,
    placement?: {
      isPreview?: boolean;
      previewMaxWidth?: number;
    }
  ): Promise<void> {
    const existingPlacement = await this.getGroupingPlacement(groupingId, mediaId);
    await this.putGroupingPlacement(
      groupingId,
      mediaId,
      position,
      existingPlacement?.groupingMediaId,
      existingPlacement?.createdAt,
      {
        isPreview: placement?.isPreview ?? existingPlacement?.isPreview,
        previewMaxWidth: placement?.previewMaxWidth ?? existingPlacement?.previewMaxWidth
      }
    );
  }

  async addCreatorMember(member: CreatorMember): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `CREATOR#${member.creatorId}`,
          SK: `MEMBER#USER#${member.userId}`,
          GSI1PK: `USER_CREATOR_MEMBER#${member.userId}`,
          GSI1SK: `CREATOR#${member.creatorId}`,
          GSI2PK: `CREATOR#${member.creatorId}`,
          GSI2SK: `MEMBER#${member.role}#USER#${member.userId}`,
          entityType: 'CREATOR_MEMBER',
          ...member
        }
      })
    );
  }

  async removeCreatorMember(creatorId: string, userId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `CREATOR#${creatorId}`,
          SK: `MEMBER#USER#${userId}`
        }
      })
    );
  }

  async listCreatorMembers(creatorId: string): Promise<CreatorMember[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `CREATOR#${creatorId}`,
          ':prefix': 'MEMBER#USER#'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'CREATOR_MEMBER')
      .map((item) => stripEntityFields<CreatorMember>(item));
  }

  async hasCreatorAccess(userId: string, creatorId: string): Promise<boolean> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `CREATOR#${creatorId}`,
          SK: `MEMBER#USER#${userId}`
        }
      })
    );
    return Boolean(response.Item);
  }

  async listCreatorsByUserId(userId: string): Promise<Creator[]> {
    const memberships = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `USER_CREATOR_MEMBER#${userId}`
        }
      })
    );

    const creatorIds = Array.from(
      new Set(
        (memberships.Items || [])
          .filter((item) => item.entityType === 'CREATOR' && typeof item.creatorId === 'string')
          .map((item) => String(item.creatorId))
      )
    );
    if (creatorIds.length === 0) {
      return [];
    }

    const creatorProfiles = await this.client.send(
      new BatchGetCommand({
        RequestItems: {
          [this.tableName]: {
            Keys: creatorIds.map((creatorId) => ({ PK: `CREATOR#${creatorId}`, SK: 'PROFILE' }))
          }
        }
      })
    );

    return (creatorProfiles.Responses?.[this.tableName] || [])
      .filter((item) => item.entityType === 'CREATOR')
      .map((item) => stripEntityFields<Creator>(item));
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

  async listUserProfiles(): Promise<UserProfile[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: {
          ':pk': 'ENTITY#USER_PROFILE'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'USER_PROFILE')
      .map((item) => stripEntityFields<UserProfile>(item));
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

  async getUserIdentity(userId: string): Promise<UserIdentity | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `USER#${userId}`,
          SK: 'IDENTITY'
        }
      })
    );
    return response.Item ? stripEntityFields<UserIdentity>(response.Item) : null;
  }

  async listUserIdentities(): Promise<UserIdentity[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: {
          ':pk': 'ENTITY#USER_IDENTITY'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'USER_IDENTITY')
      .map((item) => stripEntityFields<UserIdentity>(item));
  }

  async upsertUserIdentity(identity: UserIdentity): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `USER#${identity.userId}`,
          SK: 'IDENTITY',
          GSI1PK: `USER_IDENTITY#${identity.userId}`,
          GSI1SK: 'PROFILE',
          GSI2PK: 'ENTITY#USER_IDENTITY',
          GSI2SK: `USER#${identity.userId}`,
          entityType: 'USER_IDENTITY',
          ...identity
        }
      })
    );
  }

  async setUserRole(userId: string, role: PlatformRole): Promise<UserIdentity> {
    const existing = await this.getUserIdentity(userId);
    const now = new Date().toISOString();
    const next: UserIdentity = {
      userId,
      role,
      isBeeker: existing?.isBeeker || false,
      capabilities: capabilitiesForRole(role),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    await this.upsertUserIdentity(next);
    return next;
  }

  private async getGroupingPlacement(groupingId: string, mediaId: string): Promise<{
    groupingMediaId: string;
    groupingId: string;
    mediaId: string;
    position: number;
    isPreview?: boolean;
    previewMaxWidth?: number;
    createdAt: string;
  } | null> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `GROUPING#${groupingId}`,
          ':prefix': 'ITEM#'
        }
      })
    );

    const item = (response.Items || []).find((candidate) => candidate.entityType === 'GROUPING_MEDIA' && candidate.mediaId === mediaId);
    return item
      ? stripEntityFields<{
          groupingMediaId: string;
          groupingId: string;
          mediaId: string;
          position: number;
          isPreview?: boolean;
          previewMaxWidth?: number;
          createdAt: string;
        }>(item)
      : null;
  }

  async updateCreator(creator: Creator): Promise<void> {
    await this.createCreator(creator);
  }

  async updateGrouping(grouping: Grouping): Promise<void> {
    await this.createGrouping(grouping);
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
          GSI2PK: `CREATOR#${media.creatorId}`,
          GSI2SK: `MEDIA#${media.createdAt}#${media.mediaId}`,
          entityType: 'MEDIA_OBJECT',
          ...media,
          appearsInFeed: media.appearsInFeed !== false
        }
      })
    );
  }

  async moveMediaInGrouping(groupingId: string, mediaId: string, position: number): Promise<void> {
    const placement = await this.getGroupingPlacement(groupingId, mediaId);
    if (!placement) return;

    await this.putGroupingPlacement(groupingId, mediaId, position, placement.groupingMediaId, placement.createdAt, {
      isPreview: placement.isPreview,
      previewMaxWidth: placement.previewMaxWidth
    });
  }

  async deleteCreator(creator: string): Promise<void> {
    const profile = await this.getCreatorProfileById(creator);
    for (const slug of profile?.slugHistory || (profile?.slug ? [profile.slug] : [])) {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: {
            PK: `CREATOR#${creator}`,
            SK: `SLUG#${slug}`
          }
        })
      );
    }

    const members = await this.listCreatorMembers(creator);
    for (const member of members) {
      await this.removeCreatorMember(creator, member.userId);
    }

    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `CREATOR#${creator}`,
          SK: 'PROFILE'
        }
      })
    );
  }

  private async getCreatorProfileById(creator: string): Promise<Creator | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `CREATOR#${creator}`,
          SK: 'PROFILE'
        }
      })
    );
    return response.Item ? stripEntityFields<Creator>(response.Item) : null;
  }

  async deleteGrouping(groupingId: string): Promise<void> {
    const grouping = await this.getGroupingProfileById(groupingId);
    const media = await this.getMediaByGroupingId(groupingId);
    for (const item of media) {
      await this.deleteMediaFromGrouping(groupingId, item.mediaId);
    }
    for (const slug of grouping?.slugHistory || (grouping?.slug ? [grouping.slug] : [])) {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: {
            PK: `GROUPING#${groupingId}`,
            SK: `SLUG#${slug}`
          }
        })
      );
    }
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `GROUPING#${groupingId}`,
          SK: 'PROFILE'
        }
      })
    );
  }

  async deletePost(postId: string): Promise<void> {
    const post = await this.getPostById(postId);
    for (const slug of post?.slugHistory || (post?.slug ? [post.slug] : [])) {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: {
            PK: `POST#${postId}`,
            SK: `SLUG#${slug}`
          }
        })
      );
    }
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `POST#${postId}`,
          SK: 'PROFILE'
        }
      })
    );
  }

  private async countGroupingPlacementsForMedia(mediaId: string): Promise<number> {
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

  async deleteMediaFromGrouping(groupingId: string, mediaId: string): Promise<void> {
    const placement = await this.getGroupingPlacement(groupingId, mediaId);
    if (!placement) {
      return;
    }

    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: `GROUPING#${groupingId}`,
          SK: `ITEM#${placement.groupingMediaId}`
        }
      })
    );

    const remainingPlacements = await this.countGroupingPlacementsForMedia(mediaId);
    if (remainingPlacements === 0) {
      const mediaProfile = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: {
            PK: `MEDIA#${mediaId}`,
            SK: 'PROFILE'
          }
        })
      );
      if (mediaProfile.Item && mediaProfile.Item.appearsInFeed !== false) {
        return;
      }
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

  async listContributionContexts(): Promise<ContributionContext[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: {
          ':pk': 'ENTITY#CONTRIBUTION_CONTEXT'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'CONTRIBUTION_CONTEXT')
      .map((item) => stripEntityFields<ContributionContext>(item))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getContributionContextById(contextId: string): Promise<ContributionContext | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `CONTEXT#${contextId}`,
          SK: 'PROFILE'
        }
      })
    );
    return response.Item ? stripEntityFields<ContributionContext>(response.Item) : null;
  }

  async getContributionContextBySlug(slug: string): Promise<ContributionContext | null> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `CONTEXT_SLUG#${slug}`
        },
        Limit: 1
      })
    );
    const item = response.Items?.[0];
    return item ? stripEntityFields<ContributionContext>(item) : null;
  }

  async createContributionContext(context: ContributionContext): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `CONTEXT#${context.contextId}`,
          SK: 'PROFILE',
          GSI1PK: `CONTEXT_SLUG#${context.slug}`,
          GSI1SK: `CONTEXT#${context.contextId}`,
          GSI2PK: 'ENTITY#CONTRIBUTION_CONTEXT',
          GSI2SK: `CONTEXT#${context.createdAt}#${context.contextId}`,
          entityType: 'CONTRIBUTION_CONTEXT',
          ...context
        }
      })
    );
  }

  async updateContributionContext(context: ContributionContext): Promise<void> {
    await this.createContributionContext(context);
  }

  async listContextSubmissions(contextId: string): Promise<ContextSubmission[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `CONTEXT#${contextId}`,
          ':prefix': 'SUBMISSION#'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'CONTEXT_SUBMISSION')
      .map((item) => stripEntityFields<ContextSubmission>(item))
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  }

  async getContextSubmissionById(submissionId: string): Promise<ContextSubmission | null> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `SUBMISSION#${submissionId}`
        },
        Limit: 1
      })
    );
    const item = response.Items?.[0];
    return item ? stripEntityFields<ContextSubmission>(item) : null;
  }

  async createContextSubmission(submission: ContextSubmission): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `CONTEXT#${submission.contextId}`,
          SK: `SUBMISSION#${submission.submissionId}`,
          GSI1PK: `SUBMISSION#${submission.submissionId}`,
          GSI1SK: `CONTEXT#${submission.contextId}`,
          GSI2PK: `CONTEXT#${submission.contextId}`,
          GSI2SK: `SUBMISSION#${submission.submittedAt}#${submission.submissionId}`,
          entityType: 'CONTEXT_SUBMISSION',
          ...submission
        }
      })
    );
  }

  async updateContextSubmission(submission: ContextSubmission): Promise<void> {
    await this.createContextSubmission(submission);
  }

  async listContextUnlockThresholds(contextId: string): Promise<ContextUnlockThreshold[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `CONTEXT#${contextId}`,
          ':prefix': 'UNLOCK#'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'CONTEXT_UNLOCK_THRESHOLD')
      .map((item) => stripEntityFields<ContextUnlockThreshold>(item));
  }

  async createContextUnlockThreshold(threshold: ContextUnlockThreshold): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `CONTEXT#${threshold.contextId}`,
          SK: `UNLOCK#${threshold.unlockId}`,
          GSI1PK: `UNLOCK#${threshold.unlockId}`,
          GSI1SK: `CONTEXT#${threshold.contextId}`,
          GSI2PK: `CONTEXT#${threshold.contextId}`,
          GSI2SK: `UNLOCK#${threshold.createdAt}#${threshold.unlockId}`,
          entityType: 'CONTEXT_UNLOCK_THRESHOLD',
          ...threshold
        }
      })
    );
  }

  async updateContextUnlockThreshold(threshold: ContextUnlockThreshold): Promise<void> {
    await this.createContextUnlockThreshold(threshold);
  }

  async listChallengePrizes(contextId: string): Promise<ChallengePrize[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `CONTEXT#${contextId}`,
          ':prefix': 'PRIZE#'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'CHALLENGE_PRIZE')
      .map((item) => stripEntityFields<ChallengePrize>(item));
  }

  async createChallengePrize(prize: ChallengePrize): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `CONTEXT#${prize.contextId}`,
          SK: `PRIZE#${prize.prizeId}`,
          GSI1PK: `PRIZE#${prize.prizeId}`,
          GSI1SK: `CONTEXT#${prize.contextId}`,
          GSI2PK: `CONTEXT#${prize.contextId}`,
          GSI2SK: `PRIZE#${prize.createdAt}#${prize.prizeId}`,
          entityType: 'CHALLENGE_PRIZE',
          ...prize
        }
      })
    );
  }

  async updateChallengePrize(prize: ChallengePrize): Promise<void> {
    await this.createChallengePrize(prize);
  }

  async listPrizeAwards(contextId: string): Promise<PrizeAward[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `CONTEXT#${contextId}`,
          ':prefix': 'AWARD#'
        }
      })
    );
    return (response.Items || [])
      .filter((item) => item.entityType === 'PRIZE_AWARD')
      .map((item) => stripEntityFields<PrizeAward>(item));
  }

  async createPrizeAward(award: PrizeAward): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `CONTEXT#${award.contextId}`,
          SK: `AWARD#${award.prizeAwardId}`,
          GSI1PK: `PRIZE#${award.prizeId}`,
          GSI1SK: `AWARD#${award.prizeAwardId}`,
          GSI2PK: `CONTEXT#${award.contextId}`,
          GSI2SK: `AWARD#${award.awardedAt}#${award.prizeAwardId}`,
          entityType: 'PRIZE_AWARD',
          ...award
        }
      })
    );
  }

  async grantGroupingAccess(userId: string, groupingId: string): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: `USER#${userId}`,
          SK: `ACCESS#GROUPING#${groupingId}`,
          GSI1PK: `GROUPING_ACCESS#${groupingId}`,
          GSI1SK: `USER#${userId}`,
          entityType: 'USER_GROUPING_ACCESS',
          userId,
          groupingId,
          grantedAt: new Date().toISOString()
        }
      })
    );
  }

  async hasGroupingAccess(userId: string, groupingId: string): Promise<boolean> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: `USER#${userId}`,
          SK: `ACCESS#GROUPING#${groupingId}`
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
