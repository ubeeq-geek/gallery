import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from '../config';

type MediaRow = {
  PK: string;
  SK: string;
  entityType?: string;
  mediaId?: string;
  artistId?: string;
  assetType?: 'image' | 'video';
  previewKey?: string;
  premiumKey?: string;
  previewPosterKey?: string;
};

const getArgValue = (flagName: string): string | undefined => {
  const args = process.argv.slice(2);
  const equalsMatch = args.find((arg) => arg.startsWith(`${flagName}=`));
  if (equalsMatch) return equalsMatch.slice(flagName.length + 1);
  const idx = args.indexOf(flagName);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return undefined;
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

async function run(): Promise<void> {
  const config = loadConfig();
  const region = getArgValue('--region') || config.awsRegion;
  const tableName = getArgValue('--gallery-core-table') || config.galleryCoreTable;
  const queueUrl = getArgValue('--queue-url') || process.env.VIDEO_POSTER_INGEST_QUEUE_URL || '';
  const bucket = getArgValue('--bucket') || config.mediaBucket;
  const dryRun = process.argv.includes('--dry-run');
  const maxItems = Number(getArgValue('--max-items') || '0');

  if (!tableName) throw new Error('--gallery-core-table (or GALLERY_CORE_TABLE) is required');
  if (!queueUrl) throw new Error('--queue-url (or VIDEO_POSTER_INGEST_QUEUE_URL) is required');
  if (!bucket) throw new Error('--bucket (or MEDIA_BUCKET) is required');

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const sqs = new SQSClient({ region });

  let lastEvaluatedKey: Record<string, unknown> | undefined;
  const candidates: Array<{ mediaId: string; key: string; artistId: string }> = [];
  do {
    const response = await doc.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: 'PK, SK, entityType, mediaId, artistId, assetType, previewKey, premiumKey, previewPosterKey',
        FilterExpression: 'entityType = :entityType AND assetType = :assetType',
        ExpressionAttributeValues: {
          ':entityType': 'MEDIA_OBJECT',
          ':assetType': 'video'
        },
        ExclusiveStartKey: lastEvaluatedKey
      })
    );
    const rows = (response.Items || []) as MediaRow[];
    for (const row of rows) {
      if (row.previewPosterKey) continue;
      const sourceKey = row.previewKey || row.premiumKey;
      if (!sourceKey || !row.mediaId || !row.artistId) continue;
      candidates.push({ mediaId: row.mediaId, key: sourceKey, artistId: row.artistId });
      if (maxItems > 0 && candidates.length >= maxItems) break;
    }
    if (maxItems > 0 && candidates.length >= maxItems) break;
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  console.log(`[enqueue:video-posters] table=${tableName} region=${region} queue=${queueUrl}`);
  console.log(`[enqueue:video-posters] candidates=${candidates.length} dryRun=${dryRun}`);
  if (!candidates.length || dryRun) return;

  let sent = 0;
  for (const batch of chunk(candidates, 10)) {
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((item) => ({
          Id: item.mediaId.slice(0, 80),
          MessageBody: JSON.stringify({
            source: 'video-poster-backfill',
            bucket,
            key: item.key,
            mediaId: item.mediaId,
            artistId: item.artistId
          })
        }))
      })
    );
    sent += batch.length;
  }

  console.log(`[enqueue:video-posters] queued=${sent}`);
}

run().catch((error) => {
  console.error('[enqueue:video-posters] failed', error);
  process.exitCode = 1;
});
