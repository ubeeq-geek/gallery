import { randomUUID } from 'crypto';
import type { AppConfig } from './config';
import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import { createExternalPlatformProvider, ExternalProviderError, type ExternalPlatformProvider, type ExternalRemoteContent } from './externalPlatformProvider';
import type { Asset, ExternalAccount, ExternalPublication, ExternalSyncJob } from './domain';
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
): Promise<void> => {
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
};

const executeAccountImport = async (store: DataStore, config: AppConfig, job: ExternalSyncJob, account: ExternalAccount): Promise<void> => {
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
      await upsertContent(store, account, item, now);
      synchronized += 1;
    }
    cursor = page.nextCursor;
    currentJob = await updateJob(store, currentJob, {
      status: 'processing',
      progress: { discovered, synchronized, remaining: cursor ? 1 : 0 }
    });
  } while (cursor);

  await store.updateExternalAccount({
    ...session.account,
    connectionStatus: 'connected',
    lastSuccessfulSyncAt: now,
    lastSyncAttemptAt: now,
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

export const processExternalSyncJob = async (store: DataStore, config: AppConfig, externalSyncJobId: string): Promise<void> => {
  const job = await store.getExternalSyncJob(externalSyncJobId);
  if (!job || job.status === 'cancelled' || job.status === 'successful') return;
  const account = await store.getExternalAccount(job.externalAccountId);
  if (!account) {
    await updateJob(store, job, { status: 'failed', errorCode: 'ACCOUNT_NOT_FOUND', errorMessage: 'Connected account no longer exists' });
    return;
  }
  const attemptCount = job.attemptCount + 1;
  const processingJob = await updateJob(store, job, { status: 'processing', attemptCount, lastAttemptAt: new Date().toISOString() });
  await addLog(store, job.externalSyncJobId, 'info', 'Sync job started', { type: job.type, attemptCount });
  try {
    if (job.type === 'account_import' || job.type === 'full_reconciliation' || job.type === 'account_scan') {
      await executeAccountImport(store, config, processingJob, account);
      return;
    }
    throw new ExternalProviderError(`Sync job type ${job.type} is not implemented yet`, 'unsupported');
  } catch (error) {
    const providerError = error instanceof ExternalProviderError ? error : new ExternalProviderError('External synchronization failed', 'temporarily_unavailable');
    const latest = await store.getExternalSyncJob(externalSyncJobId) || { ...job, attemptCount };
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
    await addLog(store, externalSyncJobId, 'error', providerError.message, { code: providerError.code, attemptCount });
  }
};
