import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AppConfig } from './config';
import type { AutomationReviewTask, BillingTask, ContentFlag, HumanReviewCase, ReviewHold, SafetyAuditEvent, ScanJob, ScanResult, SupportAttachment, SupportMessage, SupportNotification, SupportTicket } from './supportSafety';

export type SupportRecordMap = {
  ticket: SupportTicket;
  message: SupportMessage;
  attachment: SupportAttachment;
  notification: SupportNotification;
  flag: ContentFlag;
  automationTask: AutomationReviewTask;
  hold: ReviewHold;
  reviewCase: HumanReviewCase;
  scanResult: ScanResult;
  scanJob: ScanJob;
  billingTask: BillingTask;
  auditEvent: SafetyAuditEvent;
};

export interface SupportSafetyRepository {
  nextTicketNumber(): Promise<number>;
  put<K extends keyof SupportRecordMap>(kind: K, id: string, record: SupportRecordMap[K]): Promise<void>;
  get<K extends keyof SupportRecordMap>(kind: K, id: string): Promise<SupportRecordMap[K] | null>;
  list<K extends keyof SupportRecordMap>(kind: K): Promise<SupportRecordMap[K][]>;
}

export class InMemorySupportSafetyRepository implements SupportSafetyRepository {
  private sequence = 1041;
  private readonly records = new Map<keyof SupportRecordMap, Map<string, SupportRecordMap[keyof SupportRecordMap]>>();

  async nextTicketNumber(): Promise<number> { this.sequence += 1; return this.sequence; }
  async put<K extends keyof SupportRecordMap>(kind: K, id: string, record: SupportRecordMap[K]): Promise<void> {
    const bucket = this.records.get(kind) || new Map();
    bucket.set(id, structuredClone(record));
    this.records.set(kind, bucket);
  }
  async get<K extends keyof SupportRecordMap>(kind: K, id: string): Promise<SupportRecordMap[K] | null> {
    return structuredClone((this.records.get(kind)?.get(id) as SupportRecordMap[K] | undefined) || null);
  }
  async list<K extends keyof SupportRecordMap>(kind: K): Promise<SupportRecordMap[K][]> {
    return [...(this.records.get(kind)?.values() || [])].map((record) => structuredClone(record as SupportRecordMap[K]));
  }
}

/** Durable single-table repository. Safety evidence bytes intentionally do not belong in this table. */
export class DynamoSupportSafetyRepository implements SupportSafetyRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly partitionKey: string;
  constructor(private readonly tableName: string, tenantId: string, region: string) {
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true }
    });
    this.partitionKey = `TENANT#${tenantId}#SUPPORT_SAFETY`;
  }
  static fromConfig(config: AppConfig): DynamoSupportSafetyRepository {
    return new DynamoSupportSafetyRepository(config.contentCoreTable, config.tenantId, config.awsRegion);
  }
  async nextTicketNumber(): Promise<number> {
    const result = await this.client.send(new UpdateCommand({ TableName: this.tableName, Key: { PK: this.partitionKey, SK: 'COUNTER#TICKET' }, UpdateExpression: 'SET #value = if_not_exists(#value, :base) + :one', ExpressionAttributeNames: { '#value': 'value' }, ExpressionAttributeValues: { ':base': 1041, ':one': 1 }, ReturnValues: 'UPDATED_NEW' }));
    return Number(result.Attributes?.value);
  }
  async put<K extends keyof SupportRecordMap>(kind: K, id: string, record: SupportRecordMap[K]): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK: this.partitionKey, SK: `${kind}#${id}`, kind, record, updatedAt: new Date().toISOString() } }));
  }
  async get<K extends keyof SupportRecordMap>(kind: K, id: string): Promise<SupportRecordMap[K] | null> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: this.partitionKey, SK: `${kind}#${id}` }, ConsistentRead: true }));
    return (result.Item?.record as SupportRecordMap[K] | undefined) || null;
  }
  async list<K extends keyof SupportRecordMap>(kind: K): Promise<SupportRecordMap[K][]> {
    const records: SupportRecordMap[K][] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', ExpressionAttributeValues: { ':pk': this.partitionKey, ':prefix': `${kind}#` }, ExclusiveStartKey: cursor }));
      records.push(...(result.Items || []).map((item) => item.record as SupportRecordMap[K]));
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    return records;
  }
}
