import type { DynamoDBStreamHandler } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';

/** Emits immutable regional audit records as structured JSON into the cell audit log. */
export const handler: DynamoDBStreamHandler = async (event) => {
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) continue;
    const item = unmarshall(record.dynamodb.NewImage as any);
    if (!item.recordType || (!String(item.PK || '').startsWith('AUDIT#') && !['REGIONAL_POLICY_AUDIT', 'REGIONAL_UPLOAD_AUDIT', 'DLQ_REDRIVE_AUDIT'].includes(item.recordType))) continue;
    console.info(JSON.stringify({ schemaVersion: 1, emittedAt: new Date().toISOString(), ...item }));
  }
};
