import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { hashPassword } from '../unlock';
import { loadConfig } from '../config';
import { GalleryCoreRepository } from '../galleryCoreRepository';
import type { Artist, Gallery, Image } from '../domain';

const getArgValue = (flagName: string): string | undefined => {
  const args = process.argv.slice(2);
  const equalsMatch = args.find((arg) => arg.startsWith(`${flagName}=`));
  if (equalsMatch) {
    return equalsMatch.slice(flagName.length + 1);
  }

  const idx = args.indexOf(flagName);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }

  return undefined;
};

const resolveTableName = (envValue: string, flagName: string): string => getArgValue(flagName) || envValue;

const nowIso = () => new Date().toISOString();

const main = async () => {
  const regionArg = getArgValue('--region');
  const profileArg = getArgValue('--profile');
  if (regionArg) process.env.AWS_REGION = regionArg;
  if (profileArg) process.env.AWS_PROFILE = profileArg;

  const config = loadConfig();
  const dryRun = process.argv.includes('--dry-run');
  const galleryCoreTable = resolveTableName(config.galleryCoreTable, '--gallery-core-table');
  const premiumPassword = getArgValue('--premium-password') || 'replace-me';

  const lowLevel = new DynamoDBClient({ region: config.awsRegion });
  await lowLevel.send(new DescribeTableCommand({ TableName: galleryCoreTable }));

  const client = DynamoDBDocumentClient.from(lowLevel);
  const repo = new GalleryCoreRepository(client, galleryCoreTable);

  const artist: Artist = {
    artistId: 'artist-featured-001',
    name: 'Featured Artist',
    slug: 'featured-artist',
    status: 'active',
    sortOrder: 1,
    createdAt: nowIso()
  };

  const premiumPasswordHash = await hashPassword(premiumPassword);

  const galleries: Gallery[] = [
    {
      galleryId: 'gallery-free-001',
      artistId: artist.artistId,
      artistSlug: artist.slug,
      title: 'Free Preview Collection',
      slug: 'free-preview-collection',
      visibility: 'free',
      status: 'published',
      createdAt: nowIso()
    },
    {
      galleryId: 'gallery-premium-001',
      artistId: artist.artistId,
      artistSlug: artist.slug,
      title: 'Premium Collection',
      slug: 'premium-collection',
      visibility: 'premium',
      status: 'published',
      premiumPasswordHash,
      createdAt: nowIso()
    }
  ];

  const media: Image[] = [
    {
      imageId: 'media-img-001',
      galleryId: 'gallery-free-001',
      assetType: 'image',
      previewKey: 'artists/featured-artist/galleries/free-preview-collection/preview/images/media-img-001.jpg',
      width: 1600,
      height: 1067,
      sortOrder: 1,
      altText: 'Free sample image',
      createdAt: nowIso()
    },
    {
      imageId: 'media-vid-001',
      galleryId: 'gallery-free-001',
      assetType: 'video',
      previewKey: 'artists/featured-artist/galleries/free-preview-collection/preview/videos/media-vid-001.mp4',
      previewPosterKey: 'artists/featured-artist/galleries/free-preview-collection/preview/posters/media-vid-001.jpg',
      width: 1920,
      height: 1080,
      durationSeconds: 18,
      sortOrder: 2,
      createdAt: nowIso()
    },
    {
      imageId: 'media-img-002',
      galleryId: 'gallery-premium-001',
      assetType: 'image',
      previewKey: 'artists/featured-artist/galleries/premium-collection/preview/images/media-img-002.jpg',
      premiumKey: 'artists/featured-artist/galleries/premium-collection/premium/images/media-img-002.jpg',
      width: 2200,
      height: 1467,
      sortOrder: 1,
      altText: 'Premium sample image',
      createdAt: nowIso()
    },
    {
      imageId: 'media-vid-002',
      galleryId: 'gallery-premium-001',
      assetType: 'video',
      previewKey: 'artists/featured-artist/galleries/premium-collection/preview/videos/media-vid-002.mp4',
      premiumKey: 'artists/featured-artist/galleries/premium-collection/premium/videos/media-vid-002.mp4',
      previewPosterKey: 'artists/featured-artist/galleries/premium-collection/preview/posters/media-vid-002.jpg',
      premiumPosterKey: 'artists/featured-artist/galleries/premium-collection/premium/posters/media-vid-002.jpg',
      width: 1920,
      height: 1080,
      durationSeconds: 24,
      sortOrder: 2,
      createdAt: nowIso()
    }
  ];

  console.log(`[seed:core] table=${galleryCoreTable} region=${config.awsRegion} dryRun=${dryRun}`);
  console.log(`[seed:core] artist=${artist.slug} galleries=${galleries.length} media=${media.length}`);

  if (dryRun) {
    return;
  }

  await repo.createArtist(artist);
  for (const gallery of galleries) {
    await repo.createGallery(gallery);
  }
  for (const item of media) {
    await repo.createImage(item);
  }

  console.log('[seed:core] complete');
  console.log('[seed:core] premium password used:', premiumPassword);
};

main().catch((error) => {
  console.error('[seed:core] failed', error);
  process.exitCode = 1;
});
