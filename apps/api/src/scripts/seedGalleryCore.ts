import { DescribeTableCommand, DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DeleteObjectsCommand, HeadBucketCommand, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';
import { createReadStream, existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Jimp } from 'jimp';
import { hashPassword } from '../unlock';
import { loadConfig } from '../config';
import { GalleryCoreRepository } from '../galleryCoreRepository';
import type { AiDisclosure, Artist, ContentRating, Gallery, HeavyTopic, Media, SiteSettings } from '../domain';
import { generateImageRenditions } from '../renditions';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm']);
const SEED_UUID_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

const getArgValue = (flagName: string): string | undefined => {
  const args = process.argv.slice(2);
  const equalsMatch = args.find((arg) => arg.startsWith(`${flagName}=`));
  if (equalsMatch) return equalsMatch.slice(flagName.length + 1);

  const idx = args.indexOf(flagName);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];

  return undefined;
};

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

const parseUuidToBytes = (uuid: string): Uint8Array => {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID namespace: ${uuid}`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const bytesToUuid = (bytes: Uint8Array): string => {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const deterministicUuidV5 = (name: string, namespace = SEED_UUID_NAMESPACE): string => {
  const nsBytes = parseUuidToBytes(namespace);
  const hash = createHash('sha1');
  hash.update(Buffer.from(nsBytes));
  hash.update(Buffer.from(name, 'utf8'));
  const digest = hash.digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
};

const seedId = (entity: string, ...parts: string[]): string => {
  const name = ['seed-v1', entity, ...parts.map((value) => value.trim().toLowerCase())].join('|');
  return deterministicUuidV5(name);
};

type AssetFile = { filename: string; absolutePath: string };
type GallerySeedKind = 'free' | 'preview' | 'premium';
type ArtistSeed = {
  name: string;
  slug: string;
  filePrefix: string;
  includePrefixes?: string[];
  contentRating?: ContentRating;
  aiDisclosure?: AiDisclosure;
  heavyTopics?: HeavyTopic[];
  discoverSquareCropEnabled?: boolean;
  galleries: Array<GallerySeedKind>;
  freeGalleryTitle?: string;
  freeGallerySlug?: string;
  freeGalleryStatus?: 'draft' | 'published';
  previewGalleryTitle?: string;
  previewGallerySlug?: string;
  previewGalleryStatus?: 'draft' | 'published';
  premiumGalleryTitle?: string;
  premiumGallerySlug?: string;
  premiumGalleryStatus?: 'draft' | 'published';
  premiumPassword?: string;
  purchaseUrl?: string;
};

type ScenarioGallerySeed = {
  kind: GallerySeedKind;
  title?: string;
  slug?: string;
  status?: 'draft' | 'published';
  purchaseUrl?: string;
  premiumPassword?: string;
};

type ScenarioArtistSeed = {
  name: string;
  slug: string;
  filePrefix: string;
  includePrefixes?: string[];
  contentRating?: ContentRating;
  aiDisclosure?: AiDisclosure;
  heavyTopics?: HeavyTopic[];
  discoverSquareCropEnabled?: boolean;
  galleries: ScenarioGallerySeed[];
};

type ScenarioSiteSettings = {
  stackName?: string;
  siteName?: string;
  theme?: SiteSettings['theme'];
  logoKey?: string;
  logoFile?: string;
};

type SeedScenarioFile = {
  mediaDir?: string;
  siteSettings?: ScenarioSiteSettings;
  artists: ScenarioArtistSeed[];
};

type SeedScenarioInputs = {
  artistSeeds: ArtistSeed[];
  mediaDir: string;
  stackName?: string;
  siteName?: string;
  theme?: SiteSettings['theme'];
  logoKey?: string;
  logoFile?: string;
  sourceFile: string;
};

type StackTargets = {
  galleryCoreTable?: string;
  siteSettingsTable?: string;
  mediaBucket?: string;
};

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

const assertUniqueArtistSeedSlugs = (seeds: ArtistSeed[]): void => {
  const seen = new Set<string>();
  for (const seed of seeds) {
    const normalized = slugify(seed.slug);
    if (seen.has(normalized)) {
      throw new Error(`Duplicate artist slug in seed data: ${normalized}`);
    }
    seen.add(normalized);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown, fieldName: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Scenario field "${fieldName}" must be a non-empty string`);
  }
  return value.trim();
};

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const asOptionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const parseOptionalStringArray = (value: unknown, fieldName: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Scenario field "${fieldName}" must be an array of strings`);
  }
  const parsed = value.map((item, idx) => asString(item, `${fieldName}[${idx}]`));
  return parsed.length ? parsed : undefined;
};

const resolveScenarioChildPath = (scenarioRootDir: string, relativePathValue: string, fieldName: string): string => {
  if (path.isAbsolute(relativePathValue)) {
    throw new Error(`Scenario field "${fieldName}" must be a relative path under the scenario folder`);
  }
  const resolved = path.resolve(scenarioRootDir, relativePathValue);
  const relative = path.relative(scenarioRootDir, resolved);
  if (!relative || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Scenario field "${fieldName}" must point to a child path inside the scenario folder`);
  }
  return resolved;
};

const parseScenarioGallery = (
  value: unknown,
  fieldName: string
): ScenarioGallerySeed => {
  if (!isRecord(value)) {
    throw new Error(`Scenario field "${fieldName}" must be an object`);
  }
  const kindRaw = asString(value.kind, `${fieldName}.kind`);
  if (kindRaw !== 'free' && kindRaw !== 'preview' && kindRaw !== 'premium') {
    throw new Error(`Scenario field "${fieldName}.kind" must be one of free, preview, premium`);
  }
  const statusRaw = asOptionalString(value.status);
  if (statusRaw && statusRaw !== 'draft' && statusRaw !== 'published') {
    throw new Error(`Scenario field "${fieldName}.status" must be draft or published`);
  }
  return {
    kind: kindRaw,
    title: asOptionalString(value.title),
    slug: asOptionalString(value.slug),
    status: statusRaw as 'draft' | 'published' | undefined,
    purchaseUrl: asOptionalString(value.purchaseUrl),
    premiumPassword: asOptionalString(value.premiumPassword)
  };
};

const parseScenarioArtist = (
  value: unknown,
  fieldName: string
): ArtistSeed => {
  if (!isRecord(value)) {
    throw new Error(`Scenario field "${fieldName}" must be an object`);
  }
  const name = asString(value.name, `${fieldName}.name`);
  const slug = slugify(asString(value.slug, `${fieldName}.slug`));
  const filePrefix = asString(value.filePrefix, `${fieldName}.filePrefix`);
  const includePrefixes = parseOptionalStringArray(value.includePrefixes, `${fieldName}.includePrefixes`);
  const discoverSquareCropEnabled = asOptionalBoolean(value.discoverSquareCropEnabled);
  const galleriesRaw = value.galleries;
  if (!Array.isArray(galleriesRaw) || galleriesRaw.length === 0) {
    throw new Error(`Scenario field "${fieldName}.galleries" must be a non-empty array`);
  }
  const galleries = galleriesRaw.map((item, idx) => parseScenarioGallery(item, `${fieldName}.galleries[${idx}]`));
  const galleryByKind = new Map<GallerySeedKind, ScenarioGallerySeed>();
  for (const gallery of galleries) {
    if (galleryByKind.has(gallery.kind)) {
      throw new Error(`Scenario field "${fieldName}.galleries" has duplicate kind "${gallery.kind}"`);
    }
    galleryByKind.set(gallery.kind, gallery);
  }

  const contentRatingRaw = asOptionalString(value.contentRating);
  const aiDisclosureRaw = asOptionalString(value.aiDisclosure);
  const heavyTopicsRaw = parseOptionalStringArray(value.heavyTopics, `${fieldName}.heavyTopics`);
  const contentRating = contentRatingRaw as ContentRating | undefined;
  if (contentRatingRaw && !['general', 'suggestive', 'mature', 'sexual', 'fetish', 'graphic'].includes(contentRatingRaw)) {
    throw new Error(`Scenario field "${fieldName}.contentRating" is invalid`);
  }
  const aiDisclosure = aiDisclosureRaw as AiDisclosure | undefined;
  if (aiDisclosureRaw && !['none', 'ai-assisted', 'ai-generated'].includes(aiDisclosureRaw)) {
    throw new Error(`Scenario field "${fieldName}.aiDisclosure" is invalid`);
  }
  if (heavyTopicsRaw) {
    for (const topic of heavyTopicsRaw) {
      if (!['politics-public-affairs', 'crime-disasters-tragedy'].includes(topic)) {
        throw new Error(`Scenario field "${fieldName}.heavyTopics" contains invalid value "${topic}"`);
      }
    }
  }

  const freeGallery = galleryByKind.get('free');
  const previewGallery = galleryByKind.get('preview');
  const premiumGallery = galleryByKind.get('premium');

  return {
    name,
    slug,
    filePrefix,
    includePrefixes,
    contentRating,
    aiDisclosure,
    heavyTopics: heavyTopicsRaw as HeavyTopic[] | undefined,
    discoverSquareCropEnabled,
    galleries: Array.from(galleryByKind.keys()),
    freeGalleryTitle: freeGallery?.title,
    freeGallerySlug: freeGallery?.slug,
    freeGalleryStatus: freeGallery?.status,
    previewGalleryTitle: previewGallery?.title,
    previewGallerySlug: previewGallery?.slug,
    previewGalleryStatus: previewGallery?.status,
    premiumGalleryTitle: premiumGallery?.title,
    premiumGallerySlug: premiumGallery?.slug,
    premiumGalleryStatus: premiumGallery?.status,
    premiumPassword: premiumGallery?.premiumPassword,
    purchaseUrl: previewGallery?.purchaseUrl
  };
};

const loadScenarioInputs = (scenarioFilePath: string): SeedScenarioInputs => {
  const sourceFile = path.resolve(scenarioFilePath);
  if (!existsSync(sourceFile)) {
    throw new Error(`Scenario file not found: ${sourceFile}`);
  }
  const parsed = JSON.parse(readFileSync(sourceFile, 'utf8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('Scenario root must be a JSON object');
  }

  const scenario = parsed as SeedScenarioFile;
  const scenarioRoot = path.dirname(sourceFile);
  const mediaDirRelative = asOptionalString(scenario.mediaDir) || 'media';
  const mediaDir = resolveScenarioChildPath(scenarioRoot, mediaDirRelative, 'mediaDir');
  if (scenario.siteSettings !== undefined && !isRecord(scenario.siteSettings)) {
    throw new Error('Scenario field "siteSettings" must be an object');
  }
  const siteSettings = isRecord(scenario.siteSettings) ? scenario.siteSettings : {};

  const artistsRaw = (scenario as Record<string, unknown>).artists;
  if (!Array.isArray(artistsRaw) || artistsRaw.length === 0) {
    throw new Error('Scenario field "artists" must be a non-empty array');
  }
  const parsedArtists = artistsRaw.map((item, idx) => parseScenarioArtist(item, `artists[${idx}]`));

  const stackName = asOptionalString(siteSettings.stackName);
  const siteName = asOptionalString(siteSettings.siteName);
  const themeRaw = asOptionalString(siteSettings.theme);
  if (themeRaw && !['ubeeq', 'sand', 'forest', 'slate'].includes(themeRaw)) {
    throw new Error('Scenario field "siteSettings.theme" must be one of ubeeq, sand, forest, slate');
  }
  const logoKey = asOptionalString(siteSettings.logoKey);
  const logoFileRelative = asOptionalString(siteSettings.logoFile);
  const logoFile = logoFileRelative
    ? resolveScenarioChildPath(scenarioRoot, logoFileRelative, 'siteSettings.logoFile')
    : undefined;

  return {
    artistSeeds: parsedArtists,
    mediaDir,
    stackName,
    siteName,
    theme: themeRaw as SiteSettings['theme'] | undefined,
    logoKey,
    logoFile,
    sourceFile
  };
};

const readStackTargets = async (client: CloudFormationClient, stackName: string): Promise<StackTargets> => {
  const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = response.Stacks?.[0];
  if (!stack) {
    throw new Error(`CloudFormation stack not found: ${stackName}`);
  }
  const outputs = stack.Outputs || [];
  const outputByKey = new Map<string, string>();
  for (const output of outputs) {
    if (output.OutputKey && output.OutputValue) {
      outputByKey.set(output.OutputKey, output.OutputValue);
    }
  }
  return {
    galleryCoreTable: outputByKey.get('GalleryCoreTableName'),
    siteSettingsTable: outputByKey.get('SiteSettingsTableName'),
    mediaBucket: outputByKey.get('MediaBucketName')
  };
};

const imageDimensionCache = new Map<string, { width: number; height: number }>();

const getImageDimensions = async (file: AssetFile): Promise<{ width: number; height: number }> => {
  const cached = imageDimensionCache.get(file.absolutePath);
  if (cached) return cached;
  const image = await Jimp.read(file.absolutePath);
  const width = Number(image.bitmap.width || 0);
  const height = Number(image.bitmap.height || 0);
  if (width <= 0 || height <= 0) {
    throw new Error(`Could not determine image dimensions for ${file.absolutePath}`);
  }
  const value = { width, height };
  imageDimensionCache.set(file.absolutePath, value);
  return value;
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
  const preserveMedia = process.argv.includes('--preserve-media');
  const workspaceRoot = path.resolve(__dirname, '../../../..');
  const defaultScenarioFile = path.join(workspaceRoot, 'seed-scenarios/default/seed.json');
  const scenarioFileArg = getArgValue('--scenario-file') || defaultScenarioFile;
  const scenarioInputs = loadScenarioInputs(scenarioFileArg);

  const galleryCoreTableArg = getArgValue('--gallery-core-table');
  const siteSettingsTableArg = getArgValue('--site-settings-table');
  const mediaBucketArg = getArgValue('--media-bucket');
  const stackNameArg = getArgValue('--stack-name');
  const stackName = stackNameArg || scenarioInputs?.stackName;
  if (!stackName) {
    throw new Error(
      'Stack name is required. Provide --stack-name <name> or set siteSettings.stackName in the scenario file.'
    );
  }

  const galleryCoreTableRequested =
    galleryCoreTableArg || (stackName ? undefined : config.galleryCoreTable);
  const siteSettingsTableRequested =
    siteSettingsTableArg || (stackName ? undefined : config.siteSettingsTable);
  const premiumPassword = getArgValue('--premium-password') || 'replace-me';
  const themeArg = getArgValue('--theme') || scenarioInputs?.theme;
  const theme: SiteSettings['theme'] =
    themeArg === 'sand' || themeArg === 'forest' || themeArg === 'slate' || themeArg === 'ubeeq'
      ? themeArg
      : 'ubeeq';
  const siteName = getArgValue('--site-name') || scenarioInputs?.siteName || 'Ubeeq';
  const logoKey = getArgValue('--logo-key') || scenarioInputs?.logoKey || 'branding/ubeeq-logo.svg';

  const shouldUploadLogo = !preserveMedia && !process.argv.includes('--skip-logo-upload');
  const shouldUploadMedia = !preserveMedia && !process.argv.includes('--skip-media-upload');
  const shouldGenerateRenditions = !preserveMedia && !process.argv.includes('--skip-renditions');

  const mediaDir = getArgValue('--media-dir') || scenarioInputs.mediaDir;
  const logoFile = getArgValue('--logo-file') || scenarioInputs.logoFile || path.join(mediaDir, 'ubeeq-logo.svg');
  const activeArtistSeeds = scenarioInputs.artistSeeds;

  assertUniqueArtistSeedSlugs(activeArtistSeeds);

  if (!existsSync(mediaDir)) {
    throw new Error(`Media directory not found: ${mediaDir}`);
  }

  const mediaFiles = readdirSync(mediaDir)
    .filter((name) => !name.startsWith('.'))
    .map((name) => ({ filename: name, absolutePath: path.join(mediaDir, name) }));

  const lowLevel = new DynamoDBClient({ region: config.awsRegion });
  const cloudFormation = new CloudFormationClient({ region: config.awsRegion });
  const s3 = new S3Client({ region: config.awsRegion });
  const stackTargets = stackName ? await readStackTargets(cloudFormation, stackName) : {};
  const galleryCoreTable = await discoverTableName(
    lowLevel,
    galleryCoreTableRequested || stackTargets.galleryCoreTable || '',
    'GalleryCoreTable'
  );
  const siteSettingsTable = await discoverTableName(
    lowLevel,
    siteSettingsTableRequested || stackTargets.siteSettingsTable || '',
    'SiteSettingsTable'
  );
  const mediaBucket = await discoverMediaBucket(s3, mediaBucketArg || stackTargets.mediaBucket || config.mediaBucket);

  const client = DynamoDBDocumentClient.from(lowLevel);
  const repo = new GalleryCoreRepository(client, galleryCoreTable);

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

  for (let idx = 0; idx < activeArtistSeeds.length; idx += 1) {
    const seed = activeArtistSeeds[idx];
    const createdAt = nowIso();
    const artistId = seedId('artist', seed.slug);
    const contentRating: ContentRating = seed.contentRating || 'general';
    const aiDisclosure: AiDisclosure = seed.aiDisclosure || 'none';
    const heavyTopics: HeavyTopic[] = seed.heavyTopics || [];
    const discoverSquareCropEnabled = seed.discoverSquareCropEnabled ?? true;
    const premiumPasswordHash = await hashPassword(seed.premiumPassword || premiumPassword);

    const artist: Artist = {
      artistId,
      name: seed.name,
      slug: seed.slug,
      defaultProfileTab: 'feed',
      discoverSquareCropEnabled,
      defaultAiDisclosure: aiDisclosure,
      defaultHeavyTopics: heavyTopics,
      status: 'active',
      sortOrder: idx + 1,
      createdAt
    };
    artists.push(artist);

    const freeGallery = seed.galleries.includes('free')
      ? {
          galleryId: seedId('gallery', seed.slug, 'free'),
          artistId,
          artistSlug: seed.slug,
          title: seed.freeGalleryTitle || `${seed.name} Free Gallery`,
          slug: seed.freeGallerySlug || `${seed.slug}-free`,
          slugHistory: [seed.freeGallerySlug || `${seed.slug}-free`],
          discoverSquareCropEnabled,
          defaultAiDisclosure: aiDisclosure,
          defaultHeavyTopics: heavyTopics,
          visibility: 'free' as const,
          status: seed.freeGalleryStatus || 'published',
          createdAt
        }
      : undefined;

    const premiumGallery = seed.galleries.includes('premium')
      ? {
          galleryId: seedId('gallery', seed.slug, 'premium'),
          artistId,
          artistSlug: seed.slug,
          title: seed.premiumGalleryTitle || `${seed.name} Premium Gallery`,
          slug: seed.premiumGallerySlug || `${seed.slug}-premium`,
          slugHistory: [seed.premiumGallerySlug || `${seed.slug}-premium`],
          discoverSquareCropEnabled,
          defaultAiDisclosure: aiDisclosure,
          defaultHeavyTopics: heavyTopics,
          visibility: 'premium' as const,
          status: seed.premiumGalleryStatus || 'published',
          premiumPasswordHash,
          createdAt
        }
      : undefined;

    const previewGallery = seed.galleries.includes('preview')
      ? {
          galleryId: seedId('gallery', seed.slug, 'preview'),
          artistId,
          artistSlug: seed.slug,
          title: seed.previewGalleryTitle || `${seed.name} Premium Gallery (Preview)`,
          slug: seed.previewGallerySlug || `${seed.slug}-premium-preview`,
          slugHistory: [seed.previewGallerySlug || `${seed.slug}-premium-preview`],
          discoverSquareCropEnabled,
          defaultAiDisclosure: aiDisclosure,
          defaultHeavyTopics: heavyTopics,
          visibility: 'preview' as const,
          pairedPremiumGalleryId: premiumGallery?.galleryId,
          purchaseUrl: seed.purchaseUrl,
          status: seed.previewGalleryStatus || 'published',
          createdAt
        }
      : undefined;

    if (freeGallery) galleries.push(freeGallery);
    if (previewGallery) galleries.push(previewGallery);
    if (premiumGallery) galleries.push(premiumGallery);

    const artistFiles = mediaFiles.filter((file) => normalize(file.filename).startsWith(normalize(seed.filePrefix)));
    const selectedArtistFiles = seed.includePrefixes?.length
      ? artistFiles.filter((file) => seed.includePrefixes!.some((prefix) => normalize(file.filename).startsWith(normalize(prefix))))
      : artistFiles;

    if (seed.includePrefixes?.length) {
      const missingPrefixes = seed.includePrefixes.filter(
        (prefix) => !selectedArtistFiles.some((file) => normalize(file.filename).startsWith(normalize(prefix)))
      );
      if (missingPrefixes.length > 0) {
        throw new Error(`Missing media files for ${seed.name}: ${missingPrefixes.join(', ')}`);
      }
    }

    const imageFiles = selectedArtistFiles
      .filter((file) => IMAGE_EXT.has(path.extname(file.filename).toLowerCase()) && !isPoster(file.filename))
      .sort((a, b) => extractSequence(a.filename) - extractSequence(b.filename));

    const videoFiles = selectedArtistFiles
      .filter((file) => VIDEO_EXT.has(path.extname(file.filename).toLowerCase()))
      .sort((a, b) => extractSequence(a.filename) - extractSequence(b.filename));

    const posterFiles = selectedArtistFiles.filter((file) => IMAGE_EXT.has(path.extname(file.filename).toLowerCase()) && isPoster(file.filename));

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
        media: {
          ...payload,
          appearsInFeed: payload.appearsInFeed !== false
        },
        galleryId: targetGalleryId,
        position
      });
    };

    for (const file of freeImages) {
      const dimensions = await getImageDimensions(file);
      const mediaId = seedId('media', seed.slug, 'free', file.filename);
      const title = titleFromFilename(file.filename);
      const slug = slugify(title);
      const previewKey = `${artistId}/${mediaId}`;
      if (freeGallery) {
        pushMedia(freeGallery.galleryId, freeOrder, {
        mediaId,
        artistId,
        assetType: 'image',
        discoverSquareCropEnabled,
        contentRating,
        aiDisclosure,
        heavyTopics,
        title,
        slug,
        slugHistory: [slug],
        originalFilename: file.filename,
        previewKey,
        width: dimensions.width,
        height: dimensions.height,
        altText: `${seed.name} free image ${freeOrder}`,
        createdAt
      });
      }
      queueUpload(previewKey, file);
      freeOrder += 1;
    }

    for (const file of previewImages) {
      const dimensions = await getImageDimensions(file);
      const mediaId = seedId('media', seed.slug, 'preview', file.filename);
      const title = titleFromFilename(file.filename);
      const slug = slugify(title);
      const previewKey = `${artistId}/${mediaId}`;
      if (previewGallery) {
        pushMedia(previewGallery.galleryId, previewOrder, {
          mediaId,
          artistId,
          assetType: 'image',
          discoverSquareCropEnabled,
          contentRating,
          aiDisclosure,
          heavyTopics,
          title,
          slug,
          slugHistory: [slug],
          originalFilename: file.filename,
          previewKey,
          width: dimensions.width,
          height: dimensions.height,
          altText: `${seed.name} preview image ${previewOrder}`,
          createdAt
        });
        previewOrder += 1;
      }
      queueUpload(previewKey, file);
    }

    for (const file of premiumImages) {
      const dimensions = await getImageDimensions(file);
      const mediaId = seedId('media', seed.slug, 'premium', file.filename);
      const title = titleFromFilename(file.filename);
      const slug = slugify(title);
      const objectKey = `${artistId}/${mediaId}`;
      if (premiumGallery) {
        pushMedia(premiumGallery.galleryId, premiumOrder, {
        mediaId,
        artistId,
        assetType: 'image',
        discoverSquareCropEnabled,
        contentRating,
        aiDisclosure,
        heavyTopics,
        title,
        slug,
        slugHistory: [slug],
        originalFilename: file.filename,
        previewKey: objectKey,
        premiumKey: objectKey,
        width: dimensions.width,
        height: dimensions.height,
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
      const mediaId = seedId('media', seed.slug, 'free', file.filename);
      const title = titleFromFilename(file.filename);
      const slug = slugify(title);
      const previewKey = `${artistId}/${mediaId}`;
      const poster = findPosterForVideo(file);
      const previewPosterKey = poster
        ? `${artistId}/${seedId('poster', seed.slug, 'free', file.filename)}`
        : undefined;

      if (freeGallery) {
        pushMedia(freeGallery.galleryId, freeOrder, {
        mediaId,
        artistId,
        assetType: 'video',
        discoverSquareCropEnabled,
        contentRating,
        aiDisclosure,
        heavyTopics,
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
      const mediaId = seedId('media', seed.slug, 'preview', file.filename);
      const title = titleFromFilename(file.filename);
      const slug = slugify(title);
      const previewKey = `${artistId}/${mediaId}`;
      const poster = findPosterForVideo(file);
      const previewPosterKey = poster
        ? `${artistId}/${seedId('poster', seed.slug, 'preview', file.filename)}`
        : undefined;
      if (previewGallery) {
        pushMedia(previewGallery.galleryId, previewOrder, {
          mediaId,
          artistId,
          assetType: 'video',
          discoverSquareCropEnabled,
          contentRating,
          aiDisclosure,
          heavyTopics,
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
      const mediaId = seedId('media', seed.slug, 'premium', file.filename);
      const title = titleFromFilename(file.filename);
      const slug = slugify(title);
      const objectKey = `${artistId}/${mediaId}`;
      const poster = findPosterForVideo(file);
      const previewPosterKey = poster
        ? `${artistId}/${seedId('poster', seed.slug, 'premium', file.filename)}`
        : undefined;
      const premiumPosterKey = poster
        ? previewPosterKey
        : undefined;

      if (premiumGallery) {
        pushMedia(premiumGallery.galleryId, premiumOrder, {
        mediaId,
        artistId,
        assetType: 'video',
        discoverSquareCropEnabled,
        contentRating,
        aiDisclosure,
        heavyTopics,
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

  console.log(
    `[seed:core] table=${galleryCoreTable} siteSettingsTable=${siteSettingsTable} bucket=${mediaBucket} region=${config.awsRegion} dryRun=${dryRun} reset=${reset} preserveMedia=${preserveMedia} stack=${stackName || 'auto'}`
  );
  if (scenarioInputs) {
    console.log(`[seed:core] scenarioFile=${scenarioInputs.sourceFile} mediaDir=${mediaDir}`);
  }
  console.log(`[seed:core] artists=${artists.length} galleries=${galleries.length} media=${media.length}`);
  console.log(`[seed:core] siteName=${siteSettings.siteName} theme=${siteSettings.theme} logoKey=${siteSettings.logoKey || 'none'}`);
  console.log(`[seed:core] uploadJobs=${uploadJobs.size} (mediaUpload=${shouldUploadMedia} logoUpload=${shouldUploadLogo} renditions=${shouldGenerateRenditions})`);

  if (dryRun) return;

  if (reset) {
    const deletedCore = await wipeTable(client, galleryCoreTable, ['PK', 'SK']);
    const deletedSettings = await wipeTable(client, siteSettingsTable, ['settingId']);
    const deletedObjects = preserveMedia ? 0 : await wipeBucketPrefixes(s3, mediaBucket, ['']);
    console.log(`[seed:core] reset deleted coreItems=${deletedCore} siteSettingsItems=${deletedSettings} s3Objects=${deletedObjects}`);
    if (preserveMedia) {
      console.log('[seed:core] reset skipped S3 object deletion due to --preserve-media');
    }
  }

  // Remove legacy placeholder seed records from earlier versions.
  await repo.deleteGallery('gallery-free-001');
  await repo.deleteGallery('gallery-premium-001');
  await repo.deleteArtist('artist-featured-001');

  if (shouldUploadMedia) {
    for (const [key, job] of uploadJobs.entries()) {
      const body = createReadStream(job.localPath);
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
      item.media.width = generated.sourceWidth;
      item.media.height = generated.sourceHeight;
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
