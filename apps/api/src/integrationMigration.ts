import { createHash } from 'crypto';

export type MigrationSourceStatus = 'discovered' | 'quarantined' | 'verified' | 'attached' | 'rejected';

export interface IntegrationMigrationSource {
  sourceId: string;
  platform: string;
  externalContentId: string;
  sourceUrl: string;
  filename?: string;
  contentType?: string;
  expectedChecksumSha256?: string;
  status: MigrationSourceStatus;
  quarantineKey?: string;
  rejectionReason?: string;
  discoveredAt: string;
  updatedAt: string;
}

export interface MigrationUrlPolicy {
  approvedHosts: readonly string[];
  maxRedirects?: number;
}

const isPrivateAddress = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (/^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const match = normalized.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
};

/** Reject SSRF-prone, non-HTTPS, and unapproved source locations before download. */
export const validateMigrationSourceUrl = (value: string, policy: MigrationUrlPolicy): URL => {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Migration source URL is invalid.'); }
  if (url.protocol !== 'https:') throw new Error('Migration sources must use HTTPS.');
  if (url.username || url.password || isPrivateAddress(url.hostname)) throw new Error('Migration source URL is not allowed.');
  const hostname = url.hostname.toLowerCase();
  const approved = policy.approvedHosts.some((host) => hostname === host.toLowerCase() || hostname.endsWith(`.${host.toLowerCase()}`));
  if (!approved) throw new Error('Migration source host is not approved.');
  return url;
};

export const checksumSha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export const verifyMigrationSource = (
  source: IntegrationMigrationSource,
  bytes: Uint8Array,
  quarantineKey: string,
  now = new Date().toISOString()
): IntegrationMigrationSource => {
  const actualChecksum = checksumSha256(bytes);
  if (source.expectedChecksumSha256 && source.expectedChecksumSha256.toLowerCase() !== actualChecksum) {
    return { ...source, status: 'rejected', rejectionReason: 'SOURCE_CHECKSUM_MISMATCH', updatedAt: now };
  }
  return { ...source, status: 'verified', quarantineKey, expectedChecksumSha256: actualChecksum, rejectionReason: undefined, updatedAt: now };
};

/** A verified source cannot become canonical until the caller explicitly attaches it. */
export const attachVerifiedMigrationSource = (
  source: IntegrationMigrationSource,
  now = new Date().toISOString()
): IntegrationMigrationSource => {
  if (source.status !== 'verified' || !source.quarantineKey) throw new Error('Only verified quarantined migration sources can be attached.');
  return { ...source, status: 'attached', updatedAt: now };
};
