import serverless from 'serverless-http';
import { loadConfig } from './config';
import { createApp } from './app';
import { DynamoStore } from './dynamoStore';
import { runAdminBootstrap } from './adminBootstrap';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoFanvueRepository } from './fanvueRepository';

const config = loadConfig();
const store = new DynamoStore(config);
const fanvueRepository = new DynamoFanvueRepository(
  DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion }), { marshallOptions: { removeUndefinedValues: true } }),
  config.contentCoreTable
);
const app = createApp({ config, store, fanvueRepository });
const bootstrapPromise = runAdminBootstrap(config);

const appHandler = serverless(app);
export const handler = async (event: Parameters<typeof appHandler>[0], context: Parameters<typeof appHandler>[1]) => {
  await bootstrapPromise;
  return appHandler(event, context);
};
