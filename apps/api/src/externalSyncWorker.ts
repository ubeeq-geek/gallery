import { createHash, randomUUID } from 'crypto';
import type { AppConfig } from './config';
import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import { openStoredUbeeqWorkStream, readStoredUbeeqWorkImage, storeExternalContent } from './externalContentStorage';
import { brandForConfig } from './brand';
import { createExternalSyncQueue, type ExternalSyncQueue } from './externalSyncQueue';
import { createStoreIntegrationPolicyGate, requireIntegrationOperation, type IntegrationOperation } from './integrationStandard';
import { recordPublicationReconciliation } from './integrationReconciliation';
import { recordExternalPublicationLifecycle, type RemotePublicationState } from './integrationSync';
import { deliveryRetryDelaySeconds, shouldRetryIntegrationDelivery } from './integrationDelivery';
import { createExternalPlatformProvider, DEVIANTART_METADATA_BATCH_SIZE, ExternalProviderError, type ExternalContentPublish, type ExternalContentUpdate, type ExternalPlatformProvider, type ExternalRemoteActivity, type ExternalRemoteComment, type ExternalRemoteContent, type ExternalRemoteEngagement } from './externalPlatformProvider';
import type { Asset, ExternalAccount, ExternalAccountProfile, ExternalCollection, ExternalCollectionMapping, ExternalComment, ExternalEngagementCurrent, ExternalPublication, ExternalSyncCheckpoint, ExternalSyncJob, ExternalSyncJobType, ExternalWatcher, IntegrationActivity, SpacePublication, UbeeqCollection, UbeeqCollectionAsset } from './domain';
import type { CanonicalAsset, Publication, Work } from './canonicalDomain';
import type { DataStore } from './store';

// Preserve the existing sync-worker convention: the first retry waits at
// least the configured base delay. Delivery jobs share the same jitter curve
// after that first cooldown.
export const retryDelaySeconds = (attempt: number, configuredBase: number, random = Math.random): number => (
  Math.max(Math.max(1, Math.floor(configuredBase)), deliveryRetryDelaySeconds(attempt, configuredBase, random))
);

export const MAX_AMBIGUOUS_PUBLISH_ATTEMPTS = 3;

export const shouldRetryExternalJobFailure = (
  jobType: ExternalSyncJobType,
  code: ExternalProviderError['code'],
  attemptCount: number
): boolean => {
  if (code === 'temporarily_unavailable' && jobType === 'content_sync') return false;
  if (code !== 'rate_limited' && code !== 'temporarily_unavailable' && code !== 'ambiguous_submission') return false;
  return shouldRetryIntegrationDelivery(
    jobType === 'publish' ? 'publish' : 'update',
    code,
    attemptCount,
    MAX_AMBIGUOUS_PUBLISH_ATTEMPTS
  );
};

const updateJob = async (
  store: DataStore,
  job: ExternalSyncJob,
  update: Partial<ExternalSyncJob>
): Promise<ExternalSyncJob> => {
  const current = await store.getExternalSyncJob(job.externalSyncJobId);
  if (current?.status === 'cancelled' && update.status !== 'cancelled') return current;
  const next = { ...(current || job), ...update, updatedAt: new Date().toISOString() };
  await store.updateExternalSyncJob(next);
  return next;
};

class SyncCancelledError extends Error {
  constructor() {
    super('Synchronization cancelled by the user');
    this.name = 'SyncCancelledError';
  }
}

const ensureJobActive = async (store: DataStore, externalSyncJobId: string): Promise<void> => {
  if ((await store.getExternalSyncJob(externalSyncJobId))?.status === 'cancelled') {
    throw new SyncCancelledError();
  }
};

const addLog = async (store: DataStore, externalSyncJobId: string, level: 'info' | 'warning' | 'error', message: string, detail?: Record<string, unknown>): Promise<void> => {
  await store.appendExternalSyncLog({
    externalSyncLogId: randomUUID(),
    externalSyncJobId,
    level,
    message,
    detail,
    createdAt: new Date().toISOString()
  });
};

const deferQueuedJobsForAccount = async (
  store: DataStore,
  externalAccountId: string,
  exceptJobId: string,
  rateLimitedUntil: string
): Promise<number> => {
  const jobs = await store.listExternalSyncJobs(externalAccountId, 100);
  const deferred = jobs.filter((candidate) => (
    candidate.externalSyncJobId !== exceptJobId
    && ['queued', 'retry_scheduled', 'rate_limited'].includes(candidate.status)
  ));
  await Promise.all(deferred.map((candidate) => store.updateExternalSyncJob({
    ...candidate,
    status: 'rate_limited',
    nextAttemptAt: candidate.nextAttemptAt && candidate.nextAttemptAt > rateLimitedUntil
      ? candidate.nextAttemptAt
      : rateLimitedUntil,
    errorCode: 'ACCOUNT_RATE_LIMITED',
    errorMessage: 'Waiting for the DeviantArt account cooldown before continuing',
    updatedAt: new Date().toISOString()
  })));
  return deferred.length;
};

const markAccountRecovered = async (store: DataStore, externalAccountId: string): Promise<void> => {
  const account = await store.getExternalAccount(externalAccountId);
  if (!account || (
    account.connectionStatus !== 'rate_limited'
    && account.connectionStatus !== 'temporarily_unavailable'
    && !account.rateLimitedUntil
  )) return;
  await store.updateExternalAccount({
    ...account,
    connectionStatus: 'connected',
    rateLimitedUntil: undefined,
    updatedAt: new Date().toISOString()
  });
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
};

const fingerprint = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(stableValue(value)))
  .digest('hex');

const remoteMetadataFingerprint = (remote: ExternalRemoteContent): string => fingerprint({
  title: remote.title,
  description: remote.description,
  tags: [...remote.tags].sort(),
  collectionExternalIds: [...remote.collectionExternalIds].sort(),
  publishedAt: remote.publishedAt,
  remoteCreatedAt: remote.remoteCreatedAt,
  remoteUpdatedAt: remote.remoteUpdatedAt
});

const remoteContentFingerprint = (remote: ExternalRemoteContent): string | undefined => {
  if (!remote.content) return undefined;
  let sourcePath: string | undefined;
  try {
    const source = new URL(remote.content.sourceUrl);
    sourcePath = `${source.hostname}${source.pathname}`;
  } catch {
    sourcePath = remote.content.sourceUrl.split('?')[0];
  }
  return fingerprint({
    externalContentId: remote.externalContentId,
    sourcePath,
    filename: remote.content.filename,
    contentType: remote.content.contentType,
    byteSize: remote.content.byteSize,
    width: remote.content.width,
    height: remote.content.height
  });
};

const metricsChanged = (current: ExternalEngagementCurrent | null, incoming: ExternalRemoteEngagement['metrics']): boolean => (
  !current
  || current.views !== incoming.views
  || current.favourites !== incoming.favourites
  || current.comments !== incoming.comments
  || current.downloads !== incoming.downloads
  || current.viewsToday !== incoming.viewsToday
  || current.downloadsToday !== incoming.downloadsToday
);

const storeEngagement = async (
  store: DataStore,
  publication: ExternalPublication,
  metrics: ExternalRemoteEngagement['metrics'],
  now: string
): Promise<{ previous: ExternalEngagementCurrent | null; changed: boolean }> => {
  const previous = await store.getExternalEngagementCurrent(publication.externalPublicationId);
  const changed = metricsChanged(previous, metrics);
  const current: ExternalEngagementCurrent = {
    externalPublicationId: publication.externalPublicationId,
    capturedAt: now,
    views: metrics.views,
    favourites: metrics.favourites,
    comments: metrics.comments,
    downloads: metrics.downloads,
    viewsToday: metrics.viewsToday,
    downloadsToday: metrics.downloadsToday,
    otherMetricsJson: metrics.other
  };
  await store.upsertExternalEngagementCurrent(current);
  if (changed) {
    await store.createExternalEngagementSnapshot({
      externalEngagementSnapshotId: randomUUID(),
      externalPublicationId: publication.externalPublicationId,
      capturedAt: now,
      views: metrics.views,
      favourites: metrics.favourites,
      comments: metrics.comments,
      otherMetricsJson: {
        ...(metrics.other || {}),
        downloads: metrics.downloads,
        viewsToday: metrics.viewsToday,
        downloadsToday: metrics.downloadsToday
      }
    });
  }
  return { previous, changed };
};

const decodeComparableHtml = (value: string): string => value
  .replace(/<\s*br\s*\/?>/gi, '\n')
  .replace(/<\/(?:p|div|li|blockquote|h[1-6])\s*>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;|&#34;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t]+/g, ' ')
  .replace(/ *\n */g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const metadataBoolean = (metadata: Record<string, unknown>, ...keys: string[]): boolean | undefined => {
  const submission = metadata.submission && typeof metadata.submission === 'object' && !Array.isArray(metadata.submission)
    ? metadata.submission as Record<string, unknown>
    : {};
  for (const key of keys) {
    const value = metadata[key] ?? submission[key];
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
  }
  return undefined;
};
const metadataPositiveInteger = (metadata: Record<string, unknown>, ...keys: string[]): number | undefined => {
  const submission = metadata.submission && typeof metadata.submission === 'object' && !Array.isArray(metadata.submission)
    ? metadata.submission as Record<string, unknown>
    : {};
  for (const key of keys) {
    const value = metadata[key] ?? submission[key];
    const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isInteger(numberValue) && numberValue > 0) return numberValue;
  }
  return undefined;
};

const metadataString = (metadata: Record<string, unknown>, ...keys: string[]): string | undefined => {
  const submission = metadata.submission && typeof metadata.submission === 'object' && !Array.isArray(metadata.submission)
    ? metadata.submission as Record<string, unknown>
    : {};
  for (const key of keys) {
    const value = metadata[key] ?? submission[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

const metadataIdentifier = (metadata: Record<string, unknown>, ...keys: string[]): string | undefined => {
  const submission = metadata.submission && typeof metadata.submission === 'object' && !Array.isArray(metadata.submission)
    ? metadata.submission as Record<string, unknown>
    : {};
  for (const key of keys) {
    const value = metadata[key] ?? submission[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim();
  }
  return undefined;
};

const metadataStrings = (metadata: Record<string, unknown>, ...keys: string[]): string[] | undefined => {
  const submission = metadata.submission && typeof metadata.submission === 'object' && !Array.isArray(metadata.submission)
    ? metadata.submission as Record<string, unknown>
    : {};
  for (const key of keys) {
    const value = metadata[key] ?? submission[key];
    if (Array.isArray(value)) {
      return value
        .map((item) => typeof item === 'string' ? item : '')
        .filter(Boolean);
    }
  }
  return undefined;
};

export const mergeExternalMetadata = (
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> => {
  const previousSubmission = previous.submission && typeof previous.submission === 'object' && !Array.isArray(previous.submission)
    ? previous.submission as Record<string, unknown>
    : {};
  const incomingSubmission = incoming.submission && typeof incoming.submission === 'object' && !Array.isArray(incoming.submission)
    ? incoming.submission as Record<string, unknown>
    : {};
  const merged = { ...previous, ...incoming };
  if (Object.keys(previousSubmission).length || Object.keys(incomingSubmission).length) {
    merged.submission = { ...previousSubmission, ...incomingSubmission };
  }
  return merged;
};

const comparableTags = (tags: string[]): string => [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
  .sort()
  .join('\u0000');

export const externalContentUpdateMismatches = (remote: ExternalRemoteContent, update: ExternalContentUpdate): string[] => {
  const mismatches: string[] = [];
  if (update.title !== undefined && remote.title.trim() !== update.title.trim()) mismatches.push('title');
  if (update.description !== undefined && decodeComparableHtml(remote.description || '') !== decodeComparableHtml(update.description)) mismatches.push('description');
  if (update.tags !== undefined && comparableTags(remote.tags) !== comparableTags(update.tags)) mismatches.push('tags');
  if (update.allowComments !== undefined && metadataBoolean(remote.rawMetadata, 'allows_comments', 'allow_comments', 'allowComments') !== update.allowComments) mismatches.push('comment setting');
  if (update.allowFreeDownload !== undefined) {
    const remoteAllowFreeDownload = metadataBoolean(remote.rawMetadata, 'allow_free_download', 'allowFreeDownload');
    if (remoteAllowFreeDownload !== undefined && remoteAllowFreeDownload !== update.allowFreeDownload) mismatches.push('free-download setting');
  }
  if (update.addWatermark !== undefined) {
    const remoteAddWatermark = metadataBoolean(remote.rawMetadata, 'add_watermark', 'addWatermark');
    if (remoteAddWatermark !== undefined && remoteAddWatermark !== update.addWatermark) mismatches.push('watermark setting');
  }
  if (update.isMature !== undefined && metadataBoolean(remote.rawMetadata, 'is_mature', 'isMature') !== update.isMature) mismatches.push('mature setting');
  if (update.matureLevel !== undefined && metadataString(remote.rawMetadata, 'mature_level', 'matureLevel') !== update.matureLevel) mismatches.push('mature level');
  if (update.matureClassification !== undefined) {
    const remoteClassifications = metadataStrings(remote.rawMetadata, 'mature_classification', 'matureClassification');
    if (!remoteClassifications || comparableTags(remoteClassifications) !== comparableTags(update.matureClassification)) mismatches.push('mature classification');
  }
  const remoteAiGenerated = metadataBoolean(remote.rawMetadata, 'is_ai_generated', 'isAiGenerated', 'ai_generated', 'created_with_ai');
  if (update.isAiGenerated !== undefined && remoteAiGenerated !== undefined && remoteAiGenerated !== update.isAiGenerated) mismatches.push('AI-generated setting');
  if (update.noAi !== undefined) {
    const noAi = metadataBoolean(remote.rawMetadata, 'noai', 'noAI', 'noAi', 'no_ai');
    if (noAi !== undefined && noAi !== update.noAi) mismatches.push('NoAI setting');
  }
  return mismatches;
};

const providerForAccount = async (store: DataStore, config: AppConfig, account: ExternalAccount): Promise<ExternalPlatformProvider> => {
  const credential = await store.getExternalPlatformCredential(account.externalPlatformCredentialId);
  if (!credential || credential.userId !== account.userId || credential.platform !== account.platform) {
    throw new ExternalProviderError(`The account-owned ${account.platform} application credentials are unavailable`, 'authentication_required');
  }
  return createExternalPlatformProvider(account.platform, {
    clientId: credential.clientId,
    clientSecret: decryptExternalCredential(credential.clientSecretEncrypted, config.externalTokenEncryptionKey),
    redirectUri: credential.redirectUri,
    minimumRequestIntervalMs: account.platform === 'youtube'
      ? config.youtubeMinimumRequestIntervalMs
      : config.deviantArtMinimumRequestIntervalMs,
    ...(account.platform === 'youtube' ? { apiBaseUrl: config.youtubeApiBaseUrl } : {}),
    ...(account.platform === 'soundcloud' ? { enabled: config.soundCloudEnabled === true } : {})
  });
};

const accountRefreshTails = new Map<string, Promise<void>>();

const withAccountRefreshLock = async <T>(externalAccountId: string, callback: () => Promise<T>): Promise<T> => {
  const previous = accountRefreshTails.get(externalAccountId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  accountRefreshTails.set(externalAccountId, tail);
  await previous.catch(() => undefined);
  try {
    return await callback();
  } finally {
    release();
    if (accountRefreshTails.get(externalAccountId) === tail) accountRefreshTails.delete(externalAccountId);
  }
};

const refreshAccessTokenIfNeeded = async (
  store: DataStore,
  config: AppConfig,
  account: ExternalAccount,
  provider: ExternalPlatformProvider
): Promise<{ account: ExternalAccount; accessToken: string }> => {
  let accessToken = decryptExternalCredential(account.accessTokenEncrypted, config.externalTokenEncryptionKey);
  const expiresAt = account.tokenExpiresAt ? Date.parse(account.tokenExpiresAt) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt > Date.now() + 60_000) {
    return { account, accessToken };
  }
  if (!account.refreshTokenEncrypted) {
    throw new ExternalProviderError(`${account.platform} authentication has expired`, 'authentication_required');
  }
  return withAccountRefreshLock(account.externalAccountId, async () => {
    const leaseId = randomUUID();
    let acquired = false;
    for (let attempt = 0; attempt < 100 && !acquired; attempt += 1) {
      acquired = await store.acquireExternalAccountRefreshLease(account.externalAccountId, leaseId, Math.floor(Date.now() / 1000) + 30);
      if (!acquired) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (!acquired) throw new ExternalProviderError(`${account.platform} token refresh is already in progress`, 'temporarily_unavailable');
    try {
      // Another worker may have rotated SoundCloud's single-use refresh token
      // while this worker waited. Always re-read before spending it.
      const latest = await store.getExternalAccount(account.externalAccountId) || account;
      const latestExpiresAt = latest.tokenExpiresAt ? Date.parse(latest.tokenExpiresAt) : NaN;
      if (Number.isFinite(latestExpiresAt) && latestExpiresAt > Date.now() + 60_000) {
        return { account: latest, accessToken: decryptExternalCredential(latest.accessTokenEncrypted, config.externalTokenEncryptionKey) };
      }
      if (!latest.refreshTokenEncrypted) throw new ExternalProviderError(`${account.platform} authentication has expired`, 'authentication_required');
      const refreshToken = decryptExternalCredential(latest.refreshTokenEncrypted, config.externalTokenEncryptionKey);
      const tokens = await provider.refreshAuthentication(refreshToken);
      const refreshed: ExternalAccount = {
        ...latest,
        accessTokenEncrypted: encryptExternalCredential(tokens.accessToken, config.externalTokenEncryptionKey),
        refreshTokenEncrypted: tokens.refreshToken
          ? encryptExternalCredential(tokens.refreshToken, config.externalTokenEncryptionKey)
          : latest.refreshTokenEncrypted,
        tokenExpiresAt: tokens.expiresAt,
        connectionStatus: 'connected',
        updatedAt: new Date().toISOString()
      };
      await store.updateExternalAccount(refreshed);
      accessToken = tokens.accessToken;
      return { account: refreshed, accessToken };
    } finally {
      await store.releaseExternalAccountRefreshLease(account.externalAccountId, leaseId);
    }
  });
};

const canonicalPublicationStatus = (publication: ExternalPublication): Publication['status'] => {
  if (publication.syncStatus === 'active') return 'live';
  if (publication.syncStatus === 'draft') return 'draft';
  if (publication.syncStatus === 'pending_publish') return 'queued';
  if (publication.syncStatus === 'missing' || publication.syncStatus === 'restricted') return 'missing';
  if (publication.syncStatus === 'deleted') return 'removed';
  if (publication.syncStatus === 'unknown') return 'unknown';
  return 'failed';
};

const canonicalPublicationSyncStatus = (publication: ExternalPublication): Publication['sync']['status'] => {
  if (publication.metadataSyncStatus === 'remote_changed') return 'remote_newer';
  if (publication.metadataSyncStatus === 'local_update_pending') return 'local_newer';
  if (publication.metadataSyncStatus === 'conflict') return 'conflict';
  if (publication.syncStatus === 'error') return 'error';
  if (publication.syncStatus === 'unknown') return 'unknown';
  return 'in_sync';
};

/**
 * DeviantArt's compatibility record remains useful for provider details, but
 * every externally observable state is projected into the generic Publication
 * contract. Subsequent adapters use this boundary rather than Work state.
 */
const syncCanonicalPublication = async (
  store: DataStore,
  config: AppConfig,
  account: ExternalAccount,
  work: Work,
  publication: ExternalPublication,
  now = new Date().toISOString()
): Promise<void> => {
  const existing = await store.getPublication(config.tenantId, publication.externalPublicationId);
  const canonicalPublication: Publication = {
    publicationId: publication.externalPublicationId,
    tenantId: config.tenantId,
    creatorId: work.creatorId,
    workId: work.workId,
    destination: account.platform,
    integrationAccountId: account.externalAccountId,
    status: canonicalPublicationStatus(publication),
    visibility: 'public',
    remoteId: publication.externalContentId,
    remoteUrl: publication.externalUrl,
    remoteCreatedAt: publication.remoteCreatedAt,
    remoteUpdatedAt: publication.remoteUpdatedAt,
    metadataOverrides: {
      title: publication.externalTitle,
      description: publication.externalDescription,
      tags: publication.externalTags,
      fields: {
        targetStatus: publication.targetStatus,
        externalCollectionIds: publication.externalCollectionIds,
        ...publication.rawMetadataJson
      }
    },
    sync: {
      status: canonicalPublicationSyncStatus(publication),
      lastAttemptAt: publication.metadataSyncStatus === 'local_update_pending' ? publication.updatedAt : undefined,
      lastSuccessfulAt: publication.lastSyncedAt,
      localRevision: work.revision,
      remoteMetadataFingerprint: publication.remoteMetadataFingerprint,
      remoteContentFingerprint: publication.remoteContentFingerprint,
      errorMessage: publication.remoteStateReason
    },
    providerData: {
      ...publication.rawMetadataJson,
      externalUsername: account.externalUsername,
      externalDraftId: publication.externalDraftId,
      targetStatus: publication.targetStatus,
      externalCollectionIds: publication.externalCollectionIds
    },
    createdAt: publication.createdAt,
    updatedAt: publication.updatedAt,
    publishedAt: publication.publishedAt,
    removedAt: publication.syncStatus === 'deleted' ? now : undefined
  };
  const localSnapshot = {
    title: work.title,
    description: work.description || '',
    tags: work.tags,
    visibility: canonicalPublication.visibility
  };
  const remoteSnapshot = {
    title: publication.externalTitle || '',
    description: publication.externalDescription || '',
    tags: publication.externalTags,
    visibility: canonicalPublication.visibility,
    remoteId: publication.externalContentId,
    remoteUpdatedAt: publication.remoteUpdatedAt
  };
  await store.upsertPublication(recordPublicationReconciliation({
    ...canonicalPublication,
    sync: { ...canonicalPublication.sync, reconciliation: existing?.sync.reconciliation }
  }, localSnapshot, remoteSnapshot, now));
};

const upsertContent = async (
  store: DataStore,
  config: AppConfig,
  account: ExternalAccount,
  remote: ExternalRemoteContent,
  now: string,
  origin: 'remote_scan' | 'outbound_verification' = 'remote_scan'
): Promise<{ asset: Asset; publication: ExternalPublication }> => {
  const primaryCreatorIdentityId = account.primaryCreatorIdentityId || account.creatorIdentityId;
  if (!primaryCreatorIdentityId) {
    throw new ExternalProviderError(`Assign this ${account.platform} account to a creator before importing its catalogue`, 'unsupported');
  }
  const currentPublication = await store.getExternalPublication(account.externalAccountId, remote.externalContentId);
  let asset: Asset | null = currentPublication ? await store.getAsset(currentPublication.assetId) : null;

  // A connected account can be moved between Creators.  ExternalPublication
  // is keyed by the remote account/content pair, so it remains the durable
  // sync cursor, but the imported Work must follow the account's new
  // destination Creator.  Never move the old Asset/Work in place: that would
  // silently rewrite a Creator's catalogue and make the old Creator appear to
  // have imported content that is now owned by someone else.  Instead, reuse
  // a prior imported copy for this remote item under the new Creator when one
  // exists, or create a fresh copy below.
  if (asset && asset.creatorIdentityId !== primaryCreatorIdentityId) {
    const targetWorks = await store.listWorksByCreator(config.tenantId, primaryCreatorIdentityId);
    const targetWork = targetWorks.find((work) => (
      work.origin.type === 'import'
      && work.origin.platform === account.platform
      && work.origin.integrationAccountId === account.externalAccountId
      && work.origin.remoteId === remote.externalContentId
    ));
    asset = targetWork ? await store.getAsset(targetWork.workId) : null;

    // Source-copy jobs queued for the previous Creator must not keep that
    // catalogue in the account's active sync stream after reassignment.  The
    // next reconciliation will enqueue a new content-sync job for the target
    // Asset.  Leave completed/processing jobs alone so an in-flight download
    // can finish safely; queued retries are safe to cancel.
    if (currentPublication) {
      const jobs = await store.listExternalSyncJobs(account.externalAccountId, 500);
      await Promise.all(jobs
        .filter((job) => (
          job.type === 'content_sync'
          && job.payload?.externalPublicationId === currentPublication.externalPublicationId
          && job.payload?.assetId === currentPublication.assetId
          && ['queued', 'retry_scheduled', 'rate_limited'].includes(job.status)
        ))
        .map((job) => store.updateExternalSyncJob({
          ...job,
          status: 'cancelled',
          errorCode: 'CREATOR_REASSIGNED',
          errorMessage: 'Source synchronization was superseded when the DeviantArt account moved to another Creator',
          updatedAt: now
        })));
    }
  }
  if (!asset) {
    asset = {
      assetId: randomUUID(),
      userId: account.userId,
      creatorIdentityId: primaryCreatorIdentityId,
      assetType: remote.assetType,
      canonicalTitle: remote.title,
      canonicalDescription: remote.description,
      visibility: 'private',
      titleSyncPolicy: 'initially_mirrored',
      descriptionSyncPolicy: 'initially_mirrored',
      createdAt: now,
      updatedAt: now
    };
    await store.createAsset(asset);
  } else {
    const nextAsset: Asset = {
      ...asset,
      assetType: remote.assetType,
      canonicalTitle: asset.titleSyncPolicy === 'mirrored' || asset.titleSyncPolicy === 'initially_mirrored'
        ? remote.title
        : asset.canonicalTitle,
      canonicalDescription: asset.descriptionSyncPolicy === 'mirrored' || asset.descriptionSyncPolicy === 'initially_mirrored'
        ? remote.description
        : asset.canonicalDescription,
      updatedAt: now
    };
    await store.updateAsset(nextAsset);
    asset = nextAsset;
  }

  const nextRemoteMetadataFingerprint = remoteMetadataFingerprint(remote);
  const remoteMetadataChanged = Boolean(
    currentPublication?.remoteMetadataFingerprint
    && currentPublication.remoteMetadataFingerprint !== nextRemoteMetadataFingerprint
  );
  const metadataSyncStatus: ExternalPublication['metadataSyncStatus'] = origin === 'outbound_verification'
    ? 'in_sync'
    : !currentPublication
      ? 'in_sync'
      : remoteMetadataChanged && currentPublication.metadataSyncStatus === 'local_update_pending'
        ? 'conflict'
        : remoteMetadataChanged
          ? 'remote_changed'
          : currentPublication.metadataSyncStatus || 'in_sync';
  const publication: ExternalPublication = {
    externalPublicationId: currentPublication?.externalPublicationId || randomUUID(),
    assetId: asset.assetId,
    externalAccountId: account.externalAccountId,
    platform: account.platform,
    externalContentId: remote.externalContentId,
    externalDraftId: currentPublication?.externalDraftId || metadataIdentifier(
      remote.rawMetadata,
      'itemid',
      'item_id',
      'stash_itemid',
      'stashItemId',
      'stashid'
    ),
    targetStatus: currentPublication?.targetStatus,
    externalUrl: remote.externalUrl,
    externalTitle: remote.title,
    externalDescription: remote.description,
    externalTags: remote.tags,
    externalCollectionIds: remote.collectionExternalIds,
    publishedAt: remote.publishedAt,
    remoteCreatedAt: remote.remoteCreatedAt,
    remoteUpdatedAt: remote.remoteUpdatedAt,
    remoteMetadataFingerprint: nextRemoteMetadataFingerprint,
    remoteContentFingerprint: remoteContentFingerprint(remote),
    lastSyncedAt: now,
    lastSeenAt: now,
    syncStatus: remote.remoteState === 'deleted' ? 'deleted' : remote.remoteState === 'restricted' ? 'restricted' : 'active',
    metadataSyncStatus,
    remoteChangeDetectedAt: remoteMetadataChanged && origin === 'remote_scan'
      ? currentPublication?.remoteChangeDetectedAt || now
      : origin === 'outbound_verification' ? undefined : currentPublication?.remoteChangeDetectedAt,
    lastOutboundSyncAt: origin === 'outbound_verification' ? now : currentPublication?.lastOutboundSyncAt,
    remoteStateReason: remote.remoteStateReason,
    // DeviantArt's read API currently omits newer AI label values. Retain any
    // values Ubeeq previously submitted while refreshing the fields DA reports,
    // including values nested inside the extended `submission` object.
    rawMetadataJson: mergeExternalMetadata(currentPublication?.rawMetadataJson || {}, remote.rawMetadata),
    createdAt: currentPublication?.createdAt || now,
    updatedAt: now
  };
  if (currentPublication) await store.updateExternalPublication(publication);
  else await store.createExternalPublication(publication);

  const workKind: Work['kind'] = remote.assetType === 'literature'
    ? 'literature'
    : remote.assetType === 'audio'
      ? 'audio'
    : remote.assetType === 'video'
      ? 'video'
      : remote.assetType === 'animation'
        ? 'animation'
        : 'image';
  const currentWork = await store.getWork(config.tenantId, asset.assetId);
  const importedSlugBase = remote.title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || `work-${asset.assetId.slice(0, 8)}`;
  const importedSlug = (await store.listWorksByCreator(config.tenantId, primaryCreatorIdentityId))
    .some((item) => item.workId !== asset.assetId && item.slugHistory.includes(importedSlugBase))
    ? `${importedSlugBase}-${asset.assetId.slice(0, 8)}`
    : importedSlugBase;
  const canonicalWork: Work = currentWork ? {
    ...currentWork,
    kind: workKind,
    title: asset.titleSyncPolicy === 'mirrored' || asset.titleSyncPolicy === 'initially_mirrored' ? remote.title : currentWork.title,
    description: asset.descriptionSyncPolicy === 'mirrored' || asset.descriptionSyncPolicy === 'initially_mirrored' ? remote.description : currentWork.description,
    tags: remote.tags,
    revision: currentWork.revision + (remoteMetadataChanged ? 1 : 0),
    updatedAt: now
  } : {
    workId: asset.assetId,
    tenantId: config.tenantId,
    creatorId: primaryCreatorIdentityId,
    kind: workKind,
    title: remote.title,
    slug: importedSlug,
    slugHistory: [],
    description: remote.description,
    tags: remote.tags,
    contentRating: metadataBoolean(remote.rawMetadata, 'is_mature', 'isMature') ? 'mature' : 'general',
    aiDisclosure: metadataBoolean(remote.rawMetadata, 'is_ai_generated', 'isAiGenerated', 'ai_generated', 'created_with_ai') ? 'ai-generated' : 'none',
    heavyTopics: [],
    status: 'draft',
    origin: {
      type: 'import',
      platform: account.platform,
      integrationAccountId: account.externalAccountId,
      remoteId: remote.externalContentId,
      remoteUrl: remote.externalUrl,
      importedAt: now
    },
    // SoundCloud imports are catalogue references, not source audio Assets.
    // The normal creator upload flow may attach a canonical audio Asset later.
    primaryAssetId: account.platform === 'soundcloud' ? undefined : `${asset.assetId}:remote`,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  if (!canonicalWork.slugHistory.length) canonicalWork.slugHistory = [canonicalWork.slug];
  if (currentWork) await store.updateWork(canonicalWork);
  else {
    await store.createWork(canonicalWork);
    await store.upsertWorkDiscoveryParticipation({
      workId: canonicalWork.workId,
      tenantId: canonicalWork.tenantId,
      creatorId: canonicalWork.creatorId,
      state: 'none',
      updatedAt: now
    });
  }
  if (account.platform !== 'soundcloud') {
    const remoteAssetId = `${asset.assetId}:remote`;
    const currentCanonicalAsset = await store.getCanonicalAsset(config.tenantId, remoteAssetId);
    const canonicalAsset: CanonicalAsset = {
      assetId: remoteAssetId,
      tenantId: config.tenantId,
      creatorId: primaryCreatorIdentityId,
      kind: workKind === 'video' || workKind === 'animation' ? 'video' : workKind === 'literature' ? 'document' : 'image',
      status: 'ready',
      mimeType: remote.content?.contentType || currentCanonicalAsset?.mimeType || 'application/octet-stream',
      originalFilename: remote.content?.filename || currentCanonicalAsset?.originalFilename,
      sizeBytes: remote.content?.byteSize || currentCanonicalAsset?.sizeBytes,
      width: remote.content?.width || currentCanonicalAsset?.width,
      height: remote.content?.height || currentCanonicalAsset?.height,
      storage: { mode: 'external', externalUrl: remote.content?.sourceUrl || remote.externalUrl },
      metadata: { sourcePlatform: account.platform, sourceAccount: account.externalUsername },
      createdAt: currentCanonicalAsset?.createdAt || now,
      updatedAt: now
    };
    if (currentCanonicalAsset) await store.updateCanonicalAsset(canonicalAsset);
    else {
      await store.createCanonicalAsset(canonicalAsset);
      await store.attachAssetToWork(config.tenantId, { workId: canonicalWork.workId, assetId: canonicalAsset.assetId, role: 'primary', position: 0 });
    }
  }
  await syncCanonicalPublication(store, config, account, canonicalWork, publication, now);

  if (remote.metrics && Object.values(remote.metrics).some((value) => value !== undefined)) {
    await storeEngagement(store, publication, remote.metrics, now);
  }
  return { asset, publication };
};

const enqueueContentSyncJob = async (
  store: DataStore,
  config: AppConfig,
  externalAccountId: string,
  assetId: string,
  externalPublicationId: string,
  parentJobId?: string,
  queue?: ExternalSyncQueue
): Promise<void> => {
  const activeStatuses = new Set<ExternalSyncJob['status']>(['queued', 'processing', 'retry_scheduled', 'rate_limited']);
  const existing = (await store.listExternalSyncJobs(externalAccountId, 100)).find((candidate) => (
    candidate.type === 'content_sync'
    && candidate.payload?.externalPublicationId === externalPublicationId
    && activeStatuses.has(candidate.status)
  ));
  if (existing) return;
  const now = new Date().toISOString();
  const contentJob: ExternalSyncJob = {
    externalSyncJobId: randomUUID(),
    externalAccountId,
    type: 'content_sync',
    status: 'queued',
    payload: { assetId, externalPublicationId, ...(parentJobId ? { parentJobId } : {}) },
    progress: { discovered: 1, synchronized: 0, remaining: 1 },
    attemptCount: 0,
    createdAt: now,
    updatedAt: now
  };
  await store.createExternalSyncJob(contentJob);
  try {
    await (queue || createExternalSyncQueue(config)).enqueue(contentJob.externalSyncJobId);
  } catch {
    await store.updateExternalSyncJob({
      ...contentJob,
      status: 'retry_scheduled',
      nextAttemptAt: new Date(Date.now() + config.externalSyncBaseDelaySeconds * 1000).toISOString(),
      errorCode: 'QUEUE_UNAVAILABLE',
      errorMessage: 'The content synchronization queue is unavailable',
      updatedAt: new Date().toISOString()
    });
    throw new ExternalProviderError('The content synchronization queue is unavailable', 'temporarily_unavailable');
  }
};

const enqueueRelatedSyncJob = async (
  store: DataStore,
  config: AppConfig,
  account: ExternalAccount,
  type: Extract<ExternalSyncJobType, 'activity_sync' | 'engagement_sync'>,
  queue?: ExternalSyncQueue
): Promise<ExternalSyncJob> => {
  const activeStatuses = new Set<ExternalSyncJob['status']>(['queued', 'processing', 'retry_scheduled', 'rate_limited']);
  const existing = (await store.listExternalSyncJobs(account.externalAccountId, 100))
    .find((candidate) => candidate.type === type && activeStatuses.has(candidate.status));
  if (existing) return existing;
  const now = new Date().toISOString();
  const relatedJob: ExternalSyncJob = {
    externalSyncJobId: randomUUID(),
    externalAccountId: account.externalAccountId,
    type,
    status: 'queued',
    progress: { discovered: 0, synchronized: 0, remaining: 0 },
    attemptCount: 0,
    createdAt: now,
    updatedAt: now
  };
  await store.createExternalSyncJob(relatedJob);
  try {
    await (queue || createExternalSyncQueue(config)).enqueue(relatedJob.externalSyncJobId);
  } catch {
    const retryJob: ExternalSyncJob = {
      ...relatedJob,
      status: 'retry_scheduled',
      nextAttemptAt: new Date(Date.now() + config.externalSyncBaseDelaySeconds * 1000).toISOString(),
      errorCode: 'QUEUE_UNAVAILABLE',
      errorMessage: 'The synchronization queue is unavailable',
      updatedAt: new Date().toISOString()
    };
    await store.updateExternalSyncJob(retryJob);
    return retryJob;
  }
  return relatedJob;
};

const enqueueAccountScanIfIdle = async (
  store: DataStore,
  config: AppConfig,
  account: ExternalAccount,
  triggeredByJobId: string,
  queue?: ExternalSyncQueue
): Promise<ExternalSyncJob> => {
  const activeStatuses = new Set<ExternalSyncJob['status']>(['queued', 'processing', 'retry_scheduled', 'rate_limited']);
  const existing = (await store.listExternalSyncJobs(account.externalAccountId, 100))
    .find((candidate) => (
      (candidate.type === 'account_scan' || candidate.type === 'account_import' || candidate.type === 'full_reconciliation')
      && activeStatuses.has(candidate.status)
    ));
  if (existing) return existing;

  const now = new Date().toISOString();
  const scanJob: ExternalSyncJob = {
    externalSyncJobId: randomUUID(),
    externalAccountId: account.externalAccountId,
    type: 'account_scan',
    status: 'queued',
    payload: { reason: 'remote_update_verification', triggeredByJobId },
    progress: { discovered: 0, synchronized: 0, remaining: 0 },
    attemptCount: 0,
    createdAt: now,
    updatedAt: now
  };
  await store.createExternalSyncJob(scanJob);
  try {
    await (queue || createExternalSyncQueue(config)).enqueue(scanJob.externalSyncJobId);
    return scanJob;
  } catch {
    const retryJob: ExternalSyncJob = {
      ...scanJob,
      status: 'retry_scheduled',
      nextAttemptAt: new Date(Date.now() + config.externalSyncBaseDelaySeconds * 1000).toISOString(),
      errorCode: 'QUEUE_UNAVAILABLE',
      errorMessage: 'The verification synchronization queue is unavailable',
      updatedAt: new Date().toISOString()
    };
    await store.updateExternalSyncJob(retryJob);
    return retryJob;
  }
};

const queueSpaceContentSync = async (
  store: DataStore,
  config: AppConfig,
  account: ExternalAccount,
  asset: Asset,
  publication: ExternalPublication,
  parentJobId?: string,
  queue?: ExternalSyncQueue
): Promise<void> => {
  const current = await store.getSpacePublication(asset.assetId);
  const now = new Date().toISOString();
  const lastCheckedAt = current?.lastRemoteContentCheckedAt ? Date.parse(current.lastRemoteContentCheckedAt) : NaN;
  const descriptorChanged = current?.remoteContentFingerprint !== publication.remoteContentFingerprint;
  const needsPeriodicVerification = !Number.isFinite(lastCheckedAt) || lastCheckedAt < Date.now() - 24 * 60 * 60 * 1000;
  const shouldQueue = current?.contentSyncStatus !== 'hosted' || descriptorChanged || needsPeriodicVerification;
  if (!shouldQueue) return;
  const spacePublication: SpacePublication = {
    ...current,
    assetId: asset.assetId,
    published: current?.published || false,
    hostingMode: current?.hostingMode === 'hosted' ? 'hosted' : 'linked',
    publishedAt: current?.publishedAt,
    ubeeqTitleOverride: current?.ubeeqTitleOverride,
    ubeeqDescriptionOverride: current?.ubeeqDescriptionOverride,
    visibility: current?.visibility || 'private',
    contentSyncStatus: 'queued',
    contentSyncError: undefined,
    remoteContentFingerprint: publication.remoteContentFingerprint,
    updatedAt: now
  };
  await store.upsertSpacePublication(spacePublication);
  await enqueueContentSyncJob(store, config, account.externalAccountId, asset.assetId, publication.externalPublicationId, parentJobId, queue);
};

const executeContentSync = async (store: DataStore, config: AppConfig, job: ExternalSyncJob, account: ExternalAccount): Promise<void> => {
  const assetId = typeof job.payload?.assetId === 'string' ? job.payload.assetId : '';
  const externalPublicationId = typeof job.payload?.externalPublicationId === 'string' ? job.payload.externalPublicationId : '';
  const publication = (await store.listExternalPublications(account.externalAccountId))
    .find((item) => item.externalPublicationId === externalPublicationId && item.assetId === assetId);
  const asset = assetId ? await store.getAsset(assetId) : null;
  if (!asset || !publication) throw new ExternalProviderError('The work is no longer available for content synchronization', 'invalid_response');
  const current = await store.getSpacePublication(asset.assetId);
  const now = new Date().toISOString();
  await store.upsertSpacePublication({
    ...current,
    assetId: asset.assetId,
    published: current?.published || false,
    hostingMode: current?.hostingMode || 'linked',
    publishedAt: current?.publishedAt,
    ubeeqTitleOverride: current?.ubeeqTitleOverride,
    ubeeqDescriptionOverride: current?.ubeeqDescriptionOverride,
    visibility: current?.visibility || 'private',
    contentSyncStatus: 'syncing',
    remoteContentFingerprint: publication.remoteContentFingerprint,
    lastRemoteContentCheckedAt: now,
    updatedAt: now
  });
  const provider = await providerForAccount(store, config, account);
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  const remote = await provider.getContent(session.accessToken, publication.externalContentId);
  const original = await provider.getOriginalDownload(session.accessToken, publication.externalContentId);
  await ensureJobActive(store, job.externalSyncJobId);
  const source = original.status === 'available' && original.sourceUrl
    ? {
      sourceUrl: original.sourceUrl,
      expectedByteSize: original.byteSize,
      quality: 'original' as const
    }
    : remote.content?.sourceUrl
      ? {
        sourceUrl: remote.content.sourceUrl,
        contentType: remote.content.contentType,
        expectedByteSize: remote.content.byteSize,
        quality: 'display_copy' as const
      }
      : undefined;
  if (!source) {
    await store.upsertSpacePublication({
      ...current,
      assetId: asset.assetId,
      published: current?.published || false,
      hostingMode: current?.hostingMode || 'linked',
      publishedAt: current?.publishedAt,
      ubeeqTitleOverride: current?.ubeeqTitleOverride,
      ubeeqDescriptionOverride: current?.ubeeqDescriptionOverride,
      visibility: current?.visibility || 'private',
      contentSyncStatus: 'not_available',
      originalDownloadStatus: original.status,
      remoteContentFingerprint: remoteContentFingerprint(remote),
      lastRemoteContentCheckedAt: new Date().toISOString(),
      contentSyncError: undefined,
      updatedAt: new Date().toISOString()
    });
    await updateJob(store, job, { status: 'successful', progress: { discovered: 1, synchronized: 0, remaining: 0 }, errorCode: undefined, errorMessage: undefined });
    await addLog(store, job.externalSyncJobId, 'info', 'DeviantArt does not make a downloadable copy of this work available', {
      assetId,
      originalDownloadStatus: original.status
    });
    return;
  }
  const stored = await storeExternalContent(config, {
    tenantId: config.tenantId,
    userId: asset.userId,
    creatorIdentityId: asset.creatorIdentityId,
    assetId: asset.assetId,
    externalContentId: publication.externalContentId,
    sourceUrl: source.sourceUrl,
    contentType: source.contentType,
    expectedByteSize: source.expectedByteSize,
    existingChecksumSha256: current?.hostedChecksumSha256,
    existingObjectKey: current?.hostedObjectKey,
    existingThumbnailObjectKey: current?.hostedThumbnailObjectKey
  });
  await ensureJobActive(store, job.externalSyncJobId);
  await store.upsertSpacePublication({
    ...current,
    assetId: asset.assetId,
    published: current?.published || false,
    hostingMode: 'hosted',
    publishedAt: current?.publishedAt,
    ubeeqTitleOverride: current?.ubeeqTitleOverride,
    ubeeqDescriptionOverride: current?.ubeeqDescriptionOverride,
    visibility: current?.visibility || 'private',
    contentSyncStatus: 'hosted',
    sourceCopyQuality: source.quality,
    originalDownloadStatus: original.status,
    hostedObjectKey: stored.objectKey,
    hostedThumbnailObjectKey: stored.thumbnailObjectKey,
    hostedContentType: stored.contentType,
    hostedByteSize: stored.byteSize,
    hostedChecksumSha256: stored.checksumSha256,
    remoteContentFingerprint: remoteContentFingerprint(remote),
    remoteContentEtag: stored.etag,
    remoteContentLastModified: stored.lastModified,
    lastRemoteContentCheckedAt: new Date().toISOString(),
    lastContentSyncAt: new Date().toISOString(),
    contentSyncError: undefined,
    updatedAt: new Date().toISOString()
  });
  const canonicalWork = await store.getWork(config.tenantId, asset.assetId);
  const canonicalAssetId = `${asset.assetId}:remote`;
  const currentCanonicalAsset = await store.getCanonicalAsset(config.tenantId, canonicalAssetId);
  if (canonicalWork && currentCanonicalAsset) {
    await store.updateCanonicalAsset({
      ...currentCanonicalAsset,
      status: 'ready',
      mimeType: stored.contentType,
      sizeBytes: stored.byteSize,
      checksumSha256: stored.checksumSha256,
      storage: {
        mode: 'hosted',
        objectKey: stored.objectKey,
        thumbnailObjectKey: stored.thumbnailObjectKey
      },
      metadata: {
        ...(currentCanonicalAsset.metadata || {}),
        sourcePlatform: account.platform,
        sourceAccount: account.externalUsername,
        sourceCopyQuality: source.quality,
        remoteUrl: remote.externalUrl || ''
      },
      updatedAt: new Date().toISOString()
    });
  }
  await updateJob(store, job, { status: 'successful', progress: { discovered: 1, synchronized: 1, remaining: 0 }, errorCode: undefined, errorMessage: undefined });
  const brand = brandForConfig(config);
  await addLog(store, job.externalSyncJobId, 'info', stored.unchanged
    ? `DeviantArt source file is unchanged; existing ${brand.workspaceFullName} copy retained`
    : `DeviantArt source file stored as a new ${brand.workspaceFullName} version`, {
    assetId,
    bytes: stored.byteSize,
    checksumSha256: stored.checksumSha256,
    unchanged: stored.unchanged,
    sourceCopyQuality: source.quality,
    originalDownloadStatus: original.status
  });
};

const executeRemoteUpdate = async (store: DataStore, config: AppConfig, job: ExternalSyncJob, account: ExternalAccount, queue?: ExternalSyncQueue): Promise<void> => {
  const externalPublicationId = typeof job.payload?.externalPublicationId === 'string' ? job.payload.externalPublicationId : '';
  const publication = (await store.listExternalPublications(account.externalAccountId))
    .find((item) => item.externalPublicationId === externalPublicationId);
  if (!publication) throw new ExternalProviderError('The connected work is no longer available for an outbound update', 'invalid_response');
  const update: ExternalContentUpdate = {};
  if (typeof job.payload?.title === 'string') update.title = job.payload.title;
  if (typeof job.payload?.description === 'string') update.description = job.payload.description;
  if (Array.isArray(job.payload?.tags)) update.tags = job.payload.tags.filter((tag): tag is string => typeof tag === 'string');
  if (Array.isArray(job.payload?.collectionExternalIds)) update.collectionExternalIds = job.payload.collectionExternalIds
    .filter((collectionId): collectionId is string => typeof collectionId === 'string');
  if (typeof job.payload?.allowComments === 'boolean') update.allowComments = job.payload.allowComments;
  if (job.payload && Object.prototype.hasOwnProperty.call(job.payload, 'displayResolution')) {
    if (job.payload.displayResolution === null) update.displayResolution = null;
    else if (typeof job.payload.displayResolution === 'number') update.displayResolution = job.payload.displayResolution;
  }
  if (typeof job.payload?.allowFreeDownload === 'boolean') update.allowFreeDownload = job.payload.allowFreeDownload;
  if (typeof job.payload?.addWatermark === 'boolean') update.addWatermark = job.payload.addWatermark;
  if (typeof job.payload?.isMature === 'boolean') update.isMature = job.payload.isMature;
  if (job.payload?.matureLevel === 'strict' || job.payload?.matureLevel === 'moderate') update.matureLevel = job.payload.matureLevel;
  if (Array.isArray(job.payload?.matureClassification)) update.matureClassification = job.payload.matureClassification
    .filter((classification): classification is 'nudity' | 'sexual' | 'gore' | 'language' | 'ideology' => (
      classification === 'nudity' || classification === 'sexual' || classification === 'gore' || classification === 'language' || classification === 'ideology'
    ));
  if (typeof job.payload?.isAiGenerated === 'boolean') update.isAiGenerated = job.payload.isAiGenerated;
  if (typeof job.payload?.noAi === 'boolean') update.noAi = job.payload.noAi;
  // Accept already-queued jobs from the previous inverted DTO during rollout.
  else if (typeof job.payload?.allowAiTraining === 'boolean') update.noAi = !job.payload.allowAiTraining;
  const provider = await providerForAccount(store, config, account);
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  await provider.updateContent(session.accessToken, publication.externalContentId, update, {
    externalDraftId: publication.externalDraftId,
    publishedDescriptionUpdate: config.deviantArtPublishedDescriptionUpdate
  });
  const remote = await provider.getContent(session.accessToken, publication.externalContentId);
  const mismatches = externalContentUpdateMismatches(remote, update);
  if (update.collectionExternalIds !== undefined) {
    const desiredCollectionIds = new Set(update.collectionExternalIds);
    const relevantCollectionIds = [...new Set([
      ...(publication.externalCollectionIds || []),
      ...update.collectionExternalIds
    ])];
    for (const collectionId of relevantCollectionIds) {
      let cursor: string | undefined;
      let found = false;
      do {
        const page = await provider.listCollectionContent(session.accessToken, collectionId, session.account.externalUsername, cursor);
        found ||= page.items.some((item) => item.externalContentId === publication.externalContentId);
        cursor = found ? undefined : page.nextCursor;
      } while (cursor);
      if (found !== desiredCollectionIds.has(collectionId)) {
        mismatches.push(`gallery placement (${collectionId})`);
      }
    }
  }
  if (mismatches.length) {
    throw new ExternalProviderError(
      `DeviantArt accepted the edit request, but read-back verification did not match: ${mismatches.join(', ')}`,
      'invalid_response'
    );
  }
  // DeviantArt's read API currently omits the AI label fields. Preserve the
  // values Ubeeq just wrote so subsequent edits show known state rather than
  // incorrectly reverting to an unchecked/unknown presentation.
  const verifiedRemote: ExternalRemoteContent = {
    ...remote,
    collectionExternalIds: update.collectionExternalIds ?? remote.collectionExternalIds,
    rawMetadata: {
      ...remote.rawMetadata,
      ...(update.displayResolution !== undefined ? { display_resolution: update.displayResolution } : {}),
      ...(update.allowFreeDownload !== undefined ? { allow_free_download: update.allowFreeDownload } : {}),
      ...(update.addWatermark !== undefined ? { add_watermark: update.addWatermark } : {}),
      ...(update.isAiGenerated !== undefined ? { is_ai_generated: update.isAiGenerated } : {}),
      ...(update.noAi !== undefined ? { noai: update.noAi } : {})
    }
  };
  await upsertContent(store, config, session.account, verifiedRemote, new Date().toISOString(), 'outbound_verification');
  const followUpJob = await enqueueAccountScanIfIdle(store, config, session.account, job.externalSyncJobId, queue);
  await updateJob(store, job, {
    status: 'successful',
    progress: { discovered: 1, synchronized: 1, remaining: 0 },
    errorCode: undefined,
    errorMessage: undefined,
    nextAttemptAt: undefined
  });
  await addLog(store, job.externalSyncJobId, 'info', 'Integration metadata update completed and verified', {
    externalPublicationId,
    fields: Object.keys(update),
    followUpJobId: followUpJob.externalSyncJobId,
    followUpJobStatus: followUpJob.status
  });
};

const executeRemoteDelete = async (store: DataStore, config: AppConfig, job: ExternalSyncJob, account: ExternalAccount): Promise<void> => {
  const externalPublicationId = typeof job.payload?.externalPublicationId === 'string' ? job.payload.externalPublicationId : '';
  const publication = (await store.listExternalPublications(account.externalAccountId)).find((item) => item.externalPublicationId === externalPublicationId);
  if (!publication) throw new ExternalProviderError('The publication is no longer available for deletion', 'invalid_response');
  const provider = await providerForAccount(store, config, account);
  if (!provider.deleteContent) throw new ExternalProviderError(`${account.platform} does not support content deletion`, 'unsupported');
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  await provider.deleteContent(session.accessToken, publication.externalContentId);
  const now = new Date().toISOString();
  await store.updateExternalPublication({ ...publication, syncStatus: 'deleted', remoteStateReason: 'Deleted after explicit creator confirmation', lastSyncedAt: now, updatedAt: now });
  const canonical = await store.getPublication(config.tenantId, publication.externalPublicationId);
  if (canonical) await store.upsertPublication({ ...canonical, status: 'removed', removedAt: now, updatedAt: now });
  await updateJob(store, job, { status: 'successful', progress: { discovered: 1, synchronized: 1, remaining: 0 }, errorCode: undefined, errorMessage: undefined, nextAttemptAt: undefined });
  await addLog(store, job.externalSyncJobId, 'info', `${account.platform} publication deleted after explicit confirmation`, { externalPublicationId });
};

const executePublish = async (store: DataStore, config: AppConfig, job: ExternalSyncJob, account: ExternalAccount): Promise<void> => {
  const assetId = typeof job.payload?.assetId === 'string' ? job.payload.assetId : '';
  const asset = assetId ? await store.getAsset(assetId) : null;
  const spacePublication = asset ? await store.getSpacePublication(asset.assetId) : null;
  if (!asset || !spacePublication?.hostedObjectKey || !spacePublication.hostedContentType) {
    throw new ExternalProviderError('The uploaded work is not available for publishing', 'invalid_response');
  }
  const provider = await providerForAccount(store, config, account);
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  const externalPublicationId = typeof job.payload?.externalPublicationId === 'string' ? job.payload.externalPublicationId : '';
  const pendingPublication = externalPublicationId
    ? (await store.listExternalPublications(account.externalAccountId)).find((publication) => publication.externalPublicationId === externalPublicationId && publication.assetId === asset.assetId)
    : undefined;
  if (!pendingPublication) throw new ExternalProviderError('The selected destination is no longer available for publishing', 'invalid_response');
  const savedSettings = pendingPublication.rawMetadataJson || {};
  const tags = Array.isArray(job.payload?.tags)
    ? job.payload.tags.filter((tag): tag is string => typeof tag === 'string')
    : pendingPublication.externalTags;
  const isMature = typeof job.payload?.isMature === 'boolean'
    ? job.payload.isMature
    : (metadataBoolean(savedSettings, 'is_mature', 'isMature') ?? false);
  const matureLevel = job.payload?.matureLevel === 'strict' || job.payload?.matureLevel === 'moderate'
    ? job.payload.matureLevel
    : (() => {
      const savedLevel = metadataString(savedSettings, 'mature_level', 'matureLevel');
      return savedLevel === 'strict' || savedLevel === 'moderate' ? savedLevel : undefined;
    })();
  const matureClassification = Array.isArray(job.payload?.matureClassification)
    ? job.payload.matureClassification.filter((classification): classification is 'nudity' | 'sexual' | 'gore' | 'language' | 'ideology' => (
      classification === 'nudity' || classification === 'sexual' || classification === 'gore' || classification === 'language' || classification === 'ideology'
    ))
    : (() => {
      const savedClassifications = metadataStrings(savedSettings, 'mature_classification', 'matureClassification');
      return Array.isArray(savedClassifications)
      ? savedClassifications.filter((classification): classification is 'nudity' | 'sexual' | 'gore' | 'language' | 'ideology' => (
        classification === 'nudity' || classification === 'sexual' || classification === 'gore' || classification === 'language' || classification === 'ideology'
      ))
      : undefined;
    })();
  const filename = typeof job.payload?.originalFilename === 'string' && job.payload.originalFilename.trim()
    ? job.payload.originalFilename.trim()
    : `${asset.assetId}.jpg`;
  if (account.platform === 'soundcloud') {
    const work = await store.getWork(config.tenantId, asset.assetId);
    if (!work || work.kind !== 'audio') throw new ExternalProviderError('Only canonical audio Works can be published to SoundCloud', 'invalid_response');
    if (!spacePublication.hostedContentType.startsWith('audio/')) throw new ExternalProviderError('The SoundCloud source Asset must be audio', 'invalid_response');
    const visibility = job.payload?.visibility === 'public' || job.payload?.visibility === 'unlisted' ? job.payload.visibility : 'private';
    const published = await provider.publishContent(session.accessToken, {
      body: Buffer.alloc(0),
      uploadSource: {
        assetId: asset.assetId,
        filename,
        contentType: spacePublication.hostedContentType,
        byteSize: spacePublication.hostedByteSize,
        openReadStream: () => openStoredUbeeqWorkStream(config, spacePublication.hostedObjectKey!)
      },
      filename,
      contentType: spacePublication.hostedContentType,
      title: pendingPublication.externalTitle || asset.canonicalTitle || filename,
      description: pendingPublication.externalDescription ?? asset.canonicalDescription,
      tags,
      visibility,
      artist: metadataString(savedSettings, 'metadataArtist', 'artist'),
      providerFields: {
        genre: metadataString(savedSettings, 'genre'),
        license: metadataString(savedSettings, 'license'),
        purchase_url: metadataString(savedSettings, 'purchaseUrl', 'purchase_url'),
        downloadable: metadataBoolean(savedSettings, 'downloadable'),
        commentable: metadataBoolean(savedSettings, 'commentable')
      }
    });
    const now = new Date().toISOString();
    const publication: ExternalPublication = {
      ...pendingPublication,
      externalContentId: published.externalContentId,
      externalUrl: published.externalUrl,
      externalTitle: pendingPublication.externalTitle || asset.canonicalTitle,
      externalDescription: pendingPublication.externalDescription ?? asset.canonicalDescription,
      externalTags: tags,
      targetStatus: 'published',
      syncStatus: 'active',
      rawMetadataJson: { ...savedSettings, ...published.rawMetadata },
      publishedAt: now,
      remoteCreatedAt: now,
      remoteUpdatedAt: now,
      lastSyncedAt: now,
      lastSeenAt: now,
      updatedAt: now
    };
    await store.updateExternalPublication(publication, pendingPublication.externalContentId);
    await syncCanonicalPublication(store, config, session.account, work, publication, now);
    await updateJob(store, job, { status: 'successful', progress: { discovered: 1, synchronized: 1, remaining: 0 }, errorCode: undefined, errorMessage: undefined, nextAttemptAt: undefined });
    await addLog(store, job.externalSyncJobId, 'info', `${brandForConfig(config).productName} audio uploaded to SoundCloud`, { assetId: asset.assetId, externalContentId: published.externalContentId });
    return;
  }
  const content: ExternalContentPublish = {
    body: await readStoredUbeeqWorkImage(config, spacePublication.hostedObjectKey),
    filename,
    contentType: spacePublication.hostedContentType,
    title: pendingPublication.externalTitle || asset.canonicalTitle || filename,
    description: pendingPublication.externalDescription ?? asset.canonicalDescription,
    tags,
    collectionExternalIds: pendingPublication.externalCollectionIds,
    isMature,
    matureLevel,
    matureClassification,
    allowComments: typeof job.payload?.allowComments === 'boolean'
      ? job.payload.allowComments
      : metadataBoolean(savedSettings, 'allows_comments', 'allow_comments', 'allowComments'),
    displayResolution: metadataPositiveInteger(savedSettings, 'display_resolution', 'displayResolution'),
    allowFreeDownload: metadataBoolean(savedSettings, 'allow_free_download', 'allowFreeDownload'),
    addWatermark: metadataBoolean(savedSettings, 'add_watermark', 'addWatermark'),
    isAiGenerated: typeof job.payload?.isAiGenerated === 'boolean'
      ? job.payload.isAiGenerated
      : metadataBoolean(savedSettings, 'is_ai_generated', 'isAiGenerated', 'ai_generated', 'created_with_ai'),
    noAi: typeof job.payload?.noAi === 'boolean'
      ? job.payload.noAi
      : metadataBoolean(savedSettings, 'noai', 'noAI', 'noAi', 'no_ai')
  };
  // The publication record is authoritative so a creator can change their
  // choice while a queued job is still waiting to run.
  const targetStatus = pendingPublication.targetStatus === 'draft' ? 'draft' : 'published';
  const draft = await provider.submitContent(session.accessToken, content, pendingPublication.externalDraftId);
  const now = new Date().toISOString();
  // Persist the Sta.sh item before attempting the irreversible publish step.
  // A retry can then update and publish this same draft rather than creating a
  // second Sta.sh submission after a transient publish failure.
  const submittedDraftPublication: ExternalPublication = {
    ...pendingPublication,
    externalContentId: `stash:${draft.externalDraftId}`,
    externalDraftId: draft.externalDraftId,
    externalUrl: draft.externalUrl,
    externalTitle: pendingPublication.externalTitle || asset.canonicalTitle,
    externalDescription: pendingPublication.externalDescription ?? asset.canonicalDescription,
    externalTags: tags,
    targetStatus,
    syncStatus: 'draft',
    rawMetadataJson: { ...savedSettings, ...draft.rawMetadata },
    remoteUpdatedAt: now,
    lastSyncedAt: now,
    lastSeenAt: now,
    updatedAt: now
  };
  await store.updateExternalPublication(submittedDraftPublication, pendingPublication.externalContentId);
  const work = await store.getWork(config.tenantId, asset.assetId);
  if (work) await syncCanonicalPublication(store, config, session.account, work, submittedDraftPublication, now);
  if (targetStatus === 'draft') {
    await updateJob(store, job, {
      status: 'successful',
      progress: { discovered: 1, synchronized: 1, remaining: 0 },
      errorCode: undefined,
      errorMessage: undefined,
      nextAttemptAt: undefined
    });
    await addLog(store, job.externalSyncJobId, 'info', `${brandForConfig(config).productName} work saved as a DeviantArt Sta.sh draft`, { assetId: asset.assetId, externalDraftId: draft.externalDraftId });
    return;
  }
  const published = await provider.publishDraft(session.accessToken, draft.externalDraftId, content);
  const publication: ExternalPublication = {
    ...submittedDraftPublication,
    assetId: asset.assetId,
    externalAccountId: account.externalAccountId,
    platform: account.platform,
    externalContentId: published.externalContentId,
    externalDraftId: published.externalDraftId,
    externalUrl: published.externalUrl,
    externalTitle: pendingPublication.externalTitle || asset.canonicalTitle,
    externalDescription: pendingPublication.externalDescription ?? asset.canonicalDescription,
    externalTags: tags,
    targetStatus: 'published',
    syncStatus: 'active',
    rawMetadataJson: { ...submittedDraftPublication.rawMetadataJson, ...published.rawMetadata },
    publishedAt: now,
    remoteCreatedAt: now,
    remoteUpdatedAt: now,
    lastSyncedAt: now,
    lastSeenAt: now,
    createdAt: submittedDraftPublication.createdAt || now,
    updatedAt: now
  };
  if (pendingPublication) await store.updateExternalPublication(publication, submittedDraftPublication.externalContentId);
  else await store.createExternalPublication(publication);
  if (work) await syncCanonicalPublication(store, config, session.account, work, publication, now);
  await updateJob(store, job, {
    status: 'successful',
    progress: { discovered: 1, synchronized: 1, remaining: 0 },
    errorCode: undefined,
    errorMessage: undefined,
    nextAttemptAt: undefined
  });
  await addLog(store, job.externalSyncJobId, 'info', `${brandForConfig(config).productName} work published to DeviantArt`, { assetId: asset.assetId, externalContentId: published.externalContentId });
};

const reconcilePublicationLifecycle = async (
  store: DataStore,
  config: AppConfig,
  provider: ExternalPlatformProvider,
  accessToken: string,
  account: ExternalAccount,
  seenExternalContentIds: Set<string>,
  now: string
): Promise<{ missing: number; deleted: number; restricted: number }> => {
  const publications = (await store.listExternalPublications(account.externalAccountId))
    .filter((publication) => (
      publication.syncStatus === 'active'
      || publication.syncStatus === 'missing'
      || publication.syncStatus === 'restricted'
    ));
  let missing = 0;
  let deleted = 0;
  let restricted = 0;
  for (const publication of publications) {
    if (seenExternalContentIds.has(publication.externalContentId)) continue;
    let remoteState: RemotePublicationState = 'missing';
    let remoteStateReason = 'No longer present in the connected DeviantArt gallery';
    try {
      const remote = await provider.getContent(accessToken, publication.externalContentId);
      if (remote.remoteState === 'deleted') {
        remoteState = 'deleted';
        remoteStateReason = remote.remoteStateReason || 'Deleted on DeviantArt';
      } else if (remote.remoteState === 'restricted') {
        remoteState = 'restricted';
        remoteStateReason = remote.remoteStateReason || 'Restricted on DeviantArt';
      }
    } catch (error) {
      if (!(error instanceof ExternalProviderError) || error.code !== 'invalid_response') throw error;
      remoteStateReason = error.message;
    }
    if (remoteState === 'deleted') deleted += 1;
    else if (remoteState === 'restricted') restricted += 1;
    else missing += 1;
    const updatedPublication = recordExternalPublicationLifecycle(publication, remoteState, { observedAt: now, reason: remoteStateReason });
    await store.updateExternalPublication(updatedPublication);
    const work = await store.getWork(config.tenantId, publication.assetId);
    if (work) await syncCanonicalPublication(store, config, account, work, updatedPublication, now);
  }
  await updateCheckpoint(store, account, 'publication.lifecycle', account.externalAccountId, now, [...seenExternalContentIds], {
    missing,
    deleted,
    restricted,
    checkedAt: now
  });
  return { missing, deleted, restricted };
};

const reconcileCollectionMappings = async (
  store: DataStore,
  provider: ExternalPlatformProvider,
  accessToken: string,
  account: ExternalAccount,
  externalCollections: ExternalCollection[],
  now: string
): Promise<{ mappings: number; memberships: number; errors: number }> => {
  const mappings = await store.listExternalCollectionMappings(account.externalAccountId);
  const eligibleMappings = mappings.filter((mapping) => (
    mapping.syncMode === 'continuous'
    || (mapping.syncMode === 'initial_only' && !mapping.lastMembershipSyncAt)
  ));
  if (!eligibleMappings.length) return { mappings: 0, memberships: 0, errors: 0 };

  const creatorIds = [...new Set([
    ...(await store.listExternalAccountCreatorAssignments(account.externalAccountId)).map((assignment) => assignment.creatorIdentityId),
    account.primaryCreatorIdentityId,
    account.creatorIdentityId
  ].filter((creatorId): creatorId is string => Boolean(creatorId)))];
  const ubeeqCollections = (await Promise.all(creatorIds.map((creatorId) => store.listUbeeqCollectionsByCreatorIdentity(creatorId)))).flat();
  const ubeeqCollectionById = new Map(ubeeqCollections.map((collection) => [collection.ubeeqCollectionId, collection]));
  const externalCollectionById = new Map(externalCollections.map((collection) => [collection.externalCollectionId, collection]));
  const mappingByExternalCollectionId = new Map(mappings.map((mapping) => [mapping.externalCollectionId, mapping]));
  const publications = await store.listExternalPublications(account.externalAccountId);
  const publicationByExternalContentId = new Map(publications.map((publication) => [publication.externalContentId, publication]));
  const assetCache = new Map<string, Asset | null>();
  const remoteAssetIdsByMapping = new Map<string, Set<string>>();
  let errors = 0;

  for (const mapping of eligibleMappings) {
    const externalCollection = externalCollectionById.get(mapping.externalCollectionId);
    const targetCollection = ubeeqCollectionById.get(mapping.ubeeqCollectionId);
    if (!externalCollection || externalCollection.syncStatus === 'missing' || !targetCollection) {
      errors += 1;
      await store.updateExternalCollectionMapping({
        ...mapping,
        lastMembershipError: !targetCollection ? 'Mapped destination collection is unavailable' : 'DeviantArt gallery folder is unavailable',
        updatedAt: now
      });
      continue;
    }
    try {
      const remoteContentIds: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await provider.listCollectionContent(
          accessToken,
          externalCollection.externalCollectionExternalId,
          account.externalUsername,
          cursor
        );
        remoteContentIds.push(...page.items.map((item) => item.externalContentId));
        cursor = page.nextCursor;
      } while (cursor);
      const assetIds = new Set<string>();
      for (const externalContentId of remoteContentIds) {
        const publication = publicationByExternalContentId.get(externalContentId);
        if (!publication) continue;
        let asset = assetCache.get(publication.assetId);
        if (asset === undefined) {
          asset = await store.getAsset(publication.assetId);
          assetCache.set(publication.assetId, asset);
        }
        if (asset?.creatorIdentityId === targetCollection.creatorIdentityId) assetIds.add(publication.assetId);
      }
      remoteAssetIdsByMapping.set(mapping.externalCollectionMappingId, assetIds);
      const membershipFingerprint = fingerprint([...remoteContentIds].sort());
      await store.updateExternalCollectionMapping({
        ...mapping,
        lastMembershipSyncAt: now,
        lastMembershipFingerprint: membershipFingerprint,
        lastMembershipCount: assetIds.size,
        lastMembershipError: undefined,
        updatedAt: now
      });
      await updateCheckpoint(store, account, 'gallery.membership', mapping.externalCollectionMappingId, now, remoteContentIds, {
        mappedAssetCount: assetIds.size,
        remoteContentCount: remoteContentIds.length
      });

      const parentExternalCollection = externalCollection.parentExternalCollectionExternalId
        ? externalCollections.find((candidate) => candidate.externalCollectionExternalId === externalCollection.parentExternalCollectionExternalId)
        : undefined;
      const parentMapping = parentExternalCollection
        ? mappingByExternalCollectionId.get(parentExternalCollection.externalCollectionId)
        : undefined;
      const parentUbeeqCollectionId = parentMapping?.ubeeqCollectionId === targetCollection.ubeeqCollectionId
        ? undefined
        : parentMapping?.ubeeqCollectionId;
      if (
        targetCollection.parentUbeeqCollectionId !== parentUbeeqCollectionId
        || (externalCollection.position !== undefined && targetCollection.position !== externalCollection.position)
      ) {
        await store.updateUbeeqCollection({
          ...targetCollection,
          parentUbeeqCollectionId,
          position: externalCollection.position ?? targetCollection.position,
          updatedAt: now
        });
      }
    } catch (error) {
      if (error instanceof ExternalProviderError && (
        error.code === 'authentication_required'
        || error.code === 'rate_limited'
        || error.code === 'temporarily_unavailable'
      )) throw error;
      errors += 1;
      await store.updateExternalCollectionMapping({
        ...mapping,
        lastMembershipError: error instanceof Error ? error.message : 'Unable to synchronize gallery membership',
        updatedAt: now
      });
    }
  }

  const eligibleMappingIds = new Set(remoteAssetIdsByMapping.keys());
  const targetCollectionIds = [...new Set(eligibleMappings
    .filter((mapping) => eligibleMappingIds.has(mapping.externalCollectionMappingId))
    .map((mapping) => mapping.ubeeqCollectionId))];
  let memberships = 0;
  for (const ubeeqCollectionId of targetCollectionIds) {
    const collection = ubeeqCollectionById.get(ubeeqCollectionId);
    if (!collection) continue;
    const targetMappings = eligibleMappings.filter((mapping) => (
      mapping.ubeeqCollectionId === ubeeqCollectionId
      && eligibleMappingIds.has(mapping.externalCollectionMappingId)
    ));
    const targetMappingIds = new Set(targetMappings.map((mapping) => mapping.externalCollectionMappingId));
    const existing = await store.listUbeeqCollectionAssets(ubeeqCollectionId);
    const byAssetId = new Map<string, UbeeqCollectionAsset>();
    for (const item of existing) {
      const remainingMappingIds = (item.externalCollectionMappingIds || []).filter((mappingId) => !targetMappingIds.has(mappingId));
      const manuallyAssigned = item.manuallyAssigned ?? !(item.externalCollectionMappingIds || []).length;
      if (manuallyAssigned || remainingMappingIds.length) {
        byAssetId.set(item.assetId, { ...item, manuallyAssigned, externalCollectionMappingIds: remainingMappingIds });
      }
    }
    for (const mapping of targetMappings) {
      for (const assetId of remoteAssetIdsByMapping.get(mapping.externalCollectionMappingId) || []) {
        const current = byAssetId.get(assetId) || existing.find((item) => item.assetId === assetId);
        byAssetId.set(assetId, {
          ubeeqCollectionId,
          assetId,
          userId: collection.userId,
          creatorIdentityId: collection.creatorIdentityId,
          manuallyAssigned: current?.manuallyAssigned ?? false,
          externalCollectionMappingIds: [...new Set([
            ...(current?.externalCollectionMappingIds || []).filter((mappingId) => !targetMappingIds.has(mappingId)),
            mapping.externalCollectionMappingId
          ])],
          createdAt: current?.createdAt || now,
          updatedAt: now
        });
      }
    }
    const nextAssets = [...byAssetId.values()].filter((item) => item.manuallyAssigned || (item.externalCollectionMappingIds || []).length);
    await store.replaceUbeeqCollectionAssets(ubeeqCollectionId, nextAssets);
    memberships += nextAssets.filter((item) => (item.externalCollectionMappingIds || []).some((mappingId) => targetMappingIds.has(mappingId))).length;
  }
  return { mappings: remoteAssetIdsByMapping.size, memberships, errors };
};

const executeAccountImport = async (store: DataStore, config: AppConfig, job: ExternalSyncJob, account: ExternalAccount, queue?: ExternalSyncQueue): Promise<void> => {
  const provider = await providerForAccount(store, config, account);
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  const now = new Date().toISOString();
  const collections = await provider.listCollections(session.accessToken, session.account.externalUsername);
  await ensureJobActive(store, job.externalSyncJobId);
  const existingCollections = await store.listExternalCollections(account.externalAccountId);
  const seenExternalCollectionIds = new Set<string>();
  for (const collection of collections) {
    await ensureJobActive(store, job.externalSyncJobId);
    seenExternalCollectionIds.add(collection.externalCollectionId);
    const existing = existingCollections
      .find((item) => item.externalCollectionExternalId === collection.externalCollectionId);
    const record = {
      externalCollectionId: existing?.externalCollectionId || randomUUID(),
      externalAccountId: account.externalAccountId,
      platform: account.platform,
      externalCollectionExternalId: collection.externalCollectionId,
      name: collection.name,
      description: collection.description,
      parentExternalCollectionExternalId: collection.parentExternalCollectionId,
      position: collection.position,
      remoteSize: collection.size,
      syncStatus: 'active' as const,
      lastSeenAt: now,
      lastSyncedAt: now,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (existing) await store.updateExternalCollection(record);
    else await store.createExternalCollection(record);
  }
  for (const collection of existingCollections) {
    if (!seenExternalCollectionIds.has(collection.externalCollectionExternalId) && collection.syncStatus !== 'missing') {
      await store.updateExternalCollection({
        ...collection,
        syncStatus: 'missing',
        lastSyncedAt: now,
        updatedAt: now
      });
    }
  }

  let cursor = typeof job.payload?.resumeCursor === 'string' ? job.payload.resumeCursor : undefined;
  let resumeItemIndex = typeof job.payload?.resumeItemIndex === 'number'
    ? Math.max(0, Math.floor(job.payload.resumeItemIndex))
    : 0;
  let resumePageLoaded = job.payload?.resumePageLoaded === true;
  let contentScanComplete = job.payload?.contentScanComplete === true;
  let discovered = job.progress?.discovered || 0;
  let synchronized = job.progress?.synchronized || 0;
  const seenExternalContentIds = new Set(
    Array.isArray(job.payload?.seenExternalContentIds)
      ? job.payload.seenExternalContentIds.filter((value): value is string => typeof value === 'string' && Boolean(value))
      : []
  );
  let currentJob = job;
  const shouldSyncContent = session.account.platform === 'deviantart' && (job.payload?.syncContent === true
    || session.account.initialContentSyncRequested === true
    || session.account.includeSourceFilesOnSync === true);
  if (!contentScanComplete) {
    do {
      await ensureJobActive(store, job.externalSyncJobId);
      const pageCursor = cursor || (account.platform === 'deviantart' ? '0' : undefined);
      const page = await provider.listContent(session.accessToken, {
        username: session.account.externalUsername,
        cursor: pageCursor,
        limit: 50
      });
      if (!resumePageLoaded) discovered += page.items.length;
      resumePageLoaded = true;
      const pageStartIndex = Math.min(resumeItemIndex, page.items.length);
      for (let itemIndex = pageStartIndex; itemIndex < page.items.length; itemIndex += 1) {
        const item = page.items[itemIndex];
        await ensureJobActive(store, job.externalSyncJobId);
        seenExternalContentIds.add(item.externalContentId);
        const hasPublishedSettings = metadataBoolean(item.rawMetadata, 'is_mature', 'isMature') !== undefined
          && metadataBoolean(item.rawMetadata, 'allows_comments', 'allow_comments', 'allowComments') !== undefined
          && metadataBoolean(item.rawMetadata, 'is_ai_generated', 'isAiGenerated', 'ai_generated', 'created_with_ai') !== undefined
          && metadataBoolean(item.rawMetadata, 'noai', 'noAI', 'noAi', 'no_ai') !== undefined;
        let resolvedItem = item;
        // YouTube listContent already returns the full batched Videos resource.
        // Avoid an extra API request for every video that simply has no tags or
        // an intentionally empty description.
        const needsFullRemoteMetadata = session.account.platform === 'deviantart'
          && (!item.description || !item.tags.length || !hasPublishedSettings);
        if (needsFullRemoteMetadata) {
          try {
            resolvedItem = await provider.getContent(session.accessToken, item.externalContentId);
          } catch (error) {
            if (error instanceof ExternalProviderError && error.code === 'rate_limited') {
              currentJob = await updateJob(store, currentJob, {
                payload: {
                  ...(currentJob.payload || {}),
                  ...(pageCursor ? { resumeCursor: pageCursor } : {}),
                  resumeItemIndex: itemIndex,
                  resumePageLoaded: true,
                  contentScanComplete: false,
                  seenExternalContentIds: [...seenExternalContentIds]
                },
                progress: { discovered, synchronized, remaining: 1 }
              });
              await addLog(store, job.externalSyncJobId, 'warning', `${session.account.platform === 'youtube' ? 'YouTube' : 'DeviantArt'} rate limit detected; reconciliation stopped immediately and its position was saved`, {
                externalContentId: item.externalContentId,
                resumeCursor: pageCursor,
                resumeItemIndex: itemIndex
              });
              throw error;
            }
            await addLog(store, job.externalSyncJobId, 'warning', `Could not load complete ${session.account.platform === 'youtube' ? 'YouTube' : 'DeviantArt'} metadata; retaining catalogue values`, {
              externalContentId: item.externalContentId,
              message: error instanceof Error ? error.message : String(error)
            });
          }
        }
        const imported = await upsertContent(store, config, account, resolvedItem, now);
        if (shouldSyncContent) {
          await queueSpaceContentSync(store, config, account, imported.asset, imported.publication, job.externalSyncJobId, queue);
        }
        synchronized += 1;
        resumeItemIndex = itemIndex + 1;
        currentJob = await updateJob(store, currentJob, {
          status: 'processing',
          payload: {
            ...(currentJob.payload || {}),
            resumeCursor: pageCursor,
            resumeItemIndex,
            resumePageLoaded: true,
            contentScanComplete: false,
            seenExternalContentIds: [...seenExternalContentIds]
          },
          progress: { discovered, synchronized, remaining: 1 }
        });
      }
      cursor = page.nextCursor;
      resumeItemIndex = 0;
      resumePageLoaded = false;
      contentScanComplete = !cursor;
      const { resumeCursor: _previousResumeCursor, ...pageCompletedPayload } = currentJob.payload || {};
      currentJob = await updateJob(store, currentJob, {
        status: 'processing',
        payload: {
          ...pageCompletedPayload,
          ...(cursor ? { resumeCursor: cursor } : {}),
          resumeItemIndex: 0,
          resumePageLoaded: false,
          contentScanComplete,
          seenExternalContentIds: [...seenExternalContentIds]
        },
        progress: { discovered, synchronized, remaining: cursor ? 1 : 0 }
      });
    } while (cursor);
  }

  await ensureJobActive(store, job.externalSyncJobId);
  const lifecycle = await reconcilePublicationLifecycle(
    store,
    config,
    provider,
    session.accessToken,
    session.account,
    seenExternalContentIds,
    now
  );
  await ensureJobActive(store, job.externalSyncJobId);
  const refreshedCollections = await store.listExternalCollections(account.externalAccountId);
  const galleryMappings = await reconcileCollectionMappings(
    store,
    provider,
    session.accessToken,
    session.account,
    refreshedCollections,
    now
  );
  await ensureJobActive(store, job.externalSyncJobId);

  const currentAccount = await store.getExternalAccount(account.externalAccountId);
  if (currentAccount?.connectionStatus === 'disabled') {
    await updateJob(store, currentJob, {
      status: 'cancelled',
      errorCode: 'ACCOUNT_REMOVED',
      errorMessage: 'Synchronization stopped because the DeviantArt account was removed'
    });
    return;
  }

  const {
    resumeCursor: _resumeCursor,
    resumeItemIndex: _resumeItemIndex,
    resumePageLoaded: _resumePageLoaded,
    contentScanComplete: _contentScanComplete,
    seenExternalContentIds: _seenExternalContentIds,
    ...completedPayload
  } = currentJob.payload || {};
  const completedJob = await updateJob(store, currentJob, {
    status: 'successful',
    payload: completedPayload,
    progress: { discovered, synchronized, remaining: 0 },
    errorCode: undefined,
    errorMessage: undefined,
    nextAttemptAt: undefined
  });
  if (completedJob.status === 'cancelled') return;
  await store.updateExternalAccount({
    ...session.account,
    connectionStatus: 'connected',
    lastSuccessfulSyncAt: now,
    lastSyncAttemptAt: now,
    initialContentSyncRequested: false,
    updatedAt: now
  });
  const [activityJob, engagementJob] = await Promise.all([
    (session.account.platform === 'deviantart' || session.account.platform === 'soundcloud')
      ? enqueueRelatedSyncJob(store, config, session.account, 'activity_sync', queue)
      : Promise.resolve(undefined),
    enqueueRelatedSyncJob(store, config, session.account, 'engagement_sync', queue)
  ]);
  await addLog(store, job.externalSyncJobId, 'info', `${session.account.platform} account import completed`, {
    discovered,
    synchronized,
    collections: collections.length,
    galleryMappings: galleryMappings.mappings,
    galleryMemberships: galleryMappings.memberships,
    galleryMappingErrors: galleryMappings.errors,
    missingPublications: lifecycle.missing,
    deletedPublications: lifecycle.deleted,
    restrictedPublications: lifecycle.restricted,
    activityJobId: activityJob?.externalSyncJobId,
    engagementJobId: engagementJob.externalSyncJobId
  });
};

const upsertRemoteComment = async (
  store: DataStore,
  publication: ExternalPublication,
  remote: ExternalRemoteComment,
  now: string,
  existing?: ExternalComment
): Promise<ExternalComment> => {
  const current = existing || (await store.listExternalComments(publication.externalPublicationId, 5000))
    .find((item) => item.externalCommentExternalId === remote.externalCommentId);
  const comment: ExternalComment = {
    externalCommentId: current?.externalCommentId || randomUUID(),
    platform: publication.platform,
    externalCommentExternalId: remote.externalCommentId,
    externalPublicationId: publication.externalPublicationId,
    externalAuthorId: remote.authorId,
    externalAuthorName: remote.authorName,
    body: remote.body,
    createdAtRemote: remote.createdAt,
    parentExternalCommentExternalId: remote.parentExternalCommentId,
    positionMilliseconds: remote.positionMilliseconds,
    externalAuthorAvatarUrl: remote.authorAvatarUrl,
    replyCount: remote.replyCount,
    likeCount: remote.likeCount,
    isLiked: remote.isLiked,
    isFeatured: remote.isFeatured,
    hiddenReason: remote.hiddenReason,
    firstSeenAt: current?.firstSeenAt || now,
    lastSeenAt: now,
    remoteDeletedAt: undefined,
    rawPayload: remote.rawPayload,
    lastSyncedAt: now
  };
  if (current) await store.updateExternalComment(comment);
  else await store.createExternalComment(comment);
  return comment;
};

const upsertActivity = async (
  store: DataStore,
  account: ExternalAccount,
  remote: ExternalRemoteActivity,
  publication: ExternalPublication | undefined,
  now: string,
  direction: IntegrationActivity['direction'] = 'inbound'
): Promise<IntegrationActivity> => {
  const existing = await store.getExternalActivityByRemoteId(account.externalAccountId, remote.remoteActivityId);
  const activity: IntegrationActivity = {
    externalActivityId: existing?.externalActivityId || randomUUID(),
    externalAccountId: account.externalAccountId,
    creatorIdentityId: publication
      ? (await store.getAsset(publication.assetId))?.creatorIdentityId
      : account.primaryCreatorIdentityId || account.creatorIdentityId,
    assetId: publication?.assetId,
    externalPublicationId: publication?.externalPublicationId,
    platform: account.platform,
    type: remote.type,
    direction,
    remoteActivityId: remote.remoteActivityId,
    remoteObjectType: remote.externalCommentId ? 'comment' : remote.externalContentId ? 'deviation' : 'message',
    remoteObjectId: remote.externalCommentId || remote.externalContentId || remote.sourceMessageId,
    remoteMessageId: remote.remoteMessageId || existing?.remoteMessageId,
    remoteParentId: remote.parentExternalCommentId,
    remoteStackId: remote.stackId || existing?.remoteStackId,
    externalActorId: remote.actorId,
    externalActorName: remote.actorName,
    externalActorAvatarUrl: remote.actorAvatarUrl,
    body: remote.body,
    occurredAt: remote.occurredAt,
    firstSeenAt: existing?.firstSeenAt || now,
    lastSeenAt: now,
    seenAt: existing?.seenAt || (remote.isNew === false ? now : undefined),
    readAt: existing?.readAt,
    remoteDeletedAt: existing?.remoteDeletedAt,
    rawPayload: remote.rawPayload,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await store.upsertExternalActivity(activity);
  return activity;
};

const updateCheckpoint = async (
  store: DataStore,
  account: ExternalAccount,
  resourceType: ExternalSyncCheckpoint['resourceType'],
  resourceId: string,
  now: string,
  remoteIds: string[] = [],
  summary?: Record<string, unknown>
): Promise<void> => {
  const current = await store.getExternalSyncCheckpoint(account.externalAccountId, resourceType, resourceId);
  await store.upsertExternalSyncCheckpoint({
    externalAccountId: account.externalAccountId,
    resourceType,
    resourceId,
    highWatermarkAt: now,
    lastRemoteId: remoteIds[0] || current?.lastRemoteId,
    recentRemoteIds: [...new Set([...remoteIds, ...(current?.recentRemoteIds || [])])].slice(0, 200),
    lastAttemptAt: now,
    lastSuccessfulSyncAt: now,
    lastError: undefined,
    summary: summary || current?.summary,
    updatedAt: now
  });
};

const reconcileCommentsForPublication = async (
  store: DataStore,
  provider: ExternalPlatformProvider,
  accessToken: string,
  account: ExternalAccount,
  publication: ExternalPublication,
  now: string
): Promise<{ discovered: number; synchronized: number }> => {
  const existing = await store.listExternalComments(publication.externalPublicationId, 5000);
  const existingByRemoteId = new Map(existing.map((comment) => [comment.externalCommentExternalId, comment]));
  const seen = new Set<string>();
  let discovered = 0;
  let cursor: string | undefined;
  do {
    const page = await provider.listComments(accessToken, publication.externalContentId, cursor);
    discovered += page.items.length;
    for (const remote of page.items) {
      seen.add(remote.externalCommentId);
      const comment = await upsertRemoteComment(store, publication, remote, now, existingByRemoteId.get(remote.externalCommentId));
      await upsertActivity(store, account, {
        remoteActivityId: `comment:${remote.externalCommentId}`,
        sourceMessageId: remote.externalCommentId,
        type: remote.parentExternalCommentId ? 'reply' : 'comment',
        occurredAt: remote.createdAt,
        actorId: remote.authorId,
        actorName: remote.authorName,
        actorAvatarUrl: remote.authorAvatarUrl,
        externalContentId: publication.externalContentId,
        externalCommentId: remote.externalCommentId,
        parentExternalCommentId: remote.parentExternalCommentId,
        body: remote.body,
        rawPayload: remote.rawPayload || {}
      }, publication, now);
      existingByRemoteId.set(remote.externalCommentId, comment);
    }
    cursor = page.nextCursor;
  } while (cursor);
  for (const comment of existing) {
    if (!seen.has(comment.externalCommentExternalId) && !comment.remoteDeletedAt) {
      await store.updateExternalComment({ ...comment, remoteDeletedAt: now, lastSyncedAt: now });
      const activity = await store.getExternalActivityByRemoteId(account.externalAccountId, `comment:${comment.externalCommentExternalId}`);
      if (activity) {
        await store.upsertExternalActivity({ ...activity, remoteDeletedAt: now, updatedAt: now });
      }
    }
  }
  await updateCheckpoint(store, account, 'comments', publication.externalPublicationId, now, [...seen]);
  return { discovered, synchronized: seen.size };
};

const reconcileFavouritesForPublication = async (
  store: DataStore,
  provider: ExternalPlatformProvider,
  accessToken: string,
  account: ExternalAccount,
  publication: ExternalPublication,
  now: string
): Promise<number> => {
  const existing = await store.listExternalFavourites(publication.externalPublicationId, 50000);
  const existingByUserId = new Map(existing.map((favourite) => [favourite.externalUserId, favourite]));
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await provider.listFavourites(accessToken, publication.externalContentId, cursor);
    for (const remote of page.items) {
      seen.add(remote.externalUserId);
      const current = existingByUserId.get(remote.externalUserId);
      await store.upsertExternalFavourite({
        externalPublicationId: publication.externalPublicationId,
        externalUserId: remote.externalUserId,
        externalUsername: remote.username,
        externalUserAvatarUrl: remote.avatarUrl,
        favouritedAtRemote: remote.favouritedAt,
        firstSeenAt: current?.firstSeenAt || now,
        lastSeenAt: now,
        active: true,
        removalDetectedAt: undefined,
        rawPayload: remote.rawPayload
      });
      await upsertActivity(store, account, {
        remoteActivityId: `favourite:${publication.externalContentId}:${remote.externalUserId}:${remote.favouritedAt || 'current'}`,
        sourceMessageId: `${publication.externalContentId}:${remote.externalUserId}`,
        type: 'favourite',
        occurredAt: remote.favouritedAt,
        actorId: remote.externalUserId,
        actorName: remote.username,
        actorAvatarUrl: remote.avatarUrl,
        externalContentId: publication.externalContentId,
        rawPayload: remote.rawPayload
      }, publication, now);
    }
    cursor = page.nextCursor;
  } while (cursor);
  for (const favourite of existing) {
    if (favourite.active && !seen.has(favourite.externalUserId)) {
      await store.upsertExternalFavourite({ ...favourite, active: false, removalDetectedAt: now, lastSeenAt: now });
    }
  }
  await updateCheckpoint(store, account, 'favourites', publication.externalPublicationId, now, [...seen]);
  return seen.size;
};

const executeCommentSync = async (store: DataStore, config: AppConfig, job: ExternalSyncJob, account: ExternalAccount): Promise<void> => {
  const provider = await providerForAccount(store, config, account);
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  const requestedContentId = typeof job.payload?.externalContentId === 'string' ? job.payload.externalContentId : undefined;
  const publications = (await store.listExternalPublications(account.externalAccountId))
    .filter((publication) => publication.syncStatus === 'active' && (!requestedContentId || publication.externalContentId === requestedContentId));
  let discovered = 0;
  let synchronized = 0;
  const now = new Date().toISOString();
  for (const publication of publications) {
    const result = await reconcileCommentsForPublication(store, provider, session.accessToken, session.account, publication, now);
    discovered += result.discovered;
    synchronized += result.synchronized;
  }
  await updateJob(store, job, { status: 'successful', progress: { discovered, synchronized, remaining: 0 }, errorCode: undefined, errorMessage: undefined, nextAttemptAt: undefined });
  await addLog(store, job.externalSyncJobId, 'info', 'DeviantArt comments synchronized', { publications: publications.length, discovered, synchronized });
};

const synchronizeAccountProfile = async (
  store: DataStore,
  provider: ExternalPlatformProvider,
  accessToken: string,
  account: ExternalAccount,
  now: string
): Promise<{ changed: boolean; profile: ExternalAccountProfile }> => {
  const remote = await provider.getProfile(accessToken, account.platform === 'soundcloud' ? account.externalUserId : account.externalUsername);
  const profileFingerprint = fingerprint({
    profileUrl: remote.profileUrl,
    avatarUrl: remote.avatarUrl,
    userIsArtist: remote.userIsArtist,
    artistLevel: remote.artistLevel,
    artistSpecialty: remote.artistSpecialty,
    realName: remote.realName,
    tagline: remote.tagline,
    country: remote.country,
    website: remote.website,
    bio: remote.bio,
    coverPhotoUrl: remote.coverPhotoUrl,
    joinedAt: remote.joinedAt,
    stats: remote.stats
  });
  const current = await store.getExternalAccountProfile(account.externalAccountId);
  const profile: ExternalAccountProfile = {
    externalAccountId: account.externalAccountId,
    capturedAt: now,
    profileUrl: remote.profileUrl,
    avatarUrl: remote.avatarUrl,
    userIsArtist: remote.userIsArtist,
    artistLevel: remote.artistLevel,
    artistSpecialty: remote.artistSpecialty,
    realName: remote.realName,
    tagline: remote.tagline,
    country: remote.country,
    website: remote.website,
    bio: remote.bio,
    coverPhotoUrl: remote.coverPhotoUrl,
    joinedAt: remote.joinedAt,
    stats: remote.stats,
    profileFingerprint,
    rawPayload: remote.rawPayload
  };
  await store.upsertExternalAccountProfile(profile);
  const changed = current?.profileFingerprint !== profileFingerprint;
  if (changed) {
    await store.createExternalAccountProfileSnapshot({
      ...profile,
      externalAccountProfileSnapshotId: randomUUID()
    });
  }
  return { changed, profile };
};

const reconcileWatchers = async (
  store: DataStore,
  provider: ExternalPlatformProvider,
  accessToken: string,
  account: ExternalAccount,
  now: string
): Promise<{ discovered: number; synchronized: number; added: number; removed: number; truncated: boolean }> => {
  const existing = await store.listExternalWatchers(account.externalAccountId, 50050);
  const existingByUserId = new Map(existing.map((watcher) => [watcher.externalUserId, watcher]));
  const checkpoint = await store.getExternalSyncCheckpoint(account.externalAccountId, 'watchers', account.externalAccountId);
  const isInitialBaseline = !checkpoint?.lastSuccessfulSyncAt;
  const seen = new Set<string>();
  let cursor: string | undefined;
  let truncated = false;
  let synchronized = 0;
  let added = 0;
  let removed = 0;
  do {
    const page = await provider.listWatchers(accessToken, account.externalUsername, cursor);
    truncated ||= page.truncated === true;
    for (const remote of page.items) {
      seen.add(remote.externalUserId);
      const current = existingByUserId.get(remote.externalUserId);
      const becameActive = Boolean(current && !current.active) || Boolean(!current && !isInitialBaseline);
      const stateVersion = current?.stateVersion || 0;
      const lastActivityRemoteId = becameActive
        ? `watcher:${remote.externalUserId}:${stateVersion + 1}:watch`
        : current?.lastActivityRemoteId;
      const watcher: ExternalWatcher = {
        externalAccountId: account.externalAccountId,
        externalUserId: remote.externalUserId,
        externalUsername: remote.username,
        externalUserAvatarUrl: remote.avatarUrl,
        lastVisitAtRemote: remote.lastVisitAt,
        watchSettings: remote.watchSettings,
        firstSeenAt: current?.firstSeenAt || now,
        lastSeenAt: now,
        active: true,
        removalDetectedAt: undefined,
        stateVersion: becameActive ? stateVersion + 1 : stateVersion,
        lastActivityRemoteId,
        rawPayload: remote.rawPayload
      };
      await store.upsertExternalWatcher(watcher);
      existingByUserId.set(remote.externalUserId, watcher);
      if (becameActive && lastActivityRemoteId) {
        added += 1;
        await upsertActivity(store, account, {
          remoteActivityId: lastActivityRemoteId,
          sourceMessageId: remote.externalUserId,
          type: 'watch',
          occurredAt: now,
          actorId: remote.externalUserId,
          actorName: remote.username,
          actorAvatarUrl: remote.avatarUrl,
          body: `Started watching @${account.externalUsername}`,
          rawPayload: remote.rawPayload
        }, undefined, now);
      }
      synchronized += 1;
    }
    cursor = page.nextCursor;
  } while (cursor);

  if (!truncated) {
    for (const watcher of existing) {
      if (!watcher.active || seen.has(watcher.externalUserId)) continue;
      const stateVersion = watcher.stateVersion + 1;
      const lastActivityRemoteId = `watcher:${watcher.externalUserId}:${stateVersion}:unwatch`;
      await store.upsertExternalWatcher({
        ...watcher,
        active: false,
        removalDetectedAt: now,
        lastSeenAt: now,
        stateVersion,
        lastActivityRemoteId
      });
      await upsertActivity(store, account, {
        remoteActivityId: lastActivityRemoteId,
        sourceMessageId: watcher.externalUserId,
        type: 'unwatch',
        occurredAt: now,
        actorId: watcher.externalUserId,
        actorName: watcher.externalUsername,
        actorAvatarUrl: watcher.externalUserAvatarUrl,
        body: `Stopped watching @${account.externalUsername}`,
        rawPayload: watcher.rawPayload || {}
      }, undefined, now);
      removed += 1;
    }
  }
  const activeCount = truncated
    ? [...existingByUserId.values()].filter((watcher) => watcher.active).length
    : seen.size;
  await updateCheckpoint(store, account, 'watchers', account.externalAccountId, now, [...seen], {
    activeCount,
    added,
    removed,
    truncated,
    lastReconciledAt: now
  });
  return { discovered: seen.size, synchronized, added, removed, truncated };
};

const executeActivitySync = async (store: DataStore, config: AppConfig, job: ExternalSyncJob, account: ExternalAccount, queue?: ExternalSyncQueue): Promise<void> => {
  const provider = await providerForAccount(store, config, account);
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  const publicationByContentId = new Map((await store.listExternalPublications(account.externalAccountId))
    .map((publication) => [publication.externalContentId, publication]));
  const now = new Date().toISOString();
  let discovered = 0;
  let synchronized = 0;
  const profileResult = await synchronizeAccountProfile(store, provider, session.accessToken, session.account, now);
  discovered += 1;
  synchronized += 1;
  const storeRemoteActivity = async (remote: ExternalRemoteActivity): Promise<void> => {
    const publication = remote.externalContentId ? publicationByContentId.get(remote.externalContentId) : undefined;
    await upsertActivity(store, session.account, remote, publication, now);
    if (publication && remote.externalCommentId) {
      await upsertRemoteComment(store, publication, {
        externalCommentId: remote.externalCommentId,
        authorId: remote.actorId,
        authorName: remote.actorName,
        authorAvatarUrl: remote.actorAvatarUrl,
        body: remote.body || '',
        createdAt: remote.occurredAt,
        parentExternalCommentId: remote.parentExternalCommentId,
        rawPayload: remote.rawPayload
      }, now);
    }
    synchronized += 1;
  };
  if (session.account.platform === 'soundcloud') {
    const checkpoint = await store.getExternalSyncCheckpoint(account.externalAccountId, 'messages.feed', account.externalAccountId);
    const known = new Set(checkpoint?.recentRemoteIds || []);
    const remoteIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await provider.listMessages(session.accessToken, 'feed', cursor);
      discovered += page.items.length;
      let newOnPage = 0;
      for (const remote of page.items) {
        remoteIds.push(remote.remoteActivityId);
        if (!known.has(remote.remoteActivityId)) newOnPage += 1;
        await storeRemoteActivity(remote);
      }
      cursor = known.size && newOnPage === 0 ? undefined : page.nextCursor;
    } while (cursor);
    await updateCheckpoint(store, session.account, 'messages.feed', account.externalAccountId, now, remoteIds);
    const engagementJob = await enqueueRelatedSyncJob(store, config, session.account, 'engagement_sync', queue);
    await updateJob(store, job, { status: 'successful', progress: { discovered, synchronized, remaining: 0 }, errorCode: undefined, errorMessage: undefined, nextAttemptAt: undefined });
    await addLog(store, job.externalSyncJobId, 'info', 'Available SoundCloud activity synchronized', { discovered, synchronized, profileChanged: profileResult.changed, engagementJobId: engagementJob.externalSyncJobId });
    return;
  }
  for (const feedbackType of ['comments', 'replies', 'activity'] as const) {
    const resourceType = `feedback.${feedbackType}` as ExternalSyncCheckpoint['resourceType'];
    const checkpoint = await store.getExternalSyncCheckpoint(account.externalAccountId, resourceType, account.externalAccountId);
    const known = new Set(checkpoint?.recentRemoteIds || []);
    const remoteIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await provider.listFeedback(session.accessToken, feedbackType, cursor);
      discovered += page.items.length;
      let newOnPage = 0;
      for (const remote of page.items) {
        remoteIds.push(remote.remoteActivityId);
        if (!known.has(remote.remoteActivityId)) newOnPage += 1;
        await storeRemoteActivity(remote);
      }
      cursor = page.nextCursor;
      if (known.size && newOnPage === 0) cursor = undefined;
    } while (cursor);
    await updateCheckpoint(store, session.account, resourceType, account.externalAccountId, now, remoteIds);
  }

  for (const source of ['feed', 'mentions'] as const) {
    const resourceType = `messages.${source}` as ExternalSyncCheckpoint['resourceType'];
    const checkpoint = await store.getExternalSyncCheckpoint(account.externalAccountId, resourceType, account.externalAccountId);
    const known = new Set(checkpoint?.recentRemoteIds || []);
    const remoteIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await provider.listMessages(session.accessToken, source, cursor);
      discovered += page.items.length;
      let newOnPage = 0;
      for (const remote of page.items) {
        remoteIds.push(remote.remoteActivityId);
        if (!known.has(remote.remoteActivityId)) newOnPage += 1;
        if (source === 'mentions' && remote.stackId && (remote.stackCount || 0) > 1) {
          let stackCursor: string | undefined;
          do {
            const stackPage = await provider.listMessageStack(session.accessToken, 'mentions', remote.stackId, stackCursor);
            discovered += stackPage.items.length;
            for (const stackRemote of stackPage.items) {
              const withStack = { ...stackRemote, stackId: stackRemote.stackId || remote.stackId };
              remoteIds.push(withStack.remoteActivityId);
              await storeRemoteActivity(withStack);
            }
            stackCursor = stackPage.nextCursor;
          } while (stackCursor);
        } else {
          await storeRemoteActivity(remote);
        }
      }
      cursor = page.nextCursor;
      if (known.size && newOnPage === 0) cursor = undefined;
    } while (cursor);
    await updateCheckpoint(store, session.account, resourceType, account.externalAccountId, now, remoteIds);
  }

  const watchers = await reconcileWatchers(store, provider, session.accessToken, session.account, now);
  discovered += watchers.discovered;
  synchronized += watchers.synchronized;
  if (watchers.truncated) {
    await addLog(store, job.externalSyncJobId, 'warning', 'DeviantArt watcher reconciliation reached the API pagination limit; removals were not inferred', {
      discovered: watchers.discovered
    });
  }
  const engagementJob = await enqueueRelatedSyncJob(store, config, session.account, 'engagement_sync', queue);
  await updateJob(store, job, { status: 'successful', progress: { discovered, synchronized, remaining: 0 }, errorCode: undefined, errorMessage: undefined, nextAttemptAt: undefined });
  await addLog(store, job.externalSyncJobId, 'info', 'DeviantArt messages, mentions, and watchers synchronized', {
    discovered,
    synchronized,
    watchersAdded: watchers.added,
    watchersRemoved: watchers.removed,
    watcherListTruncated: watchers.truncated,
    profileChanged: profileResult.changed,
    engagementJobId: engagementJob.externalSyncJobId
  });
};

const executeEngagementSync = async (store: DataStore, config: AppConfig, job: ExternalSyncJob, account: ExternalAccount): Promise<void> => {
  const provider = await providerForAccount(store, config, account);
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  const requestedContentId = typeof job.payload?.externalContentId === 'string' ? job.payload.externalContentId : undefined;
  const publications = (await store.listExternalPublications(account.externalAccountId))
    .filter((publication) => publication.syncStatus === 'active' && (!requestedContentId || publication.externalContentId === requestedContentId));
  const publicationByContentId = new Map(publications.map((publication) => [publication.externalContentId, publication]));
  const now = new Date().toISOString();
  let synchronized = 0;
  let commentsReconciled = 0;
  let favouritesReconciled = 0;
  for (let offset = 0; offset < publications.length; offset += DEVIANTART_METADATA_BATCH_SIZE) {
    const batch = publications.slice(offset, offset + DEVIANTART_METADATA_BATCH_SIZE);
    const engagement = await provider.getEngagement(session.accessToken, batch.map((publication) => publication.externalContentId));
    for (const remote of engagement) {
      const publication = publicationByContentId.get(remote.externalContentId);
      if (!publication) continue;
      const result = await storeEngagement(store, publication, remote.metrics, now);
      synchronized += 1;
      const [commentsCheckpoint, favouritesCheckpoint] = await Promise.all([
        store.getExternalSyncCheckpoint(account.externalAccountId, 'comments', publication.externalPublicationId),
        store.getExternalSyncCheckpoint(account.externalAccountId, 'favourites', publication.externalPublicationId)
      ]);
      if (!commentsCheckpoint?.lastSuccessfulSyncAt || !result.previous || result.previous.comments !== remote.metrics.comments) {
        await reconcileCommentsForPublication(store, provider, session.accessToken, session.account, publication, now);
        commentsReconciled += 1;
      }
      if (!favouritesCheckpoint?.lastSuccessfulSyncAt || !result.previous || result.previous.favourites !== remote.metrics.favourites) {
        await reconcileFavouritesForPublication(store, provider, session.accessToken, session.account, publication, now);
        favouritesReconciled += 1;
      }
      await updateCheckpoint(store, session.account, 'engagement', publication.externalPublicationId, now, [remote.externalContentId]);
    }
  }
  await updateJob(store, job, { status: 'successful', progress: { discovered: publications.length, synchronized, remaining: 0 }, errorCode: undefined, errorMessage: undefined, nextAttemptAt: undefined });
  await addLog(store, job.externalSyncJobId, 'info', 'DeviantArt engagement synchronized', {
    publications: publications.length,
    synchronized,
    commentsReconciled,
    favouritesReconciled
  });
};

export const replyToExternalComment = async (
  store: DataStore,
  config: AppConfig,
  account: ExternalAccount,
  publication: ExternalPublication,
  body: string,
  parentExternalCommentId?: string
): Promise<ExternalComment> => {
  const provider = await providerForAccount(store, config, account);
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  const remote = await provider.postComment(session.accessToken, publication.externalContentId, body, parentExternalCommentId);
  const now = new Date().toISOString();
  const comment = await upsertRemoteComment(store, publication, remote, now);
  await upsertActivity(store, session.account, {
    remoteActivityId: `comment:${remote.externalCommentId}`,
    sourceMessageId: remote.externalCommentId,
    type: parentExternalCommentId ? 'reply' : 'comment',
    occurredAt: remote.createdAt,
    actorId: session.account.externalUserId,
    actorName: session.account.externalUsername,
    externalContentId: publication.externalContentId,
    externalCommentId: remote.externalCommentId,
    parentExternalCommentId,
    body: remote.body,
    rawPayload: remote.rawPayload || {}
  }, publication, now, 'outbound');
  return comment;
};

export const dismissExternalActivity = async (
  store: DataStore,
  config: AppConfig,
  account: ExternalAccount,
  activity: IntegrationActivity,
  dismissStack = false
): Promise<IntegrationActivity> => {
  const messageId = dismissStack ? undefined : activity.remoteMessageId;
  const stackId = dismissStack ? activity.remoteStackId : undefined;
  if (!messageId && !stackId) {
    throw new ExternalProviderError('This activity is not backed by a dismissible DeviantArt notification', 'unsupported');
  }
  const provider = await providerForAccount(store, config, account);
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  await provider.deleteMessage(session.accessToken, { messageId, stackId });
  const now = new Date().toISOString();
  const updated: IntegrationActivity = {
    ...activity,
    readAt: activity.readAt || now,
    remoteDeletedAt: now,
    updatedAt: now
  };
  await store.upsertExternalActivity(updated);
  if (dismissStack && stackId) {
    const stackActivities = (await store.listExternalActivitiesByAccount(account.externalAccountId, 1000))
      .filter((candidate) => candidate.remoteStackId === stackId && candidate.externalActivityId !== activity.externalActivityId);
    await Promise.all(stackActivities.map((candidate) => store.upsertExternalActivity({
      ...candidate,
      readAt: candidate.readAt || now,
      remoteDeletedAt: now,
      updatedAt: now
    })));
  }
  return updated;
};

const executeUserAction = async (store: DataStore, config: AppConfig, job: ExternalSyncJob, account: ExternalAccount): Promise<void> => {
  const action = typeof job.payload?.action === 'string' ? job.payload.action : '';
  const targetId = typeof job.payload?.targetId === 'string' ? job.payload.targetId : '';
  if (!targetId) throw new ExternalProviderError('The SoundCloud action target is missing', 'invalid_response');
  const provider = await providerForAccount(store, config, account);
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  const invoke = async (): Promise<ExternalRemoteComment | undefined> => {
    if (action === 'comment' && provider.postTimedComment) return provider.postTimedComment(session.accessToken, targetId, String(job.payload?.body || ''), typeof job.payload?.timestampMs === 'number' ? job.payload.timestampMs : undefined);
    if (action === 'like' && provider.likeContent) await provider.likeContent(session.accessToken, targetId);
    else if (action === 'unlike' && provider.unlikeContent) await provider.unlikeContent(session.accessToken, targetId);
    else if (action === 'repost' && provider.repostContent) await provider.repostContent(session.accessToken, targetId);
    else if (action === 'unrepost' && provider.unrepostContent) await provider.unrepostContent(session.accessToken, targetId);
    else if (action === 'follow' && provider.followUser) await provider.followUser(session.accessToken, targetId);
    else if (action === 'unfollow' && provider.unfollowUser) await provider.unfollowUser(session.accessToken, targetId);
    else if (action !== 'comment') throw new ExternalProviderError(`Unsupported ${account.platform} user action`, 'unsupported');
    return undefined;
  };
  const comment = await invoke();
  const now = new Date().toISOString();
  const publication = (await store.listExternalPublications(account.externalAccountId)).find((item) => item.externalContentId === targetId);
  if (comment && publication) await upsertRemoteComment(store, publication, comment, now);
  await upsertActivity(store, session.account, {
    remoteActivityId: `outbound:${job.payload?.idempotencyKey || job.externalSyncJobId}`,
    sourceMessageId: job.externalSyncJobId,
    type: comment ? 'comment' : action === 'like' || action === 'unlike' ? 'favourite' : 'activity',
    occurredAt: now,
    externalContentId: publication?.externalContentId,
    externalCommentId: comment?.externalCommentId,
    body: comment?.body || action,
    rawPayload: { action, targetId }
  }, publication, now, 'outbound');
  await updateJob(store, job, { status: 'successful', progress: { discovered: 1, synchronized: 1, remaining: 0 }, errorCode: undefined, errorMessage: undefined, nextAttemptAt: undefined });
  await addLog(store, job.externalSyncJobId, 'info', `Explicit ${account.platform} ${action} action completed`, { targetId });
};

export const processExternalSyncJob = async (store: DataStore, config: AppConfig, externalSyncJobId: string, queue?: ExternalSyncQueue): Promise<void> => {
  const job = await store.getExternalSyncJob(externalSyncJobId);
  if (!job || job.status === 'cancelled' || job.status === 'successful') return;
  const account = await store.getExternalAccount(job.externalAccountId);
  if (!account) {
    await updateJob(store, job, { status: 'failed', errorCode: 'ACCOUNT_NOT_FOUND', errorMessage: 'Connected account no longer exists' });
    return;
  }
  if (account.connectionStatus === 'disabled') {
    await updateJob(store, job, { status: 'cancelled', errorCode: 'ACCOUNT_REMOVED', errorMessage: 'Synchronization stopped because the DeviantArt account was removed' });
    return;
  }
  const operation: IntegrationOperation = job.type === 'publish'
    ? 'publish'
    : job.type === 'remote_update'
      ? 'update_remote'
      : job.type === 'content_sync' || job.type === 'account_import' || job.type === 'account_scan' || job.type === 'full_reconciliation'
        ? 'import'
        : 'read_engagement';
  try {
    requireIntegrationOperation(account.platform, operation);
  } catch (error) {
    await updateJob(store, job, {
      status: 'failed',
      errorCode: 'UNSUPPORTED_OPERATION',
      errorMessage: error instanceof Error ? error.message : 'The integration does not support this operation.',
      nextAttemptAt: undefined
    });
    return;
  }
  const policyTargets = [
    { type: 'external_account' as const, id: account.externalAccountId },
    ...(account.primaryCreatorIdentityId || account.creatorIdentityId
      ? [{ type: 'creator' as const, id: account.primaryCreatorIdentityId || account.creatorIdentityId! }]
      : []),
    ...(typeof job.payload?.assetId === 'string' ? [{ type: 'asset' as const, id: job.payload.assetId }] : []),
    ...(typeof job.payload?.externalPublicationId === 'string' ? [{ type: 'publication' as const, id: job.payload.externalPublicationId }] : []),
    ...(typeof job.payload?.externalContentId === 'string' ? [{ type: 'external_content' as const, id: job.payload.externalContentId }] : [])
  ];
  const policy = await createStoreIntegrationPolicyGate(store).evaluate({ operation, targets: policyTargets });
  if (!policy.allowed) {
    await updateJob(store, job, {
      status: 'failed',
      errorCode: 'SAFETY_HOLD',
      errorMessage: policy.reason,
      nextAttemptAt: undefined
    });
    await addLog(store, job.externalSyncJobId, 'warning', 'Integration job blocked by an active safety hold', { operation, activeHoldTypes: policy.activeHoldTypes });
    return;
  }
  const rateLimitedUntilMs = account.rateLimitedUntil ? Date.parse(account.rateLimitedUntil) : NaN;
  if (account.connectionStatus === 'rate_limited' && Number.isFinite(rateLimitedUntilMs) && rateLimitedUntilMs > Date.now()) {
    await updateJob(store, job, {
      status: 'rate_limited',
      nextAttemptAt: account.rateLimitedUntil,
      errorCode: 'ACCOUNT_RATE_LIMITED',
      errorMessage: 'Waiting for the DeviantArt account cooldown before continuing'
    });
    return;
  }
  const attemptCount = job.attemptCount + 1;
  const processingJob = await updateJob(store, job, { status: 'processing', attemptCount, lastAttemptAt: new Date().toISOString() });
  if (processingJob.status === 'cancelled') return;
  await addLog(store, job.externalSyncJobId, 'info', 'Sync job started', { type: job.type, attemptCount });
  try {
    if (job.type === 'account_import' || job.type === 'full_reconciliation' || job.type === 'account_scan') {
      await executeAccountImport(store, config, processingJob, account, queue);
    } else if (job.type === 'content_sync') {
      await executeContentSync(store, config, processingJob, account);
    } else if (job.type === 'comment_sync') {
      await executeCommentSync(store, config, processingJob, account);
    } else if (job.type === 'activity_sync') {
      await executeActivitySync(store, config, processingJob, account, queue);
    } else if (job.type === 'engagement_sync') {
      await executeEngagementSync(store, config, processingJob, account);
    } else if (job.type === 'remote_update') {
      await executeRemoteUpdate(store, config, processingJob, account, queue);
    } else if (job.type === 'remote_delete') {
      await executeRemoteDelete(store, config, processingJob, account);
    } else if (job.type === 'user_action') {
      await executeUserAction(store, config, processingJob, account);
    } else if (job.type === 'publish') {
      await executePublish(store, config, processingJob, account);
    } else {
      throw new ExternalProviderError(`Sync job type ${job.type} is not implemented yet`, 'unsupported');
    }
    if ((await store.getExternalSyncJob(externalSyncJobId))?.status === 'successful') {
      await markAccountRecovered(store, account.externalAccountId);
    }
  } catch (error) {
    const providerError = error instanceof ExternalProviderError
      ? error
      : new ExternalProviderError(
        error instanceof Error && error.message ? error.message : 'External synchronization failed',
        'temporarily_unavailable'
      );
    const latest = await store.getExternalSyncJob(externalSyncJobId) || { ...job, attemptCount };
    if (error instanceof SyncCancelledError || latest.status === 'cancelled') {
      if (latest.status !== 'cancelled') {
        await updateJob(store, latest, {
          status: 'cancelled',
          nextAttemptAt: undefined,
          errorCode: 'CANCELLED_BY_USER',
          errorMessage: 'Synchronization cancelled by the user'
        });
      }
      await addLog(store, externalSyncJobId, 'info', 'Synchronization cancelled');
      return;
    }
    const currentAccount = await store.getExternalAccount(account.externalAccountId);
    if (currentAccount?.connectionStatus === 'disabled') {
      await updateJob(store, latest, {
        status: 'cancelled',
        errorCode: 'ACCOUNT_REMOVED',
        errorMessage: 'Synchronization stopped because the DeviantArt account was removed'
      });
      return;
    }
    // A failed optional Space copy does not invalidate the DeviantArt
    // connection. Keep its failure on the content-sync job/publication so a
    // healthy catalogue connection does not appear unavailable.
    const isContentSync = job.type === 'content_sync';
    const jobWillRetry = shouldRetryExternalJobFailure(job.type, providerError.code, attemptCount);
    if (providerError.code === 'authentication_required' && !isContentSync) {
      await store.updateExternalAccount({ ...account, connectionStatus: 'authentication_required', lastSyncAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await updateJob(store, latest, { status: 'authentication_required', errorCode: providerError.code, errorMessage: providerError.message });
    } else if (providerError.code === 'rate_limited') {
      const delay = providerError.retryAfterSeconds !== undefined
        ? Math.max(1, providerError.retryAfterSeconds)
        : retryDelaySeconds(attemptCount, config.externalSyncBaseDelaySeconds);
      const proposedRateLimitedUntil = new Date(Date.now() + delay * 1000).toISOString();
      const existingRateLimitedUntil = currentAccount?.rateLimitedUntil;
      const rateLimitedUntil = existingRateLimitedUntil && existingRateLimitedUntil > proposedRateLimitedUntil
        ? existingRateLimitedUntil
        : proposedRateLimitedUntil;
      await store.updateExternalAccount({
        ...(currentAccount || account),
        connectionStatus: 'rate_limited',
        rateLimitedUntil,
        lastSyncAttemptAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      await updateJob(store, latest, {
        status: 'rate_limited',
        nextAttemptAt: rateLimitedUntil,
        errorCode: providerError.code,
        errorMessage: providerError.message
      });
      const deferredJobs = await deferQueuedJobsForAccount(store, account.externalAccountId, externalSyncJobId, rateLimitedUntil);
      if (job.type === 'content_sync' && typeof job.payload?.assetId === 'string') {
        const spacePublication = await store.getSpacePublication(job.payload.assetId);
        if (spacePublication && spacePublication.contentSyncStatus !== 'hosted') {
          await store.upsertSpacePublication({
            ...spacePublication,
            contentSyncStatus: 'queued',
            contentSyncError: undefined,
            updatedAt: new Date().toISOString()
          });
        }
      }
      const platformLabel = account.platform === 'youtube' ? 'YouTube' : 'DeviantArt';
      await addLog(store, externalSyncJobId, 'warning', `${platformLabel} rate limit reached; account work paused`, {
        type: job.type,
        attemptCount,
        delaySeconds: delay,
        rateLimitedUntil,
        deferredJobs
      });
    } else if (providerError.code === 'ambiguous_submission' && jobWillRetry) {
      const delay = retryDelaySeconds(attemptCount, config.externalSyncBaseDelaySeconds);
      await updateJob(store, latest, {
        status: 'retry_scheduled',
        nextAttemptAt: new Date(Date.now() + delay * 1000).toISOString(),
        errorCode: providerError.code,
        errorMessage: `${providerError.message}. Retrying automatically (${attemptCount + 1}/${MAX_AMBIGUOUS_PUBLISH_ATTEMPTS}).`
      });
    } else if (providerError.code === 'temporarily_unavailable' && !isContentSync) {
      const delay = retryDelaySeconds(attemptCount, config.externalSyncBaseDelaySeconds);
      await store.updateExternalAccount({ ...(currentAccount || account), connectionStatus: 'temporarily_unavailable', lastSyncAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await updateJob(store, latest, {
        status: 'retry_scheduled',
        nextAttemptAt: new Date(Date.now() + delay * 1000).toISOString(),
        errorCode: providerError.code,
        errorMessage: providerError.message
      });
    } else {
      await updateJob(store, latest, { status: 'failed', errorCode: providerError.code, errorMessage: providerError.message });
    }
    const failedPublicationId = typeof job.payload?.externalPublicationId === 'string' ? job.payload.externalPublicationId : '';
    const publishWillRetry = job.type === 'publish' && jobWillRetry;
    if (failedPublicationId && (providerError.code !== 'rate_limited' || publishWillRetry)) {
      const canonicalPublication = await store.getPublication(config.tenantId, failedPublicationId);
      if (canonicalPublication) {
        await store.upsertPublication({
          ...canonicalPublication,
          status: publishWillRetry
            ? 'queued'
            : job.type === 'publish'
              ? 'failed'
              : canonicalPublication.status,
          sync: {
            ...canonicalPublication.sync,
            status: publishWillRetry ? 'local_newer' : 'error',
            lastAttemptAt: new Date().toISOString(),
            errorCode: publishWillRetry ? undefined : providerError.code,
            errorMessage: publishWillRetry ? undefined : providerError.message
          },
          updatedAt: new Date().toISOString()
        });
      }
    }
    if (job.type === 'content_sync' && providerError.code !== 'rate_limited' && typeof job.payload?.assetId === 'string') {
      const current = await store.getSpacePublication(job.payload.assetId);
      if (current) {
        await store.upsertSpacePublication({
          ...current,
          hostingMode: current.hostingMode === 'hosted' ? 'hosted' : 'linked',
          contentSyncStatus: 'failed',
          contentSyncError: providerError.message,
          updatedAt: new Date().toISOString()
        });
      }
    }
    if (providerError.code !== 'rate_limited') {
      await addLog(store, externalSyncJobId, jobWillRetry ? 'warning' : 'error', providerError.message, {
        code: providerError.code,
        attemptCount,
        retryScheduled: jobWillRetry
      });
    }
  } finally {
    // Hold the single worker slot briefly after each job as well. This closes
    // the gap between separate SQS/Lambda invocations, where an in-process
    // request pacer may be reset by a cold start.
    const minimumRequestIntervalMs = account.platform === 'youtube'
      ? config.youtubeMinimumRequestIntervalMs
      : config.deviantArtMinimumRequestIntervalMs;
    const intervalMs = Number.isFinite(minimumRequestIntervalMs)
      ? Math.max(0, Math.floor(minimumRequestIntervalMs))
      : 0;
    if ((account.platform === 'deviantart' || account.platform === 'youtube') && intervalMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
};
