import { DescribeTableCommand, DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { loadConfig } from './config';
import { DynamoStore } from './dynamoStore';
import { refreshTrendingFeeds } from './trendingFeed';

export const handler = async () => {
  const config = loadConfig();
  const store = new DynamoStore(config);
  const startedAt = Date.now();
  const stats = await refreshTrendingFeeds(store, config, Date.now());
  const durationMs = Date.now() - startedAt;
  const payload = {
    ok: true,
    durationMs,
    stats
  };
  console.info(`[trending-ranker] ${JSON.stringify(payload)}`);
  return payload;
};

const getArgValue = (flagName: string): string | undefined => {
  const args = process.argv.slice(2);
  const index = args.findIndex((arg) => arg === flagName);
  if (index === -1) return undefined;
  return args[index + 1];
};

const tableExists = async (client: DynamoDBClient, tableName: string): Promise<boolean> => {
  if (!tableName) return false;
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch {
    return false;
  }
};

const discoverTableName = async (client: DynamoDBClient, preferred: string, marker: string): Promise<string> => {
  if (await tableExists(client, preferred)) return preferred;

  let lastEvaluatedTableName: string | undefined;
  const matches: string[] = [];
  do {
    const response = await client.send(
      new ListTablesCommand({
        ExclusiveStartTableName: lastEvaluatedTableName,
        Limit: 100
      })
    );
    for (const tableName of response.TableNames || []) {
      if (tableName.includes(marker)) matches.push(tableName);
    }
    lastEvaluatedTableName = response.LastEvaluatedTableName;
  } while (lastEvaluatedTableName);

  if (matches.length === 0) {
    throw new Error(`Could not discover DynamoDB table containing marker: ${marker}`);
  }

  return matches.sort((a, b) => {
    const aScore = a.startsWith('GalleryStack-') ? 0 : 1;
    const bScore = b.startsWith('GalleryStack-') ? 0 : 1;
    if (aScore !== bScore) return aScore - bScore;
    return a.localeCompare(b);
  })[0];
};

const prepareCliConfig = async (): Promise<void> => {
  const regionArg = getArgValue('--region');
  const profileArg = getArgValue('--profile');
  if (regionArg) process.env.AWS_REGION = regionArg;
  if (profileArg) process.env.AWS_PROFILE = profileArg;

  const region = process.env.AWS_REGION || 'ca-central-1';
  const lowLevel = new DynamoDBClient({ region });

  const galleryCoreTable = getArgValue('--gallery-core-table')
    || process.env.GALLERY_CORE_TABLE
    || 'gallery-core';
  const imageStatsTable = getArgValue('--image-stats-table')
    || process.env.IMAGE_STATS_TABLE
    || 'image-stats';
  const trendingFeedTable = getArgValue('--trending-feed-table')
    || process.env.TRENDING_FEED_TABLE
    || 'trending-feed';

  process.env.GALLERY_CORE_TABLE = await discoverTableName(lowLevel, galleryCoreTable, 'GalleryCoreTable');
  process.env.IMAGE_STATS_TABLE = await discoverTableName(lowLevel, imageStatsTable, 'ImageStatsTable');
  process.env.TRENDING_FEED_TABLE = await discoverTableName(lowLevel, trendingFeedTable, 'TrendingFeedTable');
  process.env.USE_GALLERY_CORE_TABLE = 'true';

  console.log(
    `[trending-ranker] resolved tables: core=${process.env.GALLERY_CORE_TABLE} imageStats=${process.env.IMAGE_STATS_TABLE} trendingFeed=${process.env.TRENDING_FEED_TABLE} region=${region}`
  );
};

if (require.main === module) {
  prepareCliConfig()
    .then(() => handler())
    .then((payload) => {
      console.log(JSON.stringify(payload, null, 2));
    })
    .catch((error) => {
      console.error('[trending-ranker] failed', error);
      process.exit(1);
    });
}
