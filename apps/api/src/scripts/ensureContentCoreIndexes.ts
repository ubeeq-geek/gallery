import { DescribeTableCommand, DynamoDBClient, UpdateTableCommand } from '@aws-sdk/client-dynamodb';

const parseArgs = (argv: string[]): Record<string, string | boolean> => {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      result[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const requireString = (value: string | boolean | undefined, message: string): string => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(message);
};

const waitForTableActive = async (client: DynamoDBClient, tableName: string): Promise<void> => {
  const deadline = Date.now() + (15 * 60 * 1000);
  while (Date.now() < deadline) {
    const description = await client.send(new DescribeTableCommand({ TableName: tableName }));
    const tableStatus = description.Table?.TableStatus;
    const updatingIndex = (description.Table?.GlobalSecondaryIndexes || []).find((index) => index.IndexStatus !== 'ACTIVE');
    if (tableStatus === 'ACTIVE' && !updatingIndex) return;
    await sleep(5000);
  }
  throw new Error(`Timed out waiting for ${tableName} and indexes to become ACTIVE.`);
};

const ensureIndex = async (client: DynamoDBClient, tableName: string, indexName: 'GSI1' | 'GSI2', dryRun: boolean): Promise<void> => {
  const description = await client.send(new DescribeTableCommand({ TableName: tableName }));
  const existing = new Set((description.Table?.GlobalSecondaryIndexes || []).map((index) => index.IndexName || ''));
  if (existing.has(indexName)) {
    console.info(`[ensure:content-core-indexes] ${indexName} already exists on ${tableName}`);
    return;
  }

  const keySchema = indexName === 'GSI1'
    ? [{ AttributeName: 'GSI1PK', KeyType: 'HASH' as const }, { AttributeName: 'GSI1SK', KeyType: 'RANGE' as const }]
    : [{ AttributeName: 'GSI2PK', KeyType: 'HASH' as const }, { AttributeName: 'GSI2SK', KeyType: 'RANGE' as const }];
  const attributes = indexName === 'GSI1'
    ? [{ AttributeName: 'GSI1PK', AttributeType: 'S' as const }, { AttributeName: 'GSI1SK', AttributeType: 'S' as const }]
    : [{ AttributeName: 'GSI2PK', AttributeType: 'S' as const }, { AttributeName: 'GSI2SK', AttributeType: 'S' as const }];

  if (dryRun) {
    console.info(`[ensure:content-core-indexes] would create ${indexName} on ${tableName}`);
    return;
  }

  console.info(`[ensure:content-core-indexes] creating ${indexName} on ${tableName}`);
  await client.send(new UpdateTableCommand({
    TableName: tableName,
    AttributeDefinitions: attributes,
    GlobalSecondaryIndexUpdates: [{
      Create: {
        IndexName: indexName,
        KeySchema: keySchema,
        Projection: { ProjectionType: 'ALL' }
      }
    }]
  }));
  await waitForTableActive(client, tableName);
  console.info(`[ensure:content-core-indexes] ${indexName} is now ACTIVE on ${tableName}`);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const tableName = requireString(
    (args['content-core-table'] as string | undefined) || process.env.CONTENT_CORE_TABLE,
    '--content-core-table (or CONTENT_CORE_TABLE) is required'
  );
  const region = (args.region as string | undefined) || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ca-central-1';
  const dryRun = Boolean(args['dry-run']);

  const client = new DynamoDBClient({ region });
  await ensureIndex(client, tableName, 'GSI1', dryRun);
  await ensureIndex(client, tableName, 'GSI2', dryRun);
};

main().catch((error) => {
  console.error('[ensure:content-core-indexes] failed', error);
  process.exitCode = 1;
});
