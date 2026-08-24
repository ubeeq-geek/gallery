import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { decryptTumblrCreatorApplication, decryptTumblrOAuthGrant, DynamoTumblrRepository, encryptTumblrCreatorApplication, encryptTumblrOAuthGrant, InMemoryTumblrRepository, publicTumblrConnector, TumblrOAuthStateService } from '../src/tumblrRepository';
import type { TumblrConnector } from '../src/tumblrIntegration';

const connector = (encrypted: TumblrConnector['creatorApplicationEncrypted']): TumblrConnector => ({
  id: 'connector', tenantId: 'tenant', userId: 'user', creatorId: 'creator', ownership: 'creator_owned', authProtocol: 'oauth2',
  status: 'pending', creatorApplicationEncrypted: encrypted, credentialsEncrypted: {}, scopes: []
});

describe('Tumblr persistence and credential custody', () => {
  test('encrypts creator application values and strips all secrets from public payloads', () => {
    const plaintext = { clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'https://app.example/callback' };
    const stored = connector(encryptTumblrCreatorApplication(plaintext, 'encryption-key'));
    expect(JSON.stringify(stored.creatorApplicationEncrypted)).not.toContain('client-secret');
    expect(decryptTumblrCreatorApplication(stored, 'encryption-key')).toEqual(plaintext);
    const safe = publicTumblrConnector(stored);
    expect(safe).toMatchObject({ hasCreatorApplication: true, hasOAuthGrant: false });
    expect(safe).not.toHaveProperty('creatorApplicationEncrypted');
    expect(safe).not.toHaveProperty('credentialsEncrypted');
  });

  test('encrypts access and refresh tokens at the persistence boundary', () => {
    const stored = connector(undefined);
    stored.credentialsEncrypted = encryptTumblrOAuthGrant({ accessToken: 'access', refreshToken: 'refresh', expiresAt: '2026-08-24T00:00:00.000Z', scopes: ['basic', 'write'] }, 'encryption-key');
    expect(JSON.stringify(stored.credentialsEncrypted)).not.toContain(':"refresh"');
    expect(decryptTumblrOAuthGrant(stored, 'encryption-key')).toEqual({ accessToken: 'access', refreshToken: 'refresh', expiresAt: '2026-08-24T00:00:00.000Z', scopes: ['basic', 'write'] });
    expect(publicTumblrConnector(stored)).toMatchObject({ hasOAuthGrant: true });
  });

  test('persists connectors with tenant, user, and creator isolation', async () => {
    const repository = new InMemoryTumblrRepository();
    await repository.putConnector(connector(undefined));
    expect(await repository.listConnectors('tenant', 'user', 'creator')).toHaveLength(1);
    expect(await repository.listConnectors('tenant', 'another-user', 'creator')).toHaveLength(0);
    expect(await repository.getConnector('another-tenant', 'connector')).toBeNull();
  });

  test('atomically consumes signed OAuth state once and rejects cross-user callbacks', async () => {
    const repository = new InMemoryTumblrRepository();
    const states = new TumblrOAuthStateService(repository, 'signing-key');
    const token = await states.issue({ tenantId: 'tenant', userId: 'user', creatorId: 'creator', connectorId: 'connector', ownership: 'managed' }, 60, 1_000);
    await expect(states.consume(token, { tenantId: 'tenant', userId: 'another-user' }, 2_000)).rejects.toThrow('another user');
    await expect(states.consume(token, { tenantId: 'tenant', userId: 'user' }, 2_000)).resolves.toMatchObject({ connectorId: 'connector' });
    await expect(states.consume(token, { tenantId: 'tenant', userId: 'user' }, 2_000)).rejects.toThrow('already been used');
  });

  test('tracks hourly and daily quota independently by consumer key', async () => {
    const repository = new InMemoryTumblrRepository();
    const now = new Date('2026-08-23T05:00:00.000Z');
    await expect(repository.consumeQuota('consumer-a', now, 1, 2)).resolves.toBe(true);
    await expect(repository.consumeQuota('consumer-a', now, 1, 2)).resolves.toBe(false);
    await expect(repository.consumeQuota('consumer-b', now, 1, 2)).resolves.toBe(true);
    await expect(repository.consumeQuota('consumer-a', new Date('2026-08-23T06:00:00.000Z'), 1, 2)).resolves.toBe(true);
    await expect(repository.consumeQuota('consumer-a', new Date('2026-08-23T07:00:00.000Z'), 1, 2)).resolves.toBe(false);
  });

  test('claims Dynamo hourly and daily quota in one atomic transaction', async () => {
    const send = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(Object.assign(new Error('quota full'), { name: 'TransactionCanceledException' }));
    const repository = new DynamoTumblrRepository({ send } as never, 'content');
    const now = new Date('2026-08-23T05:00:00.000Z');
    await expect(repository.consumeQuota('consumer', now, 1000, 5000)).resolves.toBe(true);
    expect(send.mock.calls[0][0]).toBeInstanceOf(TransactWriteCommand);
    expect(send.mock.calls[0][0].input.TransactItems).toHaveLength(2);
    await expect(repository.consumeQuota('consumer', now, 1000, 5000)).resolves.toBe(false);
  });
});
