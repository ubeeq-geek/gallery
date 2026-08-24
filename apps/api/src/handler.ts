import serverless from 'serverless-http';
import { loadConfig } from './config';
import { createApp } from './app';
import { DynamoStore } from './dynamoStore';
import { runAdminBootstrap } from './adminBootstrap';
import { DynamoSupportSafetyRepository } from './supportSafetyRepository';

const config = loadConfig();
const store = new DynamoStore(config);
const app = createApp({
  config,
  store,
  supportSafetyRepository: DynamoSupportSafetyRepository.fromConfig(config)
});
const bootstrapPromise = runAdminBootstrap(config);

const appHandler = serverless(app);
export const handler = async (event: Parameters<typeof appHandler>[0], context: Parameters<typeof appHandler>[1]) => {
  await bootstrapPromise;
  return appHandler(event, context);
};
