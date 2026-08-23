import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import { promises as dns } from 'dns';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import express from 'express';
import type { AppConfig } from './config';
import type { DataStore } from './store';
import type { PostBlock } from './domain';
import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import { requireAuth } from './auth';

export type WordPressCapabilityProfile = {
  postsRead: boolean; postsWrite: boolean; pagesRead: boolean; pagesWrite: boolean;
  mediaUpload: boolean; categoriesWrite: boolean; tagsWrite: boolean; schedule: boolean;
  authorAssignment: boolean; featuredMedia: boolean; blockFormat: boolean;
  classicHtmlFormat: boolean; webhookAdapter: boolean;
};

export type WordPressConnectionEligibility = 'ALLOWED_MANAGED' | 'CREATOR_OWNED_REQUIRED' | 'PLATFORM_INELIGIBLE' | 'SAFETY_HOLD';

export type WordPressEligibilityPolicy = { managedSiteHosts?: string[]; blockedSiteHosts?: string[]; safetyHoldSiteHosts?: string[] };

export const evaluateWordPressEligibility = (siteUrl: URL, policy: WordPressEligibilityPolicy = {}): { eligibility: WordPressConnectionEligibility; reason: string } => {
  const host = siteUrl.hostname.toLowerCase();
  if ((policy.safetyHoldSiteHosts || []).map((item) => item.toLowerCase()).includes(host)) return { eligibility: 'SAFETY_HOLD', reason: 'External publication is disabled by a site safety hold' };
  if ((policy.blockedSiteHosts || []).map((item) => item.toLowerCase()).includes(host)) return { eligibility: 'PLATFORM_INELIGIBLE', reason: 'This site is not eligible for the WordPress connector' };
  if ((policy.managedSiteHosts || []).map((item) => item.toLowerCase()).includes(host)) return { eligibility: 'ALLOWED_MANAGED', reason: 'Site is in the approved managed cohort' };
  return { eligibility: 'CREATOR_OWNED_REQUIRED', reason: 'A creator-owned connector credential is required' };
};

export type WordPressConnectionRecord = {
  connectionId: string; tenantId: string; creatorId: string; ownerUserId: string;
  siteUrl: string; apiRoot: string; mode: 'CREATOR_OWNED_APPLICATION_PASSWORD';
  username: string; credentialEncrypted: string; state: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'SAFETY_HOLD';
  wpUser?: { id: number; name: string; roles: string[] }; capabilities: WordPressCapabilityProfile;
  compatibilityWarnings: string[]; lastSyncAt?: string; createdAt: string; updatedAt: string;
  eligibility: WordPressConnectionEligibility;
};

export type WordPressPublicationRecord = {
  publicationId: string; connectionId: string; workId: string; ownerUserId: string;
  remoteId?: number; remoteUrl?: string; type: 'posts' | 'pages'; title: string; slug?: string;
  excerpt?: string; content: string; contentHash: string; status: 'draft' | 'future' | 'publish' | 'private';
  scheduledAt?: string; authorId?: number; categories: number[]; tags: number[]; featuredMediaId?: number;
  idempotencyKey: string; state: 'PREVIEW' | 'IN_SYNC' | 'LOCAL_CHANGED' | 'REMOTE_CHANGED' | 'MISSING' | 'REMOVED' | 'FAILED';
  remoteHash?: string; createdAt: string; updatedAt: string;
  remoteSnapshot?: WordPressPostSnapshot;
};

export type WordPressPostSnapshot = {
  title: string; slug: string; excerpt: string; content: string; status: string;
  date: string; author?: number; categories: number[]; tags: number[]; featuredMediaId?: number;
};

export type WordPressFieldDiff = {
  field: keyof WordPressPostSnapshot; local: unknown; remote: unknown;
};

export type WordPressAuditRecord = { auditId: string; actorId: string; action: string; connectionId: string; publicationId?: string; result: 'SUCCESS' | 'FAILED'; correlationId: string; at: string; beforeHash?: string; afterHash?: string };

export type WordPressExternalReferenceRecord = {
  externalReferenceWorkId: string; connectionId: string; creatorId: string;
  remoteId: number; remoteType: 'post' | 'page'; remoteUrl?: string; title: string;
  slug?: string; excerpt?: string; status?: string; authorId?: number; categoryIds: number[];
  tagIds: number[]; publishedAt?: string; modifiedAt?: string; contentHash: string;
  mediaReferences: Array<{ remoteMediaId: number; remoteUrl?: string }>;
  sourceAvailability: 'REFERENCE_ONLY'; mappingState: 'STAGED'; updatedAt: string;
};

export type WordPressMediaMappingRecord = {
  mediaMappingId: string; connectionId: string; publicationId: string; assetId: string;
  remoteMediaId: number; remoteUrl: string; checksum?: string; altText?: string;
  caption?: string; provenance: 'UBEEQ_CANONICAL_ASSET'; createdAt: string;
};

export type WordPressIntegrationState = {
  connections: WordPressConnectionRecord[];
  publications: WordPressPublicationRecord[];
  externalReferences: WordPressExternalReferenceRecord[];
  mediaMappings: WordPressMediaMappingRecord[];
  audits: WordPressAuditRecord[];
};

const routeSupports = (routes: any, route: string, method: string): boolean => {
  const definition = routes?.[route];
  if (!definition) return false;
  if (Array.isArray(definition.methods) && definition.methods.includes(method)) return true;
  return Array.isArray(definition.endpoints)
    && definition.endpoints.some((endpoint: any) => Array.isArray(endpoint?.methods) && endpoint.methods.includes(method));
};

export const detectWordPressCapabilities = (user: any, routes: any): WordPressCapabilityProfile => {
  const can = user?.capabilities || {};
  const has = (route: string, method: string) => routeSupports(routes, route, method);
  return {
    postsRead: has('/wp/v2/posts', 'GET'), postsWrite: has('/wp/v2/posts', 'POST') && !!can.edit_posts,
    pagesRead: has('/wp/v2/pages', 'GET'), pagesWrite: has('/wp/v2/pages', 'POST') && !!can.edit_pages,
    mediaUpload: has('/wp/v2/media', 'POST') && !!can.upload_files,
    categoriesWrite: has('/wp/v2/categories', 'POST') && !!can.manage_categories,
    tagsWrite: has('/wp/v2/tags', 'POST') && !!can.manage_categories,
    schedule: !!can.publish_posts, authorAssignment: !!can.edit_others_posts,
    featuredMedia: has('/wp/v2/media', 'POST'), blockFormat: true, classicHtmlFormat: true, webhookAdapter: false
  };
};

const privateAddress = (address: string) => /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(address);

/** Validate both the URL and every DNS answer immediately before a request. */
export const validateWordPressUrl = async (value: string): Promise<URL> => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('WordPress URL must use standard HTTPS');
  if (url.hostname === 'localhost' || (isIP(url.hostname) && privateAddress(url.hostname))) throw new Error('Private-network WordPress URLs are not allowed');
  const answers = await dns.lookup(url.hostname, { all: true });
  if (!answers.length || answers.some(({ address }) => privateAddress(address))) throw new Error('WordPress host resolves to a private or unavailable address');
  return url;
};

export class WordPressRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'WordPressRequestError';
  }
}

const escapeHtml = (text = '') => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The only route from canonical blocks to WordPress HTML; raw HTML and arbitrary embeds are rejected. */
export type WordPressRenderPolicy = { approvedEmbedHosts?: string[]; format?: 'blocks' | 'classic' };

export const renderWordPressContent = (blocks: PostBlock[] = [], policy: WordPressRenderPolicy = {}): string => blocks.map((block) => {
  if (block.type === 'paragraph') return `<p>${escapeHtml(block.text)}</p>`;
  if (block.type === 'heading') return `<h${Math.min(6, Math.max(2, block.level || 2))}>${escapeHtml(block.text)}</h${Math.min(6, Math.max(2, block.level || 2))}>`;
  if (block.type === 'quote') return `<blockquote><p>${escapeHtml(block.quote || block.text)}</p></blockquote>`;
  if (block.type === 'divider') return '<hr />';
  if (block.type === 'link') {
    const url = new URL(block.url || '');
    if (!['https:', 'mailto:'].includes(url.protocol)) throw new Error('Only HTTPS and email links are supported');
    return `<p><a href="${escapeHtml(url.toString())}" rel="noopener noreferrer">${escapeHtml(block.label || block.text || url.toString())}</a></p>`;
  }
  if (block.type === 'embed') {
    let url: URL;
    try { url = new URL(block.url || ''); } catch { throw new Error('Untrusted WordPress embed provider'); }
    const approved = (policy.approvedEmbedHosts || []).map((host) => host.toLowerCase());
    if (url.protocol !== 'https:' || !approved.includes(url.hostname.toLowerCase()) || url.username || url.password) throw new Error('Untrusted WordPress embed provider');
    const link = `<figure class="wp-block-embed"><div class="wp-block-embed__wrapper">${escapeHtml(url.toString())}</div></figure>`;
    return policy.format === 'classic' ? `<p><a href="${escapeHtml(url.toString())}" rel="noopener noreferrer">${escapeHtml(block.title || url.toString())}</a></p>` : `<!-- wp:embed -->\n${link}\n<!-- /wp:embed -->`;
  }
  if (['html_fragment', 'video', 'audio', 'file', 'pdf_preview'].includes(block.type)) throw new Error(`Unsupported WordPress block: ${block.type}`);
  if (block.type === 'section') return renderWordPressContent(block.blocks || [], policy);
  throw new Error(`Unsupported WordPress block: ${block.type}`);
}).join('\n');

const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const safeView = ({ credentialEncrypted: _secret, ...connection }: WordPressConnectionRecord) => connection;

const rendered = (value: unknown): string => typeof value === 'string'
  ? value
  : typeof (value as any)?.raw === 'string'
    ? (value as any).raw
    : typeof (value as any)?.rendered === 'string' ? (value as any).rendered : '';

export const wordPressPostSnapshot = (post: any): WordPressPostSnapshot => ({
  title: rendered(post?.title), slug: String(post?.slug || ''), excerpt: rendered(post?.excerpt),
  content: rendered(post?.content), status: String(post?.status || ''),
  date: String(post?.date_gmt || post?.date || ''),
  author: Number.isInteger(post?.author) ? post.author : undefined,
  categories: Array.isArray(post?.categories) ? post.categories.filter(Number.isInteger) : [],
  tags: Array.isArray(post?.tags) ? post.tags.filter(Number.isInteger) : [],
  featuredMediaId: Number.isInteger(post?.featured_media) && post.featured_media > 0 ? post.featured_media : undefined
});

const publicationSnapshot = (publication: WordPressPublicationRecord): WordPressPostSnapshot => ({
  title: publication.title, slug: publication.slug || '', excerpt: publication.excerpt || '',
  content: publication.content, status: publication.status, date: publication.scheduledAt || '',
  author: publication.authorId, categories: publication.categories, tags: publication.tags, featuredMediaId: publication.featuredMediaId
});

export const diffWordPressSnapshots = (local: WordPressPostSnapshot, remote: WordPressPostSnapshot): WordPressFieldDiff[] =>
  (Object.keys(local) as Array<keyof WordPressPostSnapshot>).flatMap((field) =>
    JSON.stringify(local[field]) === JSON.stringify(remote[field]) ? [] : [{ field, local: local[field], remote: remote[field] }]
  );

export const signWordPressWebhookEvent = (masterSecret: string, connectionId: string, timestamp: string, eventId: string, remoteType: 'posts' | 'pages', remoteId: number, action: 'updated' | 'deleted'): string => {
  const connectionKey = createHmac('sha256', masterSecret).update(connectionId).digest('base64url');
  return createHmac('sha256', connectionKey).update(`${connectionId}.${timestamp}.${eventId}.${remoteType}.${remoteId}.${action}`).digest('hex');
};

export const createWordPressRouter = (config: AppConfig, store: DataStore) => {
  const router = express.Router();
  const s3 = new S3Client({ region: config.awsRegion });
  const connections = new Map<string, WordPressConnectionRecord>();
  const publications = new Map<string, WordPressPublicationRecord>();
  const externalReferences = new Map<string, WordPressExternalReferenceRecord>();
  const mediaMappings = new Map<string, WordPressMediaMappingRecord>();
  const audits: WordPressAuditRecord[] = [];
  const stateReady = store.getWordPressIntegrationState(config.tenantId).then((state) => {
    state.connections.forEach((item) => connections.set(item.connectionId, item));
    state.publications.forEach((item) => publications.set(item.publicationId, item));
    state.externalReferences.forEach((item) => externalReferences.set(item.externalReferenceWorkId, item));
    state.mediaMappings.forEach((item) => mediaMappings.set(item.mediaMappingId, item));
    audits.push(...state.audits);
  });
  let persistQueue = Promise.resolve();
  const persist = () => {
    const state: WordPressIntegrationState = { connections: [...connections.values()], publications: [...publications.values()], externalReferences: [...externalReferences.values()], mediaMappings: [...mediaMappings.values()], audits: [...audits] };
    persistQueue = persistQueue.then(() => store.putWordPressIntegrationState(config.tenantId, state));
    return persistQueue;
  };
  const record = (actorId: string, action: string, connectionId: string, result: WordPressAuditRecord['result'], correlationId: string, publicationId?: string, beforeHash?: string, afterHash?: string) => audits.push({ auditId: randomUUID(), actorId, action, connectionId, publicationId, result, correlationId, at: new Date().toISOString(), beforeHash, afterHash });
  const owned = (id: string, userId: string) => { const item = connections.get(id); return item?.ownerUserId === userId ? item : undefined; };
  const request = async (connection: WordPressConnectionRecord, path: string, init: RequestInit = {}) => {
    const target = new URL(path.replace(/^\//, ''), `${connection.apiRoot.replace(/\/$/, '')}/`);
    await validateWordPressUrl(target.toString());
    const response = await fetch(target, { ...init, redirect: 'error', headers: { Authorization: `Basic ${Buffer.from(`${connection.username}:${decryptExternalCredential(connection.credentialEncrypted, config.externalTokenEncryptionKey)}`).toString('base64')}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    if (!response.ok) {
      let details: any;
      try { details = await response.json(); } catch { details = undefined; }
      throw new WordPressRequestError(
        typeof details?.message === 'string' ? details.message : `WordPress REST request failed (${response.status})`,
        response.status,
        typeof details?.code === 'string' ? details.code : undefined
      );
    }
    return response.status === 204 ? null : response.json();
  };
  const assetBytes = async (objectKey: string): Promise<Buffer> => {
    if (config.localMediaDirectory) {
      const root = resolve(config.localMediaDirectory);
      const path = resolve(root, objectKey);
      if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error('Canonical asset storage key is invalid');
      return readFile(path);
    }
    const output = await s3.send(new GetObjectCommand({ Bucket: config.mediaBucket, Key: objectKey }));
    if (!output.Body) throw new Error('Canonical asset bytes are unavailable');
    return Buffer.from(await output.Body.transformToByteArray());
  };

  const webhookKey = (connectionId: string): string | undefined => config.wordpressWebhookSecret
    ? createHmac('sha256', config.wordpressWebhookSecret).update(connectionId).digest('base64url')
    : undefined;

  router.use(async (_req, res, next) => {
    try {
      await stateReady;
      res.on('finish', () => { void persist().catch(() => undefined); });
      next();
    } catch {
      res.status(503).json({ message: 'WordPress integration storage is unavailable' });
    }
  });

  router.post('/webhooks/wordpress/:connectionId', (req, res) => {
    const connection = connections.get(req.params.connectionId);
    const key = webhookKey(req.params.connectionId);
    if (!connection || connection.state !== 'CONNECTED' || !key) return res.status(404).json({ message: 'Webhook adapter is not configured' });
    const eventId = typeof req.header('x-wordpress-event-id') === 'string' ? req.header('x-wordpress-event-id')! : '';
    const timestamp = typeof req.header('x-wordpress-timestamp') === 'string' ? req.header('x-wordpress-timestamp')! : '';
    const signature = typeof req.header('x-wordpress-signature') === 'string' ? req.header('x-wordpress-signature')! : '';
    const remoteType = req.body?.type === 'page' ? 'pages' : req.body?.type === 'post' ? 'posts' : '';
    const remoteId = Number.isInteger(req.body?.id) ? req.body.id : 0;
    const action = ['updated', 'deleted'].includes(req.body?.action) ? req.body.action : '';
    const occurredAt = Date.parse(timestamp);
    if (!eventId || !remoteType || !remoteId || !action || !Number.isFinite(occurredAt) || Math.abs(Date.now() - occurredAt) > 300_000) return res.status(400).json({ message: 'Webhook event is invalid or expired' });
    if (audits.some((audit) => audit.action === 'WEBHOOK_RECEIVED' && audit.correlationId === eventId)) return res.status(202).json({ duplicate: true });
    const expected = signWordPressWebhookEvent(config.wordpressWebhookSecret!, connection.connectionId, timestamp, eventId, remoteType, remoteId, action);
    const supplied = signature.replace(/^sha256=/, '');
    const expectedBytes = Buffer.from(expected, 'hex');
    const suppliedBytes = /^[a-f0-9]{64}$/i.test(supplied) ? Buffer.from(supplied, 'hex') : Buffer.alloc(0);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) return res.status(401).json({ message: 'Webhook signature is invalid' });
    const affected = [...publications.values()].filter((publication) => publication.connectionId === connection.connectionId && publication.type === remoteType && publication.remoteId === remoteId);
    affected.forEach((publication) => { publication.state = action === 'deleted' ? 'MISSING' : 'REMOTE_CHANGED'; publication.updatedAt = new Date().toISOString(); });
    record('WORDPRESS_WEBHOOK', 'WEBHOOK_RECEIVED', connection.connectionId, 'SUCCESS', eventId, affected[0]?.publicationId);
    return res.status(202).json({ accepted: true, affectedPublications: affected.length, canonicalWorkChanged: false });
  });

  router.use(requireAuth);
  router.get('/integrations/wordpress/eligibility', async (req, res) => {
    try {
      const site = await validateWordPressUrl(String(req.query.siteUrl || ''));
      return res.json(evaluateWordPressEligibility(site, { managedSiteHosts: config.wordpressManagedSiteHosts, blockedSiteHosts: config.wordpressBlockedSiteHosts }));
    } catch (error) {
      return res.status(400).json({ eligibility: 'PLATFORM_INELIGIBLE', reason: error instanceof Error ? error.message : 'Site URL is invalid' });
    }
  });
  router.post('/integrations/wordpress/connections', async (req, res) => {
    try {
      if (!config.externalTokenEncryptionKey) return res.status(503).json({ message: 'Credential encryption is not configured' });
      const creatorId = String(req.body?.creatorId || '');
      if (!creatorId || !(await store.hasCreatorAccess(req.authUser!.userId, creatorId))) return res.status(403).json({ message: 'Creator access required' });
      const site = await validateWordPressUrl(String(req.body?.siteUrl || ''));
      const eligibility = evaluateWordPressEligibility(site, { managedSiteHosts: config.wordpressManagedSiteHosts, blockedSiteHosts: config.wordpressBlockedSiteHosts });
      if (eligibility.eligibility === 'PLATFORM_INELIGIBLE' || eligibility.eligibility === 'SAFETY_HOLD') return res.status(403).json(eligibility);
      if (req.body?.mode && req.body.mode !== 'CREATOR_OWNED_APPLICATION_PASSWORD') return res.status(400).json({ message: 'Creator-owned Application Password is the only enabled launch credential mode' });
      const connection: WordPressConnectionRecord = { connectionId: randomUUID(), tenantId: config.tenantId, creatorId, ownerUserId: req.authUser!.userId, siteUrl: site.origin, apiRoot: new URL('/wp-json/', site).toString(), mode: 'CREATOR_OWNED_APPLICATION_PASSWORD', username: String(req.body?.username || ''), credentialEncrypted: encryptExternalCredential(String(req.body?.applicationPassword || ''), config.externalTokenEncryptionKey), state: 'ERROR', capabilities: detectWordPressCapabilities(null, null), compatibilityWarnings: [], eligibility: eligibility.eligibility, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      if (!connection.username || !req.body?.applicationPassword) return res.status(400).json({ message: 'Username and connector-specific Application Password are required' });
      const discovery: any = await request(connection, '/');
      const user: any = await request(connection, '/wp/v2/users/me?context=edit');
      const discoveredApiRoot = new URL(discovery?._links?.['wp:api-root']?.[0]?.href || connection.apiRoot);
      await validateWordPressUrl(discoveredApiRoot.toString());
      if (discoveredApiRoot.origin !== site.origin) throw new Error('WordPress REST API root must use the connected site host');
      connection.apiRoot = discoveredApiRoot.toString();
      connection.wpUser = { id: user.id, name: user.name, roles: user.roles || [] };
      connection.capabilities = detectWordPressCapabilities(user, discovery.routes);
      connection.capabilities.webhookAdapter = Boolean(config.wordpressWebhookSecret);
      const requested = Array.isArray(req.body?.enabledCapabilities) ? req.body.enabledCapabilities : [];
      const unavailable = requested.filter((name: string) => !(name in connection.capabilities) || !connection.capabilities[name as keyof WordPressCapabilityProfile]);
      if (unavailable.length) throw new Error(`Requested WordPress capabilities are unavailable: ${unavailable.join(', ')}`);
      connection.state = 'CONNECTED'; connection.updatedAt = new Date().toISOString();
      connections.set(connection.connectionId, connection);
      record(req.authUser!.userId, 'CONNECTION_CREATED', connection.connectionId, 'SUCCESS', randomUUID());
      return res.status(201).json({ connection: safeView(connection) });
    } catch (error) { return res.status(400).json({ message: error instanceof Error ? error.message : 'Connection failed' }); }
  });

  router.post('/integrations/wordpress/connections/:id/test', async (req, res) => {
    const connection = owned(req.params.id, req.authUser!.userId); if (!connection) return res.status(404).json({ message: 'Connection not found' });
    try { await request(connection, '/wp/v2/users/me?context=edit'); connection.state = 'CONNECTED'; return res.json({ ok: true, capabilityProfile: connection.capabilities }); }
    catch (error) { connection.state = 'ERROR'; return res.status(502).json({ ok: false, message: error instanceof Error ? error.message : 'Test failed' }); }
  });

  router.post('/integrations/wordpress/connections/:id/sync', async (req, res) => {
    const connection = owned(req.params.id, req.authUser!.userId); if (!connection) return res.status(404).json({ message: 'Connection not found' });
    try {
      const [posts, pages, media, categories, tags, authors] = await Promise.all(['posts', 'pages', 'media', 'categories', 'tags', 'users'].map((kind) => request(connection, `/wp/v2/${kind}?context=edit&per_page=100`)));
      const now = new Date().toISOString();
      const mediaById = new Map((media as any[]).map((item: any) => [item.id, item]));
      const references = ([...(posts as any[]).map((item: any) => [item, 'post'] as const), ...(pages as any[]).map((item: any) => [item, 'page'] as const)]).map(([item, remoteType]) => {
        const existing = [...externalReferences.values()].find((reference) => reference.connectionId === connection.connectionId && reference.remoteType === remoteType && reference.remoteId === item.id);
        const featured = mediaById.get(item.featured_media) as any;
        const reference: WordPressExternalReferenceRecord = {
          externalReferenceWorkId: existing?.externalReferenceWorkId || randomUUID(), connectionId: connection.connectionId,
          creatorId: connection.creatorId, remoteId: item.id, remoteType, remoteUrl: item.link,
          title: String(item.title?.rendered || ''), slug: item.slug,
          excerpt: typeof item.excerpt?.rendered === 'string' ? item.excerpt.rendered : undefined,
          status: item.status, authorId: item.author, categoryIds: Array.isArray(item.categories) ? item.categories : [],
          tagIds: Array.isArray(item.tags) ? item.tags : [], publishedAt: item.date_gmt, modifiedAt: item.modified_gmt,
          contentHash: hash(item.content?.raw || item.content?.rendered || ''),
          mediaReferences: featured ? [{ remoteMediaId: featured.id, remoteUrl: featured.source_url }] : [],
          sourceAvailability: 'REFERENCE_ONLY', mappingState: 'STAGED', updatedAt: now
        };
        externalReferences.set(reference.externalReferenceWorkId, reference);
        return reference;
      });
      connection.lastSyncAt = now;
      record(req.authUser!.userId, 'REFERENCE_IMPORT_SYNCED', connection.connectionId, 'SUCCESS', randomUUID(), undefined, undefined, hash(references));
      return res.json({ warning: 'WordPress reference only — connecting WordPress does not back up the original. Upload the original directly to Ubeeq to keep it under your control.', staging: { references, media, categories, tags, authors }, discoveryEnabled: false });
    } catch (error) { return res.status(502).json({ message: error instanceof Error ? error.message : 'Sync failed' }); }
  });

  router.get('/integrations/wordpress/connections/:id/staging', (req, res) => {
    const connection = owned(req.params.id, req.authUser!.userId);
    if (!connection) return res.status(404).json({ message: 'Connection not found' });
    return res.json({
      items: [...externalReferences.values()].filter((reference) => reference.connectionId === connection.connectionId),
      warning: 'WordPress reference only — connecting WordPress does not back up the original. Upload the original directly to Ubeeq to keep it under your control.',
      discoveryEnabled: false
    });
  });

  router.post('/integrations/wordpress/connections/:id/taxonomies', async (req, res) => {
    const connection = owned(req.params.id, req.authUser!.userId);
    if (!connection) return res.status(404).json({ message: 'Connection not found' });
    if (connection.state !== 'CONNECTED') return res.status(409).json({ message: 'Connection is not available' });
    const taxonomy = req.body?.taxonomy === 'tag' ? 'tags' : req.body?.taxonomy === 'category' ? 'categories' : undefined;
    if (!taxonomy) return res.status(400).json({ message: 'taxonomy must be category or tag' });
    if (!connection.capabilities[taxonomy === 'tags' ? 'tagsWrite' : 'categoriesWrite']) return res.status(409).json({ message: `The connected WordPress user cannot create ${taxonomy}` });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 200) : '';
    if (!name) return res.status(400).json({ message: 'A taxonomy name is required' });
    try {
      const remote = await request(connection, `/wp/v2/${taxonomy}`, { method: 'POST', body: JSON.stringify({ name, slug: typeof req.body?.slug === 'string' ? req.body.slug.trim().slice(0, 200) : undefined, parent: taxonomy === 'categories' && Number.isInteger(req.body?.parent) ? req.body.parent : undefined }) });
      record(req.authUser!.userId, 'TAXONOMY_CREATED', connection.connectionId, 'SUCCESS', randomUUID(), undefined, undefined, hash(remote));
      return res.status(201).json({ taxonomy: remote });
    } catch (error) {
      record(req.authUser!.userId, 'TAXONOMY_CREATED', connection.connectionId, 'FAILED', randomUUID());
      return res.status(502).json({ message: error instanceof Error ? error.message : 'Taxonomy creation failed' });
    }
  });

  router.post('/integrations/wordpress/connections/:id/webhook-secret', (req, res) => {
    const connection = owned(req.params.id, req.authUser!.userId);
    if (!connection) return res.status(404).json({ message: 'Connection not found' });
    if (req.body?.confirm !== true) return res.status(409).json({ message: 'Explicit confirmation is required' });
    const secret = webhookKey(connection.connectionId);
    if (!secret) return res.status(501).json({ message: 'No approved webhook adapter is configured' });
    record(req.authUser!.userId, 'WEBHOOK_SECRET_REVEALED', connection.connectionId, 'SUCCESS', randomUUID());
    return res.json({ endpoint: `/api/webhooks/wordpress/${connection.connectionId}`, secret, algorithm: 'HMAC-SHA256', expiresEventAfterSeconds: 300 });
  });

  router.delete('/integrations/wordpress/connections/:id', (req, res) => { const connection = owned(req.params.id, req.authUser!.userId); if (!connection) return res.status(404).json({ message: 'Connection not found' }); connection.state = 'DISCONNECTED'; connection.credentialEncrypted = encryptExternalCredential(randomUUID(), config.externalTokenEncryptionKey); return res.status(204).send(); });

  router.get('/works/:workId/wordpress/eligibility', async (req, res) => { const work = await store.getWork(config.tenantId, req.params.workId); if (!work || !(await store.hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Work not found' }); const blockers = work.status === 'deleted' ? ['WORK_DELETED'] : work.status === 'archived' ? ['WORK_ARCHIVED'] : []; return res.json({ eligible: blockers.length === 0, blockers }); });

  router.post('/works/:workId/wordpress/publications', async (req, res) => {
    try {
      const work = await store.getWork(config.tenantId, req.params.workId); if (!work || !(await store.hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Work not found' });
      const connection = owned(String(req.body?.connectionId), req.authUser!.userId); if (!connection || connection.creatorId !== work.creatorId) return res.status(404).json({ message: 'Connection not found' });
      if (connection.state !== 'CONNECTED') return res.status(409).json({ message: 'Connection is not available for publishing' });
      const type = req.body?.type === 'page' ? 'pages' : 'posts';
      if (!connection.capabilities[type === 'pages' ? 'pagesWrite' : 'postsWrite']) return res.status(409).json({ message: `The connected WordPress user cannot write ${type}` });
      if (work.status === 'deleted' || work.status === 'archived') return res.status(409).json({ message: 'Archived or deleted Works cannot be published externally' });
      const requestedStatus = ['future', 'publish', 'private'].includes(req.body?.status) ? req.body.status : 'draft';
      const authorId = Number.isInteger(req.body?.authorId) ? req.body.authorId : undefined;
      if (authorId !== undefined && authorId !== connection.wpUser?.id && !connection.capabilities.authorAssignment) return res.status(409).json({ message: 'The connected WordPress user cannot assign another author' });
      if (requestedStatus === 'future') {
        if (!connection.capabilities.schedule) return res.status(409).json({ message: 'The connection does not support scheduling' });
        const scheduledAt = Date.parse(String(req.body?.scheduledAt || ''));
        if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) return res.status(400).json({ message: 'A future scheduledAt time is required for scheduled publications' });
      }
      const contentFormat = req.body?.contentFormat === 'classic' ? 'classic' : 'blocks';
      if (contentFormat === 'classic' && !connection.capabilities.classicHtmlFormat) return res.status(409).json({ message: 'The connection does not support the limited classic HTML renderer' });
      if (contentFormat === 'blocks' && !connection.capabilities.blockFormat) return res.status(409).json({ message: 'The connection does not support WordPress block content' });
      const content = renderWordPressContent(work.body || [], { approvedEmbedHosts: config.wordpressApprovedEmbedHosts, format: contentFormat }); const now = new Date().toISOString();
      const publication: WordPressPublicationRecord = { publicationId: randomUUID(), connectionId: connection.connectionId, workId: work.workId, ownerUserId: req.authUser!.userId, type, title: String(req.body?.title || work.title).trim().slice(0, 200), slug: typeof req.body?.slug === 'string' ? req.body.slug.trim().slice(0, 200) : undefined, excerpt: typeof (req.body?.excerpt || work.description) === 'string' ? String(req.body?.excerpt || work.description).slice(0, 10_000) : undefined, content, contentHash: hash(content), status: requestedStatus, scheduledAt: req.body?.scheduledAt, authorId, categories: Array.isArray(req.body?.categories) ? req.body.categories.filter(Number.isInteger) : [], tags: Array.isArray(req.body?.tags) ? req.body.tags.filter(Number.isInteger) : [], featuredMediaId: Number.isInteger(req.body?.featuredMediaId) ? req.body.featuredMediaId : undefined, idempotencyKey: String(req.body?.idempotencyKey || randomUUID()).slice(0, 200), state: 'PREVIEW', createdAt: now, updatedAt: now };
      if (!publication.title) return res.status(400).json({ message: 'A WordPress title is required' });
      publications.set(publication.publicationId, publication);
      return res.status(201).json({ publication, preview: { title: publication.title, content: publication.content, status: publication.status }, confirmationRequired: true });
    } catch (error) { return res.status(400).json({ message: error instanceof Error ? error.message : 'Invalid publication' }); }
  });

  router.patch('/wordpress/publications/:id', (req, res) => {
    const p = publications.get(req.params.id);
    if (!p || p.ownerUserId !== req.authUser!.userId) return res.status(404).json({ message: 'Publication not found' });
    if (req.body?.content !== undefined) return res.status(400).json({ message: 'Rendered content cannot be supplied by the browser' });
    if (req.body?.status !== undefined && !['draft', 'future', 'publish', 'private'].includes(req.body.status)) return res.status(400).json({ message: 'Unsupported WordPress status' });
    const before = publicationSnapshot(p);
    Object.assign(p, {
      title: typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 200) : p.title,
      slug: typeof req.body?.slug === 'string' ? req.body.slug.trim().slice(0, 200) : p.slug,
      excerpt: typeof req.body?.excerpt === 'string' ? req.body.excerpt.slice(0, 10_000) : p.excerpt,
      status: req.body?.status ?? p.status, scheduledAt: req.body?.scheduledAt ?? p.scheduledAt,
      categories: Array.isArray(req.body?.categories) ? req.body.categories.filter(Number.isInteger) : p.categories,
      tags: Array.isArray(req.body?.tags) ? req.body.tags.filter(Number.isInteger) : p.tags,
      updatedAt: new Date().toISOString()
    });
    if (!p.title) return res.status(400).json({ message: 'A WordPress title is required' });
    if (p.status === 'future' && (!p.scheduledAt || Date.parse(p.scheduledAt) <= Date.now())) return res.status(400).json({ message: 'A future scheduledAt time is required for scheduled publications' });
    p.state = 'LOCAL_CHANGED';
    return res.json({ publication: p, diff: diffWordPressSnapshots(before, publicationSnapshot(p)), confirmationRequired: true });
  });

  router.post('/wordpress/publications/:id/media', async (req, res) => {
    const publication = publications.get(req.params.id);
    if (!publication || publication.ownerUserId !== req.authUser!.userId) return res.status(404).json({ message: 'Publication not found' });
    if (publication.state !== 'PREVIEW' && publication.state !== 'LOCAL_CHANGED') return res.status(409).json({ message: 'Media must be selected before final publication confirmation' });
    const connection = owned(publication.connectionId, req.authUser!.userId);
    if (!connection || connection.state !== 'CONNECTED') return res.status(409).json({ message: 'Connection is not available for media upload' });
    if (!connection.capabilities.mediaUpload) return res.status(409).json({ message: 'The connected WordPress user cannot upload media' });
    const assetId = String(req.body?.assetId || '');
    const asset = await store.getCanonicalAsset(config.tenantId, assetId);
    if (!asset || asset.creatorId !== connection.creatorId || asset.status !== 'ready' || asset.storage.mode !== 'hosted' || !asset.storage.objectKey) return res.status(409).json({ message: 'A ready, Ubeeq-hosted canonical Asset is required' });
    if (!asset.mimeType.startsWith('image/')) return res.status(400).json({ message: 'WordPress v1 media publishing supports image Assets only' });
    if (asset.sizeBytes && asset.sizeBytes > config.externalContentMaxBytes) return res.status(413).json({ message: 'Asset exceeds the external publication size limit' });
    const existing = [...mediaMappings.values()].find((mapping) => mapping.connectionId === connection.connectionId && mapping.assetId === asset.assetId && mapping.checksum === asset.checksumSha256);
    if (existing) {
      publication.featuredMediaId = req.body?.featured === true ? existing.remoteMediaId : publication.featuredMediaId;
      return res.json({ mediaMapping: existing, reused: true });
    }
    try {
      const bytes = await assetBytes(asset.storage.objectKey);
      if (bytes.byteLength > config.externalContentMaxBytes) return res.status(413).json({ message: 'Asset exceeds the external publication size limit' });
      const filename = (asset.originalFilename || `${asset.assetId}.${asset.mimeType.split('/')[1] || 'bin'}`).replace(/[\r\n"\\]/g, '_');
      const remote: any = await request(connection, '/wp/v2/media', {
        method: 'POST', body: new Blob([new Uint8Array(bytes)]),
        headers: { 'Content-Type': asset.mimeType, 'Content-Disposition': `attachment; filename="${filename}"` }
      });
      const altText = typeof req.body?.altText === 'string' ? req.body.altText.trim().slice(0, 2_000) : undefined;
      const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim().slice(0, 10_000) : undefined;
      if (altText || caption) await request(connection, `/wp/v2/media/${remote.id}`, { method: 'POST', body: JSON.stringify({ alt_text: altText, caption }) });
      const mapping: WordPressMediaMappingRecord = { mediaMappingId: randomUUID(), connectionId: connection.connectionId, publicationId: publication.publicationId, assetId: asset.assetId, remoteMediaId: remote.id, remoteUrl: remote.source_url, checksum: asset.checksumSha256, altText, caption, provenance: 'UBEEQ_CANONICAL_ASSET', createdAt: new Date().toISOString() };
      mediaMappings.set(mapping.mediaMappingId, mapping);
      if (req.body?.featured === true) publication.featuredMediaId = mapping.remoteMediaId;
      record(req.authUser!.userId, 'MEDIA_UPLOADED', connection.connectionId, 'SUCCESS', randomUUID(), publication.publicationId, asset.checksumSha256, hash(mapping));
      return res.status(201).json({ mediaMapping: mapping, reused: false, publication });
    } catch (error) {
      record(req.authUser!.userId, 'MEDIA_UPLOADED', connection.connectionId, 'FAILED', randomUUID(), publication.publicationId, asset.checksumSha256);
      return res.status(502).json({ message: error instanceof Error ? error.message : 'Media upload failed' });
    }
  });

  router.post('/wordpress/publications/:id/publish', async (req, res) => {
    const p = publications.get(req.params.id); if (!p || p.ownerUserId !== req.authUser!.userId) return res.status(404).json({ message: 'Publication not found' }); if (req.body?.confirm !== true) return res.status(409).json({ message: 'Explicit confirmation is required' });
    const connection = owned(p.connectionId, req.authUser!.userId)!;
    if (connection.state !== 'CONNECTED') return res.status(409).json({ message: 'Connection is not available for publishing' });
    const work = await store.getWork(config.tenantId, p.workId);
    if (!work || work.creatorId !== connection.creatorId || work.status === 'deleted' || work.status === 'archived') return res.status(409).json({ message: 'The canonical Work is no longer eligible for external publication' });
    const correlation = randomUUID();
    try { const payload = { title: p.title, slug: p.slug, excerpt: p.excerpt, content: p.content, status: p.status, date: p.scheduledAt, author: p.authorId, categories: p.categories, tags: p.tags, featured_media: p.featuredMediaId, meta: { ubeeq_correlation_id: p.idempotencyKey } }; const remote: any = await request(connection, `/wp/v2/${p.type}${p.remoteId ? `/${p.remoteId}` : ''}`, { method: 'POST', body: JSON.stringify(payload) }); p.remoteId = remote.id; p.remoteUrl = remote.link; p.remoteSnapshot = wordPressPostSnapshot(remote); p.remoteHash = hash(p.remoteSnapshot); p.state = 'IN_SYNC'; p.updatedAt = new Date().toISOString(); record(req.authUser!.userId, 'PUBLICATION_PUBLISHED', connection.connectionId, 'SUCCESS', correlation, p.publicationId, p.contentHash, p.remoteHash); return res.json({ publication: p }); } catch (error) { p.state = 'FAILED'; record(req.authUser!.userId, 'PUBLICATION_PUBLISHED', connection.connectionId, 'FAILED', correlation, p.publicationId); return res.status(502).json({ message: error instanceof Error ? error.message : 'Publish failed' }); }
  });

  router.post('/wordpress/publications/:id/reconcile', async (req, res) => {
    const p = publications.get(req.params.id);
    if (!p || p.ownerUserId !== req.authUser!.userId) return res.status(404).json({ message: 'Publication not found' });
    if (!p.remoteId) return res.status(409).json({ message: 'Publication has no remote object' });
    try {
      const remote: any = await request(owned(p.connectionId, req.authUser!.userId)!, `/wp/v2/${p.type}/${p.remoteId}?context=edit`);
      const snapshot = wordPressPostSnapshot(remote);
      const diff = diffWordPressSnapshots(publicationSnapshot(p), snapshot);
      if (req.body?.resolution === 'KEEP_LOCAL') p.state = diff.length ? 'LOCAL_CHANGED' : 'IN_SYNC';
      else if (req.body?.resolution === 'ACCEPT_REMOTE') {
        const allowed = new Set<keyof WordPressPostSnapshot>(Array.isArray(req.body?.fields) ? req.body.fields : []);
        if (!allowed.size) return res.status(400).json({ message: 'Select at least one remote field to accept' });
        if (allowed.has('title')) p.title = snapshot.title;
        if (allowed.has('slug')) p.slug = snapshot.slug;
        if (allowed.has('excerpt')) p.excerpt = snapshot.excerpt;
        if (allowed.has('content')) p.content = snapshot.content;
        if (allowed.has('status') && ['draft', 'future', 'publish', 'private'].includes(snapshot.status)) p.status = snapshot.status as WordPressPublicationRecord['status'];
        if (allowed.has('date')) p.scheduledAt = snapshot.date || undefined;
        if (allowed.has('author')) p.authorId = snapshot.author;
        if (allowed.has('categories')) p.categories = snapshot.categories;
        if (allowed.has('tags')) p.tags = snapshot.tags;
        if (allowed.has('featuredMediaId')) p.featuredMediaId = snapshot.featuredMediaId;
        p.contentHash = hash(p.content); p.state = 'IN_SYNC'; p.updatedAt = new Date().toISOString();
      } else p.state = diff.length ? 'REMOTE_CHANGED' : 'IN_SYNC';
      p.remoteSnapshot = snapshot; p.remoteHash = hash(snapshot);
      return res.json({ publication: p, diff, resolutionRequired: p.state === 'REMOTE_CHANGED', canonicalWorkChanged: false });
    } catch (error) {
      if (error instanceof WordPressRequestError && error.status === 404) { p.state = 'MISSING'; return res.json({ publication: p, canonicalWorkChanged: false }); }
      return res.status(502).json({ message: error instanceof Error ? error.message : 'Reconciliation failed', canonicalWorkChanged: false });
    }
  });
  router.post('/wordpress/publications/:id/unpublish', async (req, res) => { const p = publications.get(req.params.id); if (!p || p.ownerUserId !== req.authUser!.userId) return res.status(404).json({ message: 'Publication not found' }); if (req.body?.confirm !== true || !p.remoteId) return res.status(409).json({ message: 'Explicit confirmation and a remote publication are required' }); await request(owned(p.connectionId, req.authUser!.userId)!, `/wp/v2/${p.type}/${p.remoteId}`, { method: 'POST', body: JSON.stringify({ status: 'draft' }) }); p.status = 'draft'; p.state = 'IN_SYNC'; return res.json({ publication: p }); });
  router.delete('/wordpress/publications/:id', async (req, res) => { const p = publications.get(req.params.id); if (!p || p.ownerUserId !== req.authUser!.userId) return res.status(404).json({ message: 'Publication not found' }); if (req.query.confirm !== 'true') return res.status(409).json({ message: 'Explicit confirmation is required' }); if (p.remoteId) await request(owned(p.connectionId, req.authUser!.userId)!, `/wp/v2/${p.type}/${p.remoteId}`, { method: 'DELETE' }); p.state = 'REMOVED'; return res.status(204).send(); });
  router.get('/integrations/wordpress/audit', (req, res) => res.json({ items: audits.filter((a) => owned(a.connectionId, req.authUser!.userId)) }));
  return router;
};
