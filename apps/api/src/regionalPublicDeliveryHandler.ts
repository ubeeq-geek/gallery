import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { ManagedProduct, ManagedRegion } from './regionalMedia';
import type { RegionalPolicyDecision } from './regionalPolicy';
import { publishRegionalPublicDerivative, regionalAssetKey, type PublishRegionalPublicDerivativeInput } from './regionalPublicDelivery';
import { dynamoRegionalPublicDeliveryRepository, s3RegionalPublicDerivativeStore } from './regionalPublicDeliveryAws';

export interface RegionalPublicDeliveryMessage {
  product: ManagedProduct;
  environment: string;
  dataHomeRegion: ManagedRegion;
  assetId: string;
  mediaVersionId: string;
  scanGroupId: string;
  contentHash: string;
  contentType: string;
  privateDerivativeObjectKey: string;
}

export interface AuthoritativeRegionalDeliveryState {
  canonicalRegion: ManagedRegion;
  policyDecision: RegionalPolicyDecision;
  remainingCreditUnits: number;
  requiredCreditUnits: number;
  overagePermitted?: boolean;
}

export interface RegionalPublicDeliveryHandlerDependencies {
  cell: { product: ManagedProduct; environment: string; dataHomeRegion: ManagedRegion };
  privateDerivativesBucket: string;
  publicDerivativesBucket: string;
  loadAuthoritativeState(message: RegionalPublicDeliveryMessage): Promise<AuthoritativeRegionalDeliveryState>;
  publish(input: PublishRegionalPublicDerivativeInput): Promise<void>;
}

const parseMessage = (body: string): RegionalPublicDeliveryMessage => {
  const message = JSON.parse(body) as RegionalPublicDeliveryMessage;
  const requiredStrings: Array<keyof RegionalPublicDeliveryMessage> = [
    'product', 'environment', 'dataHomeRegion', 'assetId', 'mediaVersionId', 'scanGroupId',
    'contentHash', 'contentType', 'privateDerivativeObjectKey'
  ];
  if (requiredStrings.some((field) => typeof message[field] !== 'string' || !message[field].trim())) throw new Error('Regional publication message is incomplete');
  return message;
};

/** Uses only identifiers from SQS; policy, placement, and entitlement are reloaded authoritatively. */
export const createRegionalPublicDeliveryHandler = (deps: RegionalPublicDeliveryHandlerDependencies) => async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    try {
      const message = parseMessage(record.body);
      if (message.product !== deps.cell.product || message.environment !== deps.cell.environment || message.dataHomeRegion !== deps.cell.dataHomeRegion) {
        throw new Error('Cross-cell public derivative publication rejected');
      }
      const state = await deps.loadAuthoritativeState(message);
      await deps.publish({
        product: message.product, environment: message.environment, dataHomeRegion: message.dataHomeRegion,
        assetId: message.assetId, mediaVersionId: message.mediaVersionId, scanGroupId: message.scanGroupId,
        contentHash: message.contentHash, contentType: message.contentType,
        sourceBucket: deps.privateDerivativesBucket, sourceObjectKey: message.privateDerivativeObjectKey,
        expectedPrivateDerivativesBucket: deps.privateDerivativesBucket,
        publicDerivativesBucket: deps.publicDerivativesBucket, expectedPublicDerivativesBucket: deps.publicDerivativesBucket,
        delivery: state
      });
    } catch {
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
};

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const dependencies = (): RegionalPublicDeliveryHandlerDependencies => {
  const region = required('DATA_HOME_REGION') as ManagedRegion;
  const metadataTableName = required('METADATA_TABLE');
  const scanTableName = required('SCAN_JOBS_TABLE');
  const auditTableName = required('AUDIT_USAGE_TABLE');
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  const repository = dynamoRegionalPublicDeliveryRepository({ client: ddb, metadataTableName, auditTableName });
  const store = s3RegionalPublicDerivativeStore(new S3Client({ region }));
  return {
    cell: { product: required('PRODUCT') as ManagedProduct, environment: required('ENVIRONMENT'), dataHomeRegion: region },
    privateDerivativesBucket: required('PRIVATE_DERIVATIVES_BUCKET'),
    publicDerivativesBucket: required('PUBLIC_DERIVATIVES_BUCKET'),
    loadAuthoritativeState: async (message) => {
      const [asset, policy] = await Promise.all([
        ddb.send(new GetCommand({ TableName: metadataTableName, Key: { PK: regionalAssetKey(message.assetId) }, ConsistentRead: true })),
        ddb.send(new GetCommand({ TableName: scanTableName, Key: { id: `policy-${message.scanGroupId}` }, ConsistentRead: true }))
      ]);
      if (!asset.Item || !policy.Item) throw new Error('Authoritative Asset or policy decision is unavailable');
      if (asset.Item.product !== message.product || asset.Item.environment !== message.environment || asset.Item.dataHomeRegion !== message.dataHomeRegion || asset.Item.currentMediaVersionId !== message.mediaVersionId || asset.Item.currentScanGroupId !== message.scanGroupId) {
        throw new Error('Publication message does not match the authoritative Asset version');
      }
      return {
        canonicalRegion: asset.Item.canonicalRegion as ManagedRegion,
        policyDecision: policy.Item as RegionalPolicyDecision,
        remainingCreditUnits: Number(asset.Item.remainingCreditUnits ?? 0),
        requiredCreditUnits: Number(asset.Item.requiredCreditUnits ?? 0),
        overagePermitted: asset.Item.overagePermitted === true
      };
    },
    publish: async (input) => { await publishRegionalPublicDerivative(input, repository, store); }
  };
};

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> =>
  createRegionalPublicDeliveryHandler(dependencies())(event);
