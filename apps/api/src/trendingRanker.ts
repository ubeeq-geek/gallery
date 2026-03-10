import { loadConfig } from './config';
import { DynamoStore } from './dynamoStore';
import { refreshTrendingFeeds } from './trendingFeed';

export const handler = async () => {
  const config = loadConfig();
  const store = new DynamoStore(config);
  const startedAt = Date.now();
  const stats = await refreshTrendingFeeds(store, config, Date.now());
  const durationMs = Date.now() - startedAt;
  const payload = {
    ok: true,
    durationMs,
    stats
  };
  console.info(`[trending-ranker] ${JSON.stringify(payload)}`);
  return payload;
};

if (require.main === module) {
  handler()
    .then((payload) => {
      console.log(JSON.stringify(payload, null, 2));
    })
    .catch((error) => {
      console.error('[trending-ranker] failed', error);
      process.exit(1);
    });
}
