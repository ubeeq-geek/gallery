/**
 * Provenance describes how a work was made.  It deliberately does not express
 * whether a creator permits model training; that is a separate usage choice.
 */
export type AiProvenanceKind = 'unknown' | 'human-created' | 'ai-assisted' | 'ai-generated' | 'mixed';
export type AiProvenanceSource = 'creator-declaration' | 'remote-platform-label' | 'content-credentials' | 'inference';

export interface AiProvenance {
  kind: AiProvenanceKind;
  source: AiProvenanceSource;
  recordedAt?: string;
  /** Stable provider label or credential assertion, never the complete raw payload. */
  evidence?: string;
}

/** A usage preference, not evidence about how the work or asset was made. */
export interface AiTrainingPreference {
  training: 'allow' | 'disallow' | 'unspecified';
  declaredAt?: string;
}

export type InstagramCarouselDisclosureChoice = 'disclose-all' | 'edit-assets' | 'cancel';

export interface PublicationDisclosureSnapshot {
  capturedAt: string;
  work: AiProvenance;
  assets: Array<{ assetId: string; provenance: AiProvenance }>;
  effective: AiProvenance;
  /** The exact outbound value used by Instagram's is_ai_generated field. */
  platformDisclosure?: boolean;
  carouselResolution?: InstagramCarouselDisclosureChoice;
  warning?: string;
}

const unknown: AiProvenance = { kind: 'unknown', source: 'inference' };
const aiKinds = new Set<AiProvenanceKind>(['ai-assisted', 'ai-generated']);

export const parseAiProvenance = (value: unknown, fallbackSource: AiProvenanceSource = 'creator-declaration'): AiProvenance | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const kind = input.kind;
  const source = input.source;
  if (!['unknown', 'human-created', 'ai-assisted', 'ai-generated', 'mixed'].includes(String(kind))) return undefined;
  if (source !== undefined && !['creator-declaration', 'remote-platform-label', 'content-credentials', 'inference'].includes(String(source))) return undefined;
  return {
    kind: kind as AiProvenanceKind,
    source: (source || fallbackSource) as AiProvenanceSource,
    ...(typeof input.evidence === 'string' && input.evidence.trim() ? { evidence: input.evidence.trim().slice(0, 500) } : {})
  };
};

export const parseAiTrainingPreference = (value: unknown): AiTrainingPreference | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const training = (value as Record<string, unknown>).training;
  return training === 'allow' || training === 'disallow' || training === 'unspecified'
    ? { training, declaredAt: new Date().toISOString() }
    : undefined;
};

export const effectiveProvenance = (work: AiProvenance | undefined, assets: Array<{ assetId: string; provenance?: AiProvenance }>): AiProvenance => {
  const values = assets.length ? assets.map((asset) => asset.provenance || work || unknown) : [work || unknown];
  const kinds = new Set(values.map((value) => value.kind));
  if (kinds.size === 1) return values[0]!;
  return { kind: 'mixed', source: values.some((value) => value.source === 'creator-declaration') ? 'creator-declaration' : 'inference' };
};

export const instagramDisclosureSnapshot = (
  work: AiProvenance | undefined,
  assets: Array<{ assetId: string; provenance?: AiProvenance }>,
  placement: 'IMAGE' | 'CAROUSEL' | 'REEL' | 'STORY',
  carouselResolution?: InstagramCarouselDisclosureChoice,
  capturedAt = new Date().toISOString()
): PublicationDisclosureSnapshot => {
  const assetSnapshot = assets.map((asset) => ({ assetId: asset.assetId, provenance: asset.provenance || work || unknown }));
  const effective = effectiveProvenance(work, assets);
  if (placement !== 'CAROUSEL') {
    return { capturedAt, work: work || unknown, assets: assetSnapshot, effective, platformDisclosure: aiKinds.has(effective.kind) };
  }
  const kinds = new Set(assetSnapshot.map((asset) => asset.provenance.kind));
  const allAi = kinds.size > 0 && [...kinds].every((kind) => aiKinds.has(kind));
  const allHuman = kinds.size > 0 && [...kinds].every((kind) => kind === 'human-created');
  if (allAi) return { capturedAt, work: work || unknown, assets: assetSnapshot, effective, platformDisclosure: true };
  if (allHuman) return { capturedAt, work: work || unknown, assets: assetSnapshot, effective, platformDisclosure: false };
  const warning = 'Instagram only supports one AI label for a carousel; it cannot represent mixed or unknown item provenance precisely.';
  return {
    capturedAt, work: work || unknown, assets: assetSnapshot, effective, carouselResolution,
    ...(carouselResolution === 'disclose-all' ? { platformDisclosure: true } : {}), warning
  };
};

export const requiresInstagramCarouselDisclosureChoice = (snapshot: PublicationDisclosureSnapshot): boolean =>
  Boolean(snapshot.warning) && snapshot.carouselResolution !== 'disclose-all';
