import { createHash } from 'node:crypto';
import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FederationError, type FederationAuditRecord } from './federation';

export type FederationAuditClassification = 'operations' | 'moderation' | 'restricted_safety' | 'legal';
export type FederationAuditRole = 'federation_operator' | 'moderator' | 'safety_investigator' | 'legal_reviewer';
export interface StoredFederationAuditRecord {
  record: FederationAuditRecord;
  classification: FederationAuditClassification;
  recordHash: string;
  retainedUntil?: string;
  legalHold: boolean;
}

const restrictedKeys = /(password|secret|token|credential|email|private|internal.?note|raw.?payload)/i;
const classificationFor = (event: FederationAuditRecord['event']): FederationAuditClassification => {
  if (event === 'SAFETY_ALERT') return 'restricted_safety';
  if (event === 'LEGAL_HOLD') return 'legal';
  if (['PROFILE_MODERATED', 'PUBLICATION_MODERATED', 'PUBLICATION_REMOVED', 'CREATOR_BLOCKED', 'INSTANCE_BLOCKED'].includes(event)) return 'moderation';
  return 'operations';
};
const canonical = (value: unknown): string => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  : JSON.stringify(value);

export const prepareFederationAuditRecord = (record: FederationAuditRecord, retentionDays = 365): StoredFederationAuditRecord => {
  const forbidden = Object.keys(record.detail).find((key) => restrictedKeys.test(key));
  if (forbidden) throw new FederationError('audit_privacy_violation', `Audit detail field is forbidden: ${forbidden}`);
  const classification = classificationFor(record.event); const legalHold = classification === 'legal';
  const retainedUntil = legalHold ? undefined : new Date(Date.parse(record.occurredAt) + retentionDays * 86_400_000).toISOString();
  const normalized = structuredClone(record);
  return { record: normalized, classification, legalHold, retainedUntil, recordHash: createHash('sha256').update(canonical({ record: normalized, classification })).digest('hex') };
};

const allowed = (role: FederationAuditRole, classification: FederationAuditClassification): boolean => ({
  federation_operator: ['operations'], moderator: ['operations', 'moderation'], safety_investigator: ['operations', 'moderation', 'restricted_safety'], legal_reviewer: ['operations', 'moderation', 'restricted_safety', 'legal']
}[role] as string[]).includes(classification);

export class FederationAuditDynamoRepository {
  private readonly pk: string;
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string, tenantId: string) { this.pk = `TENANT#${tenantId}#FEDERATION`; }

  async list(role: FederationAuditRole, from?: string, limit = 100): Promise<StoredFederationAuditRecord[]> {
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', FilterExpression: from ? '#occurred >= :from' : undefined, ExpressionAttributeNames: from ? { '#occurred': 'occurredAt' } : undefined, ExpressionAttributeValues: { ':pk': this.pk, ':prefix': 'AUDIT#', ...(from ? { ':from': from } : {}) }, Limit: Math.min(500, Math.max(1, limit)), ConsistentRead: true }));
    return (response.Items ?? []).map((item) => item.envelope as StoredFederationAuditRecord).filter((item) => item && allowed(role, item.classification));
  }

  async placeLegalHold(input: { occurredAt: string; auditId: string; reviewerId: string; reason: string }): Promise<void> {
    if (!input.reviewerId || !input.reason) throw new FederationError('legal_hold_invalid', 'Legal hold requires reviewer and reason');
    await this.client.send(new UpdateCommand({ TableName: this.tableName, Key: { PK: this.pk, SK: `AUDIT#${input.occurredAt}#${input.auditId}` }, UpdateExpression: 'SET envelope.legalHold = :true, legalHoldReviewerId = :reviewer, legalHoldReason = :reason REMOVE ttlEpochSeconds, envelope.retainedUntil', ConditionExpression: 'attribute_exists(PK)', ExpressionAttributeValues: { ':true': true, ':reviewer': input.reviewerId, ':reason': input.reason } }));
  }

  async exportNdjson(role: FederationAuditRole, from?: string): Promise<string> {
    const records = await this.list(role, from, 500);
    for (const item of records) {
      const expected = createHash('sha256').update(canonical({ record: item.record, classification: item.classification })).digest('hex');
      if (expected !== item.recordHash) throw new FederationError('audit_integrity_failed', 'Audit record hash verification failed');
    }
    return records.map((item) => JSON.stringify(item)).join('\n');
  }
}

