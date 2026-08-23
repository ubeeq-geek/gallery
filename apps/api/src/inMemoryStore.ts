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
  ChallengeVote,
  ChallengeLaurelDefinition,
  ChallengeLaurelAward,
  PlatformRole,
  UserCapabilities,
  ExternalAccount,
  ExternalAccountProfile,
  ExternalAccountProfileSnapshot,
  ExternalAccountCreatorAssignment,
  ExternalPlatformCredential,
  Asset,
  ExternalPublication,
  SpacePublication,
  ExternalCollection,
  UbeeqCollection,
  UbeeqCollectionAsset,
  ExternalCollectionMapping,
  ExternalEngagementSnapshot,
  ExternalEngagementCurrent,
  ExternalComment,
  ExternalFavourite,
  ExternalWatcher,
  ExternalActivity,
  ExternalSyncCheckpoint,
  ExternalSyncJob,
  ExternalSyncLog,
  IntegrationReviewHold,
  CommunityInstallation,
  CommunityDestination,
  CommunityEvent,
  CommunityDelivery
} from './domain';
import type { DataStore, TrendingFeedQueryOptions } from './store';
import type { WordPressIntegrationState } from './wordpressIntegration';
import { capabilitiesForRole } from './roleHelpers';
import type {
  CanonicalAsset,
  CollectionWork,
  CreatorCollection,
  Publication,
  PublicationIntent,
  Work,
  WorkAsset,
  WorkDiscoveryParticipation
} from './canonicalDomain';

export class InMemoryStore implements DataStore {
  private wordpressStates = new Map<string, WordPressIntegrationState>();

  async getWordPressIntegrationState(tenantId: string): Promise<WordPressIntegrationState> {
    return structuredClone(this.wordpressStates.get(tenantId) || { connections: [], publications: [], externalReferences: [], mediaMappings: [], audits: [] });
  }

  async putWordPressIntegrationState(tenantId: string, state: WordPressIntegrationState): Promise<void> {
    this.wordpressStates.set(tenantId, structuredClone(state));
  }

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
  challengeVotes: ChallengeVote[] = [];
  challengeLaurels: ChallengeLaurelDefinition[] = [];
  challengeLaurelAwards: ChallengeLaurelAward[] = [];
  externalAccounts: ExternalAccount[] = [];
  externalAccountProfiles: ExternalAccountProfile[] = [];
  externalAccountProfileSnapshots: ExternalAccountProfileSnapshot[] = [];
  externalAccountCreatorAssignments: ExternalAccountCreatorAssignment[] = [];
  externalPlatformCredentials: ExternalPlatformCredential[] = [];
  assets: Asset[] = [];
  externalPublications: ExternalPublication[] = [];
  spacePublications: SpacePublication[] = [];
  externalCollections: ExternalCollection[] = [];
  ubeeqCollections: UbeeqCollection[] = [];
  ubeeqCollectionAssets: UbeeqCollectionAsset[] = [];
  externalCollectionMappings: ExternalCollectionMapping[] = [];
  externalEngagementSnapshots: ExternalEngagementSnapshot[] = [];
  externalEngagementCurrent: ExternalEngagementCurrent[] = [];
  externalComments: ExternalComment[] = [];
  externalFavourites: ExternalFavourite[] = [];
  externalWatchers: ExternalWatcher[] = [];
  externalActivities: ExternalActivity[] = [];
  externalSyncCheckpoints: ExternalSyncCheckpoint[] = [];
  externalSyncJobs: ExternalSyncJob[] = [];
  externalSyncLogs: ExternalSyncLog[] = [];
  integrationReviewHolds: IntegrationReviewHold[] = [];
  communityInstallations: CommunityInstallation[] = [];
  communityDestinations: CommunityDestination[] = [];
  communityEvents: CommunityEvent[] = [];
  communityDeliveries: CommunityDelivery[] = [];
  idempotency: IdempotencyRecord[] = [];
  auditEvents: AuditEvent[] = [];
  works: Work[] = [];
  canonicalAssets: CanonicalAsset[] = [];
  workAssets: Array<WorkAsset & { tenantId: string }> = [];
  publications: Publication[] = [];
  publicationIntents: PublicationIntent[] = [];
  creatorCollections: CreatorCollection[] = [];
  collectionWorks: Array<CollectionWork & { tenantId: string }> = [];
  workDiscovery: WorkDiscoveryParticipation[] = [];
  imageFavoriteCounts = new Map<string, number>();
  trendingFeed = new Map<TrendingPeriod, TrendingFeedItem[]>([
    ['hourly', []],
    ['daily', []]
  ]);

  async getSiteSettings(): Promise<SiteSettings> { return this.siteSettings; }
  async updateSiteSettings(settings: SiteSettings): Promise<void> { this.siteSettings = settings; }

  async listWorksByCreator(tenantId: string, creatorId: string): Promise<Work[]> {
    return this.works
      .filter((work) => work.tenantId === tenantId && work.creatorId === creatorId && work.status !== 'deleted')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getWork(tenantId: string, workId: string): Promise<Work | null> {
    return this.works.find((work) => work.tenantId === tenantId && work.workId === workId) || null;
  }

  async createWork(work: Work): Promise<void> {
    this.works = this.works.filter((item) => !(item.tenantId === work.tenantId && item.workId === work.workId));
    this.works.push(work);
  }

  async updateWork(work: Work): Promise<void> { await this.createWork(work); }

  async listCanonicalAssetsByWork(tenantId: string, workId: string): Promise<Array<CanonicalAsset & { attachment: WorkAsset }>> {
    return this.workAssets
      .filter((attachment) => attachment.tenantId === tenantId && attachment.workId === workId)
      .sort((a, b) => a.position - b.position)
      .map((attachment) => {
        const asset = this.canonicalAssets.find((candidate) => candidate.tenantId === tenantId && candidate.assetId === attachment.assetId);
        const { tenantId: _attachmentTenantId, ...publicAttachment } = attachment;
        return asset ? { ...asset, attachment: publicAttachment } : null;
      })
      .filter((asset): asset is CanonicalAsset & { attachment: WorkAsset } => Boolean(asset));
  }

  async getCanonicalAsset(tenantId: string, assetId: string): Promise<CanonicalAsset | null> {
    return this.canonicalAssets.find((asset) => asset.tenantId === tenantId && asset.assetId === assetId) || null;
  }

  async createCanonicalAsset(asset: CanonicalAsset): Promise<void> {
    this.canonicalAssets = this.canonicalAssets.filter((item) => !(item.tenantId === asset.tenantId && item.assetId === asset.assetId));
    this.canonicalAssets.push(asset);
  }

  async updateCanonicalAsset(asset: CanonicalAsset): Promise<void> { await this.createCanonicalAsset(asset); }

  async attachAssetToWork(tenantId: string, attachment: WorkAsset): Promise<void> {
    this.workAssets = this.workAssets.filter((item) => !(item.tenantId === tenantId && item.workId === attachment.workId && item.assetId === attachment.assetId));
    this.workAssets.push({ ...attachment, tenantId });
  }

  async detachAssetFromWork(tenantId: string, workId: string, assetId: string): Promise<void> {
    this.workAssets = this.workAssets.filter((item) => !(item.tenantId === tenantId && item.workId === workId && item.assetId === assetId));
  }

  async listPublicationsByWork(tenantId: string, workId: string): Promise<Publication[]> {
    return this.publications
      .filter((publication) => publication.tenantId === tenantId && publication.workId === workId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listPublicationsByDestination(tenantId: string, destination: Publication['destination']): Promise<Publication[]> {
    return this.publications
      .filter((publication) => publication.tenantId === tenantId && publication.destination === destination)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getPublication(tenantId: string, publicationId: string): Promise<Publication | null> {
    return this.publications.find((publication) => publication.tenantId === tenantId && publication.publicationId === publicationId) || null;
  }

  async upsertPublication(publication: Publication): Promise<void> {
    this.publications = this.publications.filter((item) => !(item.tenantId === publication.tenantId && item.publicationId === publication.publicationId));
    this.publications.push(publication);
  }

  async listPublicationIntentsByWork(tenantId: string, workId: string): Promise<PublicationIntent[]> {
    return this.publicationIntents.filter((intent) => intent.tenantId === tenantId && intent.workId === workId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getPublicationIntent(tenantId: string, publicationIntentId: string): Promise<PublicationIntent | null> {
    return this.publicationIntents.find((intent) => intent.tenantId === tenantId && intent.publicationIntentId === publicationIntentId) || null;
  }

  async upsertPublicationIntent(intent: PublicationIntent): Promise<void> {
    this.publicationIntents = this.publicationIntents.filter((item) => !(item.tenantId === intent.tenantId && item.publicationIntentId === intent.publicationIntentId));
    this.publicationIntents.push(intent);
  }

  async deletePublicationIntent(tenantId: string, publicationIntentId: string): Promise<void> {
    this.publicationIntents = this.publicationIntents.filter((intent) => !(intent.tenantId === tenantId && intent.publicationIntentId === publicationIntentId));
  }

  async listCreatorCollections(tenantId: string, creatorId: string): Promise<CreatorCollection[]> {
    return this.creatorCollections
      .filter((collection) => collection.tenantId === tenantId && collection.creatorId === creatorId && collection.status !== 'deleted')
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  async getCreatorCollection(tenantId: string, collectionId: string): Promise<CreatorCollection | null> {
    return this.creatorCollections.find((collection) => collection.tenantId === tenantId && collection.collectionId === collectionId) || null;
  }

  async createCreatorCollection(collection: CreatorCollection): Promise<void> {
    this.creatorCollections = this.creatorCollections.filter((item) => !(item.tenantId === collection.tenantId && item.collectionId === collection.collectionId));
    this.creatorCollections.push(collection);
  }

  async updateCreatorCollection(collection: CreatorCollection): Promise<void> { await this.createCreatorCollection(collection); }

  async listCollectionWorks(tenantId: string, collectionId: string): Promise<CollectionWork[]> {
    const collection = await this.getCreatorCollection(tenantId, collectionId);
    if (!collection) return [];
    return this.collectionWorks.filter((item) => item.tenantId === tenantId && item.collectionId === collectionId).sort((a, b) => a.position - b.position);
  }

  async replaceCollectionWorks(tenantId: string, collectionId: string, works: CollectionWork[]): Promise<void> {
    if (!(await this.getCreatorCollection(tenantId, collectionId))) throw new Error('Collection not found');
    this.collectionWorks = [
      ...this.collectionWorks.filter((item) => !(item.tenantId === tenantId && item.collectionId === collectionId)),
      ...works.map((item) => ({ ...item, tenantId }))
    ];
  }

  async getWorkDiscoveryParticipation(tenantId: string, workId: string): Promise<WorkDiscoveryParticipation | null> {
    return this.workDiscovery.find((item) => item.tenantId === tenantId && item.workId === workId) || null;
  }

  async upsertWorkDiscoveryParticipation(participation: WorkDiscoveryParticipation): Promise<void> {
    this.workDiscovery = this.workDiscovery.filter((item) => !(item.tenantId === participation.tenantId && item.workId === participation.workId));
    this.workDiscovery.push(participation);
  }

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

  async listChallengeVotes(contextId: string): Promise<ChallengeVote[]> {
    return this.challengeVotes.filter((vote) => vote.contextId === contextId);
  }

  async getChallengeVote(contextId: string, submissionId: string, userId: string): Promise<ChallengeVote | null> {
    return this.challengeVotes.find((vote) => vote.contextId === contextId && vote.submissionId === submissionId && vote.userId === userId) || null;
  }

  async createChallengeVote(vote: ChallengeVote): Promise<void> {
    this.challengeVotes = this.challengeVotes.filter((item) => item.voteId !== vote.voteId && !(item.contextId === vote.contextId && item.submissionId === vote.submissionId && item.userId === vote.userId));
    this.challengeVotes.push(vote);
  }

  async listChallengeLaurels(contextId?: string): Promise<ChallengeLaurelDefinition[]> {
    return this.challengeLaurels.filter((item) => !contextId || !item.contextId || item.contextId === contextId);
  }

  async createChallengeLaurel(laurel: ChallengeLaurelDefinition): Promise<void> {
    this.challengeLaurels = this.challengeLaurels.filter((item) => item.laurelId !== laurel.laurelId);
    this.challengeLaurels.push(laurel);
  }

  async listChallengeLaurelAwards(contextId: string): Promise<ChallengeLaurelAward[]> {
    return this.challengeLaurelAwards.filter((item) => item.contextId === contextId);
  }

  async createChallengeLaurelAward(award: ChallengeLaurelAward): Promise<void> {
    this.challengeLaurelAwards = this.challengeLaurelAwards.filter((item) => item.awardId !== award.awardId);
    this.challengeLaurelAwards.push(award);
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

  async listExternalAccountsByCreatorIdentity(creatorIdentityId: string): Promise<ExternalAccount[]> {
    const assignedAccountIds = new Set(this.externalAccountCreatorAssignments
      .filter((item) => item.creatorIdentityId === creatorIdentityId)
      .map((item) => item.externalAccountId));
    return this.externalAccounts.filter((item) => item.creatorIdentityId === creatorIdentityId || assignedAccountIds.has(item.externalAccountId));
  }

  async listExternalAccountsByUser(userId: string): Promise<ExternalAccount[]> {
    return this.externalAccounts.filter((item) => item.userId === userId);
  }

  async listExternalAccountCreatorAssignments(externalAccountId: string): Promise<ExternalAccountCreatorAssignment[]> {
    return this.externalAccountCreatorAssignments.filter((item) => item.externalAccountId === externalAccountId);
  }

  async replaceExternalAccountCreatorAssignments(externalAccountId: string, assignments: ExternalAccountCreatorAssignment[]): Promise<void> {
    this.externalAccountCreatorAssignments = this.externalAccountCreatorAssignments
      .filter((item) => item.externalAccountId !== externalAccountId)
      .concat(assignments);
  }

  async listExternalAccountsForScheduledScan(limit = 100): Promise<ExternalAccount[]> {
    return this.externalAccounts
      .filter((item) => item.platform === 'deviantart')
      .sort((a, b) => String(a.lastSuccessfulSyncAt || a.createdAt).localeCompare(String(b.lastSuccessfulSyncAt || b.createdAt)))
      .slice(0, limit);
  }

  async getExternalAccount(externalAccountId: string): Promise<ExternalAccount | null> {
    return this.externalAccounts.find((item) => item.externalAccountId === externalAccountId) || null;
  }

  async createExternalAccount(account: ExternalAccount): Promise<void> {
    this.externalAccounts = this.externalAccounts.filter((item) => item.externalAccountId !== account.externalAccountId);
    this.externalAccounts.push(account);
  }

  async updateExternalAccount(account: ExternalAccount): Promise<void> {
    await this.createExternalAccount(account);
  }

  async getExternalAccountProfile(externalAccountId: string): Promise<ExternalAccountProfile | null> {
    return this.externalAccountProfiles.find((profile) => profile.externalAccountId === externalAccountId) || null;
  }

  async upsertExternalAccountProfile(profile: ExternalAccountProfile): Promise<void> {
    this.externalAccountProfiles = this.externalAccountProfiles.filter((item) => item.externalAccountId !== profile.externalAccountId);
    this.externalAccountProfiles.push(profile);
  }

  async listExternalAccountProfileSnapshots(externalAccountId: string, limit = 100): Promise<ExternalAccountProfileSnapshot[]> {
    return this.externalAccountProfileSnapshots
      .filter((profile) => profile.externalAccountId === externalAccountId)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
      .slice(0, limit);
  }

  async createExternalAccountProfileSnapshot(snapshot: ExternalAccountProfileSnapshot): Promise<void> {
    this.externalAccountProfileSnapshots = this.externalAccountProfileSnapshots
      .filter((item) => item.externalAccountProfileSnapshotId !== snapshot.externalAccountProfileSnapshotId);
    this.externalAccountProfileSnapshots.push(snapshot);
  }

  async getExternalPlatformCredential(externalPlatformCredentialId: string): Promise<ExternalPlatformCredential | null> {
    return this.externalPlatformCredentials.find((item) => item.externalPlatformCredentialId === externalPlatformCredentialId) || null;
  }

  async listExternalPlatformCredentialsByCreatorIdentity(creatorIdentityId: string): Promise<ExternalPlatformCredential[]> {
    return this.externalPlatformCredentials.filter((item) => item.creatorIdentityId === creatorIdentityId);
  }

  async listExternalPlatformCredentialsByUser(userId: string): Promise<ExternalPlatformCredential[]> {
    return this.externalPlatformCredentials.filter((item) => item.userId === userId);
  }

  async createExternalPlatformCredential(credential: ExternalPlatformCredential): Promise<void> {
    this.externalPlatformCredentials = this.externalPlatformCredentials.filter((item) => item.externalPlatformCredentialId !== credential.externalPlatformCredentialId);
    this.externalPlatformCredentials.push(credential);
  }

  async updateExternalPlatformCredential(credential: ExternalPlatformCredential): Promise<void> {
    await this.createExternalPlatformCredential(credential);
  }

  async deleteExternalPlatformCredential(externalPlatformCredentialId: string): Promise<void> {
    this.externalPlatformCredentials = this.externalPlatformCredentials
      .filter((item) => item.externalPlatformCredentialId !== externalPlatformCredentialId);
  }

  async listAssetsByCreatorIdentity(creatorIdentityId: string): Promise<Asset[]> {
    return this.assets
      .filter((item) => item.creatorIdentityId === creatorIdentityId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getAsset(assetId: string): Promise<Asset | null> {
    return this.assets.find((item) => item.assetId === assetId) || null;
  }

  async createAsset(asset: Asset): Promise<void> {
    this.assets = this.assets.filter((item) => item.assetId !== asset.assetId);
    this.assets.push(asset);
  }

  async updateAsset(asset: Asset): Promise<void> {
    await this.createAsset(asset);
  }

  async getExternalPublication(externalAccountId: string, externalContentId: string): Promise<ExternalPublication | null> {
    return this.externalPublications.find((item) => (
      item.externalAccountId === externalAccountId && item.externalContentId === externalContentId
    )) || null;
  }

  async listExternalPublications(externalAccountId: string): Promise<ExternalPublication[]> {
    return this.externalPublications
      .filter((item) => item.externalAccountId === externalAccountId)
      .sort((a, b) => (b.publishedAt || b.createdAt).localeCompare(a.publishedAt || a.createdAt));
  }

  async createExternalPublication(publication: ExternalPublication): Promise<void> {
    this.externalPublications = this.externalPublications.filter((item) => !(
      item.externalAccountId === publication.externalAccountId && item.externalContentId === publication.externalContentId
    ));
    this.externalPublications.push(publication);
  }

  async updateExternalPublication(publication: ExternalPublication, previousExternalContentId?: string): Promise<void> {
    if (previousExternalContentId && previousExternalContentId !== publication.externalContentId) {
      this.externalPublications = this.externalPublications.filter((item) => !(
        item.externalAccountId === publication.externalAccountId
        && item.externalContentId === previousExternalContentId
      ));
    }
    await this.createExternalPublication(publication);
  }

  async getSpacePublication(assetId: string): Promise<SpacePublication | null> {
    return this.spacePublications.find((item) => item.assetId === assetId) || null;
  }

  async upsertSpacePublication(publication: SpacePublication): Promise<void> {
    this.spacePublications = this.spacePublications.filter((item) => item.assetId !== publication.assetId);
    this.spacePublications.push(publication);
  }

  async listExternalCollections(externalAccountId: string): Promise<ExternalCollection[]> {
    return this.externalCollections
      .filter((item) => item.externalAccountId === externalAccountId)
      .sort((a, b) => (a.position || 0) - (b.position || 0));
  }

  async createExternalCollection(collection: ExternalCollection): Promise<void> {
    this.externalCollections = this.externalCollections.filter((item) => !(
      item.externalAccountId === collection.externalAccountId
      && item.externalCollectionExternalId === collection.externalCollectionExternalId
    ));
    this.externalCollections.push(collection);
  }

  async updateExternalCollection(collection: ExternalCollection): Promise<void> {
    await this.createExternalCollection(collection);
  }

  async listUbeeqCollectionsByCreatorIdentity(creatorIdentityId: string): Promise<UbeeqCollection[]> {
    return this.ubeeqCollections
      .filter((item) => item.creatorIdentityId === creatorIdentityId)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  async createUbeeqCollection(collection: UbeeqCollection): Promise<void> {
    this.ubeeqCollections = this.ubeeqCollections.filter((item) => item.ubeeqCollectionId !== collection.ubeeqCollectionId);
    this.ubeeqCollections.push(collection);
  }

  async updateUbeeqCollection(collection: UbeeqCollection): Promise<void> {
    await this.createUbeeqCollection(collection);
  }

  async listUbeeqCollectionAssets(ubeeqCollectionId: string): Promise<UbeeqCollectionAsset[]> {
    return this.ubeeqCollectionAssets.filter((item) => item.ubeeqCollectionId === ubeeqCollectionId);
  }

  async replaceUbeeqCollectionAssets(ubeeqCollectionId: string, assets: UbeeqCollectionAsset[]): Promise<void> {
    this.ubeeqCollectionAssets = [
      ...this.ubeeqCollectionAssets.filter((item) => item.ubeeqCollectionId !== ubeeqCollectionId),
      ...assets
    ];
  }

  async listExternalCollectionMappings(externalAccountId: string): Promise<ExternalCollectionMapping[]> {
    return this.externalCollectionMappings.filter((item) => item.externalAccountId === externalAccountId);
  }

  async createExternalCollectionMapping(mapping: ExternalCollectionMapping): Promise<void> {
    this.externalCollectionMappings = this.externalCollectionMappings.filter((item) => item.externalCollectionMappingId !== mapping.externalCollectionMappingId);
    this.externalCollectionMappings.push(mapping);
  }

  async updateExternalCollectionMapping(mapping: ExternalCollectionMapping): Promise<void> {
    await this.createExternalCollectionMapping(mapping);
  }

  async listExternalEngagementSnapshots(externalPublicationId: string, limit = 100): Promise<ExternalEngagementSnapshot[]> {
    return this.externalEngagementSnapshots
      .filter((item) => item.externalPublicationId === externalPublicationId)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
      .slice(0, limit);
  }

  async createExternalEngagementSnapshot(snapshot: ExternalEngagementSnapshot): Promise<void> {
    this.externalEngagementSnapshots = this.externalEngagementSnapshots.filter((item) => item.externalEngagementSnapshotId !== snapshot.externalEngagementSnapshotId);
    this.externalEngagementSnapshots.push(snapshot);
  }

  async getExternalEngagementCurrent(externalPublicationId: string): Promise<ExternalEngagementCurrent | null> {
    return this.externalEngagementCurrent.find((item) => item.externalPublicationId === externalPublicationId) || null;
  }

  async upsertExternalEngagementCurrent(engagement: ExternalEngagementCurrent): Promise<void> {
    this.externalEngagementCurrent = this.externalEngagementCurrent.filter((item) => item.externalPublicationId !== engagement.externalPublicationId);
    this.externalEngagementCurrent.push(engagement);
  }

  async listExternalComments(externalPublicationId: string, limit = 100): Promise<ExternalComment[]> {
    return this.externalComments
      .filter((item) => item.externalPublicationId === externalPublicationId)
      .sort((a, b) => (b.createdAtRemote || b.lastSyncedAt).localeCompare(a.createdAtRemote || a.lastSyncedAt))
      .slice(0, limit);
  }

  async createExternalComment(comment: ExternalComment): Promise<void> {
    this.externalComments = this.externalComments.filter((item) => !(
      item.externalPublicationId === comment.externalPublicationId
      && item.externalCommentExternalId === comment.externalCommentExternalId
    ));
    this.externalComments.push(comment);
  }

  async updateExternalComment(comment: ExternalComment): Promise<void> {
    await this.createExternalComment(comment);
  }

  async listExternalFavourites(externalPublicationId: string, limit = 100): Promise<ExternalFavourite[]> {
    return this.externalFavourites
      .filter((item) => item.externalPublicationId === externalPublicationId)
      .sort((a, b) => String(b.favouritedAtRemote || b.lastSeenAt).localeCompare(String(a.favouritedAtRemote || a.lastSeenAt)))
      .slice(0, limit);
  }

  async upsertExternalFavourite(favourite: ExternalFavourite): Promise<void> {
    this.externalFavourites = this.externalFavourites.filter((item) => !(
      item.externalPublicationId === favourite.externalPublicationId && item.externalUserId === favourite.externalUserId
    ));
    this.externalFavourites.push(favourite);
  }

  async listExternalWatchers(externalAccountId: string, limit = 50050): Promise<ExternalWatcher[]> {
    return this.externalWatchers
      .filter((item) => item.externalAccountId === externalAccountId)
      .sort((a, b) => a.externalUsername.localeCompare(b.externalUsername))
      .slice(0, limit);
  }

  async upsertExternalWatcher(watcher: ExternalWatcher): Promise<void> {
    this.externalWatchers = this.externalWatchers.filter((item) => !(
      item.externalAccountId === watcher.externalAccountId && item.externalUserId === watcher.externalUserId
    ));
    this.externalWatchers.push(watcher);
  }

  async getExternalActivityByRemoteId(externalAccountId: string, remoteActivityId: string): Promise<ExternalActivity | null> {
    return this.externalActivities.find((item) => item.externalAccountId === externalAccountId && item.remoteActivityId === remoteActivityId) || null;
  }

  async listExternalActivitiesByAccount(externalAccountId: string, limit = 100): Promise<ExternalActivity[]> {
    return this.externalActivities
      .filter((item) => item.externalAccountId === externalAccountId)
      .sort((a, b) => String(b.occurredAt || b.firstSeenAt).localeCompare(String(a.occurredAt || a.firstSeenAt)))
      .slice(0, limit);
  }

  async listExternalActivitiesByPublication(externalPublicationId: string, limit = 100): Promise<ExternalActivity[]> {
    return this.externalActivities
      .filter((item) => item.externalPublicationId === externalPublicationId)
      .sort((a, b) => String(b.occurredAt || b.firstSeenAt).localeCompare(String(a.occurredAt || a.firstSeenAt)))
      .slice(0, limit);
  }

  async upsertExternalActivity(activity: ExternalActivity): Promise<void> {
    this.externalActivities = this.externalActivities.filter((item) => !(
      item.externalAccountId === activity.externalAccountId && item.remoteActivityId === activity.remoteActivityId
    ));
    this.externalActivities.push(activity);
  }

  async getExternalSyncCheckpoint(externalAccountId: string, resourceType: ExternalSyncCheckpoint['resourceType'], resourceId: string): Promise<ExternalSyncCheckpoint | null> {
    return this.externalSyncCheckpoints.find((item) => item.externalAccountId === externalAccountId && item.resourceType === resourceType && item.resourceId === resourceId) || null;
  }

  async upsertExternalSyncCheckpoint(checkpoint: ExternalSyncCheckpoint): Promise<void> {
    this.externalSyncCheckpoints = this.externalSyncCheckpoints.filter((item) => !(
      item.externalAccountId === checkpoint.externalAccountId && item.resourceType === checkpoint.resourceType && item.resourceId === checkpoint.resourceId
    ));
    this.externalSyncCheckpoints.push(checkpoint);
  }

  async getExternalSyncJob(externalSyncJobId: string): Promise<ExternalSyncJob | null> {
    return this.externalSyncJobs.find((item) => item.externalSyncJobId === externalSyncJobId) || null;
  }

  async listExternalSyncJobs(externalAccountId: string, limit = 100): Promise<ExternalSyncJob[]> {
    return this.externalSyncJobs
      .filter((item) => item.externalAccountId === externalAccountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async listDueExternalSyncJobs(now: string, limit = 100): Promise<ExternalSyncJob[]> {
    return this.externalSyncJobs
      .filter((item) => (item.status === 'retry_scheduled' || item.status === 'rate_limited') && Boolean(item.nextAttemptAt))
      .filter((item) => String(item.nextAttemptAt) <= now)
      .sort((a, b) => String(a.nextAttemptAt).localeCompare(String(b.nextAttemptAt)))
      .slice(0, limit);
  }

  async createExternalSyncJob(job: ExternalSyncJob): Promise<void> {
    this.externalSyncJobs = this.externalSyncJobs.filter((item) => item.externalSyncJobId !== job.externalSyncJobId);
    this.externalSyncJobs.push(job);
  }

  async updateExternalSyncJob(job: ExternalSyncJob): Promise<void> {
    await this.createExternalSyncJob(job);
  }

  async listExternalSyncLogs(externalSyncJobId: string, limit = 100): Promise<ExternalSyncLog[]> {
    return this.externalSyncLogs
      .filter((item) => item.externalSyncJobId === externalSyncJobId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async appendExternalSyncLog(log: ExternalSyncLog): Promise<void> {
    this.externalSyncLogs.push(log);
  }

  async listActiveIntegrationReviewHolds(targets: Array<{ targetType: IntegrationReviewHold['targetType']; targetId: string }>): Promise<IntegrationReviewHold[]> {
    return this.integrationReviewHolds.filter((hold) => hold.active && targets.some((target) => target.targetType === hold.targetType && target.targetId === hold.targetId));
  }

  async upsertIntegrationReviewHold(hold: IntegrationReviewHold): Promise<void> {
    this.integrationReviewHolds = this.integrationReviewHolds.filter((item) => item.integrationReviewHoldId !== hold.integrationReviewHoldId);
    this.integrationReviewHolds.push(hold);
  }

  async listCommunityInstallationsByUser(userId: string): Promise<CommunityInstallation[]> {
    return this.communityInstallations.filter((item) => item.userId === userId).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async getCommunityInstallation(communityInstallationId: string): Promise<CommunityInstallation | null> {
    return this.communityInstallations.find((item) => item.communityInstallationId === communityInstallationId) || null;
  }

  async upsertCommunityInstallation(installation: CommunityInstallation): Promise<void> {
    this.communityInstallations = this.communityInstallations.filter((item) => item.communityInstallationId !== installation.communityInstallationId);
    this.communityInstallations.push(installation);
  }

  async deleteCommunityInstallation(communityInstallationId: string): Promise<void> {
    this.communityInstallations = this.communityInstallations.filter((item) => item.communityInstallationId !== communityInstallationId);
    this.communityDestinations = this.communityDestinations.filter((item) => item.communityInstallationId !== communityInstallationId);
  }

  async listCommunityDestinationsByCreator(creatorIdentityId: string): Promise<CommunityDestination[]> {
    return this.communityDestinations.filter((item) => item.creatorIdentityId === creatorIdentityId).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async getCommunityDestination(communityDestinationId: string): Promise<CommunityDestination | null> {
    return this.communityDestinations.find((item) => item.communityDestinationId === communityDestinationId) || null;
  }

  async upsertCommunityDestination(destination: CommunityDestination): Promise<void> {
    this.communityDestinations = this.communityDestinations.filter((item) => item.communityDestinationId !== destination.communityDestinationId);
    this.communityDestinations.push(destination);
  }

  async deleteCommunityDestination(communityDestinationId: string): Promise<void> {
    this.communityDestinations = this.communityDestinations.filter((item) => item.communityDestinationId !== communityDestinationId);
  }

  async getCommunityEventByIdempotency(tenantId: string, idempotencyKey: string): Promise<CommunityEvent | null> {
    return this.communityEvents.find((item) => item.tenantId === tenantId && item.idempotencyKey === idempotencyKey) || null;
  }

  async getCommunityEvent(communityEventId: string): Promise<CommunityEvent | null> {
    return this.communityEvents.find((item) => item.communityEventId === communityEventId) || null;
  }

  async createCommunityEvent(event: CommunityEvent): Promise<void> {
    this.communityEvents = this.communityEvents.filter((item) => item.communityEventId !== event.communityEventId);
    this.communityEvents.push(event);
  }

  async getCommunityDelivery(communityDeliveryId: string): Promise<CommunityDelivery | null> {
    return this.communityDeliveries.find((item) => item.communityDeliveryId === communityDeliveryId) || null;
  }

  async listCommunityDeliveriesByCreator(creatorIdentityId: string, limit = 100): Promise<CommunityDelivery[]> {
    return this.communityDeliveries.filter((item) => item.creatorIdentityId === creatorIdentityId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  async upsertCommunityDelivery(delivery: CommunityDelivery): Promise<void> {
    this.communityDeliveries = this.communityDeliveries.filter((item) => item.communityDeliveryId !== delivery.communityDeliveryId);
    this.communityDeliveries.push(delivery);
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
