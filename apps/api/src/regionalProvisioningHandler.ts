import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { ManagedProduct, ManagedRegion } from './regionalMedia';

export interface RegionalProvisioningRepository { put(item: Record<string, unknown>): Promise<void>; }
const identifiers = /^[A-Za-z0-9_-]{1,128}$/;
const reply = (statusCode: number, body: unknown): APIGatewayProxyResult => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });

export const createRegionalProvisioningHandler = (cell: { product: ManagedProduct; environment: string; dataHomeRegion: ManagedRegion }, repository: RegionalProvisioningRepository) => async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod !== 'POST') return reply(405, { error: 'method_not_allowed' });
    const creatorId = String(event.requestContext.authorizer?.claims?.sub || '');
    const body = JSON.parse(event.body || '{}'); const resource = event.resource;
    if (!identifiers.test(creatorId)) throw new Error('Invalid creator');
    if (resource.endsWith('/spaces')) {
      if (!identifiers.test(body.spaceId)) throw new Error('Invalid space');
      await repository.put({ PK: `SPACE#${body.spaceId}`, recordType: 'REGIONAL_SPACE', product: cell.product, environment: cell.environment, dataHomeRegion: cell.dataHomeRegion, creatorId, status: 'ACTIVE', dataHomeMigrationState: 'NONE', createdAt: new Date().toISOString() });
      return reply(201, { spaceId: body.spaceId, dataHomeRegion: cell.dataHomeRegion });
    }
    if (resource.endsWith('/assets')) {
      if (!identifiers.test(body.spaceId) || !identifiers.test(body.assetId)) throw new Error('Invalid asset');
      await repository.put({ PK: `ASSET#${body.assetId}`, recordType: 'REGIONAL_ASSET', product: cell.product, environment: cell.environment, dataHomeRegion: cell.dataHomeRegion, canonicalRegion: cell.dataHomeRegion, creatorId, spaceId: body.spaceId, publicDeliveryState: 'PRIVATE', scanState: 'QUEUED', remainingCreditUnits: Number(body.remainingCreditUnits || 0), requiredCreditUnits: Number(body.requiredCreditUnits || 0), createdAt: new Date().toISOString() });
      return reply(201, { assetId: body.assetId, spaceId: body.spaceId, dataHomeRegion: cell.dataHomeRegion });
    }
    return reply(404, { error: 'not_found' });
  } catch (error) { return reply(400, { error: 'provisioning_rejected' }); }
};

const region = process.env.DATA_HOME_REGION as ManagedRegion;
const table = process.env.METADATA_TABLE || '';
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const repository: RegionalProvisioningRepository = { put: async (item) => {
  await client.send(new PutCommand({ TableName: table, Item: item,
    ConditionExpression: 'attribute_not_exists(PK) OR (creatorId = :creator AND dataHomeRegion = :region AND #product = :product AND #environment = :environment AND (attribute_not_exists(spaceId) OR spaceId = :spaceId))',
    ExpressionAttributeNames: { '#product': 'product', '#environment': 'environment' },
    ExpressionAttributeValues: { ':creator': item.creatorId, ':region': region, ':product': item.product, ':environment': item.environment, ':spaceId': item.spaceId || '' }
  }));
} };
export const handler = createRegionalProvisioningHandler({ product: process.env.PRODUCT as ManagedProduct, environment: process.env.ENVIRONMENT || '', dataHomeRegion: region }, repository);
