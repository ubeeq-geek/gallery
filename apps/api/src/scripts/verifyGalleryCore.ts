import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from '../config';

const getArgValue = (flagName: string): string | undefined => {
  const args = process.argv.slice(2);
  const equalsMatch = args.find((arg) => arg.startsWith(`${flagName}=`));
  if (equalsMatch) {
    return equalsMatch.slice(flagName.length + 1);
  }

  const idx = args.indexOf(flagName);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }

  return undefined;
};

const resolveTableName = (envValue: string, flagName: string): string => getArgValue(flagName) || envValue;

const scanAll = async (client: DynamoDBDocumentClient, tableName: string): Promise<Record<string, unknown>[]> => {
  const items: Record<string, unknown>[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await client.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastEvaluatedKey
      })
    );

    if (response.Items) {
      items.push(...(response.Items as Record<string, unknown>[]));
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return items;
};

const countBy = (items: Record<string, unknown>[], predicate: (item: Record<string, unknown>) => boolean): number =>
  items.reduce((acc, item) => acc + (predicate(item) ? 1 : 0), 0);

const main = async () => {
  const regionArg = getArgValue('--region');
  const profileArg = getArgValue('--profile');
  if (regionArg) process.env.AWS_REGION = regionArg;
  if (profileArg) process.env.AWS_PROFILE = profileArg;

  const config = loadConfig();
  const creators = resolveTableName(config.creators, '--creators-table');
  const groupingsTable = resolveTableName(config.groupingsTable, '--groupings-table');
  const imagesTable = resolveTableName(config.imagesTable, '--images-table');
  const groupingCoreTable = resolveTableName(config.contentCoreTable, '--content-core-table');

  const lowLevel = new DynamoDBClient({ region: config.awsRegion });
  const client = DynamoDBDocumentClient.from(lowLevel);

  const requiredTables = [creators, groupingsTable, imagesTable, groupingCoreTable];
  for (const tableName of requiredTables) {
    try {
      await lowLevel.send(new DescribeTableCommand({ TableName: tableName }));
    } catch (error) {
      console.error(`[verify:core] missing table: ${tableName}`);
      console.error('[verify:core] pass explicit names with --creators-table/--groupings-table/--images-table/--content-core-table');
      throw error;
    }
  }

  const [legacyArtists, legacyGalleries, legacyMedia, coreItems] = await Promise.all([
    scanAll(client, creators),
    scanAll(client, groupingsTable),
    scanAll(client, imagesTable),
    scanAll(client, groupingCoreTable)
  ]);

  const legacyCounts = {
    creators: legacyArtists.filter((item) => typeof item.creatorId === 'string').length,
    groupings: legacyGalleries.filter((item) => typeof item.groupingId === 'string').length,
    media: legacyMedia.filter((item) => typeof item.imageId === 'string').length
  };

  const coreCounts = {
    creators: countBy(coreItems, (item) => item.entityType === 'CREATOR'),
    groupings: countBy(coreItems, (item) => item.entityType === 'GROUPING'),
    media: countBy(coreItems, (item) => item.entityType === 'GROUPING_MEDIA')
  };

  const mismatches: string[] = [];
  if (legacyCounts.creators !== coreCounts.creators) mismatches.push('creators');
  if (legacyCounts.groupings !== coreCounts.groupings) mismatches.push('groupings');
  if (legacyCounts.media !== coreCounts.media) mismatches.push('media');

  console.log('[verify:core] Legacy counts:', legacyCounts);
  console.log('[verify:core] Core counts:  ', coreCounts);

  if (mismatches.length > 0) {
    console.error(`[verify:core] mismatch detected in: ${mismatches.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log('[verify:core] counts match, migration looks consistent');
};

main().catch((error) => {
  console.error('[verify:core] failed', error);
  process.exitCode = 1;
});
