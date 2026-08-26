import { createHash, generateKeyPairSync } from 'node:crypto';
import { FederationAssetTransferService, type FederationFetchResponse } from '../src/federationAssetTransfer';
import type { FederatedAssetReference, FederationInstanceMetadata } from '../src/federation';

const bytes = Buffer.from('destination controlled asset');
const source: FederationInstanceMetadata = {
  instanceId: 'nightframe', metadataRevision: 1, metadataUpdatedAt: '2026-08-26T00:00:00Z', brand: 'nightframe', name: 'Nightframe',
  origin: 'https://nightfra.me', actorBaseUrl: 'https://nightfra.me/.well-known/ubeeq/creators', policyVersion: '1', status: 'trusted',
  keys: [{ keyId: 'key', algorithm: 'Ed25519', publicKeyPem: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(), validFrom: '2026-01-01T00:00:00Z' }]
};
const reference: FederatedAssetReference = {
  assetUri: 'https://nightfra.me/assets/asset', deliveryUrl: 'https://nightfra.me/federation/assets/asset?token=opaque', mimeType: 'image/jpeg',
  sizeBytes: bytes.length, checksumSha256: createHash('sha256').update(bytes).digest('hex'), expiresAt: '2026-08-26T00:05:00Z'
};
const response = (body = bytes, status = 200): FederationFetchResponse => ({ status, headers: { 'content-length': String(body.length), 'content-type': 'image/jpeg' }, body: { async *[Symbol.asyncIterator]() { yield body.subarray(0, 5); yield body.subarray(5); } } });
const setup = (overrides: Record<string, unknown> = {}) => {
  const stored = new Map<string, Buffer>();
  const storage = {
    putQuarantine: jest.fn(async (key: string, body: AsyncIterable<Uint8Array>) => { const chunks: Buffer[] = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); stored.set(key, Buffer.concat(chunks)); }),
    promote: jest.fn(async (from: string, to: string) => { stored.set(to, stored.get(from)!); stored.delete(from); }), delete: jest.fn(async (key: string) => { stored.delete(key); })
  };
  const service = new FederationAssetTransferService({
    destinationPrefix: 'federation/', maximumBytes: 1024, timeoutMs: 1000, retentionDays: 30, storage,
    scanner: { scan: jest.fn(async () => ({ malware: 'clean' as const, safety: 'cleared' as const })) },
    renditions: { process: jest.fn(async () => ['federation/renditions/one']) }, resolve: async () => ['8.8.8.8'], fetch: async () => response(),
    now: () => new Date('2026-08-26T00:00:00Z'), ...overrides
  });
  return { service, storage, stored };
};

describe('federated asset replication', () => {
  test('streams, independently hashes, scans, processes, and promotes an approved asset', async () => {
    const observe = jest.fn();
    const times = [new Date('2026-08-26T00:00:00Z'), new Date('2026-08-26T00:00:00.125Z')];
    const { service, storage, stored } = setup({ observe, now: () => times.shift()! }); const result = await service.replicate(reference, source);
    expect(result).toMatchObject({ checksumSha256: reference.checksumSha256, sizeBytes: bytes.length, moderationState: 'cleared' });
    expect(storage.putQuarantine).toHaveBeenCalled(); expect(storage.promote).toHaveBeenCalled(); expect(stored.get(result.destinationKey)).toEqual(bytes);
    expect(observe).toHaveBeenCalledWith('federation.asset.latency', { sourceInstanceId: 'nightframe', durationMs: 125 });
  });
  test('pins the approved DNS result into the delivery transport to prevent rebinding', async () => {
    const fetcher = jest.fn(async (_url: string, _timeout: number, addresses: string[]) => { expect(addresses).toEqual(['8.8.8.8']); return response(); });
    await setup({ fetch: fetcher }).service.replicate(reference, source); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  test('blocks SSRF, redirects, checksum substitution, and failed scans', async () => {
    await expect(setup({ resolve: async () => ['127.0.0.1'] }).service.replicate(reference, source)).rejects.toThrow('private');
    await expect(setup({ fetch: async () => response(bytes, 302) }).service.replicate(reference, source)).rejects.toThrow('redirect');
    await expect(setup({ fetch: async () => response(Buffer.from('different payload')) }).service.replicate(reference, source)).rejects.toThrow('Content-Length');
    await expect(setup({ scanner: { scan: async () => ({ malware: 'detected' as const, safety: 'held' as const }) } }).service.replicate(reference, source)).rejects.toThrow('scanning');
  });
  test('records latency exactly once when validation fails before fetching', async () => {
    const observe = jest.fn();
    const times = [new Date('2026-08-26T00:00:00Z'), new Date('2026-08-26T00:00:00.010Z')];
    await expect(setup({ resolve: async () => ['127.0.0.1'], observe, now: () => times.shift()! }).service.replicate(reference, source)).rejects.toThrow('private');
    expect(observe.mock.calls.filter(([event]) => event === 'federation.asset.latency')).toEqual([
      ['federation.asset.latency', { sourceInstanceId: 'nightframe', durationMs: 10 }]
    ]);
  });
  test('does not let telemetry failures replace the replication result', async () => {
    await expect(setup({ observe: () => { throw new Error('metrics unavailable'); } }).service.replicate(reference, source)).resolves.toMatchObject({ moderationState: 'cleared' });
  });
  test('cleans failed quarantine data unless legal hold requires evidence retention', async () => {
    const observe = jest.fn();
    const times = [new Date('2026-08-26T00:00:00Z'), new Date('2026-08-26T00:00:00.250Z')];
    const ordinary = setup({ scanner: { scan: async () => ({ malware: 'detected' as const, safety: 'held' as const }) }, observe, now: () => times.shift()! });
    await expect(ordinary.service.replicate(reference, source)).rejects.toThrow(); expect(ordinary.storage.delete).toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith('federation.asset.latency', { sourceInstanceId: 'nightframe', durationMs: 250 });
    const held = setup({ scanner: { scan: async () => ({ malware: 'detected' as const, safety: 'held' as const }) } });
    await expect(held.service.replicate(reference, source, true)).rejects.toThrow(); expect(held.storage.delete).not.toHaveBeenCalled();
  });
  test('cleans generated renditions when promotion fails', async () => {
    const ordinary = setup(); ordinary.storage.promote.mockRejectedValueOnce(new Error('promotion failed'));
    await expect(ordinary.service.replicate(reference, source)).rejects.toThrow('promotion failed');
    expect(ordinary.storage.delete).toHaveBeenCalledWith('federation/renditions/one');
    expect(ordinary.storage.delete).toHaveBeenCalledWith(expect.stringContaining('federation/quarantine/'));

    const held = setup(); held.storage.promote.mockRejectedValueOnce(new Error('promotion failed'));
    await expect(held.service.replicate(reference, source, true)).rejects.toThrow('promotion failed');
    expect(held.storage.delete).not.toHaveBeenCalled();
  });
});
