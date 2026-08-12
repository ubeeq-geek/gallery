import { randomUUID } from 'crypto';
import type { AppConfig } from './config';
import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import { readStoredUbeeqWorkImage, storeExternalContent } from './externalContentStorage';
import { createExternalSyncQueue, type ExternalSyncQueue } from './externalSyncQueue';
import { createExternalPlatformProvider, ExternalProviderError, type ExternalContentUpdate, type ExternalPlatformProvider, type ExternalRemoteContent } from './externalPlatformProvider';
import type { Asset, ExternalAccount, ExternalPublication, ExternalSyncJob, SpacePublication } from './domain';
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
    externalUrl: remote.externalUrl,
    externalTitle: remote.title,
    externalDescription: remote.description,
    externalTags: remote.tags,
    externalCollectionIds: remote.collectionExternalIds,
    publishedAt: remote.publishedAt,
    remoteCreatedAt: remote.remoteCreatedAt,
    remoteUpdatedAt: remote.remoteUpdatedAt,
    lastSyncedAt: now,
    lastSeenAt: now,
    syncStatus: 'active',
    rawMetadataJson: remote.rawMetadata,
    createdAt: currentPublication?.createdAt || now,
    updatedAt: now
  };
  if (currentPublication) await store.updateExternalPublication(publication);
  else await store.createExternalPublication(publication);

  if (remote.metrics && Object.values(remote.metrics).some((value) => value !== undefined)) {
    await store.createExternalEngagementSnapshot({
      externalEngagementSnapshotId: randomUUID(),
      externalPublicationId: publication.externalPublicationId,
      capturedAt: now,
      views: remote.metrics.views,
      favourites: remote.metrics.favourites,
      comments: remote.metrics.comments,
      otherMetricsJson: remote.metrics.other
    });
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
  const spacePublication: SpacePublication = {
    assetId: asset.assetId,
    published: true,
    hostingMode: current?.hostingMode === 'hosted' ? 'hosted' : 'linked',
    publishedAt: current?.publishedAt || now,
    ubeeqTitleOverride: current?.ubeeqTitleOverride,
    ubeeqDescriptionOverride: current?.ubeeqDescriptionOverride,
    visibility: current?.visibility || 'private',
    contentSyncStatus: 'queued',
    contentSyncError: undefined,
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
    assetId: asset.assetId,
    published: true,
    hostingMode: current?.hostingMode || 'linked',
    publishedAt: current?.publishedAt || now,
    ubeeqTitleOverride: current?.ubeeqTitleOverride,
    ubeeqDescriptionOverride: current?.ubeeqDescriptionOverride,
    visibility: current?.visibility || 'private',
    contentSyncStatus: 'syncing',
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
    expectedByteSize: remote.content.byteSize
  });
  await store.upsertSpacePublication({
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
    lastContentSyncAt: new Date().toISOString(),
    contentSyncError: undefined,
    updatedAt: new Date().toISOString()
  });
  await updateJob(store, job, { status: 'successful', progress: { discovered: 1, synchronized: 1, remaining: 0 }, errorCode: undefined, errorMessage: undefined });
  await addLog(store, job.externalSyncJobId, 'info', 'DeviantArt source file stored in Ubeeq Space', { assetId, bytes: stored.byteSize });
};

const executeRemoteUpdate = async (store: DataStore, config: AppConfig, job: ExternalSyncJob, account: ExternalAccount): Promise<void> => {
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
  if (typeof job.payload?.allowAiTraining === 'boolean') update.allowAiTraining = job.payload.allowAiTraining;
  const provider = await providerForAccount(store, config, account);
  const session = await refreshAccessTokenIfNeeded(store, config, account, provider);
  await provider.updateContent(session.accessToken, publication.externalContentId, update);
  await updateJob(store, job, {
    status: 'successful',
    progress: { discovered: 1, synchronized: 1, remaining: 0 },
    errorCode: undefined,
    errorMessage: undefined,
    nextAttemptAt: undefined
  });
  await addLog(store, job.externalSyncJobId, 'info', 'Integration metadata update completed', { externalPublicationId, fields: Object.keys(update) });
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
  const isMature = typeof job.payload?.isMature === 'boolean' ? job.payload.isMature : savedSettings.is_mature === true;
  const matureLevel = job.payload?.matureLevel === 'strict' || job.payload?.matureLevel === 'moderate'
    ? job.payload.matureLevel
    : (savedSettings.mature_level === 'strict' || savedSettings.mature_level === 'moderate' ? savedSettings.mature_level : undefined);
  const matureClassification = Array.isArray(job.payload?.matureClassification)
    ? job.payload.matureClassification.filter((classification): classification is 'nudity' | 'sexual' | 'gore' | 'language' | 'ideology' => (
      classification === 'nudity' || classification === 'sexual' || classification === 'gore' || classification === 'language' || classification === 'ideology'
    ))
    : (Array.isArray(savedSettings.mature_classification)
      ? savedSettings.mature_classification.filter((classification): classification is 'nudity' | 'sexual' | 'gore' | 'language' | 'ideology' => (
        classification === 'nudity' || classification === 'sexual' || classification === 'gore' || classification === 'language' || classification === 'ideology'
      ))
      : undefined);
  const filename = typeof job.payload?.originalFilename === 'string' && job.payload.originalFilename.trim()
    ? job.payload.originalFilename.trim()
    : `${asset.assetId}.jpg`;
  const published = await provider.publishContent(session.accessToken, {
    body: await readStoredUbeeqWorkImage(config, spacePublication.hostedObjectKey),
    filename,
    contentType: spacePublication.hostedContentType,
    title: pendingPublication.externalTitle || asset.canonicalTitle || filename,
    description: pendingPublication.externalDescription ?? asset.canonicalDescription,
    tags,
    isMature,
    matureLevel,
    matureClassification,
    allowComments: typeof job.payload?.allowComments === 'boolean' ? job.payload.allowComments : (typeof savedSettings.allow_comments === 'boolean' ? savedSettings.allow_comments : undefined),
    isAiGenerated: typeof job.payload?.isAiGenerated === 'boolean' ? job.payload.isAiGenerated : (typeof savedSettings.is_ai_generated === 'boolean' ? savedSettings.is_ai_generated : undefined),
    noAi: typeof job.payload?.noAi === 'boolean' ? job.payload.noAi : (typeof savedSettings.noai === 'boolean' ? savedSettings.noai : undefined)
  });
  const now = new Date().toISOString();
  const publication: ExternalPublication = {
    ...(pendingPublication || { externalPublicationId: randomUUID(), createdAt: now }),
    assetId: asset.assetId,
    externalAccountId: account.externalAccountId,
    platform: account.platform,
    externalContentId: published.externalContentId,
    externalUrl: published.externalUrl,
    externalTitle: pendingPublication.externalTitle || asset.canonicalTitle,
    externalDescription: pendingPublication.externalDescription ?? asset.canonicalDescription,
    externalTags: tags,
    syncStatus: 'active',
    rawMetadataJson: { ...savedSettings, ...published.rawMetadata },
    publishedAt: now,
    remoteCreatedAt: now,
    remoteUpdatedAt: now,
    lastSyncedAt: now,
    lastSeenAt: now,
    createdAt: pendingPublication?.createdAt || now,
    updatedAt: now
  };
  if (pendingPublication) await store.updateExternalPublication(publication);
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
  do {
    const page = await provider.listContent(session.accessToken, {
      username: session.account.externalUsername,
      cursor,
      limit: 50
    });
    discovered += page.items.length;
    for (const item of page.items) {
      const hasCompleteLabelMetadata = ['is_ai_generated', 'ai_generated', 'created_with_ai', 'noai', 'no_ai']
        .some((key) => Object.prototype.hasOwnProperty.call(item.rawMetadata, key));
      let resolvedItem = item;
      if (!item.description || !item.tags.length || !hasCompleteLabelMetadata) {
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
      if (job.payload?.syncContent === true) {
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
  await addLog(store, job.externalSyncJobId, 'info', 'DeviantArt account import completed', { discovered, synchronized, collections: collections.length });
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
    if (job.type === 'remote_update') {
      await executeRemoteUpdate(store, config, processingJob, account);
      return;
    }
    if (job.type === 'publish') {
      await executePublish(store, config, processingJob, account);
      return;
    }
    throw new ExternalProviderError(`Sync job type ${job.type} is not implemented yet`, 'unsupported');
  } catch (error) {
    const providerError = error instanceof ExternalProviderError ? error : new ExternalProviderError('External synchronization failed', 'temporarily_unavailable');
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
    if (providerError.code === 'authentication_required') {
      await store.updateExternalAccount({ ...account, connectionStatus: 'authentication_required', lastSyncAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await updateJob(store, latest, { status: 'authentication_required', errorCode: providerError.code, errorMessage: providerError.message });
    } else if (providerError.code === 'rate_limited' || providerError.code === 'temporarily_unavailable') {
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
