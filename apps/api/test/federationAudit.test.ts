import { FederationAuditDynamoRepository, prepareFederationAuditRecord } from '../src/federationAudit';
import type { FederationAuditRecord } from '../src/federation';

const record = (event: FederationAuditRecord['event'], detail: FederationAuditRecord['detail'] = {}): FederationAuditRecord => ({ id: `audit-${event}`, event, instanceId: 'eversally', actorUri: 'https://nightfra.me/actors/a', detail, occurredAt: '2026-08-26T12:00:00Z' });

describe('federation audit privacy, retention, and access', () => {
  test('classifies records, hashes immutable content, and omits TTL under legal hold', () => {
    expect(prepareFederationAuditRecord(record('PUBLICATION_CREATED'))).toMatchObject({ classification: 'operations', legalHold: false, recordHash: expect.stringMatching(/^[a-f0-9]{64}$/), retainedUntil: expect.any(String) });
    expect(prepareFederationAuditRecord(record('SAFETY_ALERT'))).toMatchObject({ classification: 'restricted_safety' });
    expect(prepareFederationAuditRecord(record('LEGAL_HOLD'))).toMatchObject({ classification: 'legal', legalHold: true, retainedUntil: undefined });
  });
  test('rejects private credentials and internal notes from audit detail', () => {
    expect(() => prepareFederationAuditRecord(record('GRANT_REQUESTED', { accessToken: 'no' }))).toThrow('forbidden');
    expect(() => prepareFederationAuditRecord(record('PROFILE_MODERATED', { internalNote: 'no' }))).toThrow('forbidden');
  });
  test('filters records by authorized role and verifies hashes during export', async () => {
    const operations = prepareFederationAuditRecord(record('PUBLICATION_CREATED')); const safety = prepareFederationAuditRecord(record('SAFETY_ALERT'));
    const send = jest.fn().mockResolvedValue({ Items: [{ envelope: operations }, { envelope: safety }] });
    const repository = new FederationAuditDynamoRepository({ send } as never, 'core', 'tenant');
    expect(await repository.list('federation_operator')).toEqual([operations]);
    expect((await repository.exportNdjson('safety_investigator')).split('\n')).toHaveLength(2);
    send.mockResolvedValueOnce({ Items: [{ envelope: { ...operations, recordHash: 'tampered' } }] });
    await expect(repository.exportNdjson('federation_operator')).rejects.toThrow('hash');
  });
  test('legal hold removes TTL with a conditional update and requires reviewer context', async () => {
    const send = jest.fn().mockResolvedValue({}); const repository = new FederationAuditDynamoRepository({ send } as never, 'core', 'tenant');
    await repository.placeLegalHold({ occurredAt: record('PUBLICATION_CREATED').occurredAt, auditId: 'audit', reviewerId: 'legal-1', reason: 'preservation order' });
    expect(send.mock.calls[0][0].input).toMatchObject({ ConditionExpression: 'attribute_exists(PK)', UpdateExpression: expect.stringContaining('REMOVE ttlEpochSeconds') });
    await expect(repository.placeLegalHold({ occurredAt: 'now', auditId: 'audit', reviewerId: '', reason: '' })).rejects.toThrow('reviewer');
  });
});

