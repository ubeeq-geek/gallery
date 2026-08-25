import type { DynamoDBStreamEvent, DynamoDBBatchResponse } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { RegionalScanJob } from './regionalMedia';

export interface RegionalScanDispatchOutbox {
  id: string;
  recordType: 'SCAN_DISPATCH_OUTBOX';
  product: RegionalScanJob['product'];
  environment: string;
  dataHomeRegion: RegionalScanJob['dataHomeRegion'];
  job: RegionalScanJob;
  state: 'PENDING';
  createdAt: string;
}

export const scanDispatchOutbox = (job: RegionalScanJob): RegionalScanDispatchOutbox => ({
  id: `outbox-${job.id}`, recordType: 'SCAN_DISPATCH_OUTBOX', product: job.product,
  environment: job.environment, dataHomeRegion: job.dataHomeRegion, job, state: 'PENDING', createdAt: job.createdAt
});

export interface RegionalScanOutboxDependencies {
  cell: Pick<RegionalScanDispatchOutbox, 'product' | 'environment' | 'dataHomeRegion'>;
  dispatch(record: RegionalScanDispatchOutbox): Promise<void>;
}

export const createRegionalScanOutboxHandler = (deps: RegionalScanOutboxDependencies) => async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const [index, streamRecord] of event.Records.entries()) {
    try {
      if (streamRecord.eventName !== 'INSERT' || !streamRecord.dynamodb?.NewImage) continue;
      const record = unmarshall(streamRecord.dynamodb.NewImage as any) as RegionalScanDispatchOutbox;
      if (record.recordType !== 'SCAN_DISPATCH_OUTBOX' || record.state !== 'PENDING') continue;
      if (record.product !== deps.cell.product || record.environment !== deps.cell.environment || record.dataHomeRegion !== deps.cell.dataHomeRegion) throw new Error('Cross-cell scan dispatch rejected');
      await deps.dispatch(record);
    } catch {
      failures.push({ itemIdentifier: streamRecord.eventID || `stream-record-${index}` });
    }
  }
  return { batchItemFailures: failures };
};

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const dependencies = (): RegionalScanOutboxDependencies => {
  const region = required('DATA_HOME_REGION') as RegionalScanJob['dataHomeRegion'];
  const tableName = required('SCAN_JOBS_TABLE');
  const metadataTableName = required('METADATA_TABLE');
  const queueUrl = required('SCAN_QUEUE_URL');
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const sqs = new SQSClient({ region });
  return {
    cell: { product: required('PRODUCT') as RegionalScanJob['product'], environment: required('ENVIRONMENT'), dataHomeRegion: region },
    dispatch: async (record) => {
      const current = await ddb.send(new GetCommand({ TableName: tableName, Key: { id: record.id }, ConsistentRead: true }));
      if (current.Item?.state === 'SENT') return;
      if (current.Item?.state !== 'PENDING' || current.Item?.job?.id !== record.job.id) throw new Error('Scan dispatch outbox state is invalid');
      const asset = await ddb.send(new GetCommand({ TableName: metadataTableName, Key: { PK: `ASSET#${record.job.assetId}` }, ConsistentRead: true }));
      if (!asset.Item?.spaceId || asset.Item.dataHomeRegion !== region) throw new Error('Scan job has no authoritative regional tenant');
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(record.job), MessageGroupId: String(asset.Item.spaceId), MessageDeduplicationId: record.job.id }));
      await ddb.send(new UpdateCommand({ TableName: tableName, Key: { id: record.id }, UpdateExpression: 'SET #state = :sent, sentAt = :now', ConditionExpression: '#state = :pending', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':sent': 'SENT', ':pending': 'PENDING', ':now': new Date().toISOString() } }));
    }
  };
};

export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => createRegionalScanOutboxHandler(dependencies())(event);
