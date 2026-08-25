import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { assignDataHome, dynamoGlobalRoutingRepository, type GlobalRoutingRepository, type RegionalEndpointDirectory } from './globalRouting';
import { MANAGED_DATA_HOMES, type DataHomeLabel, type ManagedProduct } from './regionalMedia';

const subject = (event: APIGatewayProxyEvent): string => String(event.requestContext.authorizer?.claims?.sub || '').trim();
const response = (statusCode: number, body: unknown): APIGatewayProxyResult => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });

export const createGlobalRoutingHandler = (repository: GlobalRoutingRepository, endpoints: RegionalEndpointDirectory) => async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const identity = subject(event); const product = event.pathParameters?.product as ManagedProduct;
    if (!identity || !['eversally', 'nightframe'].includes(product)) return response(400, { error: 'invalid_request' });
    let entry = await repository.get(identity, product);
    if (event.httpMethod === 'POST') {
      const label = JSON.parse(event.body || '{}').dataHomeLabel as DataHomeLabel;
      entry = await assignDataHome({ subject: identity, product, label }, repository);
    } else if (event.httpMethod !== 'GET') return response(405, { error: 'method_not_allowed' });
    if (!entry) return response(404, { error: 'data_home_not_assigned' });
    return response(200, { opaqueSpaceId: entry.opaqueSpaceId, product: entry.product, homeRegion: entry.homeRegion, status: entry.status, regionalApiUrl: endpoints.endpoint(product, entry.homeRegion) });
  } catch (error) {
    const conflict = error instanceof Error && error.message.includes('already assigned');
    return response(conflict ? 409 : 400, { error: conflict ? 'migration_required' : 'invalid_request' });
  }
};

const region = process.env.AWS_REGION || 'us-east-1';
const repository = dynamoGlobalRoutingRepository(DynamoDBDocumentClient.from(new DynamoDBClient({ region })), process.env.ROUTING_TABLE || '');
const endpointMap = JSON.parse(process.env.REGIONAL_ENDPOINTS_JSON || '{}') as Record<string, string>;
export const handler = createGlobalRoutingHandler(repository, { endpoint: (product, homeRegion) => {
  const endpoint = endpointMap[`${product}:${homeRegion}`];
  if (!endpoint || !Object.values(MANAGED_DATA_HOMES).includes(homeRegion)) throw new Error('Regional endpoint is unavailable');
  return endpoint;
} });
