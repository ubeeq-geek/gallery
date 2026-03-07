import { createApp } from './app';
import { loadConfig } from './config';
import { InMemoryStore } from './inMemoryStore';

const config = loadConfig();
const store = new InMemoryStore();

const now = new Date().toISOString();
store.artists.push({ artistId: 'artist-1', name: 'Featured Artist', slug: 'featured-artist', status: 'active', sortOrder: 1, createdAt: now });
store.galleries.push({
  galleryId: 'gallery-1',
  artistId: 'artist-1',
  artistSlug: 'featured-artist',
  title: 'Free Preview Gallery',
  slug: 'free-preview-gallery',
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
