import { DescribeTableCommand, DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteObjectsCommand, HeadBucketCommand, ListBucketsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { BatchWriteCommand, DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from '../config';

const getArgValue = (flagName: string): string | undefined => {
  const args = process.argv.slice(2);
  const equalsMatch = args.find((arg) => arg.startsWith(`${flagName}=`));
  if (equalsMatch) return equalsMatch.slice(flagName.length + 1);

  const idx = args.indexOf(flagName);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];

  return undefined;
};

const resolveTableName = (envValue: string, flagName: string): string => getArgValue(flagName) || envValue;

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

  const found: string[] = [];
  let startTableName: string | undefined;
  do {
    const response = await client.send(new ListTablesCommand({ ExclusiveStartTableName: startTableName }));
    for (const name of response.TableNames || []) {
      if (name.includes(marker)) found.push(name);
    }
    startTableName = response.LastEvaluatedTableName;
  } while (startTableName);

  if (found.length === 0) {
    throw new Error(`Could not discover DynamoDB table containing marker: ${marker}`);
  }

  const prioritized = found.sort((a, b) => {
    const aScore = a.startsWith('GalleryStack-') ? 0 : 1;
    const bScore = b.startsWith('GalleryStack-') ? 0 : 1;
    if (aScore !== bScore) return aScore - bScore;
    return a.localeCompare(b);
  });

  return prioritized[0];
};

const bucketExists = async (s3: S3Client, bucket: string): Promise<boolean> => {
  if (!bucket) return false;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
};

const discoverMediaBucket = async (s3: S3Client, preferred: string): Promise<string> => {
  if (await bucketExists(s3, preferred)) return preferred;
  const buckets = (await s3.send(new ListBucketsCommand({}))).Buckets?.map((b) => b.Name || '').filter(Boolean) || [];
  const candidates = buckets.filter((name) => name.includes('mediabucket'));
  if (candidates.length === 0) {
    throw new Error('Could not discover media bucket (expected name containing "mediabucket")');
  }
  const prioritized = candidates.sort((a, b) => {
    const aScore = a.startsWith('gallerystack-') ? 0 : 1;
    const bScore = b.startsWith('gallerystack-') ? 0 : 1;
    if (aScore !== bScore) return aScore - bScore;
    return a.localeCompare(b);
  });
  return prioritized[0];
};

const wipeTable = async (client: DynamoDBDocumentClient, tableName: string, keyFields: string[]): Promise<number> => {
  let deleted = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const projection = keyFields.join(', ');

  do {
    const page = await client.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: projection,
        ExclusiveStartKey: exclusiveStartKey
      })
    );

    const items = page.Items || [];
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      await client.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: chunk.map((item) => {
              const key: Record<string, unknown> = {};
              for (const field of keyFields) {
                key[field] = item[field];
              }
              return { DeleteRequest: { Key: key } };
            })
          }
        })
      );
      deleted += chunk.length;
    }

    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return deleted;
};

const wipeBucketPrefixes = async (s3: S3Client, bucket: string, prefixes: string[]): Promise<number> => {
  let deleted = 0;
  for (const prefix of prefixes) {
    let continuationToken: string | undefined;
    do {
      const list = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        })
      );

      const objects = (list.Contents || []).map((item) => item.Key).filter((key): key is string => Boolean(key));
      if (objects.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: objects.map((key) => ({ Key: key })),
              Quiet: true
            }
          })
        );
        deleted += objects.length;
      }

      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  return deleted;
};

const main = async () => {
  const regionArg = getArgValue('--region');
  const profileArg = getArgValue('--profile');
  if (regionArg) process.env.AWS_REGION = regionArg;
  if (profileArg) process.env.AWS_PROFILE = profileArg;

  const config = loadConfig();
  const dryRun = process.argv.includes('--dry-run');
  const preserveMedia = process.argv.includes('--preserve-media');
  const galleryCoreTableRequested = resolveTableName(config.galleryCoreTable, '--gallery-core-table');
  const siteSettingsTableRequested = resolveTableName(config.siteSettingsTable, '--site-settings-table');

  const lowLevel = new DynamoDBClient({ region: config.awsRegion });
  const s3 = new S3Client({ region: config.awsRegion });
  const galleryCoreTable = await discoverTableName(lowLevel, galleryCoreTableRequested, 'GalleryCoreTable');
  const siteSettingsTable = await discoverTableName(lowLevel, siteSettingsTableRequested, 'SiteSettingsTable');
  const mediaBucket = await discoverMediaBucket(s3, config.mediaBucket);

  console.log(
    `[reset:core] galleryCoreTable=${galleryCoreTable} siteSettingsTable=${siteSettingsTable} bucket=${mediaBucket} region=${config.awsRegion} dryRun=${dryRun} preserveMedia=${preserveMedia}`
  );

  if (dryRun) {
    return;
  }

  const client = DynamoDBDocumentClient.from(lowLevel);
  const deletedCore = await wipeTable(client, galleryCoreTable, ['PK', 'SK']);
  const deletedSettings = await wipeTable(client, siteSettingsTable, ['settingId']);
  const deletedObjects = preserveMedia ? 0 : await wipeBucketPrefixes(s3, mediaBucket, ['']);

  console.log(`[reset:core] deleted coreItems=${deletedCore} siteSettingsItems=${deletedSettings} s3Objects=${deletedObjects}`);
  if (preserveMedia) {
    console.log('[reset:core] skipped S3 object deletion due to --preserve-media');
  }
  console.log('[reset:core] complete');
};

main().catch((error) => {
  console.error('[reset:core] failed', error);
  process.exitCode = 1;
});
