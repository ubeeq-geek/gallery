import fs from 'fs';
import https from 'https';
import path from 'path';
import { randomBytes } from 'crypto';
import { createApp } from './app';
import { loadConfig } from './config';
import { InMemoryStore } from './inMemoryStore';
import { processExternalSyncJob } from './externalSyncWorker';
import { createInProcessExternalSyncQueue, type ExternalSyncQueue } from './externalSyncQueue';
import { createInProcessCommunityDeliveryQueue, type CommunityDeliveryQueue } from './communityDeliveryQueue';
import { processDiscordDelivery } from './discordCommunity';
import { runAdminBootstrap } from './adminBootstrap';
import { SmugMugCanonicalOutboundSource, SmugMugCanonicalSink, SmugMugImageScanner } from './smugMugCanonicalSink';
import { EncryptedInMemorySmugMugCredentialVault, SmugMugHttpGateway } from './smugMugGateway';
import { SmugMugIntegrationService } from './smugMugIntegration';
import { InMemoryTumblrRepository } from './tumblrRepository';
import { createInProcessTumblrPublishQueue } from './tumblrPublishQueue';
import { processTumblrPublication } from './tumblrPublishing';

// A local seed is useful for offline UI work, but it must not override real
// Cognito identities when the paired web app has an auth configuration.
const localStateDirectory = process.env.LOCAL_API_STATE_DIRECTORY
  || path.join('/tmp', `${process.env.PRODUCT_BRAND || 'eversally'}-api`);
const localStatePath = path.join(localStateDirectory, 'state.json');
const localEncryptionKeyPath = path.join(localStateDirectory, 'external-token-encryption-key');

const localEncryptionKey = (configured?: string): string => {
  if (configured) return configured;
  fs.mkdirSync(localStateDirectory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(localEncryptionKeyPath)) {
    const existing = fs.readFileSync(localEncryptionKeyPath, 'utf8').trim();
    if (existing) return existing;
  }
  const generated = randomBytes(48).toString('base64url');
  fs.writeFileSync(localEncryptionKeyPath, `${generated}\n`, { mode: 0o600 });
  return generated;
};

const loadedConfig = loadConfig();
const localAdminMode = !loadedConfig.cognitoUserPoolId && Boolean(loadedConfig.adminEmail && loadedConfig.adminPassword);
const config = {
  ...loadedConfig,
  // Keep local integration credentials decryptable across ts-node-dev reloads.
  // The key and encrypted development state stay in /tmp, never in source control.
  externalTokenEncryptionKey: localEncryptionKey(loadedConfig.externalTokenEncryptionKey),
  localAuthUserId: process.env.LOCAL_AUTH_USER_ID || (localAdminMode ? 'local-admin' : undefined),
  localAuthRole: localAdminMode ? 'admin' as const : loadedConfig.localAuthRole,
  localAuthEmail: localAdminMode ? loadedConfig.adminEmail : loadedConfig.localAuthEmail,
  localAuthDisplayName: localAdminMode ? 'Local Administrator' : loadedConfig.localAuthDisplayName
};
void runAdminBootstrap(config);
const store = new InMemoryStore();
const smugMugService = config.smugMugApiKey && config.smugMugApiSecret && config.smugMugOAuthCallbackUrl && config.externalTokenEncryptionKey
  ? new SmugMugIntegrationService(
    new SmugMugHttpGateway({
      apiKey: config.smugMugApiKey, apiSecret: config.smugMugApiSecret, callbackUrl: config.smugMugOAuthCallbackUrl,
      vault: new EncryptedInMemorySmugMugCredentialVault(config.externalTokenEncryptionKey)
    }),
    new SmugMugCanonicalSink(store, config, new SmugMugImageScanner()),
    undefined,
    new SmugMugCanonicalOutboundSource(store, config)
  )
  : undefined;
const tumblrRepository = new InMemoryTumblrRepository();
let tumblrPublishQueue = createInProcessTumblrPublishQueue((publicationId) => processTumblrPublication(tumblrRepository, config, publicationId, tumblrPublishQueue));

type LocalStoreSnapshot = {
  version: 1;
  savedAt: string;
  data: Record<string, unknown>;
  maps: Record<string, Array<[unknown, unknown]>>;
};

const storeRecord = store as unknown as Record<string, unknown>;
const restoreLocalStore = (): boolean => {
  try {
    const snapshot = JSON.parse(fs.readFileSync(localStatePath, 'utf8')) as LocalStoreSnapshot;
    if (snapshot.version !== 1 || !snapshot.data) return false;
    for (const [key, value] of Object.entries(snapshot.data)) storeRecord[key] = value;
    for (const [key, entries] of Object.entries(snapshot.maps || {})) {
      storeRecord[key] = new Map(entries);
    }
    console.log(`Restored local API state from ${localStatePath}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Unable to restore local API state: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }
};

const createLocalStoreSnapshot = (): LocalStoreSnapshot => {
  const data: Record<string, unknown> = {};
  const maps: Record<string, Array<[unknown, unknown]>> = {};
  for (const [key, value] of Object.entries(storeRecord)) {
    if (value instanceof Map) maps[key] = [...value.entries()];
    else data[key] = value;
  }
  return { version: 1, savedAt: new Date().toISOString(), data, maps };
};

let lastPersistedLocalState = '';
const persistLocalStore = (): void => {
  try {
    fs.mkdirSync(localStateDirectory, { recursive: true, mode: 0o700 });
    const serialised = JSON.stringify(createLocalStoreSnapshot());
    if (serialised === lastPersistedLocalState) return;
    const temporaryPath = `${localStatePath}.next`;
    fs.writeFileSync(temporaryPath, serialised, { mode: 0o600 });
    fs.renameSync(temporaryPath, localStatePath);
    lastPersistedLocalState = serialised;
  } catch (error) {
    console.warn(`Unable to persist local API state: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const restoredLocalStore = restoreLocalStore();

if (!restoredLocalStore) {
  const now = new Date().toISOString();
  store.creators.push({ creatorId: 'creator-1', name: 'Featured Creator', slug: 'featured-creator', status: 'active', sortOrder: 1, createdAt: now });
  if (config.localAuthUserId) {
    store.creatorMembers.push({ creatorId: 'creator-1', userId: config.localAuthUserId, role: 'owner', createdAt: now });
  }
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
  persistLocalStore();
}

const localStateTimer = setInterval(persistLocalStore, 250);
localStateTimer.unref();
process.once('SIGTERM', persistLocalStore);
process.once('SIGINT', persistLocalStore);

let externalSyncQueue: ExternalSyncQueue;
externalSyncQueue = createInProcessExternalSyncQueue((externalSyncJobId) => processExternalSyncJob(store, config, externalSyncJobId, externalSyncQueue));
let communityDeliveryQueue: CommunityDeliveryQueue;
communityDeliveryQueue = createInProcessCommunityDeliveryQueue((communityDeliveryId) => processDiscordDelivery(store, config, communityDeliveryId, communityDeliveryQueue.enqueue.bind(communityDeliveryQueue)));

let retrySweepRunning = false;
const retrySweep = async () => {
  if (retrySweepRunning) return;
  retrySweepRunning = true;
  try {
    const now = new Date().toISOString();
    const dueJobs = await store.listDueExternalSyncJobs(now, 50);
    const resumedAccounts = new Set<string>();
    for (const job of dueJobs) {
      if (resumedAccounts.has(job.externalAccountId)) continue;
      await store.updateExternalSyncJob({ ...job, status: 'queued', nextAttemptAt: undefined, updatedAt: now });
      await externalSyncQueue.enqueue(job.externalSyncJobId);
      resumedAccounts.add(job.externalAccountId);
    }
  } catch (error) {
    console.error(`[external-sync-local-retry] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    retrySweepRunning = false;
  }
};
const retryTimer = setInterval(() => void retrySweep(), 5_000);
retryTimer.unref();

const app = createApp({
  config,
  store,
  externalSyncQueue,
  communityDeliveryQueue,
  smugMugService,
  tumblrRepository,
  tumblrPublishQueue
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
