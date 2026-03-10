import { DescribeTableCommand, DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteObjectsCommand, HeadBucketCommand, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { hashPassword } from '../unlock';
import { loadConfig } from '../config';
import { GalleryCoreRepository } from '../galleryCoreRepository';
import type { Artist, Gallery, Media, SiteSettings } from '../domain';
import { generateImageRenditions } from '../renditions';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm']);

const getArgValue = (flagName: string): string | undefined => {
  const args = process.argv.slice(2);
  const equalsMatch = args.find((arg) => arg.startsWith(`${flagName}=`));
  if (equalsMatch) return equalsMatch.slice(flagName.length + 1);

  const idx = args.indexOf(flagName);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];

  return undefined;
};

const resolveTableName = (envValue: string, flagName: string): string => getArgValue(flagName) || envValue;
const nowIso = () => new Date().toISOString();
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'item';

const contentTypeForFile = (filename: string): string => {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  return 'application/octet-stream';
};

const normalize = (value: string): string => value.toLowerCase();
const isPoster = (filename: string): boolean => normalize(filename).includes('poster');
const extractSequence = (filename: string): number => {
  const match = filename.match(/-(\d+)(?:[^\d].*)?\.[^.]+$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

const titleFromFilename = (filename: string): string => {
  const base = filename.replace(/\.[^.]+$/, '');
  return base.replace(/^[A-Z]{2,8}-\d+\s*-\s*/i, '').trim();
};

type AssetFile = { filename: string; absolutePath: string };
type ArtistSeed = {
  name: string;
  slug: string;
  filePrefix: string;
  galleries: Array<'free' | 'preview' | 'premium'>;
  freeGalleryTitle?: string;
  freeGallerySlug?: string;
  purchaseUrl?: string;
};

const artistSeeds: ArtistSeed[] = [
  {
    name: 'Anne Smith',
    slug: 'anne-smith',
    filePrefix: 'anne-',
    galleries: ['free', 'preview', 'premium'],
    purchaseUrl: 'https://store.example.com/anne-smith-premium'
  },
  {
    name: 'Samuel Jones',
    slug: 'samuel-jones',
    filePrefix: 'samuel-',
    galleries: ['free']
  },
  {
    name: 'Ubeeq Girl',
    slug: 'ubeeq-girl',
    filePrefix: 'ubeeq-girl-',
    galleries: ['preview', 'premium'],
    purchaseUrl: 'https://store.example.com/ubeeq-girl-premium'
  },
  {
    name: 'Bureau of Occupational Records',
    slug: 'bureau-of-occupational-records',
    filePrefix: 'alp-',
    galleries: ['free'],
    freeGalleryTitle: 'Atlas of Lost Occupations',
    freeGallerySlug: 'atlas-of-lost-occupations'
  }
];

const splitByAccess = (files: AssetFile[]): { free: AssetFile[]; premium: AssetFile[] } => {
  const explicitFree = files.filter((file) => normalize(file.filename).includes('free'));
  const explicitPremium = files.filter((file) => normalize(file.filename).includes('premium'));
  const unlabeled = files
    .filter((file) => !explicitFree.includes(file) && !explicitPremium.includes(file))
    .sort((a, b) => extractSequence(a.filename) - extractSequence(b.filename));

  const freeUnlabeledCount = unlabeled.length > 0 ? Math.max(2, Math.ceil(unlabeled.length / 3)) : 0;
  const free = [...explicitFree, ...unlabeled.slice(0, freeUnlabeledCount)];
  const premium = [...explicitPremium, ...unlabeled.slice(freeUnlabeledCount)];

  return { free, premium };
};

const tableExists = async (client: DynamoDBClient, tableName: string): Promise<boolean> => {
  if (!tableName) return false;
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch {
    return false;
  }
};

const discoverTableName = async (client: DynamoDBClient, preferred: string, marker: string): Promise<string> => {
  if (await tableExists(client, preferred)) return preferred;

  const found: string[] = [];
  let startTableName: string | undefined;
  do {
    const response = await client.send(new ListTablesCommand({ ExclusiveStartTableName: startTableName }));
    for (const name of response.TableNames || []) {
      if (name.includes(marker)) found.push(name);
    }
    startTableName = response.LastEvaluatedTableName;
  } while (startTableName);

  if (found.length === 0) {
    throw new Error(`Could not discover DynamoDB table containing marker: ${marker}`);
  }

  const prioritized = found.sort((a, b) => {
    const aScore = a.startsWith('GalleryStack-') ? 0 : 1;
    const bScore = b.startsWith('GalleryStack-') ? 0 : 1;
    if (aScore !== bScore) return aScore - bScore;
    return a.localeCompare(b);
  });
  return prioritized[0];
};

const bucketExists = async (s3: S3Client, bucket: string): Promise<boolean> => {
  if (!bucket) return false;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
};

const discoverMediaBucket = async (s3: S3Client, preferred: string): Promise<string> => {
  if (await bucketExists(s3, preferred)) return preferred;
  const buckets = (await s3.send(new ListBucketsCommand({}))).Buckets?.map((b) => b.Name || '').filter(Boolean) || [];
  const candidates = buckets.filter((name) => name.includes('mediabucket'));
  if (candidates.length === 0) {
    throw new Error('Could not discover media bucket (expected name containing "mediabucket")');
  }
  const prioritized = candidates.sort((a, b) => {
    const aScore = a.startsWith('gallerystack-') ? 0 : 1;
    const bScore = b.startsWith('gallerystack-') ? 0 : 1;
    if (aScore !== bScore) return aScore - bScore;
    return a.localeCompare(b);
  });
  return prioritized[0];
};

const wipeTable = async (client: DynamoDBDocumentClient, tableName: string, keyFields: string[]): Promise<number> => {
  let deleted = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const projection = keyFields.join(', ');

  do {
    const page = await client.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: projection,
        ExclusiveStartKey: exclusiveStartKey
      })
    );

    const items = page.Items || [];
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      await client.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: chunk.map((item) => {
              const key: Record<string, unknown> = {};
              for (const field of keyFields) {
                key[field] = item[field];
              }
              return { DeleteRequest: { Key: key } };
            })
          }
        })
      );
      deleted += chunk.length;
    }

    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return deleted;
};

const wipeBucketPrefixes = async (s3: S3Client, bucket: string, prefixes: string[]): Promise<number> => {
  let deleted = 0;
  for (const prefix of prefixes) {
    let continuationToken: string | undefined;
    do {
      const list = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        })
      );

      const objects = (list.Contents || []).map((item) => item.Key).filter((key): key is string => Boolean(key));
      if (objects.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: objects.map((key) => ({ Key: key })),
              Quiet: true
            }
          })
        );
        deleted += objects.length;
      }

      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);
  }
  return deleted;
};

const main = async () => {
  const regionArg = getArgValue('--region');
  const profileArg = getArgValue('--profile');
  if (regionArg) process.env.AWS_REGION = regionArg;
  if (profileArg) process.env.AWS_PROFILE = profileArg;

  const config = loadConfig();
  const dryRun = process.argv.includes('--dry-run');
  const reset = process.argv.includes('--reset');
  const galleryCoreTableRequested = resolveTableName(config.galleryCoreTable, '--gallery-core-table');
  const siteSettingsTableRequested = resolveTableName(config.siteSettingsTable, '--site-settings-table');
  const premiumPassword = getArgValue('--premium-password') || 'replace-me';
  const themeArg = getArgValue('--theme');
  const theme: SiteSettings['theme'] =
    themeArg === 'sand' || themeArg === 'forest' || themeArg === 'slate' || themeArg === 'ubeeq'
      ? themeArg
      : 'ubeeq';
  const siteName = getArgValue('--site-name') || 'Ubeeq';
  const logoKey = getArgValue('--logo-key') || 'branding/ubeeq-logo.svg';

  const shouldUploadLogo = !process.argv.includes('--skip-logo-upload');
  const shouldUploadMedia = !process.argv.includes('--skip-media-upload');
  const shouldGenerateRenditions = !process.argv.includes('--skip-renditions');

  const workspaceRoot = path.resolve(__dirname, '../../../..');
  const mediaDir = getArgValue('--media-dir') || path.join(workspaceRoot, 'media');
  const logoFile = getArgValue('--logo-file') || path.join(mediaDir, 'ubeeq-logo.svg');

  if (!existsSync(mediaDir)) {
    throw new Error(`Media directory not found: ${mediaDir}`);
  }

  const mediaFiles = readdirSync(mediaDir)
    .filter((name) => !name.startsWith('.'))
    .map((name) => ({ filename: name, absolutePath: path.join(mediaDir, name) }));

  const lowLevel = new DynamoDBClient({ region: config.awsRegion });
  const s3 = new S3Client({ region: config.awsRegion });
  const galleryCoreTable = await discoverTableName(lowLevel, galleryCoreTableRequested, 'GalleryCoreTable');
  const siteSettingsTable = await discoverTableName(lowLevel, siteSettingsTableRequested, 'SiteSettingsTable');
  const mediaBucket = await discoverMediaBucket(s3, config.mediaBucket);

  const client = DynamoDBDocumentClient.from(lowLevel);
  const repo = new GalleryCoreRepository(client, galleryCoreTable);

  const premiumPasswordHash = await hashPassword(premiumPassword);

  const artists: Artist[] = [];
  const galleries: Gallery[] = [];
  const media: Array<{ media: Media; galleryId: string; position: number }> = [];
  const uploadJobs = new Map<string, { localPath: string; contentType: string }>();

  const queueUpload = (key: string | undefined, file: AssetFile) => {
    if (!key) return;
    if (!uploadJobs.has(key)) {
      uploadJobs.set(key, { localPath: file.absolutePath, contentType: contentTypeForFile(file.filename) });
    }
  };

  for (let idx = 0; idx < artistSeeds.length; idx += 1) {
    const seed = artistSeeds[idx];
    const createdAt = nowIso();
    const artistId = randomUUID();

    const artist: Artist = {
      artistId,
      name: seed.name,
      slug: seed.slug,
      status: 'active',
      sortOrder: idx + 1,
      createdAt
    };
    artists.push(artist);

    const freeGallery = seed.galleries.includes('free')
      ? {
          galleryId: randomUUID(),
          artistId,
          artistSlug: seed.slug,
          title: seed.freeGalleryTitle || `${seed.name} Free Gallery`,
          slug: seed.freeGallerySlug || `${seed.slug}-free`,
          slugHistory: [seed.freeGallerySlug || `${seed.slug}-free`],
          visibility: 'free' as const,
          status: 'published' as const,
          createdAt
        }
      : undefined;

    const premiumGallery = seed.galleries.includes('premium')
      ? {
          galleryId: randomUUID(),
          artistId,
          artistSlug: seed.slug,
          title: `${seed.name} Premium Gallery`,
          slug: `${seed.slug}-premium`,
          slugHistory: [`${seed.slug}-premium`],
          visibility: 'premium' as const,
          status: 'published' as const,
          premiumPasswordHash,
          createdAt
        }
      : undefined;

    const previewGallery = seed.galleries.includes('preview')
      ? {
          galleryId: randomUUID(),
          artistId,
          artistSlug: seed.slug,
          title: `${seed.name} Premium Gallery (Preview)`,
          slug: `${seed.slug}-premium-preview`,
          slugHistory: [`${seed.slug}-premium-preview`],
          visibility: 'preview' as const,
          pairedPremiumGalleryId: premiumGallery?.galleryId,
          purchaseUrl: seed.purchaseUrl,
          status: 'published' as const,
          createdAt
        }
      : undefined;

    if (freeGallery) galleries.push(freeGallery);
    if (previewGallery) galleries.push(previewGallery);
    if (premiumGallery) galleries.push(premiumGallery);

    const artistFiles = mediaFiles.filter((file) => normalize(file.filename).startsWith(normalize(seed.filePrefix)));

    const imageFiles = artistFiles
      .filter((file) => IMAGE_EXT.has(path.extname(file.filename).toLowerCase()) && !isPoster(file.filename))
      .sort((a, b) => extractSequence(a.filename) - extractSequence(b.filename));

    const videoFiles = artistFiles
      .filter((file) => VIDEO_EXT.has(path.extname(file.filename).toLowerCase()))
      .sort((a, b) => extractSequence(a.filename) - extractSequence(b.filename));

    const posterFiles = artistFiles.filter((file) => IMAGE_EXT.has(path.extname(file.filename).toLowerCase()) && isPoster(file.filename));

    const hasPremiumTier = Boolean(previewGallery || premiumGallery);
    const imageSplit = hasPremiumTier
      ? splitByAccess(imageFiles)
      : { free: imageFiles, premium: [] as AssetFile[] };
    const videoSplit = hasPremiumTier
      ? splitByAccess(videoFiles)
      : { free: videoFiles, premium: [] as AssetFile[] };
    const freeImages = freeGallery ? imageSplit.free : [];
    const previewImages = previewGallery ? (freeGallery ? imageSplit.premium : imageSplit.free) : [];
    const premiumImages = premiumGallery ? imageSplit.premium : [];
    const freeVideos = freeGallery ? videoSplit.free : [];
    const previewVideos = previewGallery ? (freeGallery ? videoSplit.premium : videoSplit.free) : [];
    const premiumVideos = premiumGallery ? videoSplit.premium : [];

    let freeOrder = 1;
    let previewOrder = 1;
    let premiumOrder = 1;

    const pushMedia = (targetGalleryId: string, position: number, payload: Media) => {
      media.push({
        media: payload,
        galleryId: targetGalleryId,
        position
      });
    };

    for (const file of freeImages) {
      const mediaId = randomUUID();
      const title = titleFromFilename(file.filename);
      const slug = slugify(title);
      const previewKey = `${artistId}/${mediaId}`;
      if (freeGallery) {
        pushMedia(freeGallery.galleryId, freeOrder, {
        mediaId,
        artistId,
        assetType: 'image',
        title,
        slug,
        slugHistory: [slug],
        originalFilename: file.filename,
        previewKey,
        width: 1600,
        height: 1067,
        altText: `${seed.name} free image ${freeOrder}`,
        createdAt
      });
      }
      queueUpload(previewKey, file);
      freeOrder += 1;
    }

    for (const file of previewImages) {
      const mediaId = randomUUID();
      const title = titleFromFilename(file.filename);
      const slug = slugify(title);
      const previewKey = `${artistId}/${mediaId}`;
      if (previewGallery) {
        pushMedia(previewGallery.galleryId, previewOrder, {
          mediaId,
          artistId,
          assetType: 'image',
          title,
          slug,
          slugHistory: [slug],
          originalFilename: file.filename,
          previewKey,
          width: 1600,
          height: 1067,
          altText: `${seed.name} preview image ${previewOrder}`,
          createdAt
        });
        previewOrder += 1;
      }
      queueUpload(previewKey, file);
    }

    for (const file of premiumImages) {
      const mediaId = randomUUID();
      const title = titleFromFilename(file.filename);
      const slug = slugify(title);
      const objectKey = `${artistId}/${mediaId}`;
      if (premiumGallery) {
        pushMedia(premiumGallery.galleryId, premiumOrder, {
        mediaId,
        artistId,
        assetType: 'image',
        title,
        slug,
        slugHistory: [slug],
        originalFilename: file.filename,
        previewKey: objectKey,
        premiumKey: objectKey,
        width: 2200,
        height: 1467,
        altText: `${seed.name} premium image ${premiumOrder}`,
        createdAt
      });
      }
      queueUpload(objectKey, file);
      premiumOrder += 1;
    }

    const findPosterForVideo = (videoFile: AssetFile): AssetFile | undefined => {
      const base = normalize(videoFile.filename).replace(path.extname(videoFile.filename).toLowerCase(), '');
      return posterFiles.find((poster) => {
        const p = normalize(poster.filename);
        return p.includes(base) || p.includes(base.replace('-video', ''));
      });
    };

    for (const file of freeVideos) {
      const mediaId = randomUUID();
      const title = titleFromFilename(file.filename);
      const slug = slugify(title);
      const previewKey = `${artistId}/${mediaId}`;
      const poster = findPosterForVideo(file);
      const previewPosterKey = poster
        ? `${artistId}/${randomUUID()}`
        : undefined;

      if (freeGallery) {
        pushMedia(freeGallery.galleryId, freeOrder, {
        mediaId,
        artistId,
        assetType: 'video',
        title,
        slug,
        slugHistory: [slug],
        originalFilename: file.filename,
        previewKey,
        previewPosterKey,
        width: 1920,
        height: 1080,
        durationSeconds: 20,
        createdAt
      });
      }
      queueUpload(previewKey, file);
      if (poster) queueUpload(previewPosterKey, poster);
      freeOrder += 1;
    }

    for (const file of previewVideos) {
      const mediaId = randomUUID();
      const title = titleFromFilename(file.filename);
      const slug = slugify(title);
      const previewKey = `${artistId}/${mediaId}`;
      const poster = findPosterForVideo(file);
      const previewPosterKey = poster
        ? `${artistId}/${randomUUID()}`
        : undefined;
      if (previewGallery) {
        pushMedia(previewGallery.galleryId, previewOrder, {
          mediaId,
          artistId,
          assetType: 'video',
          title,
          slug,
          slugHistory: [slug],
          originalFilename: file.filename,
          previewKey,
          previewPosterKey,
          width: 1920,
          height: 1080,
          durationSeconds: 20,
          createdAt
        });
        previewOrder += 1;
      }
      queueUpload(previewKey, file);
      if (poster) queueUpload(previewPosterKey, poster);
    }

    for (const file of premiumVideos) {
      const mediaId = randomUUID();
      const title = titleFromFilename(file.filename);
      const slug = slugify(title);
      const objectKey = `${artistId}/${mediaId}`;
      const poster = findPosterForVideo(file);
      const previewPosterKey = poster
        ? `${artistId}/${randomUUID()}`
        : undefined;
      const premiumPosterKey = poster
        ? previewPosterKey
        : undefined;

      if (premiumGallery) {
        pushMedia(premiumGallery.galleryId, premiumOrder, {
        mediaId,
        artistId,
        assetType: 'video',
        title,
        slug,
        slugHistory: [slug],
        originalFilename: file.filename,
        previewKey: objectKey,
        premiumKey: objectKey,
        previewPosterKey,
        premiumPosterKey,
        width: 1920,
        height: 1080,
        durationSeconds: 24,
        createdAt
      });
      }
      queueUpload(objectKey, file);
      if (poster) {
        queueUpload(previewPosterKey, poster);
      }
      premiumOrder += 1;
    }
  }

  const siteSettings: SiteSettings = {
    settingId: 'SITE',
    siteName,
    theme,
    logoKey,
    updatedAt: nowIso()
  };

  console.log(`[seed:core] table=${galleryCoreTable} siteSettingsTable=${siteSettingsTable} bucket=${mediaBucket} region=${config.awsRegion} dryRun=${dryRun} reset=${reset}`);
  console.log(`[seed:core] artists=${artists.length} galleries=${galleries.length} media=${media.length}`);
  console.log(`[seed:core] siteName=${siteSettings.siteName} theme=${siteSettings.theme} logoKey=${siteSettings.logoKey || 'none'}`);
  console.log(`[seed:core] uploadJobs=${uploadJobs.size} (mediaUpload=${shouldUploadMedia} logoUpload=${shouldUploadLogo} renditions=${shouldGenerateRenditions})`);

  if (dryRun) return;

  if (reset) {
    const deletedCore = await wipeTable(client, galleryCoreTable, ['PK', 'SK']);
    const deletedSettings = await wipeTable(client, siteSettingsTable, ['settingId']);
    const deletedObjects = await wipeBucketPrefixes(s3, mediaBucket, ['']);
    console.log(`[seed:core] reset deleted coreItems=${deletedCore} siteSettingsItems=${deletedSettings} s3Objects=${deletedObjects}`);
  }

  // Remove legacy placeholder seed records from earlier versions.
  await repo.deleteGallery('gallery-free-001');
  await repo.deleteGallery('gallery-premium-001');
  await repo.deleteArtist('artist-featured-001');

  if (shouldUploadMedia) {
    for (const [key, job] of uploadJobs.entries()) {
      const body = readFileSync(job.localPath);
      await s3.send(
        new PutObjectCommand({
          Bucket: mediaBucket,
          Key: key,
          Body: body,
          ContentType: job.contentType,
          CacheControl: 'public, max-age=31536000, immutable'
        })
      );
    }
    console.log(`[seed:core] uploaded media objects: ${uploadJobs.size}`);
  }

  if (shouldUploadMedia && shouldGenerateRenditions) {
    for (const item of media) {
      if ((item.media.assetType || 'image') !== 'image') continue;
      const sourceKey = item.media.previewKey;
      const artistId = sourceKey.split('/')[0];
      const generated = await generateImageRenditions({
        s3,
        bucket: mediaBucket,
        sourceKey,
        targetPrefix: `${artistId}/${item.media.mediaId}`
      });
      item.media.thumbnailKeys = generated.keys;
      item.media.squareCrop = generated.squareCrop;
    }
    console.log('[seed:core] generated image renditions');
  }

  for (const artist of artists) {
    await repo.createArtist(artist);
  }
  for (const gallery of galleries) {
    await repo.createGallery(gallery);
  }
  for (const item of media) {
    await repo.createMedia(item.media, item.galleryId, item.position);
  }

  await client.send(new PutCommand({ TableName: siteSettingsTable, Item: siteSettings }));

  if (shouldUploadLogo) {
    if (!existsSync(logoFile)) throw new Error(`Logo file not found: ${logoFile}`);
    const logoBody = readFileSync(logoFile);
    await s3.send(
      new PutObjectCommand({
        Bucket: mediaBucket,
        Key: logoKey,
        Body: logoBody,
        ContentType: logoKey.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        CacheControl: 'public, max-age=31536000, immutable'
      })
    );
    console.log(`[seed:core] uploaded logo to s3://${mediaBucket}/${logoKey}`);
  }

  console.log('[seed:core] complete');
  console.log('[seed:core] premium password used:', premiumPassword);
};

main().catch((error) => {
  console.error('[seed:core] failed', error);
  process.exitCode = 1;
});
