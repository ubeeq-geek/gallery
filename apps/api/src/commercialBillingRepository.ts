import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AppConfig } from './config';
import type { BillingAccount, CommercialBillingRepository, CommercialInvoice, CommercialPrice, CommercialSubscription, CommercialUsageRollup, PaymentWebhook, ReconciliationIssue } from './commercialBilling';

export class DynamoCommercialBillingRepository implements CommercialBillingRepository {
  private client: DynamoDBDocumentClient; private pk: string;
  constructor(private tableName: string, tenantId: string, region: string) { this.client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } }); this.pk = `TENANT#${tenantId}#COMMERCIAL_BILLING`; }
  static fromConfig(config: AppConfig) { return new DynamoCommercialBillingRepository(config.commercialBillingTable, config.tenantId, config.awsRegion); }
  private async get<T>(sk: string): Promise<T | null> { const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: this.pk, SK: sk }, ConsistentRead: true })); return (result.Item?.record as T | undefined) || null; }
  private async put(sk: string, kind: string, record: unknown) { await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK: this.pk, SK: sk, kind, record, updatedAt: new Date().toISOString() } })); }
  private async list<T>(prefix: string, accountId?: string): Promise<T[]> { const result: T[] = []; let cursor: Record<string, unknown> | undefined; do { const page = await this.client.send(new QueryCommand({ TableName: this.tableName, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', ExpressionAttributeValues: { ':pk': this.pk, ':prefix': prefix }, ExclusiveStartKey: cursor })); result.push(...(page.Items || []).map((item) => item.record as T).filter((item: any) => !accountId || item.accountId === accountId)); cursor = page.LastEvaluatedKey; } while (cursor); return result; }
  getAccount(id: string) { return this.get<BillingAccount>(`ACCOUNT#${id}`); } putAccount(v: BillingAccount) { return this.put(`ACCOUNT#${v.accountId}`, 'ACCOUNT', v); }
  listAccounts(ownerUserId: string) { return this.list<BillingAccount>('ACCOUNT#').then((items) => items.filter((item) => item.ownerUserId === ownerUserId)); }
  getSubscription(id: string) { return this.get<CommercialSubscription>(`SUBSCRIPTION#${id}`); } putSubscription(v: CommercialSubscription) { return this.put(`SUBSCRIPTION#${v.subscriptionId}`, 'SUBSCRIPTION', v); } listSubscriptions(accountId: string) { return this.list<CommercialSubscription>('SUBSCRIPTION#', accountId); }
  getPrice(id: string) { return this.get<CommercialPrice>(`PRICE#${id}`); } putPrice(v: CommercialPrice) { return this.put(`PRICE#${v.priceId}`, 'PRICE', v); }
  listPrices() { return this.list<CommercialPrice>('PRICE#'); }
  getInvoice(id: string) { return this.get<CommercialInvoice>(`INVOICE#${id}`); } putInvoice(v: CommercialInvoice) { return this.put(`INVOICE#${v.invoiceId}`, 'INVOICE', v); } listInvoices(accountId: string) { return this.list<CommercialInvoice>('INVOICE#', accountId); }
  getWebhook(id: string) { return this.get<PaymentWebhook>(`WEBHOOK#${id}`); }
  async putWebhookIfAbsent(v: PaymentWebhook) { try { await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK: this.pk, SK: `WEBHOOK#${v.eventId}`, kind: 'WEBHOOK', record: v }, ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)' })); return true; } catch (error) { if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false; throw error; } }
  putWebhook(v: PaymentWebhook) { return this.put(`WEBHOOK#${v.eventId}`, 'WEBHOOK', v); }
  putReconciliationIssue(v: ReconciliationIssue) { return this.put(`RECONCILIATION#${v.issueId}`, 'RECONCILIATION', v); }
  listReconciliationIssues() { return this.list<ReconciliationIssue>('RECONCILIATION#'); }
  putUsageRollup(v: CommercialUsageRollup) { return this.put(`USAGE_ROLLUP#${v.rollupId}`, 'USAGE_ROLLUP', v); }
  listUsageRollups(accountId: string, period?: string) { return this.list<CommercialUsageRollup>('USAGE_ROLLUP#', accountId).then((items) => items.filter((item) => !period || item.period === period)); }
}
