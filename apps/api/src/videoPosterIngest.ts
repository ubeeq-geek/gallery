import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Media } from './domain';
import type { SQSBatchResponse, SQSHandler, SQSRecord } from 'aws-lambda';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const region = process.env.AWS_REGION || 'ca-central-1';
const tableName = process.env.GALLERY_CORE_TABLE || '';
const defaultBucket = process.env.MEDIA_BUCKET || '';
const posterPrefix = process.env.VIDEO_POSTER_OUTPUT_PREFIX || 'posters';
const ffmpegPath = process.env.VIDEO_POSTER_FFMPEG_PATH || '/opt/bin/ffmpeg';
const captureAtSeconds = Number(process.env.VIDEO_POSTER_CAPTURE_AT_SECONDS || '1');

const s3 = new S3Client({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

type S3KeyJob = { bucket: string; key: string };
type MediaRecord = Media & { PK: string; SK: string; entityType?: string };

const normalizeKey = (value: string): string => decodeURIComponent(value.replace(/\+/g, ' '));
const mediaIdFromKey = (key: string): string | undefined => {
  const parts = key.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  const raw = parts[1];
  return raw.replace(/\.[a-z0-9]+$/i, '');
};
const artistIdFromKey = (key: string): string | undefined => {
  const parts = key.split('/').filter(Boolean);
  return parts[0];
};
const isGeneratedAssetKey = (key: string): boolean => key.includes('/renditions/') || key.includes('/posters/');

const readS3Buffer = async (bucket: string, key: string): Promise<Buffer> => {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) {
    throw new Error(`Missing S3 object body for s3://${bucket}/${key}`);
  }
  const bytes = await response.Body.transformToByteArray();
  return Buffer.from(bytes);
};

const generatePoster = async (videoBuffer: Buffer): Promise<Buffer> => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'video-poster-'));
  const inputFile = path.join(runDir, 'input-video');
  const outputFile = path.join(runDir, 'poster.jpg');

  try {
    await writeFile(inputFile, videoBuffer);
    await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(captureAtSeconds),
      '-i',
      inputFile,
      '-frames:v',
      '1',
      '-vf',
      "scale='min(1280,iw)':-2",
      outputFile
    ]);
    return await readFile(outputFile);
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

const getMediaById = async (mediaId: string): Promise<MediaRecord | null> => {
  const response = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        PK: `MEDIA#${mediaId}`,
        SK: 'PROFILE'
      }
    })
  );
  if (!response.Item) return null;
  if (response.Item.entityType !== 'MEDIA_OBJECT') return null;
  return response.Item as MediaRecord;
};

const queryArtistMediaBySourceKey = async (artistId: string, sourceKey: string): Promise<MediaRecord | null> => {
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :artistPk AND begins_with(GSI2SK, :mediaPrefix)',
        ExpressionAttributeValues: {
          ':artistPk': `ARTIST#${artistId}`,
          ':mediaPrefix': 'MEDIA#'
        },
        ExclusiveStartKey: lastEvaluatedKey
      })
    );
    const match = (response.Items || []).find((item) => {
      if (item.entityType !== 'MEDIA_OBJECT') return false;
      if ((item.assetType || 'image') !== 'video') return false;
      return item.previewKey === sourceKey || item.premiumKey === sourceKey;
    });
    if (match) return match as MediaRecord;
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return null;
};

const resolveMediaForKey = async (sourceKey: string): Promise<MediaRecord | null> => {
  if (isGeneratedAssetKey(sourceKey)) return null;

  const mediaId = mediaIdFromKey(sourceKey);
  if (mediaId) {
    const byId = await getMediaById(mediaId);
    if (byId && byId.assetType === 'video' && (byId.previewKey === sourceKey || byId.premiumKey === sourceKey)) {
      return byId;
    }
  }

  const artistId = artistIdFromKey(sourceKey);
  if (!artistId) return null;
  return queryArtistMediaBySourceKey(artistId, sourceKey);
};

const updateMediaPosterKeys = async (media: MediaRecord, posterKey: string): Promise<void> => {
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };
  const assignments: string[] = ['#updatedAt = :updatedAt'];

  if (!media.previewPosterKey) {
    names['#previewPosterKey'] = 'previewPosterKey';
    values[':previewPosterKey'] = posterKey;
    assignments.push('#previewPosterKey = :previewPosterKey');
  }
  if (media.premiumKey && !media.premiumPosterKey) {
    names['#premiumPosterKey'] = 'premiumPosterKey';
    values[':premiumPosterKey'] = posterKey;
    assignments.push('#premiumPosterKey = :premiumPosterKey');
  }
  if (assignments.length === 1) {
    return;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { PK: media.PK, SK: media.SK },
      UpdateExpression: `SET ${assignments.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values
    })
  );
};

const processJob = async (job: S3KeyJob): Promise<void> => {
  if (!tableName) {
    throw new Error('GALLERY_CORE_TABLE is required');
  }

  const sourceKey = normalizeKey(job.key);
  if (!sourceKey || isGeneratedAssetKey(sourceKey)) {
    return;
  }

  const media = await resolveMediaForKey(sourceKey);
  if (!media) return;
  if ((media.assetType || 'image') !== 'video') return;
  if (media.previewPosterKey) return;

  const sourceBucket = job.bucket || defaultBucket;
  if (!sourceBucket) {
    throw new Error('MEDIA_BUCKET is required');
  }

  const posterKey = `${media.artistId}/${media.mediaId}/${posterPrefix}/preview.jpg`;
  const videoBuffer = await readS3Buffer(sourceBucket, sourceKey);
  const posterBuffer = await generatePoster(videoBuffer);

  await s3.send(
    new PutObjectCommand({
      Bucket: sourceBucket,
      Key: posterKey,
      Body: posterBuffer,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000, immutable'
    })
  );

  await updateMediaPosterKeys(media, posterKey);
}

const parseJobs = (record: SQSRecord): S3KeyJob[] => {
  const out: S3KeyJob[] = [];
  const payload = JSON.parse(record.body) as Record<string, unknown>;
  const pushFromEnvelope = (envelope: Record<string, unknown>): void => {
    const records = Array.isArray(envelope.Records) ? envelope.Records : [];
    for (const eventRecord of records) {
      const s3Block = (eventRecord as Record<string, unknown>).s3 as Record<string, unknown> | undefined;
      const bucketName = (s3Block?.bucket as Record<string, unknown> | undefined)?.name;
      const objectKey = (s3Block?.object as Record<string, unknown> | undefined)?.key;
      if (typeof bucketName === 'string' && typeof objectKey === 'string') {
        out.push({ bucket: bucketName, key: objectKey });
      }
    }
  };

  if (typeof payload.bucket === 'string' && typeof payload.key === 'string') {
    out.push({ bucket: payload.bucket, key: payload.key });
  }
  if (Array.isArray(payload.Records)) {
    pushFromEnvelope(payload);
  }
  if (typeof payload.Message === 'string') {
    const nested = JSON.parse(payload.Message) as Record<string, unknown>;
    if (Array.isArray(nested.Records)) {
      pushFromEnvelope(nested);
    }
  }

  return out;
};

export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const failures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      const jobs = parseJobs(record);
      if (!jobs.length) {
        continue;
      }
      for (const job of jobs) {
        await processJob(job);
      }
    } catch (error) {
      console.error('[video-poster-ingest] failed record', {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error)
      });
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};
