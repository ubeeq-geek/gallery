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
import type { CanonicalStore } from './canonicalStore';

export interface TrendingFeedQueryOptions {
  source?: 'media' | 'post' | 'combined';
  itemTypes?: {
    image: boolean;
    video: boolean;
    story: boolean;
    audio: boolean;
  };
}

export interface DataStore extends CanonicalStore {
  getSiteSettings(): Promise<SiteSettings>;
  updateSiteSettings(settings: SiteSettings): Promise<void>;

  listCreators(): Promise<Creator[]>;
  listAllGroupings(): Promise<Grouping[]>;
  listGroupingsByCreatorSlug(creatorSlug: string): Promise<Grouping[]>;
  getGroupingBySlug(slug: string): Promise<Grouping | null>;
  getMediaByGrouping(groupingId: string): Promise<GroupingMediaView[]>;
  listMediaByCreator(creatorId: string): Promise<Media[]>;
  listPostsByCreatorSlug(creatorSlug: string): Promise<Post[]>;
  listPostsByCreatorId(creatorId: string): Promise<Post[]>;
  listAllPosts(): Promise<Post[]>;
  listAllSourceFiles?(): Promise<SourceFile[]>;
  listAllCreatorGroups?(): Promise<CreatorGroup[]>;
  listCreatorGroupsByCreatorId?(creatorId: string): Promise<CreatorGroup[]>;
  listSourceFilesByCreatorId?(creatorId: string): Promise<SourceFile[]>;
  getPostBySlug(slug: string): Promise<Post | null>;
  getPostById(postId: string): Promise<Post | null>;
  getSourceFileById?(fileId: string): Promise<SourceFile | null>;
  listMediaGroupingPlacements(mediaId: string): Promise<Array<{
    groupingMediaId: string;
    groupingId: string;
    mediaId: string;
    position: number;
    isPreview?: boolean;
    previewMaxWidth?: number;
    createdAt: string;
  }>>;

  createCreator(creator: Creator): Promise<void>;
  createGrouping(grouping: Grouping): Promise<void>;
  createMedia(
    media: Media,
    groupingId?: string,
    position?: number,
    placement?: {
      isPreview?: boolean;
      previewMaxWidth?: number;
    }
  ): Promise<void>;
  addMediaToGrouping(
    groupingId: string,
    mediaId: string,
    position: number,
    placement?: {
      isPreview?: boolean;
      previewMaxWidth?: number;
    }
  ): Promise<void>;
  updateCreator(creator: Creator): Promise<void>;
  updateGrouping(grouping: Grouping): Promise<void>;
  updateMedia(media: Media): Promise<void>;
  createPost(post: Post): Promise<void>;
  createSourceFile?(file: SourceFile): Promise<void>;
  createCreatorGroup?(group: CreatorGroup): Promise<void>;
  updatePost(post: Post): Promise<void>;
  updateSourceFile?(file: SourceFile): Promise<void>;
  updateCreatorGroup?(group: CreatorGroup): Promise<void>;
  deletePost(postId: string): Promise<void>;
  deleteSourceFile?(fileId: string): Promise<void>;
  deleteCreatorGroup?(groupId: string): Promise<void>;
  moveMediaInGrouping(groupingId: string, mediaId: string, position: number): Promise<void>;
  deleteCreator(creatorId: string): Promise<void>;
  deleteGrouping(groupingId: string): Promise<void>;
  deleteMediaFromGrouping(groupingId: string, mediaId: string): Promise<void>;
  addCreatorMember(member: CreatorMember): Promise<void>;
  removeCreatorMember(creatorId: string, userId: string): Promise<void>;
  listCreatorMembers(creatorId: string): Promise<CreatorMember[]>;
  listCreatorsByUserId(userId: string): Promise<Creator[]>;
  hasCreatorAccess(userId: string, creatorId: string): Promise<boolean>;
  listPublicCollections(limit?: number, cursor?: string): Promise<{ items: Collection[]; nextCursor?: string }>;
  listPublicCollectionsByProfile(profileType: 'user' | 'creator', profileId: string, limit?: number): Promise<Collection[]>;
  listCollectionsByProfile(profileType: 'user' | 'creator', profileId: string): Promise<Collection[]>;
  listCollectionsByOwner(ownerUserId: string): Promise<Collection[]>;
  getCollectionById(collectionId: string): Promise<Collection | null>;
  createCollection(collection: Collection): Promise<void>;
  updateCollection(collection: Collection): Promise<void>;
  deleteCollection(collectionId: string): Promise<void>;
  addImageToCollection(collectionId: string, imageId: string, sortOrder: number): Promise<void>;
  removeImageFromCollection(collectionId: string, imageId: string): Promise<void>;
  listCollectionImageIds(collectionId: string): Promise<string[]>;
  followCreator(follow: Follow): Promise<void>;
  unfollowCreator(followerUserId: string, creatorId: string): Promise<void>;
  listFollowsByUser(followerUserId: string): Promise<Follow[]>;
  isFollowingCreator(followerUserId: string, creatorId: string): Promise<boolean>;
  countFollowersByCreator(creatorId: string): Promise<number>;

  listComments(targetType: 'grouping' | 'image', targetId: string): Promise<Comment[]>;
  createComment(comment: Comment): Promise<void>;
  updateCommentVisibility(commentId: string, hidden: boolean): Promise<void>;
  deleteComment(commentId: string): Promise<void>;

  addFavorite(favorite: Favorite): Promise<void>;
  removeFavorite(
    userId: string,
    targetType: 'grouping' | 'image' | 'collection',
    targetId: string,
    ownerProfileType?: 'user' | 'creator',
    ownerProfileId?: string
  ): Promise<void>;
  listFavoritesByUser(userId: string): Promise<Favorite[]>;
  listFavoritesByProfile(profileType: 'user' | 'creator', profileId: string): Promise<Favorite[]>;
  listPublicFavoritesByProfile(profileType: 'user' | 'creator', profileId: string): Promise<Favorite[]>;
  countFavorites(targetType: 'grouping' | 'image' | 'collection', targetId: string): Promise<number>;
  getImageFavoriteCounts(imageIds: string[]): Promise<Record<string, number>>;
  incrementImageFavoriteCount(imageId: string, delta: number): Promise<void>;
  listTrendingFeed(
    period: TrendingPeriod,
    limit?: number,
    cursor?: string,
    options?: TrendingFeedQueryOptions
  ): Promise<{ items: TrendingFeedItem[]; nextCursor?: string }>;
  replaceTrendingFeed(period: TrendingPeriod, items: TrendingFeedItem[]): Promise<void>;

  blockUser(blockedUser: BlockedUser): Promise<void>;
  unblockUser(userId: string): Promise<void>;
  isUserBlocked(userId: string): Promise<boolean>;
  grantGroupingAccess(userId: string, groupingId: string): Promise<void>;
  hasGroupingAccess(userId: string, groupingId: string): Promise<boolean>;

  isUsernameAvailable(normalizedUsername: string): Promise<boolean>;
  reserveUsername(normalizedUsername: string, username: string, email: string): Promise<void>;
  releaseUsername(normalizedUsername: string): Promise<void>;
  getUserProfileBySlug(slug: string): Promise<UserProfile | null>;
  getUserProfile(userId: string): Promise<UserProfile | null>;
  listUserProfiles?(): Promise<UserProfile[]>;
  upsertUserProfile(profile: UserProfile): Promise<void>;
  getUserIdentity?(userId: string): Promise<UserIdentity | null>;
  listUserIdentities?(): Promise<UserIdentity[]>;
  upsertUserIdentity?(identity: UserIdentity): Promise<void>;
  setUserRole?(userId: string, role: PlatformRole): Promise<UserIdentity>;
  listUserExternalLinks?(userId: string): Promise<UserExternalLink[]>;
  upsertUserExternalLink?(link: UserExternalLink): Promise<void>;
  listUserBadges?(userId: string): Promise<UserBadge[]>;
  awardUserBadge?(badge: UserBadge): Promise<void>;
  listContributionContexts?(): Promise<ContributionContext[]>;
  getContributionContextById?(contextId: string): Promise<ContributionContext | null>;
  getContributionContextBySlug?(slug: string): Promise<ContributionContext | null>;
  createContributionContext?(context: ContributionContext): Promise<void>;
  updateContributionContext?(context: ContributionContext): Promise<void>;
  listContextSubmissions?(contextId: string): Promise<ContextSubmission[]>;
  getContextSubmissionById?(submissionId: string): Promise<ContextSubmission | null>;
  createContextSubmission?(submission: ContextSubmission): Promise<void>;
  updateContextSubmission?(submission: ContextSubmission): Promise<void>;
  listChallengeVotes?(contextId: string): Promise<ChallengeVote[]>;
  getChallengeVote?(contextId: string, submissionId: string, userId: string): Promise<ChallengeVote | null>;
  createChallengeVote?(vote: ChallengeVote): Promise<void>;
  listChallengeLaurels?(contextId?: string): Promise<ChallengeLaurelDefinition[]>;
  createChallengeLaurel?(laurel: ChallengeLaurelDefinition): Promise<void>;
  listChallengeLaurelAwards?(contextId: string): Promise<ChallengeLaurelAward[]>;
  createChallengeLaurelAward?(award: ChallengeLaurelAward): Promise<void>;
  listContextUnlockThresholds?(contextId: string): Promise<ContextUnlockThreshold[]>;
  createContextUnlockThreshold?(threshold: ContextUnlockThreshold): Promise<void>;
  updateContextUnlockThreshold?(threshold: ContextUnlockThreshold): Promise<void>;
  listChallengePrizes?(contextId: string): Promise<ChallengePrize[]>;
  createChallengePrize?(prize: ChallengePrize): Promise<void>;
  updateChallengePrize?(prize: ChallengePrize): Promise<void>;
  listPrizeAwards?(contextId: string): Promise<PrizeAward[]>;
  createPrizeAward?(award: PrizeAward): Promise<void>;

  listExternalAccountsByCreatorIdentity(creatorIdentityId: string): Promise<ExternalAccount[]>;
  listExternalAccountsByUser(userId: string): Promise<ExternalAccount[]>;
  listExternalAccountCreatorAssignments(externalAccountId: string): Promise<ExternalAccountCreatorAssignment[]>;
  replaceExternalAccountCreatorAssignments(externalAccountId: string, assignments: ExternalAccountCreatorAssignment[]): Promise<void>;
  listExternalAccountsForScheduledScan(limit?: number): Promise<ExternalAccount[]>;
  getExternalAccount(externalAccountId: string): Promise<ExternalAccount | null>;
  createExternalAccount(account: ExternalAccount): Promise<void>;
  updateExternalAccount(account: ExternalAccount): Promise<void>;
  getExternalAccountProfile(externalAccountId: string): Promise<ExternalAccountProfile | null>;
  upsertExternalAccountProfile(profile: ExternalAccountProfile): Promise<void>;
  listExternalAccountProfileSnapshots(externalAccountId: string, limit?: number): Promise<ExternalAccountProfileSnapshot[]>;
  createExternalAccountProfileSnapshot(snapshot: ExternalAccountProfileSnapshot): Promise<void>;
  getExternalPlatformCredential(externalPlatformCredentialId: string): Promise<ExternalPlatformCredential | null>;
  listExternalPlatformCredentialsByCreatorIdentity(creatorIdentityId: string): Promise<ExternalPlatformCredential[]>;
  listExternalPlatformCredentialsByUser(userId: string): Promise<ExternalPlatformCredential[]>;
  createExternalPlatformCredential(credential: ExternalPlatformCredential): Promise<void>;
  updateExternalPlatformCredential(credential: ExternalPlatformCredential): Promise<void>;
  deleteExternalPlatformCredential(externalPlatformCredentialId: string): Promise<void>;
  listAssetsByCreatorIdentity(creatorIdentityId: string): Promise<Asset[]>;
  getAsset(assetId: string): Promise<Asset | null>;
  createAsset(asset: Asset): Promise<void>;
  updateAsset(asset: Asset): Promise<void>;
  getExternalPublication(externalAccountId: string, externalContentId: string): Promise<ExternalPublication | null>;
  listExternalPublications(externalAccountId: string): Promise<ExternalPublication[]>;
  createExternalPublication(publication: ExternalPublication): Promise<void>;
  updateExternalPublication(publication: ExternalPublication, previousExternalContentId?: string): Promise<void>;
  getSpacePublication(assetId: string): Promise<SpacePublication | null>;
  upsertSpacePublication(publication: SpacePublication): Promise<void>;
  listExternalCollections(externalAccountId: string): Promise<ExternalCollection[]>;
  createExternalCollection(collection: ExternalCollection): Promise<void>;
  updateExternalCollection(collection: ExternalCollection): Promise<void>;
  listUbeeqCollectionsByCreatorIdentity(creatorIdentityId: string): Promise<UbeeqCollection[]>;
  createUbeeqCollection(collection: UbeeqCollection): Promise<void>;
  updateUbeeqCollection(collection: UbeeqCollection): Promise<void>;
  listUbeeqCollectionAssets(ubeeqCollectionId: string): Promise<UbeeqCollectionAsset[]>;
  replaceUbeeqCollectionAssets(ubeeqCollectionId: string, assets: UbeeqCollectionAsset[]): Promise<void>;
  listExternalCollectionMappings(externalAccountId: string): Promise<ExternalCollectionMapping[]>;
  createExternalCollectionMapping(mapping: ExternalCollectionMapping): Promise<void>;
  updateExternalCollectionMapping(mapping: ExternalCollectionMapping): Promise<void>;
  listExternalEngagementSnapshots(externalPublicationId: string, limit?: number): Promise<ExternalEngagementSnapshot[]>;
  createExternalEngagementSnapshot(snapshot: ExternalEngagementSnapshot): Promise<void>;
  getExternalEngagementCurrent(externalPublicationId: string): Promise<ExternalEngagementCurrent | null>;
  upsertExternalEngagementCurrent(engagement: ExternalEngagementCurrent): Promise<void>;
  listExternalComments(externalPublicationId: string, limit?: number): Promise<ExternalComment[]>;
  createExternalComment(comment: ExternalComment): Promise<void>;
  updateExternalComment(comment: ExternalComment): Promise<void>;
  listExternalFavourites(externalPublicationId: string, limit?: number): Promise<ExternalFavourite[]>;
  upsertExternalFavourite(favourite: ExternalFavourite): Promise<void>;
  listExternalWatchers(externalAccountId: string, limit?: number): Promise<ExternalWatcher[]>;
  upsertExternalWatcher(watcher: ExternalWatcher): Promise<void>;
  getExternalActivityByRemoteId(externalAccountId: string, remoteActivityId: string): Promise<ExternalActivity | null>;
  listExternalActivitiesByAccount(externalAccountId: string, limit?: number): Promise<ExternalActivity[]>;
  listExternalActivitiesByPublication(externalPublicationId: string, limit?: number): Promise<ExternalActivity[]>;
  upsertExternalActivity(activity: ExternalActivity): Promise<void>;
  getExternalSyncCheckpoint(externalAccountId: string, resourceType: ExternalSyncCheckpoint['resourceType'], resourceId: string): Promise<ExternalSyncCheckpoint | null>;
  upsertExternalSyncCheckpoint(checkpoint: ExternalSyncCheckpoint): Promise<void>;
  getExternalSyncJob(externalSyncJobId: string): Promise<ExternalSyncJob | null>;
  listExternalSyncJobs(externalAccountId: string, limit?: number): Promise<ExternalSyncJob[]>;
  listDueExternalSyncJobs(now: string, limit?: number): Promise<ExternalSyncJob[]>;
  createExternalSyncJob(job: ExternalSyncJob): Promise<void>;
  updateExternalSyncJob(job: ExternalSyncJob): Promise<void>;
  listExternalSyncLogs(externalSyncJobId: string, limit?: number): Promise<ExternalSyncLog[]>;
  appendExternalSyncLog(log: ExternalSyncLog): Promise<void>;
  listActiveIntegrationReviewHolds(targets: Array<{ targetType: IntegrationReviewHold['targetType']; targetId: string }>): Promise<IntegrationReviewHold[]>;
  upsertIntegrationReviewHold(hold: IntegrationReviewHold): Promise<void>;

  listCommunityInstallationsByUser(userId: string): Promise<CommunityInstallation[]>;
  getCommunityInstallation(communityInstallationId: string): Promise<CommunityInstallation | null>;
  upsertCommunityInstallation(installation: CommunityInstallation): Promise<void>;
  deleteCommunityInstallation(communityInstallationId: string): Promise<void>;
  listCommunityDestinationsByCreator(creatorIdentityId: string): Promise<CommunityDestination[]>;
  getCommunityDestination(communityDestinationId: string): Promise<CommunityDestination | null>;
  upsertCommunityDestination(destination: CommunityDestination): Promise<void>;
  deleteCommunityDestination(communityDestinationId: string): Promise<void>;
  getCommunityEventByIdempotency(tenantId: string, idempotencyKey: string): Promise<CommunityEvent | null>;
  getCommunityEvent(communityEventId: string): Promise<CommunityEvent | null>;
  createCommunityEvent(event: CommunityEvent): Promise<void>;
  getCommunityDelivery(communityDeliveryId: string): Promise<CommunityDelivery | null>;
  listCommunityDeliveriesByCreator(creatorIdentityId: string, limit?: number): Promise<CommunityDelivery[]>;
  upsertCommunityDelivery(delivery: CommunityDelivery): Promise<void>;

  getIdempotencyRecord(scopeKey: string, idempotencyKey: string): Promise<IdempotencyRecord | null>;
  putIdempotencyRecord(record: IdempotencyRecord): Promise<void>;
  appendAuditEvent(event: AuditEvent): Promise<void>;
  listAuditEvents(limit?: number, cursor?: string): Promise<{ items: AuditEvent[]; nextCursor?: string }>;
}
