import { createHash } from 'crypto';
import type { Publication } from './canonicalDomain';

/** A normalized metadata projection supplied by a provider adapter. */
export type ReconciliationSnapshot = Record<string, unknown>;

export interface ReconciliationFieldDiff {
  field: string;
  lastSynced: unknown;
  local: unknown;
  remote: unknown;
  localChanged: boolean;
  remoteChanged: boolean;
  conflict: boolean;
}

export type ReconciliationStatus = 'in_sync' | 'local_newer' | 'remote_newer' | 'non_conflicting_changes' | 'conflict';
export type ReconciliationAction = 'accept_remote' | 'keep_local' | 'create_detached_copy';

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stable(item)]));
  return value;
};

const equal = (left: unknown, right: unknown): boolean => JSON.stringify(stable(left)) === JSON.stringify(stable(right));

export const reconciliationFingerprint = (snapshot: ReconciliationSnapshot): string => createHash('sha256')
  .update(JSON.stringify(stable(snapshot)))
  .digest('hex');

/**
 * Compare all fields known to any snapshot. Provider-specific raw payloads
 * must not be included; adapters map only user-meaningful values here.
 */
export const diffReconciliationSnapshots = (
  lastSynced: ReconciliationSnapshot,
  local: ReconciliationSnapshot,
  remote: ReconciliationSnapshot
): ReconciliationFieldDiff[] => {
  const fields = [...new Set([...Object.keys(lastSynced), ...Object.keys(local), ...Object.keys(remote)])].sort();
  return fields.map((field) => {
    const baseline = lastSynced[field];
    const localValue = local[field];
    const remoteValue = remote[field];
    const localChanged = !equal(baseline, localValue);
    const remoteChanged = !equal(baseline, remoteValue);
    return {
      field,
      lastSynced: baseline,
      local: localValue,
      remote: remoteValue,
      localChanged,
      remoteChanged,
      conflict: localChanged && remoteChanged && !equal(localValue, remoteValue)
    };
  }).filter((diff) => diff.localChanged || diff.remoteChanged);
};

export const reconciliationStatus = (diffs: ReconciliationFieldDiff[]): ReconciliationStatus => {
  if (diffs.some((diff) => diff.conflict)) return 'conflict';
  const localChanged = diffs.some((diff) => diff.localChanged);
  const remoteChanged = diffs.some((diff) => diff.remoteChanged);
  if (localChanged && remoteChanged) return 'non_conflicting_changes';
  if (localChanged) return 'local_newer';
  if (remoteChanged) return 'remote_newer';
  return 'in_sync';
};

export interface ReconciliationResolution {
  action: ReconciliationAction;
  /** Explicit acknowledgement is mandatory because actions can discard data or create content. */
  confirmed: boolean;
}

export interface ReconciliationResolutionResult {
  local: ReconciliationSnapshot;
  detachedCopy?: ReconciliationSnapshot;
}

export const resolveReconciliation = (
  local: ReconciliationSnapshot,
  remote: ReconciliationSnapshot,
  resolution: ReconciliationResolution
): ReconciliationResolutionResult => {
  if (!resolution.confirmed) throw new Error('Explicit reconciliation confirmation is required.');
  if (resolution.action === 'accept_remote') return { local: { ...remote } };
  if (resolution.action === 'keep_local') return { local: { ...local } };
  if (resolution.action === 'create_detached_copy') {
    // The caller assigns a new local ID; no provider remote ID is propagated.
    const { remoteId: _remoteId, externalContentId: _externalContentId, ...detachedCopy } = remote;
    return { local: { ...local }, detachedCopy };
  }
  throw new Error('Unsupported reconciliation action.');
};

/**
 * Retain a compact, normalized reconciliation record on the canonical
 * Publication. On the first observation, remote state becomes the baseline.
 * Later divergence leaves the baseline intact until an explicit resolution.
 */
export const recordPublicationReconciliation = (
  publication: Publication,
  local: ReconciliationSnapshot,
  remote: ReconciliationSnapshot,
  updatedAt = new Date().toISOString()
): Publication => {
  const previous = publication.sync.reconciliation;
  const baseline = previous?.baseline || remote;
  const fields = diffReconciliationSnapshots(baseline, local, remote);
  const status = reconciliationStatus(fields);
  return {
    ...publication,
    sync: {
      ...publication.sync,
      status: status === 'non_conflicting_changes' ? 'local_newer' : status,
      reconciliation: {
        baseline: status === 'in_sync' ? { ...remote } : { ...baseline },
        remote: { ...remote },
        status,
        fields,
        updatedAt
      }
    },
    updatedAt
  };
};

export interface PublicationReconciliationResolutionResult {
  publication: Publication;
  detachedPublication?: Publication;
}

/**
 * Apply the provider-neutral part of a confirmed resolution. Remote writes and
 * canonical Work edits remain explicit follow-up jobs; this method only makes
 * the selected publication state unambiguous and advances its baseline.
 */
export const resolvePublicationReconciliation = (
  publication: Publication,
  resolution: ReconciliationResolution,
  resolvedAt = new Date().toISOString()
): PublicationReconciliationResolutionResult => {
  const reconciliation = publication.sync.reconciliation;
  if (!reconciliation?.remote) throw new Error('No remote reconciliation snapshot is available.');
  const local: ReconciliationSnapshot = {
    title: publication.metadataOverrides?.title,
    description: publication.metadataOverrides?.description,
    tags: publication.metadataOverrides?.tags,
    visibility: publication.visibility
  };
  const resolved = resolveReconciliation(local, reconciliation.remote, resolution);
  if (resolution.action === 'create_detached_copy') {
    const detachedPublication: Publication = {
      ...publication,
      publicationId: '', // The caller assigns a fresh ID before persistence.
      remoteId: undefined,
      remoteUrl: undefined,
      remoteCreatedAt: undefined,
      remoteUpdatedAt: undefined,
      status: 'draft',
      metadataOverrides: {
        ...publication.metadataOverrides,
        title: resolved.detachedCopy?.title as string | undefined,
        description: resolved.detachedCopy?.description as string | undefined,
        tags: Array.isArray(resolved.detachedCopy?.tags) ? resolved.detachedCopy.tags.filter((tag): tag is string => typeof tag === 'string') : undefined
      },
      sync: { status: 'not_applicable' },
      createdAt: resolvedAt,
      updatedAt: resolvedAt,
      publishedAt: undefined,
      removedAt: undefined
    };
    return { publication, detachedPublication };
  }
  const nextLocal = resolved.local;
  const next: Publication = {
    ...publication,
    metadataOverrides: {
      ...publication.metadataOverrides,
      title: nextLocal.title as string | undefined,
      description: nextLocal.description as string | undefined,
      tags: Array.isArray(nextLocal.tags) ? nextLocal.tags.filter((tag): tag is string => typeof tag === 'string') : undefined
    },
    sync: {
      ...publication.sync,
      status: 'in_sync',
      reconciliation: {
        baseline: { ...reconciliation.remote },
        remote: { ...reconciliation.remote },
        status: 'in_sync',
        fields: [],
        updatedAt: resolvedAt
      }
    },
    updatedAt: resolvedAt
  };
  return { publication: next };
};
