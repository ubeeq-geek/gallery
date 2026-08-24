import type { AiProvenance } from './canonicalDomain';

/**
 * Conservative, dependency-free inspection for embedded C2PA/XMP evidence.
 * A credential alone does not prove generative origin, so this only assigns an
 * AI provenance when the signed metadata itself names a generative action.
 */
export interface ContentCredentialsInspection {
  present: boolean;
  provenance?: AiProvenance;
  evidence?: string;
}

const boundedText = (bytes: Buffer): string => bytes.subarray(0, Math.min(bytes.length, 2 * 1024 * 1024)).toString('latin1').toLowerCase();

export const inspectContentCredentials = (bytes: Buffer, recordedAt = new Date().toISOString()): ContentCredentialsInspection => {
  const text = boundedText(bytes);
  const present = /c2pa|content credentials|c2pa\.manifest|jumbf/.test(text);
  if (!present) return { present: false };

  // C2PA action vocabulary and common generator assertions are deliberately
  // matched only as evidence markers; opaque credential payloads are never
  // stored in canonical records.
  const generated = /c2pa\.created|trainedalgorithmicmedia|ai[_ -]?(generated|created)|generative[_ -]?ai|stable diffusion|midjourney|dall[·e]/.test(text);
  const assisted = /c2pa\.edited|ai[_ -]?(assist(ed|ance)|edit)|generative fill/.test(text);
  const assertion = generated ? 'ai-generated' : assisted ? 'ai-assisted' : undefined;
  const evidence = generated ? 'c2pa:generative-assertion' : assisted ? 'c2pa:ai-assisted-assertion' : 'c2pa:credential-present';
  return {
    present,
    evidence,
    ...(assertion ? { provenance: { assertion, sources: [{ kind: 'content-credentials', assertion, assertedAt: recordedAt, basis: evidence }], updatedAt: recordedAt } as AiProvenance } : {})
  };
};
