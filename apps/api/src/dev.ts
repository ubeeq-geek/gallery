import { createApp } from './app';
import { loadConfig } from './config';
import { InMemoryStore } from './inMemoryStore';

const config = loadConfig();
const store = new InMemoryStore();

const now = new Date().toISOString();
store.creators.push({ creatorId: 'creator-1', name: 'Featured Creator', slug: 'featured-creator', status: 'active', sortOrder: 1, createdAt: now });
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

const app = createApp({ config, store });
const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API running at http://localhost:${port}`);
});
