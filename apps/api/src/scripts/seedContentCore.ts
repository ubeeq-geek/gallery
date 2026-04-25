import { DescribeTableCommand, DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DeleteObjectsCommand, HeadBucketCommand, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { hashPassword } from '../unlock';
import { loadConfig } from '../config';
import { ContentCoreRepository } from '../contentCoreRepository';
import type {
  AiDisclosure,
  Creator as CreatorRecord,
  ContentRating,
  Grouping as GroupingRecord,
  HeavyTopic,
  Media,
  Post,
  PostBlock,
  PostDestination,
  PostDiscoveryMode,
  SiteSettings
} from '../domain';
import { generateCreatorCoverRenditions, generateCreatorProfileRenditions, generateImageRenditions } from '../renditions';

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

type AssetFile = { filename: string; relativePath: string; absolutePath: string };
type GroupingSeedKind = 'free' | 'preview' | 'premium';
type CreatorMediaSeed = {
  file: string;
  groupingSlug: string;
  isPreview?: boolean;
  previewMaxWidth?: number;
  title?: string;
  altText?: string;
  contentRating?: ContentRating;
  aiDisclosure?: AiDisclosure;
  heavyTopics?: HeavyTopic[];
  discoverSquareCropEnabled?: boolean;
  appearsInFeed?: boolean;
  assetType?: 'image' | 'video';
  posterFile?: string;
  durationSeconds?: number;
};
type ScenarioPostMediaRefSeed = {
  mediaId?: string;
  file?: string;
  groupingSlug?: string;
  discoverable?: boolean;
  sortOrder?: number;
  caption?: string;
};
type ScenarioPostDestinationSeed = {
  type?: 'post' | 'pdf' | 'external' | 'internal';
  url?: string;
};
type ScenarioPostPrimaryMediaSeed = {
  mediaId?: string;
  file?: string;
  groupingSlug?: string;
};
type ScenarioPostBlockSeed = {
  blockId?: string;
  type: string;
  text?: string;
  level?: number;
  mediaId?: string;
  file?: string;
  groupingSlug?: string;
  caption?: string;
  quote?: string;
  author?: string;
  url?: string;
  mimeType?: string;
  title?: string;
  html?: string;
  payload?: Record<string, unknown>;
};
type ScenarioPostSeed = {
  title: string;
  slug?: string;
  summary?: string;
  status?: 'draft' | 'published' | 'archived';
  discoveryMode?: PostDiscoveryMode;
  media?: ScenarioPostMediaRefSeed[];
  blocks?: ScenarioPostBlockSeed[];
  primaryMediaId?: string;
  primaryMedia?: ScenarioPostPrimaryMediaSeed;
  destination?: ScenarioPostDestinationSeed | null;
  metadata?: Record<string, string>;
};
type CreatorSeed = {
  name: string;
  slug: string;
  filePrefix?: string;
  includePrefixes?: string[];
  media?: CreatorMediaSeed[];
  contentRating?: ContentRating;
  aiDisclosure?: AiDisclosure;
  heavyTopics?: HeavyTopic[];
  discoverSquareCropEnabled?: boolean;
  groupings: Array<GroupingSeedKind>;
  freeGroupingTitle?: string;
  freeGroupingSlug?: string;
  freeGroupingStatus?: 'draft' | 'published';
  freeGroupingDefaultPreviewMaxWidth?: number;
  previewGroupingTitle?: string;
  previewGroupingSlug?: string;
  previewGroupingStatus?: 'draft' | 'published';
  previewGroupingDefaultPreviewMaxWidth?: number;
  premiumGroupingTitle?: string;
  premiumGroupingSlug?: string;
  premiumGroupingStatus?: 'draft' | 'published';
  premiumGroupingDefaultPreviewMaxWidth?: number;
  premiumPassword?: string;
  purchaseUrl?: string;
  branding?: ScenarioCreatorSeed['branding'];
  posts?: ScenarioPostSeed[];
  usesImplicitDefaultGrouping?: boolean;
};

type ScenarioGroupingSeed = {
  kind: GroupingSeedKind;
  title?: string;
  slug?: string;
  status?: 'draft' | 'published';
  defaultPreviewMaxWidth?: number;
  purchaseUrl?: string;
  premiumPassword?: string;
};

type ScenarioCreatorSeed = {
  name: string;
  slug: string;
  filePrefix?: string;
  includePrefixes?: string[];
  media?: CreatorMediaSeed[];
  contentRating?: ContentRating;
  aiDisclosure?: AiDisclosure;
  heavyTopics?: HeavyTopic[];
  discoverSquareCropEnabled?: boolean;
  groupings: ScenarioGroupingSeed[];
  branding?: {
    profileImage?: {
      file: string;
      altText?: string;
      squareCrop?: { x: number; y: number; size: number };
    };
    coverImage?: {
      file: string;
      altText?: string;
      focalPoint?: { x: number; y: number };
      crops?: {
        desktop?: { x: number; y: number; width: number; height: number };
        tablet?: { x: number; y: number; width: number; height: number };
        mobile?: { x: number; y: number; width: number; height: number };
      };
    };
  };
  posts?: ScenarioPostSeed[];
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
  creators: ScenarioCreatorSeed[];
};

type SeedScenarioInputs = {
  creatorSeeds: CreatorSeed[];
  mediaDir: string;
  stackName?: string;
  siteName?: string;
  theme?: SiteSettings['theme'];
  logoKey?: string;
  logoFile?: string;
  sourceFile: string;
};

type StackTargets = {
  contentCoreTable?: string;
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

const assertUniqueCreatorSeedSlugs = (seeds: CreatorSeed[]): void => {
  const seen = new Set<string>();
  for (const seed of seeds) {
    const normalized = slugify(seed.slug);
    if (seen.has(normalized)) {
      throw new Error(`Duplicate creator slug in seed data: ${normalized}`);
    }
    seen.add(normalized);
  }
};

const normalizePostStatus = (value: ScenarioPostSeed['status']): Post['status'] => {
  if (value === 'draft' || value === 'archived' || value === 'published') return value;
  return 'published';
};

const normalizeDiscoveryMode = (value: ScenarioPostSeed['discoveryMode']): PostDiscoveryMode => {
  if (value === 'all' || value === 'selected') return value;
  return 'primary';
};

const sanitizeOptional = (value: string | undefined, maxLength: number): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
};

const composeMediaLookupKey = (file: string, groupingSlug: string): string =>
  `${normalize(file)}::${slugify(groupingSlug)}`;

const resolveScenarioMediaId = (
  ref: { mediaId?: string; file?: string; groupingSlug?: string } | undefined,
  label: string,
  mediaIdByComposite: Map<string, string>,
  mediaIdsByFile: Map<string, string[]>
): string | undefined => {
  if (!ref) return undefined;
  const explicitMediaId = sanitizeOptional(ref.mediaId, 128);
  if (explicitMediaId) return explicitMediaId;
  const file = sanitizeOptional(ref.file, 512);
  if (!file) {
    throw new Error(`Scenario ${label} must include mediaId or file`);
  }
  const fileNorm = normalize(file);
  if (ref.groupingSlug) {
    const direct = mediaIdByComposite.get(composeMediaLookupKey(fileNorm, ref.groupingSlug));
    if (!direct) {
      throw new Error(`Scenario ${label} references unknown media "${file}" for groupingSlug "${ref.groupingSlug}"`);
    }
    return direct;
  }
  const candidates = mediaIdsByFile.get(fileNorm) || [];
  if (candidates.length === 0) {
    throw new Error(`Scenario ${label} references unknown media file "${file}"`);
  }
  if (candidates.length > 1) {
    throw new Error(`Scenario ${label} references ambiguous media file "${file}". Add groupingSlug.`);
  }
  return candidates[0];
};

const listScenarioMediaFiles = (rootDir: string): AssetFile[] => {
  const output: AssetFile[] = [];
  const visit = (relativeDir: string) => {
    const absoluteDir = path.join(rootDir, relativeDir);
    const names = readdirSync(absoluteDir).filter((name) => !name.startsWith('.'));
    for (const name of names) {
      const rel = relativeDir ? path.join(relativeDir, name) : name;
      const absolutePath = path.join(rootDir, rel);
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        visit(rel);
        continue;
      }
      output.push({
        filename: path.basename(name),
        relativePath: rel,
        absolutePath
      });
    }
  };
  visit('');
  return output;
};

const toSeedPostBlocks = (
  blocks: ScenarioPostBlockSeed[] | undefined,
  mediaIdByComposite: Map<string, string>,
  mediaIdsByFile: Map<string, string[]>,
  postKey: string
): PostBlock[] => {
  if (!blocks?.length) return [];
  return blocks.map((block, index) => {
    const hasMediaRef = Boolean(
      sanitizeOptional(block.mediaId, 128) || sanitizeOptional(block.file, 512)
    );
    const mediaRequired = block.type === 'image' || block.type === 'video' || block.type === 'audio';
    if (mediaRequired && !hasMediaRef) {
      throw new Error(`Scenario ${postKey}.blocks[${index}] of type "${block.type}" must include mediaId or file`);
    }
    const mediaId = hasMediaRef
      ? resolveScenarioMediaId(
        { mediaId: block.mediaId, file: block.file, groupingSlug: block.groupingSlug },
        `${postKey}.blocks[${index}]`,
        mediaIdByComposite,
        mediaIdsByFile
      )
      : undefined;
    const seedBlock: PostBlock = {
      blockId: sanitizeOptional(block.blockId, 128) || `${block.type}-${index + 1}`,
      type: block.type as PostBlock['type'],
      text: sanitizeOptional(block.text, 20000),
      level: typeof block.level === 'number' ? Math.max(1, Math.min(6, Math.floor(block.level))) : undefined,
      mediaId,
      caption: sanitizeOptional(block.caption, 2000),
      quote: sanitizeOptional(block.quote, 4000),
      author: sanitizeOptional(block.author, 200),
      url: sanitizeOptional(block.url, 2048),
      mimeType: sanitizeOptional(block.mimeType, 255),
      title: sanitizeOptional(block.title, 300),
      html: sanitizeOptional(block.html, 50000),
      payload: block.payload
    };
    return JSON.parse(JSON.stringify(seedBlock)) as PostBlock;
  });
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

const CONTENT_RATINGS: ContentRating[] = ['general', 'suggestive', 'mature', 'sexual', 'fetish', 'graphic'];
const AI_DISCLOSURES: AiDisclosure[] = ['none', 'ai-assisted', 'ai-generated'];
const HEAVY_TOPICS: HeavyTopic[] = ['politics-public-affairs', 'crime-disasters-tragedy'];
const POST_BLOCK_TYPES = new Set([
  'heading',
  'paragraph',
  'image',
  'video',
  'audio',
  'quote',
  'divider',
  'embed',
  'file',
  'link',
  'grouping',
  'carousel',
  'pdf_preview',
  'html_fragment'
]);

const parseOptionalContentRating = (value: unknown, fieldName: string): ContentRating | undefined => {
  const raw = asOptionalString(value);
  if (!raw) return undefined;
  if (!CONTENT_RATINGS.includes(raw as ContentRating)) {
    throw new Error(`Scenario field "${fieldName}" is invalid`);
  }
  return raw as ContentRating;
};

const parseOptionalAiDisclosure = (value: unknown, fieldName: string): AiDisclosure | undefined => {
  const raw = asOptionalString(value);
  if (!raw) return undefined;
  if (!AI_DISCLOSURES.includes(raw as AiDisclosure)) {
    throw new Error(`Scenario field "${fieldName}" is invalid`);
  }
  return raw as AiDisclosure;
};

const parseOptionalHeavyTopics = (value: unknown, fieldName: string): HeavyTopic[] | undefined => {
  const raw = parseOptionalStringArray(value, fieldName);
  if (!raw) return undefined;
  for (const topic of raw) {
    if (!HEAVY_TOPICS.includes(topic as HeavyTopic)) {
      throw new Error(`Scenario field "${fieldName}" contains invalid value "${topic}"`);
    }
  }
  return raw as HeavyTopic[];
};

const parseScenarioPostMediaRef = (value: unknown, fieldName: string): ScenarioPostMediaRefSeed => {
  if (!isRecord(value)) {
    throw new Error(`Scenario field "${fieldName}" must be an object`);
  }
  const mediaId = asOptionalString(value.mediaId);
  const file = asOptionalString(value.file);
  const groupingSlugRaw = asOptionalString(value.groupingSlug);
  if (!mediaId && !file) {
    throw new Error(`Scenario field "${fieldName}" must include mediaId or file`);
  }
  const sortOrderRaw = value.sortOrder;
  const sortOrder =
    typeof sortOrderRaw === 'number' && Number.isFinite(sortOrderRaw) && sortOrderRaw >= 0
      ? Math.floor(sortOrderRaw)
      : undefined;
  if (sortOrderRaw !== undefined && sortOrder === undefined) {
    throw new Error(`Scenario field "${fieldName}.sortOrder" must be a number >= 0`);
  }
  return {
    mediaId,
    file,
    groupingSlug: groupingSlugRaw ? slugify(groupingSlugRaw) : undefined,
    discoverable: asOptionalBoolean(value.discoverable),
    sortOrder,
    caption: asOptionalString(value.caption)
  };
};

const parseScenarioPostBlock = (value: unknown, fieldName: string): ScenarioPostBlockSeed => {
  if (!isRecord(value)) {
    throw new Error(`Scenario field "${fieldName}" must be an object`);
  }
  const type = asString(value.type, `${fieldName}.type`);
  if (!POST_BLOCK_TYPES.has(type)) {
    throw new Error(`Scenario field "${fieldName}.type" is invalid`);
  }
  const levelRaw = value.level;
  const level = typeof levelRaw === 'number' && Number.isFinite(levelRaw)
    ? Math.max(1, Math.min(6, Math.floor(levelRaw)))
    : undefined;
  if (levelRaw !== undefined && level === undefined) {
    throw new Error(`Scenario field "${fieldName}.level" must be a number`);
  }
  const payload = value.payload;
  if (payload !== undefined && (!isRecord(payload))) {
    throw new Error(`Scenario field "${fieldName}.payload" must be an object`);
  }
  return {
    blockId: asOptionalString(value.blockId),
    type,
    text: asOptionalString(value.text),
    level,
    mediaId: asOptionalString(value.mediaId),
    file: asOptionalString(value.file),
    groupingSlug: asOptionalString(value.groupingSlug),
    caption: asOptionalString(value.caption),
    quote: asOptionalString(value.quote),
    author: asOptionalString(value.author),
    url: asOptionalString(value.url),
    mimeType: asOptionalString(value.mimeType),
    title: asOptionalString(value.title),
    html: asOptionalString(value.html),
    payload: payload as Record<string, unknown> | undefined
  };
};

const parseScenarioPost = (value: unknown, fieldName: string): ScenarioPostSeed => {
  if (!isRecord(value)) {
    throw new Error(`Scenario field "${fieldName}" must be an object`);
  }
  const title = asString(value.title, `${fieldName}.title`);
  const slug = asOptionalString(value.slug);
  const summary = asOptionalString(value.summary);
  const statusRaw = asOptionalString(value.status);
  if (statusRaw && statusRaw !== 'draft' && statusRaw !== 'published' && statusRaw !== 'archived') {
    throw new Error(`Scenario field "${fieldName}.status" must be draft, published, or archived`);
  }
  const discoveryModeRaw = asOptionalString(value.discoveryMode);
  if (discoveryModeRaw && discoveryModeRaw !== 'primary' && discoveryModeRaw !== 'all' && discoveryModeRaw !== 'selected') {
    throw new Error(`Scenario field "${fieldName}.discoveryMode" must be primary, all, or selected`);
  }

  const mediaRaw = value.media;
  const media = Array.isArray(mediaRaw)
    ? mediaRaw.map((item, idx) => parseScenarioPostMediaRef(item, `${fieldName}.media[${idx}]`))
    : undefined;
  if (mediaRaw !== undefined && !Array.isArray(mediaRaw)) {
    throw new Error(`Scenario field "${fieldName}.media" must be an array`);
  }

  const blocksRaw = value.blocks;
  const blocks = Array.isArray(blocksRaw)
    ? blocksRaw.map((item, idx) => parseScenarioPostBlock(item, `${fieldName}.blocks[${idx}]`))
    : undefined;
  if (blocksRaw !== undefined && !Array.isArray(blocksRaw)) {
    throw new Error(`Scenario field "${fieldName}.blocks" must be an array`);
  }

  const primaryMediaId = asOptionalString(value.primaryMediaId);
  const primaryMediaRaw = value.primaryMedia;
  let primaryMedia: ScenarioPostPrimaryMediaSeed | undefined;
  if (primaryMediaRaw !== undefined) {
    if (!isRecord(primaryMediaRaw)) {
      throw new Error(`Scenario field "${fieldName}.primaryMedia" must be an object`);
    }
    const mediaId = asOptionalString(primaryMediaRaw.mediaId);
    const file = asOptionalString(primaryMediaRaw.file);
    const groupingSlugRaw = asOptionalString(primaryMediaRaw.groupingSlug);
    if (!mediaId && !file) {
      throw new Error(`Scenario field "${fieldName}.primaryMedia" must include mediaId or file`);
    }
    primaryMedia = {
      mediaId,
      file,
      groupingSlug: groupingSlugRaw ? slugify(groupingSlugRaw) : undefined
    };
  }

  const destinationRaw = value.destination;
  let destination: ScenarioPostDestinationSeed | null | undefined;
  if (destinationRaw === null) {
    destination = null;
  } else if (destinationRaw !== undefined) {
    if (!isRecord(destinationRaw)) {
      throw new Error(`Scenario field "${fieldName}.destination" must be an object or null`);
    }
    const type = asOptionalString(destinationRaw.type);
    if (type && type !== 'post' && type !== 'pdf' && type !== 'external' && type !== 'internal') {
      throw new Error(`Scenario field "${fieldName}.destination.type" is invalid`);
    }
    destination = {
      type: type as ScenarioPostDestinationSeed['type'] | undefined,
      url: asOptionalString(destinationRaw.url)
    };
  }

  const metadataRaw = value.metadata;
  let metadata: Record<string, string> | undefined;
  if (metadataRaw !== undefined) {
    if (!isRecord(metadataRaw)) {
      throw new Error(`Scenario field "${fieldName}.metadata" must be an object`);
    }
    metadata = {};
    for (const [key, itemValue] of Object.entries(metadataRaw)) {
      if (typeof itemValue === 'string') {
        metadata[key.slice(0, 120)] = itemValue.slice(0, 1000);
      }
    }
  }

  return {
    title,
    slug,
    summary,
    status: statusRaw as 'draft' | 'published' | 'archived' | undefined,
    discoveryMode: discoveryModeRaw as PostDiscoveryMode | undefined,
    media,
    blocks,
    primaryMediaId,
    primaryMedia,
    destination,
    metadata
  };
};

const parseScenarioCreatorMedia = (value: unknown, fieldName: string): CreatorMediaSeed => {
  if (!isRecord(value)) {
    throw new Error(`Scenario field "${fieldName}" must be an object`);
  }
  const file = asString(value.file, `${fieldName}.file`);
  const groupingSlug = slugify(asString(value.groupingSlug, `${fieldName}.groupingSlug`));
  const assetType = asOptionalString(value.assetType);
  if (assetType && assetType !== 'image' && assetType !== 'video') {
    throw new Error(`Scenario field "${fieldName}.assetType" must be image or video`);
  }
  const durationSecondsRaw = value.durationSeconds;
  const durationSeconds =
    typeof durationSecondsRaw === 'number' && Number.isFinite(durationSecondsRaw) && durationSecondsRaw > 0
      ? durationSecondsRaw
      : undefined;
  if (durationSecondsRaw !== undefined && durationSeconds === undefined) {
    throw new Error(`Scenario field "${fieldName}.durationSeconds" must be a positive number`);
  }
  const previewMaxWidthRaw = value.previewMaxWidth;
  const previewMaxWidth =
    typeof previewMaxWidthRaw === 'number' && Number.isFinite(previewMaxWidthRaw) && previewMaxWidthRaw > 0
      ? Math.floor(previewMaxWidthRaw)
      : undefined;
  if (previewMaxWidthRaw !== undefined && previewMaxWidth === undefined) {
    throw new Error(`Scenario field "${fieldName}.previewMaxWidth" must be a positive number`);
  }

  return {
    file,
    groupingSlug,
    isPreview: asOptionalBoolean(value.isPreview),
    previewMaxWidth,
    title: asOptionalString(value.title),
    altText: asOptionalString(value.altText),
    contentRating: parseOptionalContentRating(value.contentRating, `${fieldName}.contentRating`),
    aiDisclosure: parseOptionalAiDisclosure(value.aiDisclosure, `${fieldName}.aiDisclosure`),
    heavyTopics: parseOptionalHeavyTopics(value.heavyTopics, `${fieldName}.heavyTopics`),
    discoverSquareCropEnabled: asOptionalBoolean(value.discoverSquareCropEnabled),
    appearsInFeed: asOptionalBoolean(value.appearsInFeed),
    assetType: assetType as 'image' | 'video' | undefined,
    posterFile: asOptionalString(value.posterFile),
    durationSeconds
  };
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

const parseScenarioGrouping = (
  value: unknown,
  fieldName: string
): ScenarioGroupingSeed => {
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
  const defaultPreviewMaxWidthRaw = value.defaultPreviewMaxWidth;
  const defaultPreviewMaxWidth =
    typeof defaultPreviewMaxWidthRaw === 'number' && Number.isFinite(defaultPreviewMaxWidthRaw) && defaultPreviewMaxWidthRaw > 0
      ? Math.floor(defaultPreviewMaxWidthRaw)
      : undefined;
  if (defaultPreviewMaxWidthRaw !== undefined && defaultPreviewMaxWidth === undefined) {
    throw new Error(`Scenario field "${fieldName}.defaultPreviewMaxWidth" must be a positive number`);
  }
  return {
    kind: kindRaw,
    title: asOptionalString(value.title),
    slug: asOptionalString(value.slug),
    status: statusRaw as 'draft' | 'published' | undefined,
    defaultPreviewMaxWidth,
    purchaseUrl: asOptionalString(value.purchaseUrl),
    premiumPassword: asOptionalString(value.premiumPassword)
  };
};

const parseScenarioCreator = (
  value: unknown,
  fieldName: string
): CreatorSeed => {
  if (!isRecord(value)) {
    throw new Error(`Scenario field "${fieldName}" must be an object`);
  }
  const name = asString(value.name, `${fieldName}.name`);
  const slug = slugify(asString(value.slug, `${fieldName}.slug`));
  const filePrefix = asOptionalString(value.filePrefix);
  const includePrefixes = parseOptionalStringArray(value.includePrefixes, `${fieldName}.includePrefixes`);
  const mediaRaw = value.media;
  const media = Array.isArray(mediaRaw)
    ? mediaRaw.map((item, idx) => parseScenarioCreatorMedia(item, `${fieldName}.media[${idx}]`))
    : undefined;
  const postsRaw = value.posts;
  const posts = Array.isArray(postsRaw)
    ? postsRaw.map((item, idx) => parseScenarioPost(item, `${fieldName}.posts[${idx}]`))
    : undefined;
  // filePrefix/media can be omitted; seed falls back to creator slug folder under scenario mediaDir.
  if (postsRaw !== undefined && !Array.isArray(postsRaw)) {
    throw new Error(`Scenario field "${fieldName}.posts" must be an array`);
  }
  const discoverSquareCropEnabled = asOptionalBoolean(value.discoverSquareCropEnabled);
  const groupingsRaw = value.groupings;
  let usesImplicitDefaultGrouping = false;
  const groupings = groupingsRaw === undefined
    ? (() => {
        usesImplicitDefaultGrouping = true;
        return [{
          kind: 'free' as GroupingSeedKind,
          title: undefined,
          slug: `${slug}-default`,
          status: 'published' as const,
          defaultPreviewMaxWidth: undefined,
          purchaseUrl: undefined,
          premiumPassword: undefined
        }];
      })()
    : (() => {
        if (!Array.isArray(groupingsRaw) || groupingsRaw.length === 0) {
          throw new Error(`Scenario field "${fieldName}.groupings" must be a non-empty array`);
        }
        return groupingsRaw.map((item, idx) => parseScenarioGrouping(item, `${fieldName}.groupings[${idx}]`));
      })();
  const groupingByKind = new Map<GroupingSeedKind, ScenarioGroupingSeed>();
  for (const grouping of groupings) {
    if (groupingByKind.has(grouping.kind)) {
      throw new Error(`Scenario field "${fieldName}.groupings" has duplicate kind "${grouping.kind}"`);
    }
    groupingByKind.set(grouping.kind, grouping);
  }

  const contentRating = parseOptionalContentRating(value.contentRating, `${fieldName}.contentRating`);
  const aiDisclosure = parseOptionalAiDisclosure(value.aiDisclosure, `${fieldName}.aiDisclosure`);
  const heavyTopicsRaw = parseOptionalHeavyTopics(value.heavyTopics, `${fieldName}.heavyTopics`);

  const freeGrouping = groupingByKind.get('free');
  const previewGrouping = groupingByKind.get('preview');
  const premiumGrouping = groupingByKind.get('premium');

  return {
    name,
    slug,
    filePrefix,
    includePrefixes,
    media,
    contentRating,
    aiDisclosure,
    heavyTopics: heavyTopicsRaw as HeavyTopic[] | undefined,
    discoverSquareCropEnabled,
    groupings: Array.from(groupingByKind.keys()),
    freeGroupingTitle: freeGrouping?.title,
    freeGroupingSlug: freeGrouping?.slug,
    freeGroupingStatus: freeGrouping?.status,
    freeGroupingDefaultPreviewMaxWidth: freeGrouping?.defaultPreviewMaxWidth,
    previewGroupingTitle: previewGrouping?.title,
    previewGroupingSlug: previewGrouping?.slug,
    previewGroupingStatus: previewGrouping?.status,
    previewGroupingDefaultPreviewMaxWidth: previewGrouping?.defaultPreviewMaxWidth,
    premiumGroupingTitle: premiumGrouping?.title,
    premiumGroupingSlug: premiumGrouping?.slug,
    premiumGroupingStatus: premiumGrouping?.status,
    premiumGroupingDefaultPreviewMaxWidth: premiumGrouping?.defaultPreviewMaxWidth,
    premiumPassword: premiumGrouping?.premiumPassword,
    purchaseUrl: previewGrouping?.purchaseUrl,
    branding: value.branding as ScenarioCreatorSeed['branding'] | undefined,
    posts,
    usesImplicitDefaultGrouping
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

  const creatorsRaw = (scenario as Record<string, unknown>).creators;
  if (!Array.isArray(creatorsRaw) || creatorsRaw.length === 0) {
    throw new Error('Scenario field "creators" must be a non-empty array');
  }
  const parsedCreators = creatorsRaw.map((item, idx) => parseScenarioCreator(item, `creators[${idx}]`));

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
    creatorSeeds: parsedCreators,
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
    contentCoreTable: outputByKey.get('ContentCoreTableName'),
    siteSettingsTable: outputByKey.get('SiteSettingsTableName'),
    mediaBucket: outputByKey.get('MediaBucketName')
  };
};

const imageDimensionCache = new Map<string, { width: number; height: number }>();

const getImageDimensions = async (file: AssetFile): Promise<{ width: number; height: number }> => {
  const cached = imageDimensionCache.get(file.absolutePath);
  if (cached) return cached;
  const width = 1920;
  const height = 1080;
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
    const aScore = a.startsWith('UbeeqStack-') ? 0 : 1;
    const bScore = b.startsWith('UbeeqStack-') ? 0 : 1;
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
    const aScore = a.startsWith('ubeeqstack-') ? 0 : 1;
    const bScore = b.startsWith('ubeeqstack-') ? 0 : 1;
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

  const groupingCoreTableArg = getArgValue('--content-core-table');
  const siteSettingsTableArg = getArgValue('--site-settings-table');
  const mediaBucketArg = getArgValue('--media-bucket');
  const stackNameArg = getArgValue('--stack-name');
  const stackName = stackNameArg || scenarioInputs?.stackName;
  if (!stackName) {
    throw new Error(
      'Stack name is required. Provide --stack-name <name> or set siteSettings.stackName in the scenario file.'
    );
  }

  const groupingCoreTableRequested =
    groupingCoreTableArg || (stackName ? undefined : config.contentCoreTable);
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
  const activeCreatorSeeds = scenarioInputs.creatorSeeds;

  assertUniqueCreatorSeedSlugs(activeCreatorSeeds);

  if (!existsSync(mediaDir)) {
    throw new Error(`Media directory not found: ${mediaDir}`);
  }

  const mediaFiles = listScenarioMediaFiles(mediaDir);
  const mediaFileByRelativePath = new Map(
    mediaFiles.map((file) => [normalize(file.relativePath.replace(/\\/g, '/')), file])
  );
  const mediaFilesByName = new Map<string, AssetFile[]>();
  for (const file of mediaFiles) {
    const key = normalize(file.filename);
    const existing = mediaFilesByName.get(key) || [];
    existing.push(file);
    mediaFilesByName.set(key, existing);
  }
  const resolveMediaFile = (ref: string): AssetFile | undefined => {
    const normalizedRef = normalize(ref.replace(/\\/g, '/'));
    const byRelativePath = mediaFileByRelativePath.get(normalizedRef);
    if (byRelativePath) return byRelativePath;
    const byBasename = mediaFilesByName.get(normalize(path.basename(ref)));
    if (!byBasename?.length) return undefined;
    if (byBasename.length > 1) {
      throw new Error(`Ambiguous media file reference "${ref}". Use creator-slug/file.ext path.`);
    }
    return byBasename[0];
  };

  const lowLevel = new DynamoDBClient({ region: config.awsRegion });
  const cloudFormation = new CloudFormationClient({ region: config.awsRegion });
  const s3 = new S3Client({ region: config.awsRegion });
  const stackTargets = stackName ? await readStackTargets(cloudFormation, stackName) : {};
  const groupingCoreTable = await discoverTableName(
    lowLevel,
    groupingCoreTableRequested || stackTargets.contentCoreTable || '',
    'ContentCoreTable'
  );
  const siteSettingsTable = await discoverTableName(
    lowLevel,
    siteSettingsTableRequested || stackTargets.siteSettingsTable || '',
    'SiteSettingsTable'
  );
  const mediaBucket = await discoverMediaBucket(s3, mediaBucketArg || stackTargets.mediaBucket || config.mediaBucket);

  const client = DynamoDBDocumentClient.from(lowLevel);
  const repo = new ContentCoreRepository(client, groupingCoreTable);

  const creators: CreatorRecord[] = [];
  const groupings: GroupingRecord[] = [];
  const posts: Post[] = [];
  const media: Array<{
    media: Media;
    groupingId: string;
    position: number;
    placement?: {
      isPreview?: boolean;
      previewMaxWidth?: number;
    };
  }> = [];
  const uploadJobs = new Map<string, { localPath: string; contentType: string }>();

  const queueUpload = (key: string | undefined, file: AssetFile) => {
    if (!key) return;
    if (!uploadJobs.has(key)) {
      uploadJobs.set(key, { localPath: file.absolutePath, contentType: contentTypeForFile(file.filename) });
    }
  };

  for (let idx = 0; idx < activeCreatorSeeds.length; idx += 1) {
    const seed = activeCreatorSeeds[idx];
    const createdAt = nowIso();
    const creatorId = seedId('creator', seed.slug);
    const contentRating: ContentRating = seed.contentRating || 'general';
    const aiDisclosure: AiDisclosure = seed.aiDisclosure || 'none';
    const heavyTopics: HeavyTopic[] = seed.heavyTopics || [];
    const discoverSquareCropEnabled = seed.discoverSquareCropEnabled ?? true;
    const premiumPasswordHash = await hashPassword(seed.premiumPassword || premiumPassword);

    const creator: CreatorRecord = {
      creatorId: creatorId,
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

    if (seed.branding?.profileImage?.file) {
      const profileFile = resolveMediaFile(seed.branding.profileImage.file);
      if (!profileFile) {
        throw new Error(`Creator ${seed.slug} branding.profileImage.file not found: ${seed.branding.profileImage.file}`);
      }
      const sourceKey = `${creatorId}/branding/profile/source`;
      queueUpload(sourceKey, profileFile);
      creator.branding = {
        ...(creator.branding || {}),
        profileImage: {
          sourceKey,
          squareCrop: seed.branding.profileImage.squareCrop,
          altText: seed.branding.profileImage.altText,
          updatedAt: createdAt
        }
      };
    }

    if (seed.branding?.coverImage?.file) {
      const coverFile = resolveMediaFile(seed.branding.coverImage.file);
      if (!coverFile) {
        throw new Error(`Creator ${seed.slug} branding.coverImage.file not found: ${seed.branding.coverImage.file}`);
      }
      const sourceKey = `${creatorId}/branding/cover/source`;
      queueUpload(sourceKey, coverFile);
      creator.branding = {
        ...(creator.branding || {}),
        coverImage: {
          sourceKey,
          focalPoint: seed.branding.coverImage.focalPoint,
          crops: seed.branding.coverImage.crops,
          altText: seed.branding.coverImage.altText,
          updatedAt: createdAt
        }
      };
    }
    creators.push(creator);

    const defaultFreeSlug = seed.freeGroupingSlug || `${seed.slug}-default`;
    const freeGrouping = seed.groupings.includes('free')
      ? {
          groupingId: seedId('grouping', seed.slug, seed.usesImplicitDefaultGrouping ? 'default' : 'free'),
          creatorId: creatorId,
          creatorSlug: seed.slug,
          title: seed.usesImplicitDefaultGrouping
            ? (seed.freeGroupingTitle || 'Original Series')
            : (seed.freeGroupingTitle || `${seed.name} Free Grouping`),
          isDefaultStream: seed.usesImplicitDefaultGrouping || undefined,
          slug: seed.usesImplicitDefaultGrouping ? defaultFreeSlug : (seed.freeGroupingSlug || `${seed.slug}-free`),
          slugHistory: [seed.usesImplicitDefaultGrouping ? defaultFreeSlug : (seed.freeGroupingSlug || `${seed.slug}-free`)],
          discoverSquareCropEnabled,
          defaultAiDisclosure: aiDisclosure,
          defaultHeavyTopics: heavyTopics,
          visibility: 'free' as const,
          defaultPreviewMaxWidth: seed.freeGroupingDefaultPreviewMaxWidth,
          status: seed.freeGroupingStatus || 'published',
          createdAt
        }
      : undefined;

    const premiumGrouping = seed.groupings.includes('premium')
      ? {
          groupingId: seedId('grouping', seed.slug, 'premium'),
          creatorId: creatorId,
          creatorSlug: seed.slug,
          title: seed.premiumGroupingTitle || `${seed.name} Premium Grouping`,
          slug: seed.premiumGroupingSlug || `${seed.slug}-premium`,
          slugHistory: [seed.premiumGroupingSlug || `${seed.slug}-premium`],
          discoverSquareCropEnabled,
          defaultAiDisclosure: aiDisclosure,
          defaultHeavyTopics: heavyTopics,
          visibility: 'premium' as const,
          defaultPreviewMaxWidth: seed.premiumGroupingDefaultPreviewMaxWidth,
          status: seed.premiumGroupingStatus || 'published',
          premiumPasswordHash,
          createdAt
        }
      : undefined;

    const previewGrouping = seed.groupings.includes('preview')
      ? {
          groupingId: seedId('grouping', seed.slug, 'preview'),
          creatorId: creatorId,
          creatorSlug: seed.slug,
          title: seed.previewGroupingTitle || `${seed.name} Premium Grouping (Preview)`,
          slug: seed.previewGroupingSlug || `${seed.slug}-premium-preview`,
          slugHistory: [seed.previewGroupingSlug || `${seed.slug}-premium-preview`],
          discoverSquareCropEnabled,
          defaultAiDisclosure: aiDisclosure,
          defaultHeavyTopics: heavyTopics,
          visibility: 'preview' as const,
          pairedPremiumGroupingId: premiumGrouping?.groupingId,
          purchaseUrl: seed.purchaseUrl,
          defaultPreviewMaxWidth: seed.previewGroupingDefaultPreviewMaxWidth,
          status: seed.previewGroupingStatus || 'published',
          createdAt
        }
      : undefined;

    const creatorGroupings: GroupingRecord[] = [];
    if (freeGrouping) creatorGroupings.push(freeGrouping);
    if (previewGrouping) creatorGroupings.push(previewGrouping);
    if (premiumGrouping) creatorGroupings.push(premiumGrouping);
    groupings.push(...creatorGroupings);

    const groupingIdByKind: Partial<Record<GroupingSeedKind, string>> = {
      free: freeGrouping?.groupingId,
      preview: previewGrouping?.groupingId,
      premium: premiumGrouping?.groupingId
    };
    const mediaIdByComposite = new Map<string, string>();
    const mediaIdsByFile = new Map<string, string[]>();
    const groupingBySlug = new Map<string, GroupingRecord>();
    for (const grouping of creatorGroupings) {
      groupingBySlug.set(grouping.slug, grouping);
    }
    const nextPositionByKind: Record<GroupingSeedKind, number> = { free: 1, preview: 1, premium: 1 };
    const nextPositionByGroupingSlug = new Map<string, number>();
    const pushMedia = (
      targetGroupingId: string,
      position: number,
      payload: Media,
      placement?: {
        isPreview?: boolean;
        previewMaxWidth?: number;
      }
    ) => {
      media.push({
        media: {
          ...payload,
          appearsInFeed: payload.appearsInFeed !== false
        },
        groupingId: targetGroupingId,
        position,
        placement
      });
    };
    const registerMediaLookup = (file: AssetFile, groupingSlug: string, mediaId: string) => {
      const keys = Array.from(
        new Set([
          normalize(file.filename),
          normalize(file.relativePath.replace(/\\/g, '/'))
        ])
      );
      for (const fileNorm of keys) {
        mediaIdByComposite.set(composeMediaLookupKey(fileNorm, groupingSlug), mediaId);
        const fileList = mediaIdsByFile.get(fileNorm) || [];
        fileList.push(mediaId);
        mediaIdsByFile.set(fileNorm, fileList);
      }
    };
    const pushMediaToKind = (
      kind: GroupingSeedKind,
      payload: Media,
      placement?: {
        isPreview?: boolean;
        previewMaxWidth?: number;
      }
    ) => {
      const groupingId = groupingIdByKind[kind];
      if (!groupingId) {
        throw new Error(`Creator ${seed.name} media references "${kind}" grouping, but that grouping kind is not configured`);
      }
      const position = nextPositionByKind[kind];
      nextPositionByKind[kind] += 1;
      pushMedia(groupingId, position, payload, placement);
    };
    const pushMediaToGroupingSlug = (
      groupingSlug: string,
      payload: Media,
      placement?: {
        isPreview?: boolean;
        previewMaxWidth?: number;
      }
    ) => {
      const grouping = groupingBySlug.get(groupingSlug);
      if (!grouping) {
        throw new Error(`Creator ${seed.name} media references unknown groupingSlug "${groupingSlug}"`);
      }
      const nextPosition = (nextPositionByGroupingSlug.get(groupingSlug) ?? 1);
      nextPositionByGroupingSlug.set(groupingSlug, nextPosition + 1);
      pushMedia(grouping.groupingId, nextPosition, payload, placement);
      return grouping;
    };

    if (seed.media?.length) {
      const posterFiles = mediaFiles.filter((file) => IMAGE_EXT.has(path.extname(file.filename).toLowerCase()) && isPoster(file.filename));
      const findPosterForVideo = (videoFile: AssetFile): AssetFile | undefined => {
        const base = normalize(videoFile.filename).replace(path.extname(videoFile.filename).toLowerCase(), '');
        return posterFiles.find((poster) => {
          const p = normalize(poster.filename);
          return p.includes(base) || p.includes(base.replace('-video', ''));
        });
      };

      for (const mediaSeed of seed.media) {
        const file = resolveMediaFile(mediaSeed.file);
        if (!file) {
          throw new Error(`Media file not found for ${seed.name}: ${mediaSeed.file}`);
        }
        const ext = path.extname(file.filename).toLowerCase();
        const inferredAssetType: 'image' | 'video' = VIDEO_EXT.has(ext) ? 'video' : 'image';
        const assetType = mediaSeed.assetType || inferredAssetType;
        if (assetType === 'image' && !IMAGE_EXT.has(ext)) {
          throw new Error(`Media file "${file.filename}" is not an image but was configured as image`);
        }
        if (assetType === 'video' && !VIDEO_EXT.has(ext)) {
          throw new Error(`Media file "${file.filename}" is not a video but was configured as video`);
        }

        const title = mediaSeed.title || titleFromFilename(file.filename);
        const slug = slugify(title);
        const mediaId = seedId('media', seed.slug, mediaSeed.groupingSlug, file.filename);
        const objectKey = `${creatorId}/${mediaId}`;
        const effectiveContentRating = mediaSeed.contentRating || contentRating;
        const effectiveAiDisclosure = mediaSeed.aiDisclosure || aiDisclosure;
        const effectiveHeavyTopics = mediaSeed.heavyTopics || heavyTopics;
        const effectiveSquareCrop = mediaSeed.discoverSquareCropEnabled ?? discoverSquareCropEnabled;
        const appearsInFeed = mediaSeed.appearsInFeed ?? true;
        const grouping = groupingBySlug.get(mediaSeed.groupingSlug);
        if (!grouping) {
          throw new Error(`Creator ${seed.name} media references unknown groupingSlug "${mediaSeed.groupingSlug}"`);
        }
        const isPremiumGrouping = grouping.visibility === 'premium';

        if (assetType === 'image') {
          const dimensions = await getImageDimensions(file);
          pushMediaToGroupingSlug(mediaSeed.groupingSlug, {
            mediaId,
            creatorId: creatorId,
            assetType: 'image',
            discoverSquareCropEnabled: effectiveSquareCrop,
            contentRating: effectiveContentRating,
            aiDisclosure: effectiveAiDisclosure,
            heavyTopics: effectiveHeavyTopics,
            appearsInFeed,
            title,
            slug,
            slugHistory: [slug],
            originalFilename: file.filename,
            previewKey: objectKey,
            premiumKey: isPremiumGrouping ? objectKey : undefined,
            width: dimensions.width,
            height: dimensions.height,
            altText: mediaSeed.altText,
            createdAt
          }, {
            isPreview: mediaSeed.isPreview,
            previewMaxWidth: mediaSeed.previewMaxWidth
          });
          queueUpload(objectKey, file);
          registerMediaLookup(file, grouping.slug, mediaId);
          continue;
        }

        const explicitPoster = mediaSeed.posterFile ? resolveMediaFile(mediaSeed.posterFile) : undefined;
        if (mediaSeed.posterFile && !explicitPoster) {
          throw new Error(`Poster file not found for ${seed.name}: ${mediaSeed.posterFile}`);
        }
        const poster = explicitPoster || findPosterForVideo(file);
        const posterKey = poster ? `${creatorId}/${seedId('poster', seed.slug, mediaSeed.groupingSlug, file.filename)}` : undefined;
        pushMediaToGroupingSlug(mediaSeed.groupingSlug, {
          mediaId,
          creatorId: creatorId,
          assetType: 'video',
          discoverSquareCropEnabled: effectiveSquareCrop,
          contentRating: effectiveContentRating,
          aiDisclosure: effectiveAiDisclosure,
          heavyTopics: effectiveHeavyTopics,
          appearsInFeed,
          title,
          slug,
          slugHistory: [slug],
          originalFilename: file.filename,
          previewKey: objectKey,
          premiumKey: isPremiumGrouping ? objectKey : undefined,
          previewPosterKey: posterKey,
          premiumPosterKey: isPremiumGrouping ? posterKey : undefined,
          width: 1920,
          height: 1080,
          durationSeconds: mediaSeed.durationSeconds ?? (isPremiumGrouping ? 24 : 20),
          altText: mediaSeed.altText,
          createdAt
        }, {
          isPreview: mediaSeed.isPreview,
          previewMaxWidth: mediaSeed.previewMaxWidth
        });
        queueUpload(objectKey, file);
        if (poster && posterKey) {
          queueUpload(posterKey, poster);
        }
        registerMediaLookup(file, grouping.slug, mediaId);
      }
    } else {
      const normalizedSlugPrefix = `${normalize(seed.slug)}/`;
      const creatorFiles = seed.filePrefix
        ? mediaFiles.filter((file) => normalize(file.filename).startsWith(normalize(seed.filePrefix as string)))
        : mediaFiles.filter((file) => normalize(file.relativePath.replace(/\\/g, '/')).startsWith(normalizedSlugPrefix));
      if (!seed.filePrefix && creatorFiles.length === 0) {
        throw new Error(`Creator ${seed.name} has no explicit media and no files under media/${seed.slug}/`);
      }
      const selectedCreatorFiles = seed.includePrefixes?.length
        ? creatorFiles.filter((file) => seed.includePrefixes!.some((prefix) => normalize(file.filename).startsWith(normalize(prefix))))
        : creatorFiles;

      if (seed.includePrefixes?.length) {
        const missingPrefixes = seed.includePrefixes.filter(
          (prefix) => !selectedCreatorFiles.some((file) => normalize(file.filename).startsWith(normalize(prefix)))
        );
        if (missingPrefixes.length > 0) {
          throw new Error(`Missing media files for ${seed.name}: ${missingPrefixes.join(', ')}`);
        }
      }

      const imageFiles = selectedCreatorFiles
        .filter((file) => IMAGE_EXT.has(path.extname(file.filename).toLowerCase()) && !isPoster(file.filename))
        .sort((a, b) => extractSequence(a.filename) - extractSequence(b.filename));

      const videoFiles = selectedCreatorFiles
        .filter((file) => VIDEO_EXT.has(path.extname(file.filename).toLowerCase()))
        .sort((a, b) => extractSequence(a.filename) - extractSequence(b.filename));

      const posterFiles = selectedCreatorFiles.filter((file) => IMAGE_EXT.has(path.extname(file.filename).toLowerCase()) && isPoster(file.filename));

      const hasPremiumTier = Boolean(previewGrouping || premiumGrouping);
      const imageSplit = hasPremiumTier
        ? splitByAccess(imageFiles)
        : { free: imageFiles, premium: [] as AssetFile[] };
      const videoSplit = hasPremiumTier
        ? splitByAccess(videoFiles)
        : { free: videoFiles, premium: [] as AssetFile[] };
      const freeImages = freeGrouping ? imageSplit.free : [];
      const previewImages = previewGrouping ? (freeGrouping ? imageSplit.premium : imageSplit.free) : [];
      const premiumImages = premiumGrouping ? imageSplit.premium : [];
      const freeVideos = freeGrouping ? videoSplit.free : [];
      const previewVideos = previewGrouping ? (freeGrouping ? videoSplit.premium : videoSplit.free) : [];
      const premiumVideos = premiumGrouping ? videoSplit.premium : [];

      let freeOrder = 1;
      let previewOrder = 1;
      let premiumOrder = 1;

      for (const file of freeImages) {
        const dimensions = await getImageDimensions(file);
        const mediaId = seedId('media', seed.slug, 'free', file.filename);
        const title = titleFromFilename(file.filename);
        const slug = slugify(title);
        const previewKey = `${creatorId}/${mediaId}`;
        if (freeGrouping) {
          pushMedia(freeGrouping.groupingId, freeOrder, {
          mediaId,
          creatorId: creatorId,
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
        if (freeGrouping) registerMediaLookup(file, freeGrouping.slug, mediaId);
        freeOrder += 1;
      }

      for (const file of previewImages) {
        const dimensions = await getImageDimensions(file);
        const mediaId = seedId('media', seed.slug, 'preview', file.filename);
        const title = titleFromFilename(file.filename);
        const slug = slugify(title);
        const previewKey = `${creatorId}/${mediaId}`;
        if (previewGrouping) {
          pushMedia(previewGrouping.groupingId, previewOrder, {
            mediaId,
            creatorId: creatorId,
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
        if (previewGrouping) registerMediaLookup(file, previewGrouping.slug, mediaId);
      }

      for (const file of premiumImages) {
        const dimensions = await getImageDimensions(file);
        const mediaId = seedId('media', seed.slug, 'premium', file.filename);
        const title = titleFromFilename(file.filename);
        const slug = slugify(title);
        const objectKey = `${creatorId}/${mediaId}`;
        if (premiumGrouping) {
          pushMedia(premiumGrouping.groupingId, premiumOrder, {
          mediaId,
          creatorId: creatorId,
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
        if (premiumGrouping) registerMediaLookup(file, premiumGrouping.slug, mediaId);
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
        const previewKey = `${creatorId}/${mediaId}`;
        const poster = findPosterForVideo(file);
        const previewPosterKey = poster
          ? `${creatorId}/${seedId('poster', seed.slug, 'free', file.filename)}`
          : undefined;

        if (freeGrouping) {
          pushMedia(freeGrouping.groupingId, freeOrder, {
          mediaId,
          creatorId: creatorId,
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
        if (freeGrouping) registerMediaLookup(file, freeGrouping.slug, mediaId);
        freeOrder += 1;
      }

      for (const file of previewVideos) {
        const mediaId = seedId('media', seed.slug, 'preview', file.filename);
        const title = titleFromFilename(file.filename);
        const slug = slugify(title);
        const previewKey = `${creatorId}/${mediaId}`;
        const poster = findPosterForVideo(file);
        const previewPosterKey = poster
          ? `${creatorId}/${seedId('poster', seed.slug, 'preview', file.filename)}`
          : undefined;
        if (previewGrouping) {
          pushMedia(previewGrouping.groupingId, previewOrder, {
            mediaId,
            creatorId: creatorId,
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
        if (previewGrouping) registerMediaLookup(file, previewGrouping.slug, mediaId);
      }

      for (const file of premiumVideos) {
        const mediaId = seedId('media', seed.slug, 'premium', file.filename);
        const title = titleFromFilename(file.filename);
        const slug = slugify(title);
        const objectKey = `${creatorId}/${mediaId}`;
        const poster = findPosterForVideo(file);
        const previewPosterKey = poster
          ? `${creatorId}/${seedId('poster', seed.slug, 'premium', file.filename)}`
          : undefined;
        const premiumPosterKey = poster
          ? previewPosterKey
          : undefined;

        if (premiumGrouping) {
          pushMedia(premiumGrouping.groupingId, premiumOrder, {
          mediaId,
          creatorId: creatorId,
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
        if (premiumGrouping) registerMediaLookup(file, premiumGrouping.slug, mediaId);
        premiumOrder += 1;
      }
    }

    for (const [fileKey, ids] of mediaIdsByFile.entries()) {
      mediaIdsByFile.set(fileKey, Array.from(new Set(ids)));
    }
    if (seed.posts?.length) {
      for (let postIndex = 0; postIndex < seed.posts.length; postIndex += 1) {
        const postSeed = seed.posts[postIndex];
        const status = normalizePostStatus(postSeed.status);
        const slug = slugify(postSeed.slug || postSeed.title);
        const postMedia: Post['media'] = (postSeed.media || []).map((ref, mediaIndex) => ({
          mediaId: resolveScenarioMediaId(
            { mediaId: ref.mediaId, file: ref.file, groupingSlug: ref.groupingSlug },
            `creators[${idx}].posts[${postIndex}].media[${mediaIndex}]`,
            mediaIdByComposite,
            mediaIdsByFile
          ) as string,
          discoverable: ref.discoverable ?? true,
          sortOrder: ref.sortOrder ?? mediaIndex,
          caption: sanitizeOptional(ref.caption, 2000)
        }));
        const primaryMediaId =
          resolveScenarioMediaId(
            postSeed.primaryMedia
              ? {
                  mediaId: postSeed.primaryMedia.mediaId,
                  file: postSeed.primaryMedia.file,
                  groupingSlug: postSeed.primaryMedia.groupingSlug
                }
              : (postSeed.primaryMediaId ? { mediaId: postSeed.primaryMediaId } : undefined),
            `creators[${idx}].posts[${postIndex}].primaryMedia`,
            mediaIdByComposite,
            mediaIdsByFile
          ) || postMedia[0]?.mediaId;
        if (primaryMediaId && !postMedia.some((item) => item.mediaId === primaryMediaId)) {
          postMedia.unshift({ mediaId: primaryMediaId, discoverable: true, sortOrder: 0 });
        }
        const blocks = toSeedPostBlocks(
          postSeed.blocks,
          mediaIdByComposite,
          mediaIdsByFile,
          `creators[${idx}].posts[${postIndex}]`
        );
        const destination: PostDestination | null | undefined =
          postSeed.destination === null
            ? null
            : postSeed.destination
              ? {
                  type: postSeed.destination.type || 'post',
                  url: sanitizeOptional(postSeed.destination.url, 2048) || ''
                }
              : undefined;

        const post: Post = {
          postId: seedId('post', seed.slug, slug),
          creatorId: creatorId,
          title: postSeed.title.trim().slice(0, 300),
          slug,
          slugHistory: [slug],
          summary: sanitizeOptional(postSeed.summary, 2000),
          status,
          blocks,
          media: postMedia,
          primaryMediaId,
          discovery: {
            mode: normalizeDiscoveryMode(postSeed.discoveryMode)
          },
          destination,
          metadata: postSeed.metadata || {},
          createdAt,
          updatedAt: createdAt,
          publishedAt: status === 'published' ? createdAt : undefined
        };
        posts.push(JSON.parse(JSON.stringify(post)) as Post);
      }
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
    `[seed:core] table=${groupingCoreTable} siteSettingsTable=${siteSettingsTable} bucket=${mediaBucket} region=${config.awsRegion} dryRun=${dryRun} reset=${reset} preserveMedia=${preserveMedia} stack=${stackName || 'auto'}`
  );
  if (scenarioInputs) {
    console.log(`[seed:core] scenarioFile=${scenarioInputs.sourceFile} mediaDir=${mediaDir}`);
  }
  console.log(`[seed:core] creators=${creators.length} groupings=${groupings.length} media=${media.length} posts=${posts.length}`);
  console.log(`[seed:core] siteName=${siteSettings.siteName} theme=${siteSettings.theme} logoKey=${siteSettings.logoKey || 'none'}`);
  console.log(`[seed:core] uploadJobs=${uploadJobs.size} (mediaUpload=${shouldUploadMedia} logoUpload=${shouldUploadLogo} renditions=${shouldGenerateRenditions})`);

  if (dryRun) return;

  if (reset) {
    const deletedCore = await wipeTable(client, groupingCoreTable, ['PK', 'SK']);
    const deletedSettings = await wipeTable(client, siteSettingsTable, ['settingId']);
    const deletedObjects = preserveMedia ? 0 : await wipeBucketPrefixes(s3, mediaBucket, ['']);
    console.log(`[seed:core] reset deleted coreItems=${deletedCore} siteSettingsItems=${deletedSettings} s3Objects=${deletedObjects}`);
    if (preserveMedia) {
      console.log('[seed:core] reset skipped S3 object deletion due to --preserve-media');
    }
  }

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
      const creatorKeyPrefix = sourceKey.split('/')[0];
      const generated = await generateImageRenditions({
        s3,
        bucket: mediaBucket,
        sourceKey,
        targetPrefix: `${creatorKeyPrefix}/${item.media.mediaId}`
      });
      item.media.thumbnailKeys = generated.keys;
      item.media.squareCrop = generated.squareCrop;
      item.media.width = generated.sourceWidth;
      item.media.height = generated.sourceHeight;
    }
    console.log('[seed:core] generated image renditions');

    for (const creator of creators) {
      if (creator.branding?.profileImage?.sourceKey) {
        const generated = await generateCreatorProfileRenditions({
          s3,
          bucket: mediaBucket,
          sourceKey: creator.branding.profileImage.sourceKey,
          targetPrefix: `${creator.creatorId}/branding/profile`,
          squareCrop: creator.branding.profileImage.squareCrop
        });
        creator.branding.profileImage.thumbnailKeys = generated.thumbnailKeys;
        creator.branding.profileImage.squareCrop = generated.squareCrop;
        creator.branding.profileImage.updatedAt = nowIso();
      }
      if (creator.branding?.coverImage?.sourceKey) {
        const generated = await generateCreatorCoverRenditions({
          s3,
          bucket: mediaBucket,
          sourceKey: creator.branding.coverImage.sourceKey,
          targetPrefix: `${creator.creatorId}/branding/cover`,
          focalPoint: creator.branding.coverImage.focalPoint,
          crops: creator.branding.coverImage.crops
        });
        creator.branding.coverImage.renditionKeys = generated.renditionKeys;
        creator.branding.coverImage.crops = generated.crops;
        creator.branding.coverImage.focalPoint = generated.focalPoint;
        creator.branding.coverImage.updatedAt = nowIso();
      }
    }
    console.log('[seed:core] generated creator branding renditions');
  }

  for (const creatorRecord of creators) {
    await repo.createCreator(creatorRecord);
  }
  for (const groupingRecord of groupings) {
    await repo.createGrouping(groupingRecord);
  }
  for (const item of media) {
    await repo.createMedia(item.media, item.groupingId, item.position, item.placement);
  }
  for (const post of posts) {
    await repo.createPost(post);
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
