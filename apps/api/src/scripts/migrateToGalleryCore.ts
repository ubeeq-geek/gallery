import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from '../config';
import { GalleryCoreRepository } from '../galleryCoreRepository';
import type { Artist, Gallery, Media } from '../domain';

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const asNumber = (value: unknown, fallback = 0): number => (typeof value === 'number' ? value : fallback);
const asOptionalString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const asOptionalNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
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

const scanAll = async (client: DynamoDBDocumentClient, tableName: string): Promise<Record<string, unknown>[]> => {
  const items: Record<string, unknown>[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const response = await client.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastEvaluatedKey
      })
    );

    if (response.Items) {
      items.push(...(response.Items as Record<string, unknown>[]));
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return items;
};

const migrate = async () => {
  const regionArg = getArgValue('--region');
  const profileArg = getArgValue('--profile');
  if (regionArg) process.env.AWS_REGION = regionArg;
  if (profileArg) process.env.AWS_PROFILE = profileArg;

  const config = loadConfig();
  const dryRun = process.argv.includes('--dry-run');
  const artistsTable = resolveTableName(config.artistsTable, '--artists-table');
  const galleriesTable = resolveTableName(config.galleriesTable, '--galleries-table');
  const imagesTable = resolveTableName(config.imagesTable, '--images-table');
  const galleryCoreTable = resolveTableName(config.galleryCoreTable, '--gallery-core-table');

  const lowLevel = new DynamoDBClient({ region: config.awsRegion });
  const client = DynamoDBDocumentClient.from(lowLevel);
  const repo = new GalleryCoreRepository(client, galleryCoreTable);

  const requiredTables = [artistsTable, galleriesTable, imagesTable, galleryCoreTable];
  for (const tableName of requiredTables) {
    try {
      await lowLevel.send(new DescribeTableCommand({ TableName: tableName }));
    } catch (error) {
      console.error(`[migrate:core] missing table: ${tableName}`);
      console.error('[migrate:core] pass explicit names with --artists-table/--galleries-table/--images-table/--gallery-core-table');
      throw error;
    }
  }

  const [rawArtists, rawGalleries, rawImages] = await Promise.all([
    scanAll(client, artistsTable),
    scanAll(client, galleriesTable),
    scanAll(client, imagesTable)
  ]);

  const artists: Artist[] = rawArtists
    .filter((item) => typeof item.artistId === 'string' && typeof item.slug === 'string')
    .map((item) => ({
      artistId: asString(item.artistId),
      name: asString(item.name),
      slug: asString(item.slug),
      status: item.status === 'inactive' ? 'inactive' : 'active',
      sortOrder: asNumber(item.sortOrder),
      createdAt: asString(item.createdAt, new Date().toISOString())
    }));

  const artistSlugById = new Map<string, string>();
  for (const artist of artists) {
    artistSlugById.set(artist.artistId, artist.slug);
  }

  const galleries: Gallery[] = rawGalleries
    .filter((item) => typeof item.galleryId === 'string' && typeof item.artistId === 'string' && typeof item.slug === 'string')
    .map((item) => {
      const artistId = asString(item.artistId);
      return {
        galleryId: asString(item.galleryId),
        artistId,
        artistSlug: asString(item.artistSlug, artistSlugById.get(artistId) || ''),
        title: asString(item.title),
        slug: asString(item.slug),
        visibility: item.visibility === 'premium' ? 'premium' : 'free',
        status: item.status === 'published' ? 'published' : 'draft',
        premiumPasswordHash: asOptionalString(item.premiumPasswordHash),
        coverImageId: asOptionalString(item.coverImageId),
        createdAt: asString(item.createdAt, new Date().toISOString())
      };
    });

  const galleryById = new Map<string, Gallery>(galleries.map((item) => [item.galleryId, item]));

  const mediaRows = rawImages
    .filter((item) => typeof item.imageId === 'string' && typeof item.galleryId === 'string' && typeof item.previewKey === 'string')
    .map((item) => {
      const galleryId = asString(item.galleryId);
      const gallery = galleryById.get(galleryId);
      const media: Media = {
        mediaId: asString(item.imageId),
        artistId: gallery?.artistId || '',
        assetType: item.assetType === 'video' ? 'video' : 'image',
        previewKey: asString(item.previewKey),
        premiumKey: asOptionalString(item.premiumKey),
        previewPosterKey: asOptionalString(item.previewPosterKey),
        premiumPosterKey: asOptionalString(item.premiumPosterKey),
        width: asNumber(item.width),
        height: asNumber(item.height),
        durationSeconds: asOptionalNumber(item.durationSeconds),
        altText: asOptionalString(item.altText),
        createdAt: asString(item.createdAt, new Date().toISOString())
      };
      return {
        media,
        galleryId,
        position: asNumber(item.sortOrder)
      };
    });

  console.log(`[migrate:core] artists=${artists.length} galleries=${galleries.length} media=${mediaRows.length} dryRun=${dryRun}`);

  if (dryRun) {
    return;
  }

  for (const artist of artists) {
    await repo.createArtist(artist);
  }
  for (const gallery of galleries) {
    await repo.createGallery(gallery);
  }
  for (const row of mediaRows) {
    await repo.createMedia(row.media, row.galleryId, row.position);
  }

  console.log('[migrate:core] migration complete');
};

migrate().catch((error) => {
  console.error('[migrate:core] failed', error);
  process.exitCode = 1;
});
