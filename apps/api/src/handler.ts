import serverless from 'serverless-http';
import { loadConfig } from './config';
import { createApp } from './app';
import { DynamoStore } from './dynamoStore';

const config = loadConfig();
const store = new DynamoStore(config);
const app = createApp({ config, store });

export const handler = serverless(app);
