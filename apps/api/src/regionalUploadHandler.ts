import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ManagedProduct, ManagedRegion } from './regionalMedia';
import { authorizeRegionalUpload, regionalUploadAuditId, type RegionalUploadAuthorization, type RegionalUploadRepository, type RegionalUploadRequest } from './regionalUpload';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const creatorId = (event: APIGatewayProxyEvent): string => {
  const claims = event.requestContext.authorizer?.claims as Record<string, unknown> | undefined;
  const subject = claims?.sub;
  if (typeof subject !== 'string' || !subject.trim()) throw new Error('Authenticated creator subject is required');
  return subject;
};

export interface RegionalUploadHandlerDependencies {
  authorize(request: RegionalUploadRequest): Promise<{ authorization: RegionalUploadAuthorization; uploadUrl: string }>;
}

export const createRegionalUploadHandler = (deps: RegionalUploadHandlerDependencies) => async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'method_not_allowed' }) };
    const body = JSON.parse(event.body || '{}') as Omit<RegionalUploadRequest, 'creatorId'>;
    const result = await deps.authorize({ ...body, creatorId: creatorId(event) });
    return { statusCode: 201, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({
      uploadUrl: result.uploadUrl, assetId: result.authorization.assetId, mediaVersionId: result.authorization.mediaVersionId,
      dataHomeRegion: result.authorization.dataHomeRegion, quarantineObjectKey: result.authorization.quarantineObjectKey,
      expiresAt: result.authorization.expiresAt, requiredHeaders: { 'content-type': result.authorization.contentType, 'content-length': String(result.authorization.contentLength) }
    }) };
  } catch (error) {
    const malformed = error instanceof SyntaxError || (error instanceof Error && /invalid|not supported|required|authorized|match/.test(error.message));
    return { statusCode: malformed ? 400 : 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ error: malformed ? 'upload_not_authorized' : 'internal_error' }) };
  }
};

export const dynamoRegionalUploadRepository = (input: { client: DynamoDBDocumentClient; metadataTableName: string; auditTableName: string }): RegionalUploadRepository => ({
  authorize: async (authorization) => {
    const uploadKey = `UPLOAD#${authorization.mediaVersionId}`;
    try {
      await input.client.send(new TransactWriteCommand({ TransactItems: [
        { ConditionCheck: { TableName: input.metadataTableName, Key: { PK: `SPACE#${authorization.spaceId}` }, ConditionExpression: '#product = :product AND #environment = :environment AND dataHomeRegion = :region AND creatorId = :creatorId AND #status = :active AND dataHomeMigrationState = :none', ExpressionAttributeNames: { '#product': 'product', '#environment': 'environment', '#status': 'status' }, ExpressionAttributeValues: { ':product': authorization.product, ':environment': authorization.environment, ':region': authorization.dataHomeRegion, ':creatorId': authorization.creatorId, ':active': 'ACTIVE', ':none': 'NONE' } } },
        { ConditionCheck: { TableName: input.metadataTableName, Key: { PK: `ASSET#${authorization.assetId}` }, ConditionExpression: '#product = :product AND #environment = :environment AND dataHomeRegion = :region AND canonicalRegion = :region AND spaceId = :spaceId AND (attribute_not_exists(currentMediaVersionId) OR currentMediaVersionId = :mediaVersionId)', ExpressionAttributeNames: { '#product': 'product', '#environment': 'environment' }, ExpressionAttributeValues: { ':product': authorization.product, ':environment': authorization.environment, ':region': authorization.dataHomeRegion, ':spaceId': authorization.spaceId, ':mediaVersionId': authorization.mediaVersionId } } },
        { Put: { TableName: input.metadataTableName, Item: { ...authorization, PK: uploadKey }, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: input.auditTableName, Item: { PK: regionalUploadAuditId(), recordType: 'REGIONAL_UPLOAD_AUDIT', product: authorization.product, environment: authorization.environment, dataHomeRegion: authorization.dataHomeRegion, creatorId: authorization.creatorId, spaceId: authorization.spaceId, assetId: authorization.assetId, mediaVersionId: authorization.mediaVersionId, action: 'regional_upload.authorized', createdAt: authorization.createdAt } } }
      ] }));
      return authorization;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') throw error;
      const existing = await input.client.send(new GetCommand({ TableName: input.metadataTableName, Key: { PK: uploadKey }, ConsistentRead: true }));
      const item = existing.Item as RegionalUploadAuthorization | undefined;
      if (!item || item.creatorId !== authorization.creatorId || item.spaceId !== authorization.spaceId || item.assetId !== authorization.assetId || item.mediaVersionId !== authorization.mediaVersionId || item.product !== authorization.product || item.environment !== authorization.environment || item.dataHomeRegion !== authorization.dataHomeRegion || item.contentType !== authorization.contentType || item.contentLength !== authorization.contentLength || item.expiresAtEpochSeconds <= Math.floor(Date.now() / 1000)) throw error;
      return item;
    }
  }
});

const dependencies = (): RegionalUploadHandlerDependencies => {
  const region = required('DATA_HOME_REGION') as ManagedRegion;
  const metadataTableName = required('METADATA_TABLE');
  const auditTableName = required('AUDIT_USAGE_TABLE');
  const quarantineBucket = required('QUARANTINE_BUCKET');
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const s3 = new S3Client({ region });
  const uploads = dynamoRegionalUploadRepository({ client: ddb, metadataTableName, auditTableName });
  return { authorize: (request) => authorizeRegionalUpload(request, { product: required('PRODUCT') as ManagedProduct, environment: required('ENVIRONMENT'), dataHomeRegion: region, quarantineBucket }, uploads, { sign: async (upload) => getSignedUrl(s3, new PutObjectCommand({ Bucket: upload.bucket, Key: upload.objectKey, ContentType: upload.contentType, ContentLength: upload.contentLength, Metadata: { 'upload-authorization': `upload-${request.mediaVersionId}` } }), { expiresIn: upload.expiresInSeconds }) }) };
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => createRegionalUploadHandler(dependencies())(event);
