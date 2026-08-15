import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { JoseKey, NodeOAuthClient } from '@atproto/oauth-client-node';
import { createHash, createPrivateKey, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

type ApiEvent = {
  path?: string;
  rawPath?: string;
  requestContext?: { http?: { path?: string } };
  rawQueryString?: string;
  queryStringParameters?: Record<string, string | undefined>;
};

type ApiResponse = {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
};

const tableName = process.env.BLUESKY_OAUTH_TABLE;
const clientId = process.env.BLUESKY_OAUTH_CLIENT_ID;
const callbackUrl = process.env.BLUESKY_OAUTH_CALLBACK_URL;
const clientUri = process.env.BLUESKY_OAUTH_CLIENT_URI;
const oauthBrand = process.env.BLUESKY_OAUTH_BRAND === 'ubeeq' ? 'ubeeq' : 'eversally';
const privateJwkJson = process.env.BLUESKY_OAUTH_PRIVATE_JWK;
/** The Studio origin that receives a short-lived, signed connection proof. */
const studioReturnUrl = process.env.BLUESKY_OAUTH_STUDIO_RETURN_URL;
// AT Protocol state/session payloads contain optional fields. DynamoDB's v3
// document client rejects undefined values unless they are explicitly removed.
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const stateHash = (value: string) => createHash('sha256').update(value).digest('base64url');

/** Serializes refreshes for one OAuth session across concurrent Lambda instances. */
const requestLock = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
  const config = required();
  if (!config) throw new Error('Bluesky OAuth service is not configured.');
  const lockToken = randomUUID();
  const key = { PK: `LOCK#${name}`, SK: 'LOCK' };
  let acquired = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const now = Math.floor(Date.now() / 1000);
    try {
      await documentClient.send(new PutCommand({
        TableName: config.tableName,
        Item: { ...key, lockToken, expiresAt: now + 90 },
        ConditionExpression: 'attribute_not_exists(PK) OR expiresAt < :now',
        ExpressionAttributeValues: { ':now': now }
      }));
      acquired = true;
      break;
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      await delay(Math.min(500, 50 * (attempt + 1)));
    }
  }
  if (!acquired) throw new Error('A Bluesky session refresh is already in progress. Please retry shortly.');
  try {
    return await fn();
  } finally {
    try {
      await documentClient.send(new DeleteCommand({
        TableName: config.tableName,
        Key: key,
        ConditionExpression: 'lockToken = :lockToken',
        ExpressionAttributeValues: { ':lockToken': lockToken }
      }));
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    }
  }
};

const json = (statusCode: number, value: unknown, cacheControl = 'no-store'): ApiResponse => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff'
  },
  body: JSON.stringify(value)
});

const html = (statusCode: number, title: string, message: string): ApiResponse => ({
  statusCode,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  },
  body: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="margin:0;background:#101819;color:#edf8f7;font:16px system-ui,sans-serif"><main style="max-width:620px;margin:12vh auto;padding:2rem"><p style="color:#69c8bf;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Bluesky connection</p><h1>${title}</h1><p style="color:#b9cbca;line-height:1.6">${message}</p></main></body></html>`
});

const required = (): { tableName: string; clientId: string; callbackUrl: string; clientUri: string; privateJwkJson: string } | undefined => {
  if (!tableName || !clientId || !callbackUrl || !clientUri || !privateJwkJson) return undefined;
  return { tableName, clientId, callbackUrl, clientUri, privateJwkJson };
};

let oauthClientPromise: Promise<NodeOAuthClient> | undefined;

const oauthClient = async (): Promise<NodeOAuthClient> => {
  if (oauthClientPromise) return oauthClientPromise;
  const config = required();
  if (!config) throw new Error('Bluesky OAuth service is not configured.');
  oauthClientPromise = (async () => {
    const signingKey = await JoseKey.fromJWK(JSON.parse(config.privateJwkJson));
    const stateStore = {
      get: async (key: string) => {
        const item = await documentClient.send(new GetCommand({
          TableName: config.tableName,
          Key: { PK: `STATE#${key}`, SK: 'STATE' }
        }));
        return item.Item?.value;
      },
      set: async (key: string, value: unknown) => {
        await documentClient.send(new PutCommand({
          TableName: config.tableName,
          Item: { PK: `STATE#${key}`, SK: 'STATE', value, expiresAt: Math.floor(Date.now() / 1000) + 3600 }
        }));
      },
      del: async (key: string) => {
        await documentClient.send(new DeleteCommand({
          TableName: config.tableName,
          Key: { PK: `STATE#${key}`, SK: 'STATE' }
        }));
      }
    } as any;
    const sessionStore = {
      get: async (sub: string) => {
        const item = await documentClient.send(new GetCommand({
          TableName: config.tableName,
          Key: { PK: `SESSION#${sub}`, SK: 'SESSION' }
        }));
        return item.Item?.value;
      },
      set: async (sub: string, value: unknown) => {
        await documentClient.send(new PutCommand({
          TableName: config.tableName,
          Item: { PK: `SESSION#${sub}`, SK: 'SESSION', value, updatedAt: new Date().toISOString() }
        }));
      },
      del: async (sub: string) => {
        await documentClient.send(new DeleteCommand({
          TableName: config.tableName,
          Key: { PK: `SESSION#${sub}`, SK: 'SESSION' }
        }));
      }
    } as any;
    return new NodeOAuthClient({
      clientMetadata: {
        client_id: config.clientId,
        client_name: oauthBrand === 'ubeeq' ? 'Ubeeq' : 'Eversally',
        client_uri: config.clientUri,
        redirect_uris: [config.callbackUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'web',
        scope: 'atproto transition:generic',
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_signing_alg: 'ES256',
        dpop_bound_access_tokens: true,
        jwks_uri: new URL('/oauth/bluesky/jwks.json', config.clientId).toString()
      },
      keyset: [signingKey],
      stateStore,
      sessionStore,
      requestLock
    });
  })();
  return oauthClientPromise;
};

const pathFor = (event: ApiEvent): string => event.path || event.rawPath || event.requestContext?.http?.path || '';
const queryFor = (event: ApiEvent): URLSearchParams => new URLSearchParams(event.rawQueryString || new URLSearchParams(event.queryStringParameters).toString());

const connectionReturn = (state: string, proof: string): ApiResponse | undefined => {
  if (!studioReturnUrl) return undefined;
  const url = new URL(studioReturnUrl);
  // This is configured infrastructure, not a browser-supplied return URL.
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('The Bluesky Studio return URL must use HTTPS.');
  }
  url.searchParams.set('bluesky', 'connected');
  url.searchParams.set('state', state);
  url.searchParams.set('proof', proof);
  return { statusCode: 302, headers: { location: url.toString(), 'cache-control': 'no-store' }, body: '' };
};

export const handler = async (event: ApiEvent): Promise<ApiResponse> => {
  const path = pathFor(event);
  if (path.endsWith('/health')) return json(200, { ok: true, service: 'bluesky-oauth' });
  if (!required()) return json(503, { message: 'Bluesky OAuth is not configured for this deployment.' });
  try {
    const client = await oauthClient();
    if (path.endsWith('/oauth/bluesky')) {
      return html(200, `${oauthBrand === 'ubeeq' ? 'Ubeeq' : 'Eversally'} Bluesky connection`, 'This secure OAuth client connects a creator-managed Bluesky account.');
    }
    if (path.endsWith('/oauth/bluesky/client-metadata.json')) {
      return json(200, client.clientMetadata, 'public, max-age=300');
    }
    if (path.endsWith('/oauth/bluesky/jwks.json')) {
      return json(200, client.jwks, 'public, max-age=300');
    }
    if (path.endsWith('/oauth/bluesky/authorize')) {
      const handle = queryFor(event).get('handle')?.trim().toLowerCase();
      const state = queryFor(event).get('state')?.trim() || undefined;
      if (!handle || !/^[a-z0-9][a-z0-9.-]{1,252}[a-z0-9]$/i.test(handle)) {
        return json(400, { message: 'A valid Bluesky handle is required.' });
      }
      if (state) {
        await documentClient.send(new PutCommand({
          TableName: required()!.tableName,
          Item: {
            PK: `CONNECTION#${stateHash(state)}`,
            SK: 'CONNECTION',
            handle,
            expiresAt: Math.floor(Date.now() / 1000) + 600
          }
        }));
      }
      const authorizeUrl = await client.authorize(handle, state ? { state } : undefined);
      return { statusCode: 302, headers: { location: authorizeUrl.toString(), 'cache-control': 'no-store' }, body: '' };
    }
    if (path.endsWith('/oauth/bluesky/callback')) {
      const { session, state } = await client.callback(queryFor(event));
      console.info(JSON.stringify({ event: 'bluesky_oauth_connected', did: session.did }));
      if (state) {
        const stateDigest = stateHash(state);
        const connection = await documentClient.send(new GetCommand({
          TableName: required()!.tableName,
          Key: { PK: `CONNECTION#${stateDigest}`, SK: 'CONNECTION' }
        }));
        const handle = typeof connection.Item?.handle === 'string' ? connection.Item.handle : undefined;
        const signingKey = createPrivateKey({ key: JSON.parse(required()!.privateJwkJson), format: 'jwk' });
        const proof = jwt.sign({
          purpose: 'bluesky_studio_connection',
          stateHash: stateDigest,
          did: session.did,
          ...(handle ? { handle } : {})
        }, signingKey, {
          algorithm: 'ES256',
          issuer: required()!.clientId,
          audience: 'ubeeq-studio',
          expiresIn: '10m'
        });
        await documentClient.send(new DeleteCommand({
          TableName: required()!.tableName,
          Key: { PK: `CONNECTION#${stateDigest}`, SK: 'CONNECTION' }
        }));
        const response = connectionReturn(state, proof);
        if (response) return response;
      }
      return html(200, 'Bluesky connected', `Your Bluesky account (${session.did}) is connected. You can close this window.`);
    }
    return json(404, { message: 'Not found.' });
  } catch (error) {
    console.error(JSON.stringify({ event: 'bluesky_oauth_error', path, message: error instanceof Error ? error.message : 'Unknown error' }));
    return path.endsWith('/callback')
      ? html(400, 'Bluesky connection could not be completed', 'Please return to the application and try connecting again.')
      : json(400, { message: 'Bluesky OAuth request could not be completed.' });
  }
};
