import type { SQSEvent, SQSBatchResponse, SQSRecord } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FederationError, type FederationDeliveryJob } from './federation';
import type { FederationCallbackPayload, FederationCallbackPersistence, FederationCallbackQueueMessage, FederationCallbackService } from './federationCallback';

const parseObject = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FederationError('invalid_callback_job', `${name} must be an object`);
  return value as Record<string, unknown>;
};
const required = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new FederationError('invalid_callback_job', `${name} is required`);
  return value;
};

/** Fail-closed parser for untrusted SQS bodies. The worker never trusts an embedded arbitrary target. */
export const parseFederationCallbackQueueMessage = (body: string): FederationCallbackQueueMessage => {
  let decoded: unknown;
  try { decoded = JSON.parse(body); } catch { throw new FederationError('invalid_callback_job', 'Callback job is not valid JSON'); }
  const source = parseObject(decoded, 'message'); const rawJob = parseObject(source.job, 'job'); const rawCallback = parseObject(source.callback, 'callback');
  const targetOrigin = required(source.targetOrigin, 'targetOrigin'); const target = new URL(targetOrigin);
  if (target.protocol !== 'https:' || target.origin !== targetOrigin || target.pathname !== '/') throw new FederationError('invalid_callback_job', 'targetOrigin must be an HTTPS origin');
  const job = rawJob as unknown as FederationDeliveryJob; const callback = rawCallback as unknown as FederationCallbackPayload;
  if (required(job.id, 'job.id') !== required(callback.callbackId, 'callback.callbackId')) throw new FederationError('invalid_callback_job', 'Callback and delivery identifiers do not match');
  if (!['queued', 'retry_scheduled'].includes(job.status)) throw new FederationError('invalid_callback_job', 'Callback delivery is not queued');
  required(job.idempotencyKey, 'job.idempotencyKey'); required(callback.actorUri, 'callback.actorUri'); required(callback.homeInstanceId, 'callback.homeInstanceId'); required(callback.destinationInstanceId, 'callback.destinationInstanceId');
  return structuredClone({ job, callback, targetOrigin });
};

export const createFederationCallbackWorker = (service: Pick<FederationCallbackService, 'deliver'>) => async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  await Promise.all(event.Records.map(async (record: SQSRecord) => {
    try { await service.deliver(parseFederationCallbackQueueMessage(record.body)); }
    catch { failures.push({ itemIdentifier: record.messageId }); }
  }));
  return { batchItemFailures: failures };
};

/** Persists the callback payload and uses attempt-count conditions to prevent stale workers overwriting newer delivery state. */
export class FederationCallbackDynamoPersistence implements FederationCallbackPersistence {
  private readonly pk: string;
  constructor(private readonly client: DynamoDBDocumentClient, private readonly tableName: string, tenantId: string) { this.pk = `TENANT#${tenantId}#FEDERATION`; }
  async create(message: FederationCallbackQueueMessage): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.tableName, Item: { PK: this.pk, SK: `CALLBACK#${message.job.id}`, entityType: 'FEDERATION_CALLBACK', record: message, GSI2PK: `FEDERATION_DELIVERY_STATUS#${message.job.status}`, GSI2SK: `${message.job.updatedAt}#${message.job.id}` }, ConditionExpression: 'attribute_not_exists(PK)' }));
  }
  async update(job: FederationDeliveryJob): Promise<void> {
    const key = { PK: this.pk, SK: `CALLBACK#${job.id}` };
    const current = await this.client.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }));
    const message = current.Item?.record as FederationCallbackQueueMessage | undefined;
    if (!message) throw new FederationError('callback_not_found', 'Callback delivery does not exist');
    await this.client.send(new UpdateCommand({ TableName: this.tableName, Key: key, UpdateExpression: 'SET #record.#job = :job, GSI2PK = :status, GSI2SK = :sort', ConditionExpression: '#record.#job.#attempt = :previous', ExpressionAttributeNames: { '#record': 'record', '#job': 'job', '#attempt': 'attemptCount' }, ExpressionAttributeValues: { ':job': job, ':status': `FEDERATION_DELIVERY_STATUS#${job.status}`, ':sort': `${job.nextAttemptAt ?? job.updatedAt}#${job.id}`, ':previous': job.attemptCount - 1 } }));
  }
}
