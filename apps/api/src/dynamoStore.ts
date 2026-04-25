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
import type { DataStore, TrendingFeedQueryOptions } from './store';
import type {
  Creator,
  CreatorMember,
  Grouping,
  Media,
  GroupingMediaView,
  Comment,
  Favorite,
  BlockedUser,
  SiteSettings,
  UserProfile,
  Collection,
  Follow,
  IdempotencyRecord,
  AuditEvent,
  Post,
  SourceFile,
  CreatorGroup,
  TrendingFeedItem,
  TrendingPeriod,
  UserIdentity,
  ContributionContext,
  ContextSubmission,
  ContextUnlockThreshold,
  ChallengePrize,
  PrizeAward,
  PlatformRole
} from './domain';
import { ContentCoreRepository } from './contentCoreRepository';
import { normalizeContentRating } from './contentRating';
import { normalizeAiDisclosure, normalizeHeavyTopics } from './disclosures';

export class DynamoStore implements DataStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly coreRepo?: ContentCoreRepository;
  private readonly localUsernameReservations = new Map<string, { username: string; email: string }>();
  private readonly localUserProfiles = new Map<string, UserProfile>();
  private readonly localCreatorMembers = new Map<string, CreatorMember>();
  private readonly localCollections = new Map<string, Collection>();
  private readonly localPosts = new Map<string, Post>();
  private readonly localCollectionImages = new Map<string, Array<{ imageId: string; sortOrder: number }>>();
  private readonly localFollows = new Map<string, Follow>();
  private readonly localIdempotency = new Map<string, IdempotencyRecord>();
  private readonly localAuditEvents: AuditEvent[] = [];

  constructor(private readonly config: AppConfig) {
    const lowLevel = new DynamoDBClient({ region: config.awsRegion });
    this.client = DynamoDBDocumentClient.from(lowLevel);
    if (config.useContentCoreTable) {
      this.coreRepo = new ContentCoreRepository(this.client, config.contentCoreTable);
    }
  }

  private async batchWriteAll(requestItems: Record<string, Array<Record<string, unknown>>>): Promise<void> {
    let pending = requestItems;
    let attempts = 0;
    while (Object.keys(pending).length > 0) {
      const response = await this.client.send(
        new BatchWriteCommand({
          RequestItems: pending
        })
      );
      const unprocessed = (response.UnprocessedItems || {}) as Record<string, Array<Record<string, unknown>>>;
      const hasUnprocessed = Object.values(unprocessed).some((items) => (items || []).length > 0);
      if (!hasUnprocessed) return;
      pending = Object.fromEntries(
        Object.entries(unprocessed).filter(([, items]) => (items || []).length > 0)
      );
      attempts += 1;
      if (attempts > 8) {
        throw new Error('BatchWriteCommand did not complete after retries');
      }
      const sleepMs = Math.min(400, 25 * (2 ** Math.min(attempts, 4)));
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  private profileUserKey(profileType: 'user' | 'creator', profileId: string): string {
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

  async listCreators(): Promise<Creator[]> {
    if (this.coreRepo) {
      return this.coreRepo.listCreators();
    }

    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.creators,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'CREATOR' }
      })
    );
    return (response.Items || []) as Creator[];
  }

  async listAllGroupings(): Promise<Grouping[]> {
    if (this.coreRepo) {
      return this.coreRepo.listAllGroupings();
    }

    const response = await this.client.send(
      new ScanCommand({
        TableName: this.config.groupingsTable
      })
    );
    return (response.Items || []) as Grouping[];
  }

  async listGroupingsByCreatorSlug(creator: string): Promise<Grouping[]> {
    if (this.coreRepo) {
      return this.coreRepo.listGroupingsByCreatorSlug(creator);
    }

    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.groupingsTable,
        IndexName: 'creator',
        KeyConditionExpression: 'creator = :creator',
        ExpressionAttributeValues: { ':creator': creator }
      })
    );
    return (response.Items || []) as Grouping[];
  }

  async getGroupingBySlug(slug: string): Promise<Grouping | null> {
    if (this.coreRepo) {
      return this.coreRepo.getGroupingBySlug(slug);
    }

    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.groupingsTable,
        IndexName: 'slugIndex',
        KeyConditionExpression: 'slug = :slug',
        ExpressionAttributeValues: { ':slug': slug },
        Limit: 1
      })
    );
    return ((response.Items || [])[0] as Grouping) || null;
  }

  async getMediaByGrouping(groupingId: string): Promise<GroupingMediaView[]> {
    if (this.coreRepo) {
      return this.coreRepo.getMediaByGroupingId(groupingId);
    }

    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.imagesTable,
        KeyConditionExpression: 'groupingId = :groupingId',
        ExpressionAttributeValues: { ':groupingId': groupingId }
      })
    );
    return ((response.Items || []) as Array<Media & { groupingId: string; sortOrder: number; imageId?: string }>)
      .map((item) => ({
        ...item,
        mediaId: item.mediaId || item.imageId || '',
        groupingMediaId: `${item.groupingId}:${item.mediaId || item.imageId || ''}`,
        position: item.sortOrder || 0,
        isPreview: (item as { isPreview?: boolean }).isPreview,
        previewMaxWidth: (item as { previewMaxWidth?: number }).previewMaxWidth
      }))
      .filter((item) => Boolean(item.mediaId));
  }

  async listMediaByCreator(creator: string): Promise<Media[]> {
    if (this.coreRepo) {
      return this.coreRepo.listMediaByCreator(creator);
    }
    const response = await this.client.send(
      new ScanCommand({
        TableName: this.config.imagesTable,
        FilterExpression: 'creator = :creator',
        ExpressionAttributeValues: { ':creator': creator }
      })
    );
    const byId = new Map<string, Media>();
    for (const item of (response.Items || []) as Array<Media & { imageId?: string }>) {
      const mediaId = item.mediaId || item.imageId;
      if (!mediaId) continue;
      byId.set(mediaId, {
        ...item,
        mediaId,
        appearsInFeed: item.appearsInFeed !== false
      });
    }
    return [...byId.values()];
  }

  async listPostsByCreatorSlug(creator: string): Promise<Post[]> {
    if (this.coreRepo) {
      return this.coreRepo.listPostsByCreatorSlug(creator);
    }
    const creators = await this.listCreators();
    const creatorProfile = creators.find((item) => item.slug === creator || (item.slugHistory || []).includes(creator));
    if (!creatorProfile) return [];
    return this.listPostsByCreatorId(creatorProfile.creatorId);
  }

  async listPostsByCreatorId(creator: string): Promise<Post[]> {
    if (this.coreRepo) {
      return this.coreRepo.listPostsByCreatorId(creator);
    }
    return Array.from(this.localPosts.values()).filter((item) => item.creatorId === creator);
  }

  async listAllPosts(): Promise<Post[]> {
    if (this.coreRepo) {
      return this.coreRepo.listAllPosts();
    }
    return Array.from(this.localPosts.values());
  }

  async listAllSourceFiles(): Promise<SourceFile[]> {
    if (this.coreRepo) {
      return this.coreRepo.listAllSourceFiles();
    }
    return [];
  }

  async listAllCreatorGroups(): Promise<CreatorGroup[]> {
    if (this.coreRepo) {
      return this.coreRepo.listAllCreatorGroups();
    }
    return [];
  }

  async listCreatorGroupsByCreatorId(creatorId: string): Promise<CreatorGroup[]> {
    if (this.coreRepo) {
      return this.coreRepo.listCreatorGroupsByCreatorId(creatorId);
    }
    return [];
  }

  async listSourceFilesByCreatorId(creatorId: string): Promise<SourceFile[]> {
    if (this.coreRepo) {
      return this.coreRepo.listSourceFilesByCreatorId(creatorId);
    }
    return [];
  }

  async getPostBySlug(slug: string): Promise<Post | null> {
    if (this.coreRepo) {
      return this.coreRepo.getPostBySlug(slug);
    }
    for (const post of this.localPosts.values()) {
      if (post.slug === slug || (post.slugHistory || []).includes(slug)) {
        return post;
      }
    }
    return null;
  }

  async getPostById(postId: string): Promise<Post | null> {
    if (this.coreRepo) {
      return this.coreRepo.getPostById(postId);
    }
    return this.localPosts.get(postId) || null;
  }

  async getSourceFileById(fileId: string): Promise<SourceFile | null> {
    if (this.coreRepo) {
      return this.coreRepo.getSourceFileById(fileId);
    }
    return null;
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
    if (this.coreRepo) {
      return this.coreRepo.listMediaGroupingPlacements(mediaId);
    }
    const response = await this.client.send(
      new ScanCommand({
        TableName: this.config.imagesTable,
        FilterExpression: 'imageId = :imageId OR mediaId = :mediaId',
        ExpressionAttributeValues: {
          ':imageId': mediaId,
          ':mediaId': mediaId
        }
      })
    );
    return ((response.Items || []) as Array<{ groupingId: string; sortOrder?: number; createdAt?: string; imageId?: string; mediaId?: string; isPreview?: boolean; previewMaxWidth?: number }>)
      .filter((item) => Boolean(item.groupingId))
      .map((item, index) => ({
        groupingMediaId: `${item.groupingId}:${mediaId}:${index}`,
        groupingId: item.groupingId,
        mediaId,
        position: Number(item.sortOrder || 0),
        isPreview: item.isPreview,
        previewMaxWidth: item.previewMaxWidth,
        createdAt: item.createdAt || new Date().toISOString()
      }))
      .sort((a, b) => a.position - b.position);
  }

  async createCreator(creator: Creator): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createCreator(creator);
    }
    await this.client.send(new PutCommand({ TableName: this.config.creators, Item: { ...creator, pk: 'CREATOR', sk: creator.creatorId } }));
  }

  async createGrouping(grouping: Grouping): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createGrouping(grouping);
    }
    await this.client.send(new PutCommand({ TableName: this.config.groupingsTable, Item: grouping }));
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
    if (this.coreRepo) {
      await this.coreRepo.createMedia(media, groupingId, position, placement);
      return;
    }
    const resolvedGroupingId = groupingId || `FEED#${media.creatorId}`;
    await this.client.send(
      new PutCommand({
        TableName: this.config.imagesTable,
        Item: {
          ...media,
          appearsInFeed: media.appearsInFeed !== false,
          imageId: media.mediaId,
          groupingId: resolvedGroupingId,
          sortOrder: position
        }
      })
    );
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
    if (this.coreRepo) {
      await this.coreRepo.addMediaToGrouping(groupingId, mediaId, position, placement);
      return;
    }
    const response = await this.client.send(
      new ScanCommand({
        TableName: this.config.imagesTable,
        FilterExpression: 'imageId = :imageId OR mediaId = :mediaId',
        ExpressionAttributeValues: {
          ':imageId': mediaId,
          ':mediaId': mediaId
        },
        Limit: 1
      })
    );
    const base = (response.Items || [])[0] as (Media & { imageId?: string }) | undefined;
    if (!base) return;
    await this.client.send(
      new PutCommand({
        TableName: this.config.imagesTable,
        Item: {
          ...base,
          mediaId,
          imageId: mediaId,
          groupingId,
          sortOrder: position
        }
      })
    );
  }

  async updateCreator(creator: Creator): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateCreator(creator);
    }
    await this.client.send(new PutCommand({ TableName: this.config.creators, Item: { ...creator, pk: 'CREATOR', sk: creator.creatorId } }));
  }

  async updateGrouping(grouping: Grouping): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateGrouping(grouping);
    }
    await this.client.send(new PutCommand({ TableName: this.config.groupingsTable, Item: grouping }));
  }

  async updateMedia(media: Media): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateMedia(media);
      return;
    }
    await this.client.send(
      new PutCommand({
        TableName: this.config.imagesTable,
        Item: { ...media, appearsInFeed: media.appearsInFeed !== false, imageId: media.mediaId }
      })
    );
  }

  async createPost(post: Post): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createPost(post);
      return;
    }
    this.localPosts.set(post.postId, post);
  }

  async createSourceFile(file: SourceFile): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createSourceFile(file);
      return;
    }
  }

  async createCreatorGroup(group: CreatorGroup): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createCreatorGroup(group);
      return;
    }
  }

  async updatePost(post: Post): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updatePost(post);
      return;
    }
    this.localPosts.set(post.postId, post);
  }

  async updateSourceFile(file: SourceFile): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateSourceFile(file);
      return;
    }
  }

  async updateCreatorGroup(group: CreatorGroup): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateCreatorGroup(group);
      return;
    }
  }

  async deletePost(postId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.deletePost(postId);
      return;
    }
    this.localPosts.delete(postId);
  }

  async deleteSourceFile(fileId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.deleteSourceFile(fileId);
      return;
    }
  }

  async deleteCreatorGroup(groupId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.deleteCreatorGroup(groupId);
      return;
    }
  }

  async moveMediaInGrouping(groupingId: string, mediaId: string, position: number): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.moveMediaInGrouping(groupingId, mediaId, position);
      return;
    }

    const items = await this.getMediaByGrouping(groupingId);
    const existing = items.find((item) => item.mediaId === mediaId);
    if (!existing) return;

    await this.client.send(
      new PutCommand({
        TableName: this.config.imagesTable,
        Item: {
          ...existing,
          imageId: existing.mediaId,
          sortOrder: position,
          groupingId
        }
      })
    );
  }

  async deleteCreator(creator: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.deleteCreator(creator);
    }
    await this.client.send(new DeleteCommand({ TableName: this.config.creators, Key: { pk: 'CREATOR', sk: creator } }));
  }

  async deleteGrouping(groupingId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.deleteGrouping(groupingId);
    }
    await this.client.send(new DeleteCommand({ TableName: this.config.groupingsTable, Key: { groupingId } }));
  }

  async deleteMediaFromGrouping(groupingId: string, mediaId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.deleteMediaFromGrouping(groupingId, mediaId);
      return;
    }
    await this.client.send(new DeleteCommand({ TableName: this.config.imagesTable, Key: { groupingId, imageId: mediaId } }));
  }

  async addCreatorMember(member: CreatorMember): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.addCreatorMember(member);
      return;
    }
    this.localCreatorMembers.set(`${member.creatorId}:${member.userId}`, member);
  }

  async removeCreatorMember(creatorId: string, userId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.removeCreatorMember(creatorId, userId);
      return;
    }
    this.localCreatorMembers.delete(`${creatorId}:${userId}`);
  }

  async listCreatorMembers(creatorId: string): Promise<CreatorMember[]> {
    if (this.coreRepo) {
      return this.coreRepo.listCreatorMembers(creatorId);
    }
    return Array.from(this.localCreatorMembers.values()).filter((item) => item.creatorId === creatorId);
  }

  async listCreatorsByUserId(userId: string): Promise<Creator[]> {
    if (this.coreRepo) {
      return this.coreRepo.listCreatorsByUserId(userId);
    }
    const allowedIds = new Set(
      Array.from(this.localCreatorMembers.values())
        .filter((item) => item.userId === userId)
        .map((item) => item.creatorId)
    );
    return (await this.listCreators()).filter((creator) => allowedIds.has(creator.creatorId));
  }

  async hasCreatorAccess(userId: string, creator: string): Promise<boolean> {
    if (this.coreRepo) {
      return this.coreRepo.hasCreatorAccess(userId, creator);
    }
    return this.localCreatorMembers.has(`${creator}:${userId}`);
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

  async listPublicCollectionsByProfile(profileType: 'user' | 'creator', profileId: string, limit = 24): Promise<Collection[]> {
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

  async listCollectionsByProfile(profileType: 'user' | 'creator', profileId: string): Promise<Collection[]> {
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

  async followCreator(follow: Follow): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.followCreator(follow);
      return;
    }
    this.localFollows.set(`${follow.followerUserId}:${follow.creatorId}`, follow);
  }

  async unfollowCreator(followerUserId: string, creator: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.unfollowCreator(followerUserId, creator);
      return;
    }
    this.localFollows.delete(`${followerUserId}:${creator}`);
  }

  async listFollowsByUser(followerUserId: string): Promise<Follow[]> {
    if (this.coreRepo) {
      return this.coreRepo.listFollowsByUser(followerUserId);
    }
    return Array.from(this.localFollows.values()).filter((item) => item.followerUserId === followerUserId);
  }

  async isFollowingCreator(followerUserId: string, creator: string): Promise<boolean> {
    if (this.coreRepo) {
      return this.coreRepo.isFollowingCreator(followerUserId, creator);
    }
    return this.localFollows.has(`${followerUserId}:${creator}`);
  }

  async countFollowersByCreator(creator: string): Promise<number> {
    if (this.coreRepo) {
      return this.coreRepo.countFollowersByCreator(creator);
    }
    return Array.from(this.localFollows.values()).filter((item) => item.creatorId === creator).length;
  }

  async listComments(targetType: 'grouping' | 'image', targetId: string): Promise<Comment[]> {
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
    targetType: 'grouping' | 'image' | 'collection',
    targetId: string,
    ownerProfileType: 'user' | 'creator' = 'user',
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

  async listFavoritesByProfile(profileType: 'user' | 'creator', profileId: string): Promise<Favorite[]> {
    let primaryItems: Favorite[] = [];
    try {
      const primary = await this.client.send(
        new QueryCommand({
          TableName: this.config.favoritesTable,
          KeyConditionExpression: 'userKey = :userKey',
          ExpressionAttributeValues: { ':userKey': this.profileUserKey(profileType, profileId) }
        })
      );
      primaryItems = (primary.Items || []) as Favorite[];
    } catch (error) {
      const code = (error as { name?: string; __type?: string }).name
        || (error as { __type?: string }).__type
        || '';
      if (!code.includes('ResourceNotFound') && !code.includes('Validation') && !code.includes('AccessDenied')) {
        throw error;
      }
    }

    const responses: Favorite[][] = [primaryItems];
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

  async listPublicFavoritesByProfile(profileType: 'user' | 'creator', profileId: string): Promise<Favorite[]> {
    const items = await this.listFavoritesByProfile(profileType, profileId);
    return items
      .filter((item) => (item.visibility || 'public') === 'public')
      .filter((item) => (item.ownerProfileType || 'user') === profileType)
      .filter((item) => (item.ownerProfileId || item.userId) === profileId);
  }

  async countFavorites(targetType: 'grouping' | 'image' | 'collection', targetId: string): Promise<number> {
    try {
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
    } catch (error) {
      const code = (error as { name?: string; __type?: string }).name
        || (error as { __type?: string }).__type
        || '';
      if (code.includes('ResourceNotFound') || code.includes('Validation') || code.includes('AccessDenied')) {
        return 0;
      }
      throw error;
    }
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
            [this.config.contentStatsTable]: {
              Keys: slice.map((imageId) => ({ imageId }))
            }
          }
        })
      );
      for (const item of (response.Responses?.[this.config.contentStatsTable] || [])) {
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
              TableName: this.config.contentStatsTable,
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
        TableName: this.config.contentStatsTable,
        Key: { imageId },
        UpdateExpression: 'SET updatedAt = :updatedAt ADD favoriteCount :delta',
        ExpressionAttributeValues: {
          ':delta': delta,
          ':updatedAt': new Date().toISOString()
        }
      })
    );
  }

  async listTrendingFeed(
    period: TrendingPeriod,
    limit = 24,
    cursor?: string,
    options?: TrendingFeedQueryOptions
  ): Promise<{ items: TrendingFeedItem[]; nextCursor?: string }> {
    const source = options?.source || 'combined';
    const itemTypes = options?.itemTypes || { image: true, video: true, post: true };
    if (source === 'post' && !itemTypes.post) {
      return { items: [] };
    }
    if (source === 'media' && !itemTypes.image && !itemTypes.video) {
      return { items: [] };
    }
    const itemMatchesFilter = (row: Record<string, unknown>): boolean => {
      const isPostSurface = row.surfaceType === 'post_surface' || Boolean(row.postId);
      if (source === 'post' && !isPostSurface) return false;
      if (source === 'media' && isPostSurface) return false;
      if (isPostSurface) return itemTypes.post;
      const assetType = row.assetType === 'video' ? 'video' : 'image';
      if (assetType === 'video') return itemTypes.video;
      return itemTypes.image;
    };
    const resolveSingleSurface = (): 'image' | 'video' | 'post' | null => {
      if (source === 'post') return 'post';
      if (source === 'media') {
        if (itemTypes.image && !itemTypes.video) return 'image';
        if (itemTypes.video && !itemTypes.image) return 'video';
        return null;
      }
      const selected: Array<'image' | 'video' | 'post'> = [];
      if (itemTypes.image) selected.push('image');
      if (itemTypes.video) selected.push('video');
      if (itemTypes.post) selected.push('post');
      return selected.length === 1 ? selected[0] : null;
    };
    const decodedCursor = cursor
      ? JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'))
      : undefined;
    const singleSurface = resolveSingleSurface();
    const partitionKey = `PERIOD#${period}`;
    const toItem = (item: unknown): TrendingFeedItem => {
      const row = item as Record<string, unknown>;
      return {
        period,
        rank: Number(row.rank || 0),
        surfaceType: row.surfaceType === 'post_surface' ? 'post_surface' : 'media_surface',
        imageId: String(row.imageId || ''),
        assetType: row.assetType === 'video' ? 'video' : row.assetType === 'audio' ? 'audio' : 'image',
        creatorId: String(row.creatorId || ''),
        creatorName: String(row.creatorName || ''),
        postId: row.postId ? String(row.postId) : undefined,
        groupingId: String(row.groupingId || ''),
        groupingSlug: String(row.groupingSlug || ''),
        groupingVisibility: row.groupingVisibility === 'preview' ? 'preview' : 'free',
        discoverSquareCropEnabled: row.discoverSquareCropEnabled !== false,
        effectiveContentRating: normalizeContentRating(row.effectiveContentRating),
        effectiveAiDisclosure: normalizeAiDisclosure(row.effectiveAiDisclosure),
        effectiveHeavyTopics: normalizeHeavyTopics(row.effectiveHeavyTopics),
        title: String(row.title || ''),
        previewKey: String(row.previewKey || ''),
        previewPosterKey: row.previewPosterKey ? String(row.previewPosterKey) : undefined,
        thumbnailKeys: typeof row.thumbnailKeys === 'object' && row.thumbnailKeys !== null
          ? row.thumbnailKeys as TrendingFeedItem['thumbnailKeys']
          : undefined,
        width: Math.max(0, Number(row.width || 0)),
        height: Math.max(0, Number(row.height || 0)),
        aspectRatio: Math.max(0, Number(row.aspectRatio || 0)) || undefined,
        favoriteCount: Math.max(0, Number(row.favoriteCount || 0)),
        createdAt: String(row.createdAt || ''),
        score: Number(row.score || 0),
        updatedAt: String(row.updatedAt || '')
      } satisfies TrendingFeedItem;
    };

    let scanned: unknown[] = [];
    let cursorKey = decodedCursor as Record<string, unknown> | undefined;
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    if (singleSurface) {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.config.trendingFeedTable,
          IndexName: 'PeriodSurfaceRank',
          KeyConditionExpression: '#periodSurface = :periodSurface',
          ExpressionAttributeNames: { '#periodSurface': 'periodSurface' },
          ExpressionAttributeValues: { ':periodSurface': `PERIOD#${period}#SURFACE#${singleSurface}` },
          Limit: limit,
          ExclusiveStartKey: cursorKey
        })
      );
      scanned = response.Items || [];
      lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } else {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.config.trendingFeedTable,
          KeyConditionExpression: '#period = :period',
          ExpressionAttributeNames: { '#period': 'period' },
          ExpressionAttributeValues: { ':period': partitionKey },
          Limit: limit,
          ExclusiveStartKey: cursorKey
        })
      );
      scanned = (response.Items || []).filter((row) => itemMatchesFilter(row as Record<string, unknown>));
      lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    }
    const items = scanned.map((item) => toItem(item));
    const nextCursor = lastEvaluatedKey
      ? Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64')
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
        await this.batchWriteAll({
          [this.config.trendingFeedTable]: chunk.map((item) => ({
            DeleteRequest: { Key: { period: item.period, rankKey: item.rankKey } }
          }))
        });
      }
    } while (cursor);

    const nowIso = new Date().toISOString();
    const normalized = [...items].sort((a, b) => a.rank - b.rank);
    for (let i = 0; i < normalized.length; i += 25) {
      const chunk = normalized.slice(i, i + 25);
      await this.batchWriteAll({
        [this.config.trendingFeedTable]: chunk.map((item, index) => {
          const rank = i + index + 1;
          return {
            PutRequest: {
              Item: {
                ...item,
                period: partitionKey,
                rankKey: `RANK#${rank.toString().padStart(8, '0')}#IMAGE#${item.imageId}`,
                periodSurface: `PERIOD#${period}#SURFACE#${item.surfaceType === 'post_surface' || item.postId ? 'post' : item.assetType === 'video' ? 'video' : 'image'}`,
                rank,
                updatedAt: item.updatedAt || nowIso
              }
            }
          };
        })
      });
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

  async grantGroupingAccess(userId: string, groupingId: string): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.grantGroupingAccess(userId, groupingId);
    }
  }

  async hasGroupingAccess(userId: string, groupingId: string): Promise<boolean> {
    if (this.coreRepo) {
      return this.coreRepo.hasGroupingAccess(userId, groupingId);
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

  async listUserProfiles(): Promise<UserProfile[]> {
    if (this.coreRepo) {
      return this.coreRepo.listUserProfiles();
    }
    return Array.from(this.localUserProfiles.values());
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

  async getUserIdentity(userId: string): Promise<UserIdentity | null> {
    if (this.coreRepo) {
      return this.coreRepo.getUserIdentity(userId);
    }
    return null;
  }

  async listUserIdentities(): Promise<UserIdentity[]> {
    if (this.coreRepo) {
      return this.coreRepo.listUserIdentities();
    }
    return [];
  }

  async upsertUserIdentity(identity: UserIdentity): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.upsertUserIdentity(identity);
      return;
    }
  }

  async setUserRole(userId: string, role: PlatformRole): Promise<UserIdentity> {
    if (this.coreRepo) {
      return this.coreRepo.setUserRole(userId, role);
    }
    throw new Error('User identity persistence is unavailable.');
  }

  async listContributionContexts(): Promise<ContributionContext[]> {
    if (this.coreRepo) {
      return this.coreRepo.listContributionContexts();
    }
    return [];
  }

  async getContributionContextById(contextId: string): Promise<ContributionContext | null> {
    if (this.coreRepo) {
      return this.coreRepo.getContributionContextById(contextId);
    }
    return null;
  }

  async getContributionContextBySlug(slug: string): Promise<ContributionContext | null> {
    if (this.coreRepo) {
      return this.coreRepo.getContributionContextBySlug(slug);
    }
    return null;
  }

  async createContributionContext(context: ContributionContext): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createContributionContext(context);
      return;
    }
  }

  async updateContributionContext(context: ContributionContext): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateContributionContext(context);
      return;
    }
  }

  async listContextSubmissions(contextId: string): Promise<ContextSubmission[]> {
    if (this.coreRepo) {
      return this.coreRepo.listContextSubmissions(contextId);
    }
    return [];
  }

  async getContextSubmissionById(submissionId: string): Promise<ContextSubmission | null> {
    if (this.coreRepo) {
      return this.coreRepo.getContextSubmissionById(submissionId);
    }
    return null;
  }

  async createContextSubmission(submission: ContextSubmission): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createContextSubmission(submission);
      return;
    }
  }

  async updateContextSubmission(submission: ContextSubmission): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateContextSubmission(submission);
      return;
    }
  }

  async listContextUnlockThresholds(contextId: string): Promise<ContextUnlockThreshold[]> {
    if (this.coreRepo) {
      return this.coreRepo.listContextUnlockThresholds(contextId);
    }
    return [];
  }

  async createContextUnlockThreshold(threshold: ContextUnlockThreshold): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createContextUnlockThreshold(threshold);
      return;
    }
  }

  async updateContextUnlockThreshold(threshold: ContextUnlockThreshold): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateContextUnlockThreshold(threshold);
      return;
    }
  }

  async listChallengePrizes(contextId: string): Promise<ChallengePrize[]> {
    if (this.coreRepo) {
      return this.coreRepo.listChallengePrizes(contextId);
    }
    return [];
  }

  async createChallengePrize(prize: ChallengePrize): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createChallengePrize(prize);
      return;
    }
  }

  async updateChallengePrize(prize: ChallengePrize): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.updateChallengePrize(prize);
      return;
    }
  }

  async listPrizeAwards(contextId: string): Promise<PrizeAward[]> {
    if (this.coreRepo) {
      return this.coreRepo.listPrizeAwards(contextId);
    }
    return [];
  }

  async createPrizeAward(award: PrizeAward): Promise<void> {
    if (this.coreRepo) {
      await this.coreRepo.createPrizeAward(award);
      return;
    }
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
