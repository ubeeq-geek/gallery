import serverless from 'serverless-http';
import { loadConfig } from './config';
import { createApp } from './app';
import { DynamoStore } from './dynamoStore';
import { runAdminBootstrap } from './adminBootstrap';
import { createSmugMugService } from './smugMugFactory';

const config = loadConfig();
const store = new DynamoStore(config);
const app = createApp({ config, store, smugMugService: createSmugMugService(config, store) });
const bootstrapPromise = runAdminBootstrap(config);

const appHandler = serverless(app);
export const handler = async (event: Parameters<typeof appHandler>[0], context: Parameters<typeof appHandler>[1]) => {
  await bootstrapPromise;
  return appHandler(event, context);
};
