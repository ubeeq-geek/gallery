import type { DynamoDBStreamEvent, DynamoDBStreamHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { unmarshall } from '@aws-sdk/util-dynamodb';

export const createRegionalPublicationOutboxHandler = (deps: { loadAsset(assetId: string): Promise<Record<string, any>>; send(message: Record<string, unknown>): Promise<void>; complete(pk: string): Promise<void> }): DynamoDBStreamHandler => async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) continue;
    const item = unmarshall(record.dynamodb.NewImage as any);
    if (item.recordType !== 'PUBLICATION_OUTBOX' || item.state !== 'PENDING') continue;
    const asset = await deps.loadAsset(item.assetId);
    if (!asset.privateDerivativeObjectKey || !asset.mediaContentHash || !asset.mediaContentType || asset.currentScanGroupId !== item.scanGroupId) throw new Error('Publication outbox does not match its authoritative Asset');
    await deps.send({ product: item.product, environment: item.environment, dataHomeRegion: item.dataHomeRegion, assetId: item.assetId, mediaVersionId: item.mediaVersionId, scanGroupId: item.scanGroupId, contentHash: asset.mediaContentHash, contentType: asset.mediaContentType, privateDerivativeObjectKey: asset.privateDerivativeObjectKey });
    await deps.complete(item.PK);
  }
};

const region = process.env.DATA_HOME_REGION || process.env.AWS_REGION || 'us-east-1'; const auditTable = process.env.AUDIT_USAGE_TABLE || ''; const metadataTable = process.env.METADATA_TABLE || ''; const queueUrl = process.env.PUBLICATION_QUEUE_URL || '';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region })); const sqs = new SQSClient({ region });
export const handler = createRegionalPublicationOutboxHandler({
  loadAsset: async (assetId) => (await ddb.send(new GetCommand({ TableName: metadataTable, Key: { PK: `ASSET#${assetId}` }, ConsistentRead: true }))).Item || {},
  send: async (message) => { await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message), MessageDeduplicationId: undefined })); },
  complete: async (pk) => { await ddb.send(new UpdateCommand({ TableName: auditTable, Key: { PK: pk }, UpdateExpression: 'SET #state = :complete, completedAt = :now', ConditionExpression: '#state = :pending', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':pending': 'PENDING', ':complete': 'COMPLETE', ':now': new Date().toISOString() } })); }
});
