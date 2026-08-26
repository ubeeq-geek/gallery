import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { FederationError, type FederatedAssetReference, type FederationInstanceMetadata } from './federation';

export interface FederationAssetStorage {
  putQuarantine(key: string, body: AsyncIterable<Uint8Array>, metadata: Record<string, string>): Promise<void>;
  promote(quarantineKey: string, destinationKey: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface FederationAssetScanner {
  scan(key: string, input: { mimeType: string; checksumSha256: string }): Promise<{ malware: 'clean' | 'detected' | 'unavailable'; safety: 'cleared' | 'held' | 'unavailable' }>;
}
export interface FederationRenditionProcessor { process(key: string, mimeType: string): Promise<string[]>; }
export interface FederationFetchResponse { status: number; headers: Record<string, string | undefined>; body: AsyncIterable<Uint8Array>; }
export interface ReplicatedFederationAsset {
  assetUri: string; destinationKey: string; renditionKeys: string[]; checksumSha256: string; sizeBytes: number;
  moderationState: 'cleared'; retainedUntil: string; replicatedAt: string;
}

const privateAddress = (address: string): boolean => {
  if (isIP(address) === 6) {
    const first = Number.parseInt(address.split(':')[0] || '0', 16);
    return first < 0x2000 || first > 0x3fff;
  }
  if (isIP(address) !== 4) return true;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224;
};

const defaultResolve = async (hostname: string): Promise<string[]> => (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
const pinnedFetch = async (url: string, timeoutMs: number, approvedAddresses: string[]): Promise<FederationFetchResponse> => new Promise((resolve, reject) => {
  const target = new URL(url); let addressIndex = 0;
  const request = httpsRequest(target, {
    method: 'GET', timeout: timeoutMs, servername: target.hostname, headers: { Accept: 'application/octet-stream', 'User-Agent': 'Ubeeq-Federation/1' },
    lookup: (_hostname, options, callback) => {
      const address = approvedAddresses[addressIndex++ % approvedAddresses.length];
      const family = isIP(address) as 4 | 6;
      const done = callback as unknown as (...args: unknown[]) => void;
      if (typeof options === 'object' && options.all) done(null, [{ address, family }]);
      else done(null, address, family);
    }
  }, (response) => resolve({ status: response.statusCode ?? 0, headers: { 'content-length': response.headers['content-length'], 'content-type': response.headers['content-type'], location: response.headers.location }, body: response }));
  request.once('timeout', () => request.destroy(new FederationError('asset_delivery_timeout', 'Asset delivery timed out')));
  request.once('error', reject); request.end();
});

export class FederationAssetTransferService {
  constructor(private readonly options: {
    destinationPrefix: string; maximumBytes: number; timeoutMs: number; retentionDays: number;
    storage: FederationAssetStorage; scanner: FederationAssetScanner; renditions: FederationRenditionProcessor;
    resolve?: (hostname: string) => Promise<string[]>; fetch?: (url: string, timeoutMs: number, approvedAddresses: string[]) => Promise<FederationFetchResponse>;
    now?: () => Date; observe?: (event: string, detail: Record<string, string | number | boolean>) => void;
  }) {}

  private observe(event: string, detail: Record<string, string | number | boolean>): void {
    try { this.options.observe?.(event, detail); } catch { /* Telemetry must never change asset processing outcomes. */ }
  }

  async replicate(reference: FederatedAssetReference, source: FederationInstanceMetadata, legalHold = false): Promise<ReplicatedFederationAsset> {
    const now = this.options.now?.() ?? new Date();
    const startedAt = now.getTime();
    try {
      return await this.replicateAttempt(reference, source, legalHold, now);
    } finally {
      this.observe('federation.asset.latency', { sourceInstanceId: source.instanceId, durationMs: Math.max(0, (this.options.now?.() ?? new Date()).getTime() - startedAt) });
    }
  }

  private async replicateAttempt(reference: FederatedAssetReference, source: FederationInstanceMetadata, legalHold: boolean, now: Date): Promise<ReplicatedFederationAsset> {
    const delivery = new URL(reference.deliveryUrl); const asset = new URL(reference.assetUri); const origin = new URL(source.origin);
    if (delivery.username || delivery.password || delivery.protocol !== 'https:' || delivery.origin !== origin.origin || asset.origin !== origin.origin) throw new FederationError('asset_source_forbidden', 'Asset delivery must use the verified source origin');
    if (Date.parse(reference.expiresAt) <= now.getTime()) throw new FederationError('asset_expired', 'Asset delivery reference has expired');
    if (reference.sizeBytes <= 0 || reference.sizeBytes > this.options.maximumBytes) throw new FederationError('asset_too_large', 'Asset exceeds destination limits');
    const addresses = await (this.options.resolve ?? defaultResolve)(delivery.hostname);
    if (!addresses.length || addresses.some(privateAddress)) throw new FederationError('asset_source_forbidden', 'Asset source resolved to a private or reserved address');
    const quarantineKey = `${this.options.destinationPrefix.replace(/\/?$/, '/') }quarantine/${randomUUID()}`;
    const destinationKey = `${this.options.destinationPrefix.replace(/\/?$/, '/') }assets/${randomUUID()}`;
    let promoted = false; let renditionKeys: string[] = [];
    try {
      const response = await (this.options.fetch ?? pinnedFetch)(delivery.toString(), this.options.timeoutMs, addresses);
      if (response.status >= 300 && response.status < 400) throw new FederationError('asset_redirect_forbidden', 'Asset delivery redirects are not allowed');
      if (response.status !== 200) throw new FederationError('asset_delivery_failed', `Asset source returned HTTP ${response.status}`);
      const declaredLength = Number(response.headers['content-length'] ?? reference.sizeBytes);
      if (!Number.isFinite(declaredLength) || declaredLength > this.options.maximumBytes || declaredLength !== reference.sizeBytes) throw new FederationError('asset_integrity_failed', 'Asset Content-Length does not match the signed reference');
      const hash = createHash('sha256'); let received = 0;
      const checked: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() { for await (const chunk of response.body) { received += chunk.byteLength; if (received > reference.sizeBytes) throw new FederationError('asset_integrity_failed', 'Asset body exceeds its signed size'); hash.update(chunk); yield chunk; } } };
      await this.options.storage.putQuarantine(quarantineKey, checked, { sourceInstanceId: source.instanceId, assetUri: reference.assetUri, mimeType: reference.mimeType });
      const digest = hash.digest('hex');
      if (received !== reference.sizeBytes || digest !== reference.checksumSha256.toLowerCase()) throw new FederationError('asset_integrity_failed', 'Asset size or SHA-256 does not match the signed reference');
      const scan = await this.options.scanner.scan(quarantineKey, { mimeType: reference.mimeType, checksumSha256: digest });
      if (scan.malware !== 'clean' || scan.safety !== 'cleared') throw new FederationError('asset_policy_blocked', 'Asset did not pass destination scanning');
      renditionKeys = await this.options.renditions.process(quarantineKey, reference.mimeType);
      await this.options.storage.promote(quarantineKey, destinationKey); promoted = true;
      const retainedUntil = new Date(now.getTime() + this.options.retentionDays * 86_400_000).toISOString();
      this.observe('federation.asset.replicated', { sourceInstanceId: source.instanceId, sizeBytes: received });
      return { assetUri: reference.assetUri, destinationKey, renditionKeys, checksumSha256: digest, sizeBytes: received, moderationState: 'cleared', retainedUntil, replicatedAt: now.toISOString() };
    } catch (error) {
      this.observe('federation.asset.failed', { sourceInstanceId: source.instanceId, legalHold });
      if (!legalHold) {
        const cleanupKeys = [promoted ? destinationKey : quarantineKey, ...renditionKeys];
        await Promise.all(cleanupKeys.map((key) => this.options.storage.delete(key).catch(() => undefined)));
      }
      throw error;
    }
  }

  async remove(asset: ReplicatedFederationAsset, legalHold: boolean): Promise<'deleted' | 'retained_for_legal_hold'> {
    if (legalHold) return 'retained_for_legal_hold';
    await Promise.all([this.options.storage.delete(asset.destinationKey), ...asset.renditionKeys.map((key) => this.options.storage.delete(key))]);
    return 'deleted';
  }
}
