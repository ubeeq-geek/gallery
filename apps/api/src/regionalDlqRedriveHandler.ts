import type { Handler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';

export interface RedriveRequest { queue: 'scan' | 'image' | 'video' | 'publication'; maximumMessages?: number; requestedBy: string; }
export interface RedriveDependencies {
  receive(source: string, maximum: number): Promise<Array<{ body: string; receiptHandle: string }>>;
  send(destination: string, body: string, fifo?: { groupId: string; deduplicationId: string }): Promise<void>;
  remove(source: string, receiptHandle: string): Promise<void>;
  audit(item: Record<string, unknown>): Promise<void>;
}

export const redriveRegionalDlq = async (request: RedriveRequest, cell: { product: string; environment: string; region: string }, queues: Record<RedriveRequest['queue'], { source: string; destination: string }>, deps: RedriveDependencies): Promise<{ redriven: number }> => {
  const maximum = Math.min(100, Math.max(1, Number(request.maximumMessages || 10)));
  if (!request.requestedBy?.trim() || !queues[request.queue]) throw new Error('A valid queue and operator identity are required');
  let redriven = 0;
  while (redriven < maximum) {
    const messages = await deps.receive(queues[request.queue].source, Math.min(10, maximum - redriven));
    if (!messages.length) break;
    for (const message of messages) {
      const body = JSON.parse(message.body);
      if (body.product !== cell.product || body.environment !== cell.environment || body.dataHomeRegion !== cell.region) throw new Error('Cross-cell DLQ message rejected');
      await deps.send(queues[request.queue].destination, message.body, request.queue === 'scan' ? { groupId: String(body.spaceId || body.assetId), deduplicationId: String(body.id) } : undefined);
      await deps.remove(queues[request.queue].source, message.receiptHandle);
      redriven++;
    }
  }
  await deps.audit({ PK: `AUDIT#${randomUUID()}`, recordType: 'DLQ_REDRIVE_AUDIT', action: 'regional_dlq.redriven', product: cell.product, environment: cell.environment, dataHomeRegion: cell.region, queue: request.queue, requestedBy: request.requestedBy, redriven, createdAt: new Date().toISOString() });
  return { redriven };
};

const region = process.env.DATA_HOME_REGION || process.env.AWS_REGION || 'us-east-1'; const sqs = new SQSClient({ region }); const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const queues = JSON.parse(process.env.REDRIVE_QUEUES_JSON || '{}');
export const handler: Handler<RedriveRequest, { redriven: number }> = async (request) => redriveRegionalDlq(request, { product: process.env.PRODUCT || '', environment: process.env.ENVIRONMENT || '', region }, queues, {
  receive: async (source, maximum) => (await sqs.send(new ReceiveMessageCommand({ QueueUrl: source, MaxNumberOfMessages: maximum, VisibilityTimeout: 60, WaitTimeSeconds: 1 }))).Messages?.flatMap(({ Body, ReceiptHandle }) => Body && ReceiptHandle ? [{ body: Body, receiptHandle: ReceiptHandle }] : []) || [],
  send: async (destination, body, fifo) => { await sqs.send(new SendMessageCommand({ QueueUrl: destination, MessageBody: body, ...(fifo ? { MessageGroupId: fifo.groupId, MessageDeduplicationId: fifo.deduplicationId } : {}) })); },
  remove: async (source, receiptHandle) => { await sqs.send(new DeleteMessageCommand({ QueueUrl: source, ReceiptHandle: receiptHandle })); },
  audit: async (item) => { await ddb.send(new PutCommand({ TableName: process.env.AUDIT_USAGE_TABLE || '', Item: item, ConditionExpression: 'attribute_not_exists(PK)' })); }
});
