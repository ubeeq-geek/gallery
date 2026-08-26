import { FederationDynamoRepository } from '../src/federationDynamoRepository';
import type { FederationAuditRecord, FederationGrant } from '../src/federation';

describe('FederationDynamoRepository', () => {
  test('atomically creates a grant and immutable audit record with query indexes', async () => {
    const send = jest.fn().mockResolvedValue({});
    const repository = new FederationDynamoRepository({ send } as never, 'core', 'tenant');
    const grant: FederationGrant = { id: 'g', actorUri: 'https://home/actors/a', homeInstanceId: 'home', destinationInstanceId: 'destination', scopes: ['profile:publish'], status: 'pending', policyVersionAccepted: '1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const audit: FederationAuditRecord = { id: 'a', event: 'GRANT_REQUESTED', instanceId: 'destination', occurredAt: grant.createdAt, detail: {} };
    await repository.createGrant(grant, audit);
    const input = send.mock.calls[0][0].input;
    expect(input.TransactItems).toHaveLength(2);
    expect(input.TransactItems[0].Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(PK)', Item: { GSI1PK: `FEDERATION_ACTOR#${grant.actorUri}`, GSI2PK: 'FEDERATION_GRANT_STATUS#pending' } });
    expect(input.TransactItems[1].Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(PK)', Item: { entityType: 'FEDERATION_AUDIT' } });
  });

  test('uses TTL and conditional creation for replay and idempotency records', async () => {
    const send = jest.fn().mockResolvedValue({});
    const repository = new FederationDynamoRepository({ send } as never, 'core', 'tenant');
    await repository.claimNonce('home', 'nonce', '2026-01-01T00:05:00Z');
    await repository.putIdempotency('operation', { ok: true }, '2026-01-02T00:00:00Z');
    for (const call of send.mock.calls) {
      expect(call[0].input.ConditionExpression).toBe('attribute_not_exists(PK)');
      expect(call[0].input.Item.ttlEpochSeconds).toEqual(expect.any(Number));
    }
  });
});
