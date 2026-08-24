import { createHash } from 'crypto';
import type {
  AiProvenance,
  AiProvenanceAssertion,
  AiProvenanceSource,
  Publication,
  PublicationDisclosureSnapshot,
  Work
} from './canonicalDomain';

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
};

const fingerprint = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(stable(value)))
  .digest('hex');

export const unknownAiProvenance = (source: Omit<AiProvenanceSource, 'assertion'>): AiProvenance => ({
  assertion: 'unknown',
  sources: [{ ...source, assertion: 'unknown' }],
  updatedAt: source.assertedAt
});

export const providerAiProvenance = (input: {
  assertion: AiProvenanceAssertion;
  platform: AiProvenanceSource['platform'];
  remoteId: string;
  assertedAt: string;
  basis: string;
}): AiProvenance => ({
  assertion: input.assertion,
  sources: [{ kind: 'provider', ...input }],
  updatedAt: input.assertedAt
});

export const creatorAiProvenance = (
  assertion: AiProvenanceAssertion,
  assertedAt: string,
  previous?: AiProvenance
): AiProvenance => ({
  assertion,
  sources: [
    ...(previous?.sources || []),
    { kind: 'creator', assertion, assertedAt, basis: 'creator_work_disclosure' }
  ],
  updatedAt: assertedAt
});

export const effectiveWorkAiProvenance = (work: Pick<Work, 'aiDisclosure' | 'aiProvenance' | 'updatedAt'>): AiProvenance => (
  work.aiProvenance || {
    assertion: work.aiDisclosure,
    sources: [{ kind: 'system', assertion: work.aiDisclosure, assertedAt: work.updatedAt, basis: 'legacy_work_ai_disclosure' }],
    updatedAt: work.updatedAt
  }
);

export const createPublicationDisclosureSnapshot = (input: {
  publicationId: string;
  attemptKey: string;
  work: Pick<Work, 'revision' | 'contentRating' | 'aiDisclosure' | 'aiProvenance' | 'heavyTopics' | 'updatedAt'>;
  assetChecksumsSha256?: Array<string | undefined>;
  capturedAt?: string;
}): PublicationDisclosureSnapshot => {
  if (!input.attemptKey.trim()) throw new Error('A disclosure snapshot requires a stable attempt key.');
  const capturedAt = input.capturedAt || new Date().toISOString();
  const payload = {
    version: 1 as const,
    attemptKey: input.attemptKey,
    workRevision: input.work.revision,
    contentRating: input.work.contentRating,
    aiDisclosure: input.work.aiDisclosure,
    aiProvenance: effectiveWorkAiProvenance(input.work),
    heavyTopics: [...input.work.heavyTopics],
    assetChecksumsSha256: (input.assetChecksumsSha256 || []).filter((value): value is string => Boolean(value))
  };
  const fingerprintSha256 = fingerprint(payload);
  return {
    ...payload,
    snapshotId: fingerprint([input.publicationId, input.attemptKey, fingerprintSha256]),
    capturedAt,
    fingerprintSha256
  };
};

/** Append once for an attempt. Reusing an attempt key with changed disclosures fails closed. */
export const appendPublicationDisclosureSnapshot = (
  publication: Publication,
  snapshot: PublicationDisclosureSnapshot
): Publication => {
  const history = [...(publication.disclosureSnapshots || [])];
  const existing = history.find((item) => item.attemptKey === snapshot.attemptKey);
  if (existing) {
    if (existing.fingerprintSha256 !== snapshot.fingerprintSha256) {
      throw new Error('Publication disclosure snapshot is immutable for this attempt.');
    }
    return { ...publication, activeDisclosureSnapshotId: existing.snapshotId };
  }
  if (history.some((item) => item.snapshotId === snapshot.snapshotId)) {
    throw new Error('Publication disclosure snapshot identifier is already in use.');
  }
  return { ...publication, disclosureSnapshots: [...history, snapshot], activeDisclosureSnapshotId: snapshot.snapshotId };
};

export const assertPublicationDisclosureHistoryImmutable = (
  previous: Publication | null | undefined,
  next: Publication
): void => {
  if (!previous?.disclosureSnapshots?.length) return;
  const incoming = next.disclosureSnapshots || [];
  if (incoming.length < previous.disclosureSnapshots.length) throw new Error('Publication disclosure history cannot be removed.');
  previous.disclosureSnapshots.forEach((snapshot, index) => {
    if (JSON.stringify(stable(snapshot)) !== JSON.stringify(stable(incoming[index]))) {
      throw new Error('Publication disclosure history is immutable.');
    }
  });
};

export const activePublicationDisclosureSnapshot = (publication: Publication): PublicationDisclosureSnapshot | undefined => (
  publication.disclosureSnapshots?.find((snapshot) => snapshot.snapshotId === publication.activeDisclosureSnapshotId)
);
