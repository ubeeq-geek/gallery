import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createOptionalAuthMiddleware, requireAdmin } from './auth';
import { DAILY_COSMOS_TOPICS } from './dailyCosmosTopics';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SOURCES_TABLE = process.env.SYNDICATION_SOURCES_TABLE || '';
const USED_ASSETS_TABLE = process.env.SYNDICATION_USED_ASSETS_TABLE || '';
const GALLERY_CORE_TABLE = process.env.GALLERY_CORE_TABLE || '';
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID || '';
const COGNITO_TOKEN_USE = (process.env.COGNITO_TOKEN_USE || 'id') as 'id' | 'access';
const OPENVERSE_API_BASE_URL = 'https://api.openverse.org/v1/images/';
const OPENVERSE_TOKEN_URL = 'https://api.openverse.org/v1/auth_tokens/token/';

interface SyndicationSource {
  sourceId: string;
  provider: 'openverse';
  name: string;
  creatorUuid: string;
  creatorSlug: string;
  clientId: string;
  clientSecret: string;
  createdAt: string;
  updatedAt: string;
  openverseTokenValidatedAt?: string;
  openverseApiBaseUrl?: string;
  openverseTokenUrl?: string;
}

interface OpenverseResult {
  id: string;
  title?: string;
  url?: string;
  thumbnail?: string;
  creator?: string;
  source?: string;
}

const slugify = (value: string): string =>
  value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'item';

const getDateRangeForUpcomingWeek = (from: Date) => {
  const base = new Date(from);
  const day = base.getUTCDay();
  const daysToMonday = ((8 - day) % 7) || 7;
  const monday = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + daysToMonday));
  const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6));
  return { monday, sunday };
};

const getTopicPlanForDate = (isoDate: string): [string, string, string] => {
  const found = DAILY_COSMOS_TOPICS.find((item) => item.date === isoDate);
  if (found) return found.topics;
  return ['deep space nasa', 'stellar objects nasa', 'space stars universe'];
};

interface OpenverseTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

const getOpenverseAccessToken = async (clientId: string, clientSecret: string): Promise<string> => {
  const basicToken = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  const payload = new URLSearchParams();
  payload.set('grant_type', 'client_credentials');
  payload.set('client_id', clientId);
  payload.set('client_secret', clientSecret);

  const response = await fetch(OPENVERSE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basicToken}`
    },
    body: payload.toString()
  });

  if (!response.ok) {
    throw new Error(`Openverse token request failed with status ${response.status}`);
  }

  const parsed = await response.json() as OpenverseTokenResponse;
  if (!parsed.access_token) {
    throw new Error('Openverse token response missing access_token');
  }
  return parsed.access_token;
};

const searchOpenverse = async (query: string, accessToken: string): Promise<OpenverseResult[]> => {
  const url = new URL(OPENVERSE_API_BASE_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('source', 'nasa');
  url.searchParams.set('page_size', '25');

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`Openverse request failed with status ${response.status}`);
  }

  const payload = await response.json() as { results?: OpenverseResult[] };
  return Array.isArray(payload.results) ? payload.results : [];
};

const reserveAssetId = async (assetId: string): Promise<boolean> => {
  try {
    await ddb.send(new PutCommand({
      TableName: USED_ASSETS_TABLE,
      Item: {
        source: 'openverse',
        id: assetId,
        insertedAt: new Date().toISOString()
      },
      ConditionExpression: 'attribute_not_exists(#source) AND attribute_not_exists(#id)',
      ExpressionAttributeNames: {
        '#source': 'source',
        '#id': 'id'
      }
    }));
    return true;
  } catch {
    return false;
  }
};

const createScheduledPost = async (params: {
  creatorUuid: string;
  day: string;
  media: OpenverseResult[];
  topic: string;
}) => {
  const now = new Date().toISOString();
  const publishAt = `${params.day}T08:00:00.000Z`;
  const postId = randomUUID();
  await ddb.send(new PutCommand({
    TableName: GALLERY_CORE_TABLE,
    Item: {
      PK: `POST#${postId}`,
      SK: 'META',
      entityType: 'POST',
      postId,
      artistId: params.creatorUuid,
      creatorId: params.creatorUuid,
      title: 'Your Daily Cosmos',
      slug: slugify(`daily-cosmos-${params.day}`),
      status: 'published',
      blocks: [
        {
          blockId: 'intro',
          type: 'paragraph',
          text: 'Your Daily Cosmos'
        },
        {
          blockId: 'gallery',
          type: 'gallery',
          payload: {
            provider: 'openverse',
            topic: params.topic,
            items: params.media.map((item) => ({
              id: item.id,
              title: item.title,
              imageUrl: item.url,
              thumbnail: item.thumbnail,
              creator: item.creator,
              source: item.source || 'nasa'
            }))
          }
        }
      ],
      media: [],
      discovery: { mode: 'primary' },
      metadata: {
        syndicationProvider: 'openverse',
        syndicationTopic: params.topic,
        syndicationDate: params.day
      },
      createdAt: now,
      updatedAt: now,
      publishedAt: publishAt,
      GSI2PK: `ARTIST#${params.creatorUuid}`,
      GSI2SK: `POST#${now}#${postId}`
    }
  }));
};

export const syncSourceForUpcomingWeek = async (source: SyndicationSource) => {
  const { monday } = getDateRangeForUpcomingWeek(new Date());
  const summary: Array<{ day: string; topic: string; imageCount: number; created: boolean }> = [];
  const accessToken = await getOpenverseAccessToken(source.clientId, source.clientSecret);

  for (let i = 0; i < 7; i += 1) {
    const dayDate = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + i));
    const day = dayDate.toISOString().slice(0, 10);
    const topics = getTopicPlanForDate(day);

    let selectedTopic = topics[2];
    let selected: OpenverseResult[] = [];

    for (const topic of topics) {
      const results = await searchOpenverse(topic, accessToken);
      const unique: OpenverseResult[] = [];
      for (const result of results) {
        if (!result.id) continue;
        const isReserved = await reserveAssetId(result.id);
        if (!isReserved) continue;
        unique.push(result);
        if (unique.length === 5) break;
      }
      if (unique.length >= 5) {
        selectedTopic = topic;
        selected = unique;
        break;
      }
    }

    if (selected.length < 5) {
      summary.push({ day, topic: selectedTopic, imageCount: selected.length, created: false });
      continue;
    }

    await createScheduledPost({
      creatorUuid: source.creatorUuid,
      day,
      media: selected,
      topic: selectedTopic
    });
    summary.push({ day, topic: selectedTopic, imageCount: selected.length, created: true });
  }

  return summary;
};

export const runWeeklySyncAll = async () => {
  const response = await ddb.send(new ScanCommand({ TableName: SOURCES_TABLE }));
  const sources = (response.Items || []) as SyndicationSource[];
  const result = [] as Array<{ sourceId: string; summary: Awaited<ReturnType<typeof syncSourceForUpcomingWeek>> }>;
  for (const source of sources) {
    const summary = await syncSourceForUpcomingWeek(source);
    result.push({ sourceId: source.sourceId, summary });
  }
  return { count: result.length, result };
};

export const createApp = () => {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(createOptionalAuthMiddleware({ userPoolId: COGNITO_USER_POOL_ID, clientId: COGNITO_CLIENT_ID, tokenUse: COGNITO_TOKEN_USE }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(requireAdmin);

  app.get('/sources', async (_req, res) => {
    const response = await ddb.send(new ScanCommand({ TableName: SOURCES_TABLE }));
    const items = (response.Items || []) as SyndicationSource[];
    items.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ items });
  });

  app.post('/sources', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const creatorUuid = String(req.body?.creatorUuid || '').trim();
    const creatorSlug = String(req.body?.creatorSlug || '').trim();
    const clientId = String(req.body?.clientId || '').trim();
    const clientSecret = String(req.body?.clientSecret || '').trim();
    const endpointUrl = String(req.body?.endpointUrl || OPENVERSE_API_BASE_URL).trim();
    const tokenUrl = String(req.body?.tokenUrl || OPENVERSE_TOKEN_URL).trim();
    const sourceType = String(req.body?.sourceType || 'openverse_api').trim();

    if (!name || !creatorUuid || !creatorSlug || !clientId || !clientSecret) {
      return res.status(400).json({ message: 'name, creatorUuid, creatorSlug, clientId, and clientSecret are required' });
    }
    if (sourceType !== 'openverse_api') {
      return res.status(400).json({ message: 'Only Openverse API sources are supported in this phase' });
    }
    if (endpointUrl !== OPENVERSE_API_BASE_URL || tokenUrl !== OPENVERSE_TOKEN_URL) {
      return res.status(400).json({ message: 'endpointUrl/tokenUrl must point to Openverse official API endpoints' });
    }

    const openverseAccessToken = await getOpenverseAccessToken(clientId, clientSecret);
    const tokenValidationProbe = await searchOpenverse('stellar objects nasa', openverseAccessToken);
    if (!Array.isArray(tokenValidationProbe)) {
      return res.status(400).json({ message: 'Openverse registration validation failed' });
    }

    const now = new Date().toISOString();
    const item: SyndicationSource = {
      sourceId: randomUUID(),
      provider: 'openverse',
      name,
      creatorUuid,
      creatorSlug,
      clientId,
      clientSecret,
      createdAt: now,
      updatedAt: now,
      openverseTokenValidatedAt: now,
      openverseApiBaseUrl: OPENVERSE_API_BASE_URL,
      openverseTokenUrl: OPENVERSE_TOKEN_URL
    };

    await ddb.send(new PutCommand({ TableName: SOURCES_TABLE, Item: item }));
    return res.status(201).json(item);
  });

  app.post('/sources/:sourceId/run', async (req, res) => {
    const sourceId = String(req.params.sourceId || '').trim();
    if (!sourceId) return res.status(400).json({ message: 'sourceId required' });

    const row = await ddb.send(new QueryCommand({
      TableName: SOURCES_TABLE,
      KeyConditionExpression: 'sourceId = :sourceId',
      ExpressionAttributeValues: { ':sourceId': sourceId },
      Limit: 1
    }));

    const source = row.Items?.[0] as SyndicationSource | undefined;
    if (!source) return res.status(404).json({ message: 'Source not found' });

    const summary = await syncSourceForUpcomingWeek(source);
    return res.json({ sourceId, summary });
  });

  app.post('/sync/weekly', async (_req, res) => {
    return res.json(await runWeeklySyncAll());
  });

  return app;
};
