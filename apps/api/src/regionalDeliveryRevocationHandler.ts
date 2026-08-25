import { createHash } from 'node:crypto';
import type { DynamoDBStreamEvent, DynamoDBStreamHandler } from 'aws-lambda';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { processRegionalDeliveryRevocation, type RegionalDeliveryInvalidator, type RegionalDeliveryRevocation, type RegionalDeliveryRevocationRepository } from './regionalDeliveryRevocation';

class NodeSha256 {
  private readonly hash = createHash('sha256');
  update(data: string | Uint8Array): void { this.hash.update(data); }
  async digest(): Promise<Uint8Array> { return this.hash.digest(); }
}

export const cloudFrontInvalidator = (distributionId: string, fetcher: typeof fetch = fetch): RegionalDeliveryInvalidator => ({
  invalidate: async ({ paths, callerReference }) => {
    const body = `<InvalidationBatch xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"><Paths><Quantity>${paths.length}</Quantity><Items>${paths.map((path) => `<Path>${path}</Path>`).join('')}</Items></Paths><CallerReference>${callerReference}</CallerReference></InvalidationBatch>`;
    const signer = new SignatureV4({ credentials: defaultProvider(), region: 'us-east-1', service: 'cloudfront', sha256: NodeSha256 });
    const request = await signer.sign(new HttpRequest({ protocol: 'https:', hostname: 'cloudfront.amazonaws.com', method: 'POST', path: `/2020-05-31/distribution/${distributionId}/invalidation`, headers: { host: 'cloudfront.amazonaws.com', 'content-type': 'application/xml', 'content-length': String(Buffer.byteLength(body)) }, body }));
    const response = await fetcher(`https://${request.hostname}${request.path}`, { method: request.method, headers: request.headers, body });
    const responseBody = await response.text();
    if (!response.ok) throw new Error(`CloudFront invalidation failed with status ${response.status}`);
    const invalidationId = responseBody.match(/<Id>([^<]+)<\/Id>/)?.[1];
    if (!invalidationId) throw new Error('CloudFront invalidation response omitted its identifier');
    return { invalidationId };
  }
});

export const createRegionalDeliveryRevocationHandler = (input: {
  product: RegionalDeliveryRevocation['product']; environment: string; dataHomeRegion: RegionalDeliveryRevocation['dataHomeRegion'];
  invalidator: RegionalDeliveryInvalidator; repository: RegionalDeliveryRevocationRepository;
}): DynamoDBStreamHandler => async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) continue;
    const command = unmarshall(record.dynamodb.NewImage as any) as RegionalDeliveryRevocation;
    if (command.recordType !== 'DELIVERY_REVOCATION_OUTBOX' || command.state !== 'PENDING') continue;
    await processRegionalDeliveryRevocation(command, input, input.invalidator, input.repository);
  }
};

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const auditTableName = process.env.AUDIT_USAGE_TABLE || '';
export const handler = createRegionalDeliveryRevocationHandler({
  product: process.env.PRODUCT as RegionalDeliveryRevocation['product'], environment: process.env.ENVIRONMENT || '', dataHomeRegion: process.env.DATA_HOME_REGION as RegionalDeliveryRevocation['dataHomeRegion'],
  invalidator: cloudFrontInvalidator(process.env.PUBLIC_DISTRIBUTION_ID || ''),
  repository: { markComplete: async (command) => { await documentClient.send(new UpdateCommand({ TableName: auditTableName, Key: { PK: `REVOCATION#${command.id}` }, UpdateExpression: 'SET #state = :complete, invalidationId = :invalidationId, completedAt = :completedAt', ConditionExpression: '#state = :pending', ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':pending': 'PENDING', ':complete': 'COMPLETE', ':invalidationId': command.invalidationId, ':completedAt': command.completedAt } })); } }
});
