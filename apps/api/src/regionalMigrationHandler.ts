import type { Handler } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CopyObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { scanGroupManifestRecords, type ManagedRegion, type RegionalScanJob } from './regionalMedia';

export interface MigrationObject { sourceBucket: string; sourceKey: string; destinationBucket: string; destinationKey: string; sha256: string; }
export interface RegionalMigrationRequest { migrationId: string; routingId: string; product: string; environment: string; spaceId: string; sourceRegion: ManagedRegion; destinationRegion: ManagedRegion; destinationMetadataTable: string; destinationScanJobsTable: string; destinationScanQueueUrl: string; objects: MigrationObject[]; records: Array<Record<string, unknown>>; rescanJobs: RegionalScanJob[]; stage?: 'PREPARE' | 'COPY' | 'RESCAN' | 'VERIFY' | 'CUTOVER'; }
export interface RegionalMigrationDependencies {
  writeManifest(request: RegionalMigrationRequest, digest: string): Promise<void>;
  setState(request: RegionalMigrationRequest, state: string): Promise<void>;
  copy(object: MigrationObject, destinationRegion: ManagedRegion): Promise<void>;
  copyRecord(record: Record<string, unknown>, request: RegionalMigrationRequest): Promise<void>;
  verify(object: MigrationObject, destinationRegion: ManagedRegion): Promise<boolean>;
  verifyRescans(request: RegionalMigrationRequest): Promise<boolean>;
  enqueueRescan(request: RegionalMigrationRequest): Promise<void>;
  cutover(request: RegionalMigrationRequest): Promise<void>;
}

const digest = (objects: MigrationObject[]): string => createHash('sha256').update(JSON.stringify(objects)).digest('hex');
export const executeMigrationStage = async (request: RegionalMigrationRequest, deps: RegionalMigrationDependencies): Promise<RegionalMigrationRequest> => {
  if (!request.migrationId || !request.routingId || !request.spaceId || request.sourceRegion === request.destinationRegion || !request.objects.length || !request.records.length || !request.rescanJobs.length) throw new Error('Migration request is invalid');
  switch (request.stage) {
    case 'PREPARE': await deps.writeManifest(request, digest(request.objects)); await deps.setState(request, 'PREPARING'); break;
    case 'COPY': for (const object of request.objects) await deps.copy(object, request.destinationRegion); for (const record of request.records) await deps.copyRecord(record, request); await deps.setState(request, 'COPYING'); break;
    case 'RESCAN': await deps.enqueueRescan(request); await deps.setState(request, 'RESCANNING'); break;
    case 'VERIFY': for (const object of request.objects) if (!await deps.verify(object, request.destinationRegion)) throw new Error(`Migration integrity verification failed for ${object.destinationKey}`); if (!await deps.verifyRescans(request)) throw new Error('Destination rescans are incomplete'); await deps.setState(request, 'VERIFYING'); break;
    case 'CUTOVER': await deps.cutover(request); await deps.setState(request, 'COMPLETE'); break;
    default: throw new Error('Migration stage is required');
  }
  return request;
};

const metadataTable = process.env.METADATA_TABLE || '';
const sourceDdb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.DATA_HOME_REGION }));
const dependencies: RegionalMigrationDependencies = {
  writeManifest: async (request, manifestDigest) => {
    await sourceDdb.send(new PutCommand({ TableName: metadataTable, Item: { PK: `MIGRATION#${request.migrationId}`, recordType: 'DATA_HOME_MIGRATION', ...request, manifestDigest, state: 'REQUESTED', createdAt: new Date().toISOString() }, ConditionExpression: 'attribute_not_exists(PK)' }));
    const directory = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.GLOBAL_ROUTING_REGION || 'us-east-1' }));
    await directory.send(new UpdateCommand({ TableName: process.env.GLOBAL_ROUTING_TABLE || '', Key: { routingId: request.routingId }, UpdateExpression: 'SET #status = :migrating, migrationId = :migrationId, migrationDestination = :destination', ConditionExpression: 'homeRegion = :source AND #status = :active', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':source': request.sourceRegion, ':active': 'ACTIVE', ':migrating': 'MIGRATING', ':migrationId': request.migrationId, ':destination': request.destinationRegion } }));
  },
  setState: async (request, state) => { await sourceDdb.send(new UpdateCommand({ TableName: metadataTable, Key: { PK: `MIGRATION#${request.migrationId}` }, UpdateExpression: 'SET #state = :state, updatedAt = :now', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':state': state, ':now': new Date().toISOString() } })); },
  copy: async (object, region) => { await new S3Client({ region }).send(new CopyObjectCommand({ Bucket: object.destinationBucket, Key: object.destinationKey, CopySource: `${object.sourceBucket}/${encodeURIComponent(object.sourceKey)}`, MetadataDirective: 'COPY' })); },
  copyRecord: async (record, request) => { const destination = DynamoDBDocumentClient.from(new DynamoDBClient({ region: request.destinationRegion })); await destination.send(new PutCommand({ TableName: request.destinationMetadataTable, Item: { ...record, dataHomeRegion: request.destinationRegion, canonicalRegion: request.destinationRegion, dataHomeMigrationState: 'VERIFYING' }, ConditionExpression: 'attribute_not_exists(PK)' })); },
  verify: async (object, region) => { const head = await new S3Client({ region }).send(new HeadObjectCommand({ Bucket: object.destinationBucket, Key: object.destinationKey })); return head.Metadata?.sha256 === object.sha256; },
  verifyRescans: async (request) => { const destination = DynamoDBDocumentClient.from(new DynamoDBClient({ region: request.destinationRegion })); const jobs = await Promise.all(request.rescanJobs.map(({ id }) => destination.send(new GetCommand({ TableName: request.destinationScanJobsTable, Key: { id }, ConsistentRead: true })))); return jobs.every(({ Item }) => Item?.state === 'COMPLETE'); },
  enqueueRescan: async (request) => {
    const sqs = new SQSClient({ region: request.destinationRegion }); const destination = DynamoDBDocumentClient.from(new DynamoDBClient({ region: request.destinationRegion }));
    for (const manifest of scanGroupManifestRecords(request.rescanJobs)) {
      try { await destination.send(new PutCommand({ TableName: request.destinationScanJobsTable, Item: manifest, ConditionExpression: 'attribute_not_exists(id)' })); }
      catch (error) { if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error; }
    }
    for (const job of request.rescanJobs) {
      const regionalJob = { ...job, dataHomeRegion: request.destinationRegion, state: 'QUEUED', attemptCount: 0 };
      try { await destination.send(new PutCommand({ TableName: request.destinationScanJobsTable, Item: regionalJob, ConditionExpression: 'attribute_not_exists(id)' })); }
      catch (error) { if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error; }
      await sqs.send(new SendMessageCommand({ QueueUrl: request.destinationScanQueueUrl, MessageBody: JSON.stringify(regionalJob), MessageGroupId: request.spaceId, MessageDeduplicationId: regionalJob.id }));
    }
  },
  cutover: async (request) => {
    const destination = DynamoDBDocumentClient.from(new DynamoDBClient({ region: request.destinationRegion }));
    const destinationSpace = await destination.send(new GetCommand({ TableName: request.destinationMetadataTable, Key: { PK: `SPACE#${request.spaceId}` }, ConsistentRead: true }));
    if (!destinationSpace.Item || destinationSpace.Item.dataHomeRegion !== request.destinationRegion) throw new Error('Destination Space is not ready for cutover');
    const directory = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.GLOBAL_ROUTING_REGION || 'us-east-1' }));
    await directory.send(new UpdateCommand({ TableName: process.env.GLOBAL_ROUTING_TABLE || '', Key: { routingId: request.routingId }, UpdateExpression: 'SET homeRegion = :destination, #status = :active, migratedAt = :now', ConditionExpression: 'homeRegion = :source AND #status = :migrating', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':source': request.sourceRegion, ':destination': request.destinationRegion, ':migrating': 'MIGRATING', ':active': 'ACTIVE', ':now': new Date().toISOString() } }));
    await sourceDdb.send(new UpdateCommand({ TableName: metadataTable, Key: { PK: `SPACE#${request.spaceId}` }, UpdateExpression: 'SET dataHomeMigrationState = :complete, #status = :retired', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':complete': 'COMPLETE', ':retired': 'RETIRED' } }));
  }
};
export const handler: Handler<RegionalMigrationRequest, RegionalMigrationRequest> = async (event) => executeMigrationStage(event, dependencies);
