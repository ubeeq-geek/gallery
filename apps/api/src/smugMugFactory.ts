import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AppConfig } from './config';
import type { CanonicalStore } from './canonicalStore';
import { SmugMugCanonicalOutboundSource, SmugMugCanonicalSink, SmugMugImageScanner, type SmugMugContentScanner } from './smugMugCanonicalSink';
import { SmugMugHttpGateway } from './smugMugGateway';
import { SmugMugIntegrationService } from './smugMugIntegration';
import { DynamoSmugMugCredentialVault, DynamoSmugMugRepository } from './smugMugPersistence';

/** Build the production integration only when every security-sensitive OAuth setting exists. */
export const createSmugMugService = (config: AppConfig, store: CanonicalStore, scanner?: SmugMugContentScanner) => {
  if (!config.smugMugApiKey || !config.smugMugApiSecret || !config.smugMugOAuthCallbackUrl || !config.externalTokenEncryptionKey) return undefined;
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion }), { marshallOptions: { removeUndefinedValues: true } });
  const repository = new DynamoSmugMugRepository(client, config.contentCoreTable);
  const vault = new DynamoSmugMugCredentialVault(client, config.contentCoreTable, config.externalTokenEncryptionKey);
  const gateway = new SmugMugHttpGateway({ apiKey: config.smugMugApiKey, apiSecret: config.smugMugApiSecret, callbackUrl: config.smugMugOAuthCallbackUrl, vault });
  return new SmugMugIntegrationService(gateway, new SmugMugCanonicalSink(store, config, scanner || new SmugMugImageScanner()), repository, new SmugMugCanonicalOutboundSource(store, config));
};
