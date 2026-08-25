import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ManagedProduct, ManagedRegion } from './regionalMedia';

type Cell = { product: ManagedProduct; environment: string; dataHomeRegion: ManagedRegion };
type RecordValue = Record<string, any>;
export interface RegionalPrivacyRepository {
  get(key: string): Promise<RecordValue | undefined>;
  listForSpace(spaceId: string, creatorId: string): Promise<RecordValue[]>;
  put(item: RecordValue): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface RegionalPrivacyObjects {
  writeExport(key: string, body: string): Promise<string>;
  delete(bucket: string, keys: string[]): Promise<void>;
  exists(bucket: string, key: string): Promise<boolean>;
}

const ids = /^[A-Za-z0-9_-]{1,128}$/;
const response = (statusCode: number, body: unknown): APIGatewayProxyResult => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
const objectReferences = (records: RecordValue[], buckets: Record<string, string>) => records.flatMap(record => [
  ['quarantine', record.quarantineKey], ['originals', record.originalKey], ['privateDerivatives', record.privateDerivativeKey],
  ['publicDerivatives', record.publicDerivativeKey], ['evidence', record.evidenceKey]
].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(buckets[entry[0]])).map(([name, key]) => ({ bucket: buckets[name], key })));

export const createRegionalPrivacyHandler = (cell: Cell, repository: RegionalPrivacyRepository, objects: RegionalPrivacyObjects, buckets: Record<string, string>) => async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod !== 'POST') return response(405, { error: 'method_not_allowed' });
    const creatorId = String(event.requestContext.authorizer?.claims?.sub || '');
    const { spaceId } = JSON.parse(event.body || '{}');
    if (!ids.test(creatorId) || !ids.test(spaceId)) return response(400, { error: 'invalid_request' });
    const space = await repository.get(`SPACE#${spaceId}`);
    if (!space || space.creatorId !== creatorId || space.product !== cell.product || space.environment !== cell.environment || space.dataHomeRegion !== cell.dataHomeRegion) return response(404, { error: 'space_not_found' });
    const records = await repository.listForSpace(spaceId, creatorId);
    const requestId = `${Date.now()}-${spaceId}`;
    if (event.resource.endsWith('/export')) {
      const key = `${creatorId}/${spaceId}/${requestId}.json`;
      const url = await objects.writeExport(key, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), cell, spaceId, records }));
      await repository.put({ PK: `PRIVACY#EXPORT#${requestId}`, recordType: 'PRIVACY_EXPORT', creatorId, spaceId, dataHomeRegion: cell.dataHomeRegion, exportKey: key, expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 7 * 86400, createdAt: new Date().toISOString() });
      return response(202, { requestId, status: 'READY', downloadUrl: url, expiresInSeconds: 900 });
    }
    if (event.resource.endsWith('/delete')) {
      if (space.legalHold === true || records.some(record => record.legalHold === true)) return response(409, { error: 'legal_hold', message: 'Deletion is blocked until the regional legal hold is released.' });
      const references = objectReferences(records, buckets);
      for (const bucket of [...new Set(references.map(item => item.bucket))]) await objects.delete(bucket, references.filter(item => item.bucket === bucket).map(item => item.key));
      for (const record of records.filter(record => record.PK !== space.PK)) await repository.delete(record.PK);
      for (const reference of references) if (await objects.exists(reference.bucket, reference.key)) throw new Error(`Erasure verification failed for ${reference.bucket}/${reference.key}`);
      await repository.put({ ...space, status: 'DELETED', deletedAt: new Date().toISOString(), erasureVerifiedAt: new Date().toISOString() });
      await repository.put({ PK: `PRIVACY#DELETE#${requestId}`, recordType: 'PRIVACY_DELETION', creatorId, spaceId, dataHomeRegion: cell.dataHomeRegion, objectCount: references.length, recordCount: records.length - 1, status: 'VERIFIED', createdAt: new Date().toISOString() });
      return response(202, { requestId, status: 'VERIFIED', deletedObjects: references.length, deletedRecords: records.length - 1 });
    }
    return response(404, { error: 'not_found' });
  } catch { return response(500, { error: 'privacy_workflow_failed' }); }
};

const region = process.env.DATA_HOME_REGION as ManagedRegion;
const tableName = process.env.METADATA_TABLE || '';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const s3 = new S3Client({ region });
const repository: RegionalPrivacyRepository = {
  get: async PK => (await ddb.send(new GetCommand({ TableName: tableName, Key: { PK }, ConsistentRead: true }))).Item,
  listForSpace: async (spaceId, creatorId) => { const items: RecordValue[] = []; let cursor: Record<string, any> | undefined; do { const result = await ddb.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: cursor, FilterExpression: 'spaceId = :space AND creatorId = :creator', ExpressionAttributeValues: { ':space': spaceId, ':creator': creatorId } })); items.push(...(result.Items || [])); cursor = result.LastEvaluatedKey; } while (cursor); return items; },
  put: async item => { await ddb.send(new PutCommand({ TableName: tableName, Item: item })); },
  delete: async PK => { await ddb.send(new DeleteCommand({ TableName: tableName, Key: { PK } })); }
};
const exportsBucket = process.env.EXPORTS_BUCKET || '';
const objects: RegionalPrivacyObjects = {
  writeExport: async (key, body) => { await s3.send(new PutObjectCommand({ Bucket: exportsBucket, Key: key, Body: body, ContentType: 'application/json', ServerSideEncryption: 'aws:kms' })); return getSignedUrl(s3, new GetObjectCommand({ Bucket: exportsBucket, Key: key }), { expiresIn: 900 }); },
  delete: async (Bucket, keys) => { if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.map(Key => ({ Key })) } })); },
  exists: async (Bucket, Key) => { try { await s3.send(new HeadObjectCommand({ Bucket, Key })); return true; } catch (error: any) { if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return false; throw error; } }
};
export const handler = createRegionalPrivacyHandler({ product: process.env.PRODUCT as ManagedProduct, environment: process.env.ENVIRONMENT || '', dataHomeRegion: region }, repository, objects, {
  quarantine: process.env.QUARANTINE_BUCKET || '', originals: process.env.ORIGINALS_BUCKET || '', privateDerivatives: process.env.PRIVATE_DERIVATIVES_BUCKET || '', publicDerivatives: process.env.PUBLIC_DERIVATIVES_BUCKET || '', evidence: process.env.EVIDENCE_BUCKET || ''
});
