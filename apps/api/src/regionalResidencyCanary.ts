import type { Handler } from 'aws-lambda';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetBucketLocationCommand, S3Client } from '@aws-sdk/client-s3';

export const handler: Handler = async () => {
  const region = process.env.DATA_HOME_REGION || '';
  const buckets = JSON.parse(process.env.REGIONAL_BUCKETS_JSON || '[]') as string[];
  const tables = JSON.parse(process.env.REGIONAL_TABLES_JSON || '[]') as string[];
  if (!region || !buckets.length || !tables.length) throw new Error('Regional residency canary configuration is incomplete');
  const s3 = new S3Client({ region }); const ddb = new DynamoDBClient({ region });
  for (const bucket of buckets) {
    const result = await s3.send(new GetBucketLocationCommand({ Bucket: bucket }));
    const actual = result.LocationConstraint || 'us-east-1';
    if (actual !== region) throw new Error(`Bucket ${bucket} resolved to ${actual}, expected ${region}`);
  }
  for (const table of tables) {
    const result = await ddb.send(new DescribeTableCommand({ TableName: table }));
    if (!result.Table?.TableArn?.includes(`:${region}:`)) throw new Error(`Table ${table} is outside ${region}`);
  }
  return { region, buckets: buckets.length, tables: tables.length };
};
