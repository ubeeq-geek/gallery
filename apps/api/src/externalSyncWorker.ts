import { createHash, randomUUID } from 'crypto';
import type { AppConfig } from './config';
import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import { readStoredUbeeqWorkImage, storeExternalContent } from './externalContentStorage';
import { createExternalSyncQueue, type ExternalSyncQueue } from './externalSyncQueue';
import { createExternalPlatformProvider, DEVIANTART_METADATA_BATCH_SIZE, ExternalProviderError, type ExternalContentPublish, type ExternalContentUpdate, type ExternalPlatformProvider, type ExternalRemoteActivity, type ExternalRemoteComment, type ExternalRemoteContent, type ExternalRemoteEngagement } from './externalPlatformProvider';
import type { Asset, ExternalAccount, ExternalActivity, ExternalComment, ExternalEngagementCurrent, ExternalPublication, ExternalSyncCheckpoint, ExternalSyncJob, ExternalSyncJobType, SpacePublication } from './domain';
import type { DataStore } from './store';

const retryDelaySeconds = (attempt: number, configuredBase: number): number => {
  const schedule = [1, 5, 30, 120];
  const minutes = schedule[Math.min(Math.max(0, attempt - 1), schedule.length - 1)];
  return Math.max(configuredBase, minutes * 60);
};

const updateJob = async (
  store: DataStore,
  job: ExternalSyncJob,
  update: Partial<ExternalSyncJob>
): Promise<ExternalSyncJob> => {
  const next = { ...job, ...update, updatedAt: new Date().toISOString() };
  await store.updateExternalSyncJob(next);
  return next;
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
    throw new ExternalProviderError('The account-owned DeviantArt application credentials are unavailable', 'authentication_required');
  }
  return createExternalPlatformProvider(account.platform, {
    clientId: credential.clientId,
    clientSecret: decryptExternalCredential(credential.clientSecretEncrypted, config.externalTokenEncryptionKey),
    redirectUri: credential.redirectUri
  });
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
    throw new ExternalProviderError('DeviantArt authentication has expired', 'authentication_required');
  }
  const refreshToken = decryptExternalCredential(account.refreshTokenEncrypted, config.externalTokenEncryptionKey);
  const tokens = await provider.refreshAuthentication(refreshToken);
  const refreshed: ExternalAccount = {
    ...account,
    accessTokenEncrypted: encryptExternalCredential(tokens.accessToken, config.externalTokenEncryptionKey),
    refreshTokenEncrypted: tokens.refreshToken
      ? encryptExternalCredential(tokens.refreshToken, config.externalTokenEncryptionKey)
      : account.refreshTokenEncrypted,
    tokenExpiresAt: tokens.expiresAt,
    connectionStatus: 'connected',
    updatedAt: new Date().toISOString()
  };
  await store.updateExternalAccount(refreshed);
  accessToken = tokens.accessToken;
  return { account: refreshed, accessToken };
};

const upsertContent = async (
  store: DataStore,
  account: ExternalAccount,
  remote: ExternalRemoteContent,
  now: string
): Promise<{ asset: Asset; publication: ExternalPublication }> => {
  const primaryCreatorIdentityId = account.primaryCreatorIdentityId || account.creatorIdentityId;
  if (!primaryCreatorIdentityId) {
    throw new ExternalProviderError('Assign this DeviantArt account to a creator before importing its catalogue', 'unsupported');
  }
  const currentPublication = await store.getExternalPublication(account.externalAccountId, remote.externalContentId);
  let asset: Asset | null = currentPublication ? await store.getAsset(currentPublication.assetId) : null;
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
    remoteMetadataFingerprint: remoteMetadataFingerprint(remote),
    remoteContentFingerprint: remoteContentFingerprint(remote),
    lastSyncedAt: now,
    lastSeenAt: now,
    syncStatus: 'active',
    // DeviantArt's read API currently omits newer AI label values. Retain any
    // values Ubeeq previously submitted while refreshing the fields DA reports,
    // including values nested inside the extended `submission` object.
    rawMetadataJson: mergeExternalMetadata(currentPublication?.rawMetadataJson || {}, remote.rawMetadata),
    createdAt: currentPublication?.createdAt || now,
    updatedAt: now
  };
  if (currentPublication) await store.updateExternalPublication(publication);
  else await store.createExternalPublication(publication);

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
    payload: { assetId, externalPublicationId },
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
    published: true,
    hostingMode: current?.hostingMode === 'hosted' ? 'hosted' : 'linked',
    publishedAt: current?.publishedAt || now,
    ubeeqTitleOverride: current?.ubeeqTitleOverride,
    ubeeqDescriptionOverride: current?.ubeeqDescriptionOverride,
    visibility: current?.visibility || 'private',
    contentSyncStatus: 'queued',
    contentSyncError: undefined,
    remoteContentFingerprint: publication.remoteContentFingerprint,
    updatedAt: now
  };
  await store.upsertSpacePublication(spacePublication);
  await enqueueContentSyncJob(store, config, account.externalAccountId, asset.assetId, publication.externalPublicationId, queue);
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
    published: true,
    hostingMode: current?.hostingMode || 'linked',
    publishedAt: current?.publishedAt || now,
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
  if (!remote.content?.sourceUrl) {
    throw new ExternalProviderError('DeviantArt did not provide a downloadable source file for this work', 'unsupported');
  }
  const stored = await storeExternalContent(config, {
    userId: asset.userId,
    creatorIdentityId: asset.creatorIdentityId,
    assetId: asset.assetId,
    externalContentId: publication.externalContentId,
    sourceUrl: remote.content.sourceUrl,
    contentType: remote.content.contentType,
    expectedByteSize: remote.content.byteSize,
    existingChecksumSha256: current?.hostedChecksumSha256,
    existingObjectKey: current?.hostedObjectKey,
    existingThumbnailObjectKey: current?.hostedThumbnailObjectKey
  });
  await store.upsertSpacePublication({
    ...current,
    assetId: asset.assetId,
    published: true,
    hostingMode: 'hosted',
    publishedAt: current?.publishedAt || now,
    ubeeqTitleOverride: current?.ubeeqTitleOverride,
    ubeeqDescriptionOverride: current?.ubeeqDescriptionOverride,
    visibility: current?.visibility || 'private',
    contentSyncStatus: 'hosted',
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
  await updateJob(store, job, { status: 'successful', progress: { discovered: 1, synchronized: 1, remaining: 0 }, errorCode: undefined, errorMessage: undefined });
  await addLog(store, job.externalSyncJobId, 'info', stored.unchanged
    ? 'DeviantArt source file is unchanged; existing Ubeeq Space copy retained'
    : 'DeviantArt source file stored as a new Ubeeq Space version', {
    assetId,
    bytes: stored.byteSize,
    checksumSha256: stored.checksumSha256,
    unchanged: stored.unchanged
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
  if (typeof job.payload?.allowComments === 'boolean') update.allowComments = job.payload.allowComments;
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
    rawMetadata: {
      ...remote.rawMetadata,
      ...(update.isAiGenerated !== undefined ? { is_ai_generated: update.isAiGenerated } : {}),
      ...(update.noAi !== undefined ? { noai: update.noAi } : {})
    }
  };
  await upsertContent(store, session.account, verifiedRemote, new Date().toISOString());
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
  const content: ExternalContentPublish = {
    body: await readStoredUbeeqWorkImage(config, spacePublication.hostedObjectKey),
    filename,
    contentType: spacePublication.hostedContentType,
    title: pendingPublication.externalTitle || asset.canonicalTitle || filename,
    description: pendingPublication.externalDescription ?? asset.canonicalDescription,
    tags,
    isMature,
    matureLevel,
    matureClassification,
    allowComments: typeof job.payload?.allowComments === 'boolean'
      ? job.payload.allowComments
      : metadataBoolean(savedSettings, 'allows_comments', 'allow_comments', 'allowComments'),
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
  if (targetStatus === 'draft') {
    const draftPublication: ExternalPublication = {
      ...pendingPublication,
      externalContentId: `stash:${draft.externalDraftId}`,
      externalDraftId: draft.externalDraftId,
      externalUrl: draft.externalUrl,
      externalTitle: pendingPublication.externalTitle || asset.canonicalTitle,
      externalDescription: pendingPublication.externalDescription ?? asset.canonicalDescription,
      externalTags: tags,
      targetStatus: 'draft',
      syncStatus: 'draft',
      rawMetadataJson: { ...savedSettings, ...draft.rawMetadata },
      remoteUpdatedAt: now,
      lastSyncedAt: now,
      lastSeenAt: now,
      updatedAt: now
    };
    await store.updateExternalPublication(draftPublication, pendingPublication.externalContentId);
    await updateJob(store, job, {
      status: 'successful',
      progress: { discovered: 1, synchronized: 1, remaining: 0 },
      errorCode: undefined,
      errorMessage: undefined,
      nextAttemptAt: undefined
    });
    await addLog(store, job.externalSyncJobId, 'info', 'Ubeeq work saved as a DeviantArt Sta.sh draft', { assetId: asset.assetId, externalDraftId: draft.externalDraftId });
    return;
  }
  const published = await provider.publishDraft(session.accessToken, draft.externalDraftId, content);
  const publication: ExternalPublication = {
    ...(pendingPublication || { externalPublicationId: randomUUID(), createdAt: now }),
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
    rawMetadataJson: { ...savedSettings, ...draft.rawMetadata, ...published.rawMetadata },
    publishedAt: now,
    remoteCreatedAt: now,
    remoteUpdatedAt: now,
    lastSyncedAt: now,
    lastSeenAt: now,
    createdAt: pendingPublication?.createdAt || now,
    updatedAt: now
  };
  if (pendingPublication) await store.updateExternalPublication(publication, pendingPublication.externalContentId);
  else await store.createExternalPublication(publication);
  await updateJob(store, job, {
    status: 'successful',
    progress: { discovered: 1, synchronized: 1, remaining: 0 },
    errorCode: undefined,
    errorMessage: undefined,
    nextAttemptAt: undefined
  });
  await addLog(store, job.externalSyncJobId, 'info', 'Ubeeq work published to DeviantArt', { assetId: asset.assetId, externalContentId: published.externalContentId });
};

const executeAccountImport = async (store: DataStore, config: AppConfig, job: ExternalSyncJob, account: ExternalAccount, queue?: ExternalSyncQueue): Promise<void> => {
  const provider = await providerForAccount(store, config, account);
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  const now = new Date().toISOString();
  const collections = await provider.listCollections(session.accessToken, session.account.externalUsername);
  for (const collection of collections) {
    const existing = (await store.listExternalCollections(account.externalAccountId))
      .find((item) => item.externalCollectionExternalId === collection.externalCollectionId);
    const record = {
      externalCollectionId: existing?.externalCollectionId || randomUUID(),
      externalAccountId: account.externalAccountId,
      platform: account.platform,
      externalCollectionExternalId: collection.externalCollectionId,
      name: collection.name,
      parentExternalCollectionExternalId: collection.parentExternalCollectionId,
      position: collection.position,
      lastSyncedAt: now,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    if (existing) await store.updateExternalCollection(record);
    else await store.createExternalCollection(record);
  }

  let cursor: string | undefined;
  let discovered = 0;
  let synchronized = 0;
  let currentJob = job;
  const shouldSyncContent = job.payload?.syncContent === true
    || session.account.initialContentSyncRequested === true
    || session.account.includeSourceFilesOnSync === true;
  do {
    const page = await provider.listContent(session.accessToken, {
      username: session.account.externalUsername,
      cursor,
      limit: 50
    });
    discovered += page.items.length;
    for (const item of page.items) {
      const hasPublishedSettings = metadataBoolean(item.rawMetadata, 'is_mature', 'isMature') !== undefined
        && metadataBoolean(item.rawMetadata, 'allows_comments', 'allow_comments', 'allowComments') !== undefined
        && metadataBoolean(item.rawMetadata, 'is_ai_generated', 'isAiGenerated', 'ai_generated', 'created_with_ai') !== undefined
        && metadataBoolean(item.rawMetadata, 'noai', 'noAI', 'noAi', 'no_ai') !== undefined;
      let resolvedItem = item;
      if (!item.description || !item.tags.length || !hasPublishedSettings) {
        try {
          resolvedItem = await provider.getContent(session.accessToken, item.externalContentId);
        } catch (error) {
          await addLog(store, job.externalSyncJobId, 'warning', 'Could not load complete DeviantArt metadata; retaining catalogue values', {
            externalContentId: item.externalContentId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
      const imported = await upsertContent(store, account, resolvedItem, now);
      if (shouldSyncContent) {
        await queueSpaceContentSync(store, config, account, imported.asset, imported.publication, queue);
      }
      synchronized += 1;
    }
    cursor = page.nextCursor;
    currentJob = await updateJob(store, currentJob, {
      status: 'processing',
      progress: { discovered, synchronized, remaining: cursor ? 1 : 0 }
    });
  } while (cursor);

  const currentAccount = await store.getExternalAccount(account.externalAccountId);
  if (currentAccount?.connectionStatus === 'disabled') {
    await updateJob(store, currentJob, {
      status: 'cancelled',
      errorCode: 'ACCOUNT_REMOVED',
      errorMessage: 'Synchronization stopped because the DeviantArt account was removed'
    });
    return;
  }

  await store.updateExternalAccount({
    ...session.account,
    connectionStatus: 'connected',
    lastSuccessfulSyncAt: now,
    lastSyncAttemptAt: now,
    initialContentSyncRequested: false,
    updatedAt: now
  });
  await updateJob(store, currentJob, {
    status: 'successful',
    progress: { discovered, synchronized, remaining: 0 },
    errorCode: undefined,
    errorMessage: undefined,
    nextAttemptAt: undefined
  });
  const [activityJob, engagementJob] = await Promise.all([
    enqueueRelatedSyncJob(store, config, session.account, 'activity_sync', queue),
    enqueueRelatedSyncJob(store, config, session.account, 'engagement_sync', queue)
  ]);
  await addLog(store, job.externalSyncJobId, 'info', 'DeviantArt account import completed', {
    discovered,
    synchronized,
    collections: collections.length,
    activityJobId: activityJob.externalSyncJobId,
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
  direction: ExternalActivity['direction'] = 'inbound'
): Promise<ExternalActivity> => {
  const existing = await store.getExternalActivityByRemoteId(account.externalAccountId, remote.remoteActivityId);
  const activity: ExternalActivity = {
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
    remoteParentId: remote.parentExternalCommentId,
    remoteStackId: remote.stackId,
    externalActorId: remote.actorId,
    externalActorName: remote.actorName,
    externalActorAvatarUrl: remote.actorAvatarUrl,
    body: remote.body,
    occurredAt: remote.occurredAt,
    firstSeenAt: existing?.firstSeenAt || now,
    lastSeenAt: now,
    seenAt: existing?.seenAt || (remote.isNew === false ? now : undefined),
    readAt: existing?.readAt,
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
  remoteIds: string[] = []
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

const executeActivitySync = async (store: DataStore, config: AppConfig, job: ExternalSyncJob, account: ExternalAccount, queue?: ExternalSyncQueue): Promise<void> => {
  const provider = await providerForAccount(store, config, account);
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  const publicationByContentId = new Map((await store.listExternalPublications(account.externalAccountId))
    .map((publication) => [publication.externalContentId, publication]));
  const now = new Date().toISOString();
  let discovered = 0;
  let synchronized = 0;
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
      }
      cursor = page.nextCursor;
      if (known.size && newOnPage === 0) cursor = undefined;
    } while (cursor);
    await updateCheckpoint(store, session.account, resourceType, account.externalAccountId, now, remoteIds);
  }
  const engagementJob = await enqueueRelatedSyncJob(store, config, session.account, 'engagement_sync', queue);
  await updateJob(store, job, { status: 'successful', progress: { discovered, synchronized, remaining: 0 }, errorCode: undefined, errorMessage: undefined, nextAttemptAt: undefined });
  await addLog(store, job.externalSyncJobId, 'info', 'DeviantArt feedback activity synchronized', {
    discovered,
    synchronized,
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
  const attemptCount = job.attemptCount + 1;
  const processingJob = await updateJob(store, job, { status: 'processing', attemptCount, lastAttemptAt: new Date().toISOString() });
  await addLog(store, job.externalSyncJobId, 'info', 'Sync job started', { type: job.type, attemptCount });
  try {
    if (job.type === 'account_import' || job.type === 'full_reconciliation' || job.type === 'account_scan') {
      await executeAccountImport(store, config, processingJob, account, queue);
      return;
    }
    if (job.type === 'content_sync') {
      await executeContentSync(store, config, processingJob, account);
      return;
    }
    if (job.type === 'comment_sync') {
      await executeCommentSync(store, config, processingJob, account);
      return;
    }
    if (job.type === 'activity_sync') {
      await executeActivitySync(store, config, processingJob, account, queue);
      return;
    }
    if (job.type === 'engagement_sync') {
      await executeEngagementSync(store, config, processingJob, account);
      return;
    }
    if (job.type === 'remote_update') {
      await executeRemoteUpdate(store, config, processingJob, account, queue);
      return;
    }
    if (job.type === 'publish') {
      await executePublish(store, config, processingJob, account);
      return;
    }
    throw new ExternalProviderError(`Sync job type ${job.type} is not implemented yet`, 'unsupported');
  } catch (error) {
    const providerError = error instanceof ExternalProviderError
      ? error
      : new ExternalProviderError(
        error instanceof Error && error.message ? error.message : 'External synchronization failed',
        'temporarily_unavailable'
      );
    const latest = await store.getExternalSyncJob(externalSyncJobId) || { ...job, attemptCount };
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
    if (providerError.code === 'authentication_required' && !isContentSync) {
      await store.updateExternalAccount({ ...account, connectionStatus: 'authentication_required', lastSyncAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await updateJob(store, latest, { status: 'authentication_required', errorCode: providerError.code, errorMessage: providerError.message });
    } else if ((providerError.code === 'rate_limited' || providerError.code === 'temporarily_unavailable') && !isContentSync) {
      const delay = providerError.retryAfterSeconds || retryDelaySeconds(attemptCount, config.externalSyncBaseDelaySeconds);
      await store.updateExternalAccount({
        ...account,
        connectionStatus: providerError.code === 'rate_limited' ? 'rate_limited' : 'temporarily_unavailable',
        lastSyncAttemptAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      await updateJob(store, latest, {
        status: providerError.code === 'rate_limited' ? 'rate_limited' : 'retry_scheduled',
        nextAttemptAt: new Date(Date.now() + delay * 1000).toISOString(),
        errorCode: providerError.code,
        errorMessage: providerError.message
      });
    } else {
      await updateJob(store, latest, { status: 'failed', errorCode: providerError.code, errorMessage: providerError.message });
    }
    if (job.type === 'content_sync' && typeof job.payload?.assetId === 'string') {
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
    await addLog(store, externalSyncJobId, 'error', providerError.message, { code: providerError.code, attemptCount });
  }
};
