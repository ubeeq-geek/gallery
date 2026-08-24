import type { Publication, PublicationStatus, PublicationSyncStatus } from './canonicalDomain';
import type { ExternalPublication, ExternalPublicationSyncStatus } from './domain';

export type RemotePublicationState = 'active' | 'missing' | 'restricted' | 'deleted' | 'unknown';

export const publicationStatusForRemoteState = (state: RemotePublicationState): PublicationStatus => {
  if (state === 'missing') return 'missing';
  if (state === 'deleted') return 'removed';
  return 'unknown';
};

export const syncStatusForRemoteState = (state: RemotePublicationState): PublicationSyncStatus =>
  state === 'active' ? 'in_sync' : state === 'unknown' ? 'unknown' : 'remote_newer';

/** A provider-neutral remote observation used by importers and reconciliation workers. */
export const recordRemotePublicationState = (
  publication: Publication,
  state: RemotePublicationState,
  input: { cursor?: string; metadataFingerprint?: string; contentFingerprint?: string; observedAt?: string; reason?: string }
): Publication => {
  const observedAt = input.observedAt || new Date().toISOString();
  return {
    ...publication,
    ...(state === 'active' ? {} : { status: publicationStatusForRemoteState(state) }),
    sync: {
      ...publication.sync,
      status: syncStatusForRemoteState(state),
      remoteCursor: input.cursor || publication.sync.remoteCursor,
      remoteMetadataFingerprint: input.metadataFingerprint || publication.sync.remoteMetadataFingerprint,
      remoteContentFingerprint: input.contentFingerprint || publication.sync.remoteContentFingerprint,
      remoteState: state === 'deleted' ? 'missing' : state,
      ...(state === 'active' ? { lastSuccessfulAt: observedAt, errorCode: undefined, errorMessage: undefined } : { errorCode: `REMOTE_${state.toUpperCase()}`, errorMessage: input.reason })
    },
    updatedAt: observedAt
  };
};

/** Retrying callers preserve one key and never bypass an account-wide cooldown. */
export const schedulePublicationRetry = (publication: Publication, input: { idempotencyKey: string; nextAttemptAt?: string; accountCooldownUntil?: string; now?: string }): Publication => ({
  ...publication,
  sync: {
    ...publication.sync,
    retry: {
      idempotencyKey: publication.sync.retry?.idempotencyKey || input.idempotencyKey,
      attempt: (publication.sync.retry?.attempt || 0) + 1,
      nextAttemptAt: input.nextAttemptAt ?? publication.sync.retry?.nextAttemptAt,
      accountCooldownUntil: input.accountCooldownUntil ?? publication.sync.retry?.accountCooldownUntil
    }
  },
  updatedAt: input.now || new Date().toISOString()
});

export const externalSyncStatusForRemoteState = (state: RemotePublicationState): ExternalPublicationSyncStatus =>
  state === 'active' ? 'active' : state === 'deleted' ? 'deleted' : state === 'restricted' ? 'restricted' : state === 'missing' ? 'missing' : 'unknown';

/** Reusable lifecycle transition used by DeviantArt scans and future adapters. */
export const recordExternalPublicationLifecycle = (
  publication: ExternalPublication,
  state: RemotePublicationState,
  input: { observedAt?: string; reason?: string }
): ExternalPublication => ({
  ...publication,
  syncStatus: externalSyncStatusForRemoteState(state),
  remoteStateReason: input.reason || publication.remoteStateReason,
  lastSyncedAt: input.observedAt || new Date().toISOString(),
  updatedAt: input.observedAt || new Date().toISOString()
});
