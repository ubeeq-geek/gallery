import { randomUUID } from 'node:crypto';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { RegionalScanJob, RegionalScanResult } from './regionalMedia';
import { evaluateRegionalPolicy, type RegionalPolicyDecision, type RegionalPolicyProfile } from './regionalPolicy';
import { createRegionalDeliveryRevocation } from './regionalDeliveryRevocation';

export interface RegionalScanCompletionRepository {
  loadJobsAndResults(job: RegionalScanJob): Promise<{ jobs: RegionalScanJob[]; results: RegionalScanResult[] }>;
  applyDecision(job: RegionalScanJob, decision: RegionalPolicyDecision): Promise<void>;
}

export const evaluateCompletedScanGroup = async (job: RegionalScanJob, policy: RegionalPolicyProfile, repository: RegionalScanCompletionRepository): Promise<RegionalPolicyDecision | null> => {
  if (!job.scanGroupId || !job.requiredScanCount) throw new Error('Scan job is missing its immutable scan-group manifest');
  const snapshot = await repository.loadJobsAndResults(job);
  if (snapshot.jobs.length !== job.requiredScanCount || snapshot.results.length !== job.requiredScanCount) return null;
  const decision = evaluateRegionalPolicy(snapshot.jobs, snapshot.results, policy);
  await repository.applyDecision(job, decision);
  return decision;
};

export const dynamoScanCompletionRepository = (input: { client: DynamoDBDocumentClient; scanTableName: string; auditTableName: string; metadataTableName: string }): RegionalScanCompletionRepository => ({
  loadJobsAndResults: async (job) => {
    const get = async (keys: Array<{ id: string }>): Promise<Record<string, any>[]> => {
      const collected: Record<string, any>[] = [];
      for (let offset = 0; offset < keys.length; offset += 100) {
        let pending = keys.slice(offset, offset + 100);
        do {
          const response = await input.client.send(new BatchGetCommand({ RequestItems: { [input.scanTableName]: { Keys: pending, ConsistentRead: true } } }));
          collected.push(...(response.Responses?.[input.scanTableName] || [])); pending = (response.UnprocessedKeys?.[input.scanTableName]?.Keys || []) as Array<{ id: string }>;
        } while (pending.length);
      }
      return collected;
    };
    const manifestCount = Math.ceil(job.requiredScanCount / 40);
    const manifests = await get(Array.from({ length: manifestCount }, (_, chunk) => ({ id: `manifest-${job.scanGroupId}-${chunk}` })));
    const jobIds = manifests.sort((a, b) => a.chunk - b.chunk).flatMap(({ jobIds }) => jobIds as string[]);
    if (jobIds.length !== job.requiredScanCount) return { jobs: [], results: [] };
    const items = await get(jobIds.flatMap((id) => [{ id }, { id: `${id}:result` }]));
    return { jobs: items.filter(({ recordType }) => recordType !== 'SCAN_RESULT') as RegionalScanJob[], results: items.filter(({ recordType }) => recordType === 'SCAN_RESULT') as RegionalScanResult[] };
  },
  applyDecision: async (job, decision) => {
    const timestamp = new Date().toISOString();
    const transactions: any[] = [
      { Put: { TableName: input.scanTableName, Item: { id: `policy-${job.scanGroupId}`, recordType: 'POLICY_DECISION', product: job.product, environment: job.environment, dataHomeRegion: job.dataHomeRegion, assetId: job.assetId, mediaVersionId: job.mediaVersionId.split('@')[0], scanGroupId: job.scanGroupId, ...decision, createdAt: timestamp }, ConditionExpression: 'attribute_not_exists(id)' } },
      { Update: { TableName: input.metadataTableName, Key: { PK: `ASSET#${job.assetId}` },
        UpdateExpression: 'SET scanState = :scanState, publicDeliveryState = :deliveryState, activeScanProfile = :scanProfile, currentScanGroupId = :scanGroupId, policyVersion = :policyVersion, policyReasonCode = :reasonCode, policyEvaluatedAt = :now',
        ConditionExpression: '#product = :product AND #environment = :environment AND dataHomeRegion = :region AND canonicalRegion = :region AND currentScanGroupId = :scanGroupId AND currentMediaVersionId = :mediaVersionId',
        ExpressionAttributeNames: { '#product': 'product', '#environment': 'environment' },
        ExpressionAttributeValues: { ':product': job.product, ':environment': job.environment, ':region': job.dataHomeRegion, ':scanGroupId': job.scanGroupId, ':mediaVersionId': job.mediaVersionId.split('@')[0], ':scanState': decision.state, ':deliveryState': decision.state === 'CLEARED_FOR_POLICY_REVIEW' ? 'ELIGIBLE' : decision.state === 'HELD' ? 'REVOKED' : 'PRIVATE', ':scanProfile': job.scanProfile, ':policyVersion': decision.policyVersion, ':reasonCode': decision.reasonCode, ':now': timestamp } } },
      { Put: { TableName: input.auditTableName, Item: { PK: `AUDIT#${randomUUID()}`, recordType: 'REGIONAL_POLICY_AUDIT', product: job.product, environment: job.environment, dataHomeRegion: job.dataHomeRegion, assetId: job.assetId, scanGroupId: job.scanGroupId, action: `regional_asset.${decision.state.toLowerCase()}`, policyVersion: decision.policyVersion, reasonCode: decision.reasonCode, automatedCompletionOnly: true, createdAt: timestamp } } }
    ];
    if (decision.state === 'HELD') {
      transactions.push({ Put: { TableName: input.auditTableName, Item: { PK: `HOLD#${randomUUID()}`, recordType: 'RESTRICTED_REVIEW_HOLD', product: job.product, environment: job.environment, dataHomeRegion: job.dataHomeRegion, assetId: job.assetId, scanGroupId: job.scanGroupId, restricted: true, reasonCode: decision.reasonCode, createdAt: timestamp } } });
      const revocation = createRegionalDeliveryRevocation({ product: job.product, environment: job.environment, dataHomeRegion: job.dataHomeRegion, assetId: job.assetId, scanGroupId: job.scanGroupId, reasonCode: decision.reasonCode, createdAt: timestamp });
      transactions.push({ Put: { TableName: input.auditTableName, Item: { ...revocation, PK: `REVOCATION#${revocation.id}` }, ConditionExpression: 'attribute_not_exists(PK)' } });
    }
    if (decision.state === 'HELD' || decision.state === 'HUMAN_REVIEW_REQUIRED') transactions.push({ Put: { TableName: input.auditTableName, Item: { PK: `REVIEW#${randomUUID()}`, recordType: 'REGIONAL_REVIEW_CASE', product: job.product, environment: job.environment, dataHomeRegion: job.dataHomeRegion, assetId: job.assetId, scanGroupId: job.scanGroupId, restrictedSafety: decision.state === 'HELD', reasonCode: decision.reasonCode, createdAt: timestamp } } });
    try {
      await input.client.send(new TransactWriteCommand({ TransactItems: transactions }));
    } catch (error) {
      // Multiple final scan workers may race to apply the same immutable decision.
      if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') throw error;
      const existing = await input.client.send(new GetCommand({ TableName: input.scanTableName, Key: { id: `policy-${job.scanGroupId}` }, ConsistentRead: true }));
      if (!existing.Item || existing.Item.policyVersion !== decision.policyVersion || existing.Item.state !== decision.state || existing.Item.reasonCode !== decision.reasonCode) throw error;
    }
  }
});
