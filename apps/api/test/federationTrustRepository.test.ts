import { generateKeyPairSync } from 'node:crypto';
import { ManagedFederationTrust, type FederationInstanceMetadata } from '../src/federation';
import { FederationTrustDynamoRepository, parseManagedTrustRegistry } from '../src/federationTrustRepository';

const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const metadata = (revision: number): FederationInstanceMetadata => ({
  instanceId: 'nightframe-production', metadataRevision: revision, metadataUpdatedAt: `2026-08-${String(20 + revision).padStart(2, '0')}T00:00:00.000Z`,
  brand: 'nightframe', name: 'Nightframe', origin: 'https://nightfra.me', actorBaseUrl: 'https://nightfra.me/.well-known/ubeeq/creators',
  policyVersion: '2026-08', status: 'trusted', keys: [{ keyId: `key-${revision}`, algorithm: 'Ed25519', publicKeyPem: key, validFrom: '2026-08-01T00:00:00.000Z' }]
});

describe('managed federation trust rotation', () => {
  test('accepts forward key rotation while rejecting rollback and identity replacement', () => {
    const trust = new ManagedFederationTrust();
    trust.register(metadata(1)); trust.register(metadata(2));
    expect(trust.resolve('nightframe-production')?.keys[0].keyId).toBe('key-2');
    expect(() => trust.register(metadata(1))).toThrow('revision');
    expect(() => trust.register({ ...metadata(3), origin: 'https://attacker.example', actorBaseUrl: 'https://attacker.example/creators' })).toThrow('identity');
  });

  test('persists revisions conditionally and can hydrate the verifier', async () => {
    const send = jest.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ Items: [{ record: metadata(2) }] });
    const repository = new FederationTrustDynamoRepository({ send } as never, 'core', 'tenant');
    await repository.register(metadata(2), 1);
    expect(send.mock.calls[0][0].input).toMatchObject({ ConditionExpression: 'metadataRevision = :expected AND :next > metadataRevision', ExpressionAttributeValues: { ':expected': 1, ':next': 2 } });
    const trust = new ManagedFederationTrust(); await repository.hydrate(trust);
    expect(trust.list()).toHaveLength(1);
  });

  test('parses only JSON arrays from managed configuration', () => {
    expect(parseManagedTrustRegistry(JSON.stringify([metadata(1)]))).toHaveLength(1);
    expect(() => parseManagedTrustRegistry('{}')).toThrow('array');
    expect(() => parseManagedTrustRegistry('{')).toThrow('valid JSON');
  });
});
