import { randomUUID } from 'crypto';
import type {
  Creator,
  CreatorMember,
  Grouping,
  Media,
  GroupingMedia,
  GroupingMediaView,
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
  Post,
  TrendingFeedItem,
  TrendingPeriod,
  SourceFile,
  CreatorGroup,
  UserIdentity,
  UserExternalLink,
  UserBadge,
  ContributionContext,
  ContextSubmission,
  ContextUnlockThreshold,
  ChallengePrize,
  PrizeAward,
  PlatformRole,
  UserCapabilities
} from './domain';
import type { DataStore, TrendingFeedQueryOptions } from './store';
import { capabilitiesForRole } from './roleHelpers';

export class InMemoryStore implements DataStore {
  private getOrCreateIdentity(userId: string): UserIdentity {
    const existing = this.userIdentities.find((item) => item.userId === userId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const created: UserIdentity = {
      userId,
      role: 'user',
      isBeeker: false,
      capabilities: capabilitiesForRole('user'),
      createdAt: now,
      updatedAt: now
    };
    this.userIdentities.push(created);
    return created;
  }

  siteSettings: SiteSettings = {
    settingId: 'SITE',
    siteName: 'Ubeeq',
    theme: 'ubeeq',
    updatedAt: new Date().toISOString()
  };
  creators: Creator[] = [];
  groupings: Grouping[] = [];
  media: Media[] = [];
  posts: Post[] = [];
  sourceFiles: SourceFile[] = [];
  creatorGroups: CreatorGroup[] = [];
  groupingMedia: GroupingMedia[] = [];
  comments: Comment[] = [];
  favorites: Favorite[] = [];
  blockedUsers: BlockedUser[] = [];
  groupingAccess: Array<{ userId: string; groupingId: string }> = [];
  creatorMembers: CreatorMember[] = [];
  usernames: Array<{ normalized: string; username: string; email: string }> = [];
  userProfiles: UserProfile[] = [];
  collections: Collection[] = [];
  collectionImages: CollectionImage[] = [];
  follows: Follow[] = [];
  userIdentities: UserIdentity[] = [];
  userExternalLinks: UserExternalLink[] = [];
  userBadges: UserBadge[] = [];
  contributionContexts: ContributionContext[] = [];
  contextSubmissions: ContextSubmission[] = [];
  contextUnlockThresholds: ContextUnlockThreshold[] = [];
  challengePrizes: ChallengePrize[] = [];
  prizeAwards: PrizeAward[] = [];
  idempotency: IdempotencyRecord[] = [];
  auditEvents: AuditEvent[] = [];
  imageFavoriteCounts = new Map<string, number>();
  trendingFeed = new Map<TrendingPeriod, TrendingFeedItem[]>([
    ['hourly', []],
    ['daily', []]
  ]);

  async getSiteSettings(): Promise<SiteSettings> { return this.siteSettings; }
  async updateSiteSettings(settings: SiteSettings): Promise<void> { this.siteSettings = settings; }

  async listCreators(): Promise<Creator[]> { return this.creators; }
  async listAllGroupings(): Promise<Grouping[]> { return this.groupings; }
  async listAllSourceFiles(): Promise<SourceFile[]> { return this.sourceFiles; }
  async listAllCreatorGroups(): Promise<CreatorGroup[]> { return this.creatorGroups; }

  async listGroupingsByCreatorSlug(creator: string): Promise<Grouping[]> {
    return this.groupings.filter((g) => g.creatorId === creator && g.status === 'published');
  }

  async getGroupingBySlug(slug: string): Promise<Grouping | null> {
    return this.groupings.find((g) => (g.slugHistory || [g.slug]).includes(slug)) || null;
  }

  async getMediaByGrouping(groupingId: string): Promise<GroupingMediaView[]> {
    return this.groupingMedia
      .filter((item) => item.groupingId === groupingId)
      .sort((a, b) => a.position - b.position)
      .map((placement) => {
        const media = this.media.find((item) => item.mediaId === placement.mediaId);
        if (!media) return null;
        const view: GroupingMediaView = {
          ...media,
          groupingId,
          groupingMediaId: placement.groupingMediaId,
          position: placement.position
        };
        if (placement.isPreview !== undefined) {
          view.isPreview = placement.isPreview;
        }
        if (placement.previewMaxWidth !== undefined) {
          view.previewMaxWidth = placement.previewMaxWidth;
        }
        return view;
      })
      .filter((item): item is GroupingMediaView => Boolean(item));
  }

  async listMediaByCreator(creator: string): Promise<Media[]> {
    return this.media.filter((item) => item.creatorId === creator);
  }

  async listPostsByCreatorSlug(creator: string): Promise<Post[]> {
    const creatorProfile = this.creators.find((item) => item.slug === creator || (item.slugHistory || []).includes(creator));
    if (!creatorProfile) return [];
    return this.posts.filter((item) => item.creatorId === creatorProfile.creatorId);
  }

  async listPostsByCreatorId(creator: string): Promise<Post[]> {
    return this.posts.filter((item) => item.creatorId === creator);
  }

  async listAllPosts(): Promise<Post[]> {
    return this.posts;
  }

  async getPostBySlug(slug: string): Promise<Post | null> {
    return this.posts.find((item) => item.slug === slug || (item.slugHistory || []).includes(slug)) || null;
  }

  async getPostById(postId: string): Promise<Post | null> {
    return this.posts.find((item) => item.postId === postId) || null;
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
    return this.groupingMedia
      .filter((item) => item.mediaId === mediaId)
      .sort((a, b) => a.position - b.position);
  }

  async createCreator(creator: Creator): Promise<void> { this.creators.push(creator); }
  async createGrouping(grouping: Grouping): Promise<void> { this.groupings.push(grouping); }

  async createMedia(
    media: Media,
    groupingId?: string,
    position = 0,
    placement?: {
      isPreview?: boolean;
      previewMaxWidth?: number;
    }
  ): Promise<void> {
    this.media = this.media.filter((item) => item.mediaId !== media.mediaId);
    this.media.push({
      ...media,
      appearsInFeed: media.appearsInFeed !== false
    });
    if (groupingId) {
      this.groupingMedia.push({
        groupingMediaId: randomUUID(),
        groupingId,
        mediaId: media.mediaId,
        position,
        isPreview: placement?.isPreview,
        previewMaxWidth: placement?.previewMaxWidth,
        createdAt: new Date().toISOString()
      });
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
    const media = this.media.find((item) => item.mediaId === mediaId);
    if (!media) return;
    const existing = this.groupingMedia.find((item) => item.groupingId === groupingId && item.mediaId === mediaId);
    if (existing) {
      existing.position = position;
      if (placement?.isPreview !== undefined) {
        existing.isPreview = placement.isPreview;
      }
      if (placement?.previewMaxWidth !== undefined) {
        existing.previewMaxWidth = placement.previewMaxWidth;
      }
      return;
    }
    this.groupingMedia.push({
      groupingMediaId: randomUUID(),
      groupingId,
      mediaId,
      position,
      isPreview: placement?.isPreview,
      previewMaxWidth: placement?.previewMaxWidth,
      createdAt: new Date().toISOString()
    });
  }

  async updateCreator(creator: Creator): Promise<void> {
    this.creators = this.creators.map((item) => (item.creatorId === creator.creatorId ? creator : item));
  }

  async updateGrouping(grouping: Grouping): Promise<void> {
    this.groupings = this.groupings.map((item) => (item.groupingId === grouping.groupingId ? grouping : item));
  }

  async updateMedia(media: Media): Promise<void> {
    this.media = this.media.map((item) => (item.mediaId === media.mediaId ? media : item));
  }

  async createPost(post: Post): Promise<void> {
    this.posts = this.posts.filter((item) => item.postId !== post.postId);
    this.posts.push(post);
  }

  async updatePost(post: Post): Promise<void> {
    this.posts = this.posts.map((item) => (item.postId === post.postId ? post : item));
  }

  async deletePost(postId: string): Promise<void> {
    this.posts = this.posts.filter((item) => item.postId !== postId);
  }

  async moveMediaInGrouping(groupingId: string, mediaId: string, position: number): Promise<void> {
    this.groupingMedia = this.groupingMedia.map((item) => (
      item.groupingId === groupingId && item.mediaId === mediaId
        ? { ...item, position }
        : item
    ));
  }

  async deleteCreator(creator: string): Promise<void> { this.creators = this.creators.filter((a) => a.creatorId !== creator); }

  async deleteGrouping(groupingId: string): Promise<void> {
    this.groupings = this.groupings.filter((g) => g.groupingId !== groupingId);
    const removedMediaIds = new Set(this.groupingMedia.filter((item) => item.groupingId === groupingId).map((item) => item.mediaId));
    this.groupingMedia = this.groupingMedia.filter((item) => item.groupingId !== groupingId);
    this.media = this.media.filter((item) => (
      !removedMediaIds.has(item.mediaId)
      || this.groupingMedia.some((p) => p.mediaId === item.mediaId)
      || item.appearsInFeed !== false
    ));
  }

  async deleteMediaFromGrouping(groupingId: string, mediaId: string): Promise<void> {
    this.groupingMedia = this.groupingMedia.filter((item) => !(item.groupingId === groupingId && item.mediaId === mediaId));
    if (!this.groupingMedia.some((item) => item.mediaId === mediaId)) {
      const media = this.media.find((item) => item.mediaId === mediaId);
      if (media?.appearsInFeed === false) {
        this.media = this.media.filter((item) => item.mediaId !== mediaId);
      }
    }
  }

  async addCreatorMember(member: CreatorMember): Promise<void> {
    this.creatorMembers = this.creatorMembers.filter((item) => !(item.creatorId === member.creatorId && item.userId === member.userId));
    this.creatorMembers.push(member);
  }

  async removeCreatorMember(creatorId: string, userId: string): Promise<void> {
    this.creatorMembers = this.creatorMembers.filter((item) => !(item.creatorId === creatorId && item.userId === userId));
  }

  async listCreatorMembers(creatorId: string): Promise<CreatorMember[]> {
    return this.creatorMembers.filter((item) => item.creatorId === creatorId);
  }

  async listCreatorsByUserId(userId: string): Promise<Creator[]> {
    const ids = new Set(this.creatorMembers.filter((item) => item.userId === userId).map((item) => item.creatorId));
    return this.creators.filter((creator) => ids.has(creator.creatorId));
  }

  async hasCreatorAccess(userId: string, creatorId: string): Promise<boolean> {
    return this.creatorMembers.some((item) => item.userId === userId && item.creatorId === creatorId);
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

  async listPublicCollectionsByProfile(profileType: 'user' | 'creator', profileId: string, limit = 24): Promise<Collection[]> {
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

  async listCollectionsByProfile(profileType: 'user' | 'creator', profileId: string): Promise<Collection[]> {
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

  async followCreator(follow: Follow): Promise<void> {
    this.follows = this.follows.filter((item) => !(item.followerUserId === follow.followerUserId && item.creatorId === follow.creatorId));
    this.follows.push(follow);
  }

  async unfollowCreator(followerUserId: string, creator: string): Promise<void> {
    this.follows = this.follows.filter((item) => !(item.followerUserId === followerUserId && item.creatorId === creator));
  }

  async listFollowsByUser(followerUserId: string): Promise<Follow[]> {
    return this.follows.filter((item) => item.followerUserId === followerUserId);
  }

  async isFollowingCreator(followerUserId: string, creator: string): Promise<boolean> {
    return this.follows.some((item) => item.followerUserId === followerUserId && item.creatorId === creator);
  }

  async countFollowersByCreator(creator: string): Promise<number> {
    return this.follows.filter((item) => item.creatorId === creator).length;
  }

  async listComments(targetType: 'grouping' | 'image', targetId: string): Promise<Comment[]> {
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
    targetType: 'grouping' | 'image' | 'collection',
    targetId: string,
    ownerProfileType: 'user' | 'creator' = 'user',
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

  async listFavoritesByProfile(profileType: 'user' | 'creator', profileId: string): Promise<Favorite[]> {
    return this.favorites.filter((f) => {
      const ownerType = f.ownerProfileType || 'user';
      const ownerId = f.ownerProfileId || f.userId;
      return ownerType === profileType && ownerId === profileId;
    });
  }

  async listPublicFavoritesByProfile(profileType: 'user' | 'creator', profileId: string): Promise<Favorite[]> {
    return this.favorites.filter((f) => {
      const ownerType = f.ownerProfileType || 'user';
      const ownerId = f.ownerProfileId || f.userId;
      return ownerType === profileType && ownerId === profileId && (f.visibility || 'public') === 'public';
    });
  }

  async countFavorites(targetType: 'grouping' | 'image' | 'collection', targetId: string): Promise<number> {
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

  async listTrendingFeed(
    period: TrendingPeriod,
    limit = 24,
    cursor?: string,
    options?: TrendingFeedQueryOptions
  ): Promise<{ items: TrendingFeedItem[]; nextCursor?: string }> {
    const source = options?.source || 'combined';
    const itemTypes = options?.itemTypes || { image: true, video: true, story: true, audio: true };
    const matches = (item: TrendingFeedItem): boolean => {
      const isPostSurface = item.surfaceType === 'post_surface' || Boolean(item.postId);
      if (source === 'media' && isPostSurface) return false;
      if (source === 'post' && !isPostSurface) return false;
      const itemType = isPostSurface
        ? item.postType || (item.assetType === 'video' ? 'video' : item.assetType === 'audio' ? 'audio' : 'image')
        : (item.assetType === 'video' ? 'video' : item.assetType === 'audio' ? 'audio' : 'image');
      return itemTypes[itemType];
    };
    const items = (this.trendingFeed.get(period) || []).filter(matches);
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

  async grantGroupingAccess(userId: string, groupingId: string): Promise<void> {
    if (!this.groupingAccess.some((item) => item.userId === userId && item.groupingId === groupingId)) {
      this.groupingAccess.push({ userId, groupingId });
    }
  }

  async hasGroupingAccess(userId: string, groupingId: string): Promise<boolean> {
    return this.groupingAccess.some((item) => item.userId === userId && item.groupingId === groupingId);
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

  async listUserProfiles(): Promise<UserProfile[]> {
    return [...this.userProfiles];
  }

  async getUserProfileBySlug(slug: string): Promise<UserProfile | null> {
    const normalized = slug.trim().toLowerCase();
    return this.userProfiles.find((item) => item.username === normalized || (item.usernameHistory || []).includes(normalized)) || null;
  }

  async upsertUserProfile(profile: UserProfile): Promise<void> {
    this.userProfiles = this.userProfiles.filter((item) => item.userId !== profile.userId);
    this.userProfiles.push(profile);
  }

  async getUserIdentity(userId: string): Promise<UserIdentity | null> {
    return this.userIdentities.find((item) => item.userId === userId) || null;
  }

  async listUserIdentities(): Promise<UserIdentity[]> {
    return [...this.userIdentities];
  }

  async upsertUserIdentity(identity: UserIdentity): Promise<void> {
    this.userIdentities = this.userIdentities.filter((item) => item.userId !== identity.userId);
    this.userIdentities.push(identity);
  }

  async setUserRole(userId: string, role: PlatformRole): Promise<UserIdentity> {
    const existing = this.getOrCreateIdentity(userId);
    const now = new Date().toISOString();
    const next: UserIdentity = {
      ...existing,
      role,
      capabilities: capabilitiesForRole(role),
      updatedAt: now
    };
    this.userIdentities = this.userIdentities.filter((item) => item.userId !== userId);
    this.userIdentities.push(next);
    return next;
  }

  async listUserExternalLinks(userId: string): Promise<UserExternalLink[]> {
    return this.userExternalLinks.filter((item) => item.userId === userId);
  }

  async upsertUserExternalLink(link: UserExternalLink): Promise<void> {
    this.userExternalLinks = this.userExternalLinks.filter((item) => item.linkId !== link.linkId);
    this.userExternalLinks.push(link);
  }

  async listUserBadges(userId: string): Promise<UserBadge[]> {
    return this.userBadges.filter((item) => item.userId === userId);
  }

  async awardUserBadge(badge: UserBadge): Promise<void> {
    this.userBadges = this.userBadges.filter((item) => item.badgeId !== badge.badgeId);
    this.userBadges.push(badge);
  }

  async listContributionContexts(): Promise<ContributionContext[]> {
    return [...this.contributionContexts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getContributionContextById(contextId: string): Promise<ContributionContext | null> {
    return this.contributionContexts.find((item) => item.contextId === contextId) || null;
  }

  async getContributionContextBySlug(slug: string): Promise<ContributionContext | null> {
    return this.contributionContexts.find((item) => item.slug === slug) || null;
  }

  async createContributionContext(context: ContributionContext): Promise<void> {
    this.contributionContexts = this.contributionContexts.filter((item) => item.contextId !== context.contextId);
    this.contributionContexts.push(context);
  }

  async updateContributionContext(context: ContributionContext): Promise<void> {
    this.contributionContexts = this.contributionContexts.filter((item) => item.contextId !== context.contextId);
    this.contributionContexts.push(context);
  }

  async listContextSubmissions(contextId: string): Promise<ContextSubmission[]> {
    return this.contextSubmissions
      .filter((item) => item.contextId === contextId)
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  }

  async getContextSubmissionById(submissionId: string): Promise<ContextSubmission | null> {
    return this.contextSubmissions.find((item) => item.submissionId === submissionId) || null;
  }

  async createContextSubmission(submission: ContextSubmission): Promise<void> {
    this.contextSubmissions = this.contextSubmissions.filter((item) => item.submissionId !== submission.submissionId);
    this.contextSubmissions.push(submission);
  }

  async updateContextSubmission(submission: ContextSubmission): Promise<void> {
    this.contextSubmissions = this.contextSubmissions.filter((item) => item.submissionId !== submission.submissionId);
    this.contextSubmissions.push(submission);
  }

  async listContextUnlockThresholds(contextId: string): Promise<ContextUnlockThreshold[]> {
    return this.contextUnlockThresholds.filter((item) => item.contextId === contextId);
  }

  async createContextUnlockThreshold(threshold: ContextUnlockThreshold): Promise<void> {
    this.contextUnlockThresholds = this.contextUnlockThresholds.filter((item) => item.unlockId !== threshold.unlockId);
    this.contextUnlockThresholds.push(threshold);
  }

  async updateContextUnlockThreshold(threshold: ContextUnlockThreshold): Promise<void> {
    this.contextUnlockThresholds = this.contextUnlockThresholds.filter((item) => item.unlockId !== threshold.unlockId);
    this.contextUnlockThresholds.push(threshold);
  }

  async listChallengePrizes(contextId: string): Promise<ChallengePrize[]> {
    return this.challengePrizes.filter((item) => item.contextId === contextId);
  }

  async createChallengePrize(prize: ChallengePrize): Promise<void> {
    this.challengePrizes = this.challengePrizes.filter((item) => item.prizeId !== prize.prizeId);
    this.challengePrizes.push(prize);
  }

  async updateChallengePrize(prize: ChallengePrize): Promise<void> {
    this.challengePrizes = this.challengePrizes.filter((item) => item.prizeId !== prize.prizeId);
    this.challengePrizes.push(prize);
  }

  async listPrizeAwards(contextId: string): Promise<PrizeAward[]> {
    return this.prizeAwards.filter((item) => item.contextId === contextId);
  }

  async createPrizeAward(award: PrizeAward): Promise<void> {
    this.prizeAwards = this.prizeAwards.filter((item) => item.prizeAwardId !== award.prizeAwardId);
    this.prizeAwards.push(award);
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
