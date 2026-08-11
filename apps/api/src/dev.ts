import fs from 'fs';
import https from 'https';
import path from 'path';
import { createApp } from './app';
import { loadConfig } from './config';
import { InMemoryStore } from './inMemoryStore';
import { processExternalSyncJob } from './externalSyncWorker';
import { createInProcessExternalSyncQueue } from './externalSyncQueue';

const config = { ...loadConfig(), localAuthUserId: process.env.LOCAL_AUTH_USER_ID || 'local-user' };
const store = new InMemoryStore();

const now = new Date().toISOString();
store.creators.push({ creatorId: 'creator-1', name: 'Featured Creator', slug: 'featured-creator', status: 'active', sortOrder: 1, createdAt: now });
store.creatorMembers.push({ creatorId: 'creator-1', userId: config.localAuthUserId, role: 'owner', createdAt: now });
store.groupings.push({
  groupingId: 'grouping-1',
  creatorId: 'creator-1',
  creatorSlug: 'featured-creator',
  title: 'Free Preview Grouping',
  slug: 'free-preview-grouping',
  visibility: 'free',
  status: 'published',
  createdAt: now
});

const app = createApp({
  config,
  store,
  externalSyncQueue: createInProcessExternalSyncQueue((externalSyncJobId) => processExternalSyncJob(store, config, externalSyncJobId))
});
const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '127.0.0.1';
const httpsEnabled = process.env.DEV_HTTPS === 'true';
const server = httpsEnabled
  ? https.createServer({
    key: fs.readFileSync(process.env.DEV_TLS_KEY_PATH || path.resolve(__dirname, '../../../certs/fanadmin.top-key.pem')),
    cert: fs.readFileSync(process.env.DEV_TLS_CERT_PATH || path.resolve(__dirname, '../../../certs/fanadmin.top.pem'))
  }, app)
  : app;

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`API running at ${httpsEnabled ? 'https' : 'http'}://${host}:${port}`);
});
