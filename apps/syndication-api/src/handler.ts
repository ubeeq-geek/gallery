import serverless from 'serverless-http';
import { createApp, runWeeklySyncAll } from './app';
import type { Handler } from 'aws-lambda';

const app = createApp();
const httpHandler = serverless(app);

export const handler: Handler = async (event, context) => {
  if (event && typeof event === 'object' && 'trigger' in event && (event as { trigger?: string }).trigger === 'weekly-sync') {
    return runWeeklySyncAll();
  }
  return httpHandler(event, context);
};
