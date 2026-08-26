import { generateKeyPairSync } from 'node:crypto';
import { FederationCallbackReceiver, FederationCallbackService, parseFederationCallbackRequest, type FederationCallbackQueueMessage } from '../src/federationCallback';
import { InMemoryFederationRepository, ManagedFederationTrust, signFederationRequest, type FederationInstanceMetadata } from '../src/federation';

const now = new Date('2026-08-26T12:00:00Z'); const keys = generateKeyPairSync('ed25519');
const instance = (id: string, origin: string): FederationInstanceMetadata => ({ instanceId: id, metadataRevision: 1, metadataUpdatedAt: now.toISOString(), brand: id === 'home' ? 'nightframe' : 'eversally', name: id, origin, actorBaseUrl: `${origin}/actors`, policyVersion: '1', status: 'trusted', keys: [{ keyId: `${id}-key`, algorithm: 'Ed25519', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), validFrom: '2026-01-01T00:00:00Z' }] });
const home = instance('home', 'https://nightfra.me'); const destination = instance('destination', 'https://eversally.com');
const trust = new ManagedFederationTrust(); trust.register(home); trust.register(destination);

describe('federation status callbacks', () => {
  test('persists, signs, delivers, and marks a callback delivered', async () => {
    const queued: FederationCallbackQueueMessage[] = []; const created: FederationCallbackQueueMessage[] = []; const updated: unknown[] = []; let signedBody: any; const observe = jest.fn();
    const times = [now, now, new Date(now.getTime() + 75)];
    const service = new FederationCallbackService({ localInstance: destination, activeKeyId: 'destination-key', privateKey: keys.privateKey, trust,
      queue: { enqueue: async (message) => { queued.push(message); } }, persistence: { create: async (message) => { created.push(message); }, update: async (job) => { updated.push(job); } },
      fetch: async (_url, init) => { signedBody = JSON.parse(init.body); return { status: 202 }; }, now: () => times.shift()!, observe });
    await service.queue({ actorUri: 'https://nightfra.me/actors/a', homeInstanceId: home.instanceId, event: 'publication.status', status: 'held', publicationId: 'publication' }, home);
    expect(created).toHaveLength(1); expect(queued).toHaveLength(1);
    const job = await service.deliver(queued[0]); expect(job.status).toBe('delivered'); expect(updated).toHaveLength(1);
    expect(signedBody).toMatchObject({ operation: 'status.callback', sourceInstanceId: destination.instanceId, destinationInstanceId: home.instanceId, keyId: 'destination-key' });
    expect(observe).toHaveBeenCalledWith('federation.callback.latency', { targetInstanceId: 'home', event: 'publication.status', durationMs: 75 });
  });
  test('retries transient responses and dead-letters terminal responses', async () => {
    const queued: FederationCallbackQueueMessage[] = []; const persistence = { create: async () => undefined, update: async () => undefined };
    const make = (status: number) => new FederationCallbackService({ localInstance: destination, activeKeyId: 'destination-key', privateKey: keys.privateKey, trust, queue: { enqueue: async (message) => { queued.push(message); } }, persistence, fetch: async () => ({ status }), now: () => now, maximumAttempts: 3, baseDelaySeconds: 10 });
    const transient = make(503); await transient.queue({ actorUri: 'https://nightfra.me/actors/a', homeInstanceId: 'home', event: 'grant.status', status: 'active' }, home);
    expect(await transient.deliver(queued.shift()!)).toMatchObject({ status: 'retry_scheduled', attemptCount: 1, nextAttemptAt: '2026-08-26T12:00:10.000Z' });
    const terminal = make(400); await terminal.queue({ actorUri: 'https://nightfra.me/actors/a', homeInstanceId: 'home', event: 'grant.status', status: 'rejected' }, home);
    expect((await terminal.deliver(queued.shift()!)).status).toBe('dead_letter');
  });
  test('does not let telemetry failures replace a delivery result', async () => {
    const queued: FederationCallbackQueueMessage[] = [];
    const service = new FederationCallbackService({ localInstance: destination, activeKeyId: 'destination-key', privateKey: keys.privateKey, trust, queue: { enqueue: async (message) => { queued.push(message); } }, persistence: { create: async () => undefined, update: async () => undefined }, fetch: async () => ({ status: 202 }), now: () => now, observe: () => { throw new Error('metrics unavailable'); } });
    await service.queue({ actorUri: 'https://nightfra.me/actors/a', homeInstanceId: 'home', event: 'grant.status', status: 'active' }, home);
    await expect(service.deliver(queued[0])).resolves.toMatchObject({ status: 'delivered' });
  });
  test('rejects queue target tampering before making an outbound request', async () => {
    const fetch = jest.fn(async () => ({ status: 202 })); const observe = jest.fn();
    const times = [now, new Date(now.getTime() + 5), now, new Date(now.getTime() + 7)];
    const service = new FederationCallbackService({ localInstance: destination, activeKeyId: 'destination-key', privateKey: keys.privateKey, trust, queue: { enqueue: async () => undefined }, persistence: { create: async () => undefined, update: async () => undefined }, fetch, now: () => times.shift()!, observe });
    const base = { job: { id: 'callback', idempotencyKey: 'callback', operation: 'status.callback', status: 'queued', attemptCount: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() }, callback: { callbackId: 'callback', actorUri: 'https://nightfra.me/actors/a', homeInstanceId: 'home', destinationInstanceId: 'destination', event: 'publication.status', status: 'held', occurredAt: now.toISOString() }, targetOrigin: 'https://attacker.example' };
    await expect(service.deliver(base as never)).rejects.toThrow('trust registry');
    await expect(service.deliver({ ...base, targetOrigin: home.origin, callback: { ...base.callback, actorUri: 'https://attacker.example/actors/a' } } as never)).rejects.toThrow('actor namespace');
    expect(fetch).not.toHaveBeenCalled();
    expect(observe.mock.calls.filter(([event]) => event === 'federation.callback.latency')).toEqual([
      ['federation.callback.latency', { targetInstanceId: 'home', event: 'publication.status', durationMs: 5 }],
      ['federation.callback.latency', { targetInstanceId: 'home', event: 'publication.status', durationMs: 7 }]
    ]);
  });
  test('receiver authenticates audience, signature, replay, and callback identities before applying', async () => {
    const trust = new ManagedFederationTrust(); trust.register(destination); trust.register(home); const repository = new InMemoryFederationRepository(); const applied: unknown[] = [];
    const receiver = new FederationCallbackReceiver({ instanceId: home.instanceId, trust, repository, apply: async (payload) => { applied.push(payload); }, now: () => now });
    const payload = { callbackId: 'callback', actorUri: 'https://nightfra.me/actors/a', homeInstanceId: 'home', destinationInstanceId: 'destination', event: 'publication.status' as const, status: 'removed', occurredAt: now.toISOString() };
    const request = signFederationRequest({ sourceInstanceId: 'destination', destinationInstanceId: 'home', keyId: 'destination-key', privateKey: keys.privateKey, operation: 'status.callback', payload, idempotencyKey: 'callback', now });
    await receiver.receive(request as never); expect(applied).toEqual([payload]);
    await expect(receiver.receive(request as never)).rejects.toThrow('nonce');
    expect(() => parseFederationCallbackRequest({ ...request, payload: { ...payload, homeInstanceId: 'other' } } as never)).toThrow('identities');
  });
});
