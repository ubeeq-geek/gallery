import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import express, { type Express, type Request, type Response } from 'express';
import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import { requireAuth } from './auth';
import {
  diffReconciliationSnapshots,
  reconciliationStatus,
  resolveReconciliation,
  type ReconciliationSnapshot
} from './integrationReconciliation';

export const GHOST_ACCEPT_VERSION = 'v5.0';
export const GHOST_REFERENCE_NOTICE = 'Ghost reference only — connecting Ghost does not back up the original. Upload the original directly to Ubeeq to retain it under your control.';

export type GhostVisibility = 'public' | 'members' | 'paid';
export type GhostState = 'ACTIVE' | 'ERROR' | 'DISCONNECTED';
export interface GhostConnection {
  connectionId: string; creatorId: string; siteId: string; adminUrl: string; apiVersion: string;
  mode: 'CREATOR_OWNED' | 'MANAGED_SITE'; state: GhostState; capabilities: Array<'posts' | 'pages' | 'images'>;
  encryptedKey: string; createdAt: string; updatedAt: string; lastSyncAt?: string; lastError?: string;
  webhookSecretHash: string; lastWebhookAt?: string; lastWebhookError?: string;
  permittedTypes: Array<'post' | 'page'>;
  tagMappings: Record<string, string>;
  authorMappings: Record<string, string>;
  eligibility: 'ALLOWED_MANAGED' | 'CREATOR_OWNED_REQUIRED' | 'PLATFORM_INELIGIBLE' | 'SAFETY_HOLD';
}
export interface GhostPublication {
  publicationId: string; connectionId: string; creatorId: string; workId: string; type: 'post' | 'page';
  title: string; slug?: string; excerpt?: string; lexical: string; contentHash: string; visibility: GhostVisibility;
  tags: string[]; status: 'draft' | 'scheduled' | 'published' | 'unpublished' | 'missing' | 'remote_changed';
  remoteId?: string; remoteUrl?: string; publishedAt?: string; scheduledAt?: string; idempotencyKey: string;
  remoteUpdatedAt?: string; remoteContentHash?: string;
  featureImageAssetId?: string;
  canonicalUrlPolicy?: 'ghost' | 'ubeeq' | 'custom';
  canonicalUrl?: string;
  eligibilityCheckedAt?: string;
  eligibilityReasons?: string[];
  conflictResolution?: 'accept_remote' | 'keep_ghost_unchanged' | 'create_new_post';
  conflictResolvedAt?: string;
  createdAt: string; updatedAt: string;
}

type GhostComparablePublication = Pick<GhostPublication, 'title' | 'slug' | 'excerpt' | 'lexical' | 'visibility' | 'tags' | 'scheduledAt' | 'featureImageAssetId' | 'canonicalUrlPolicy' | 'canonicalUrl'> & {
  remoteStatus?: string;
};

/** Maps Ghost's editable metadata onto the integration-neutral contract. */
const ghostReconciliationSnapshot = (publication: GhostComparablePublication): ReconciliationSnapshot => ({
  title: publication.title,
  slug: publication.slug || '',
  excerpt: publication.excerpt || '',
  lexical: publication.lexical,
  visibility: publication.visibility,
  tags: [...publication.tags],
  scheduledAt: publication.scheduledAt || '',
  featureImageAssetId: publication.featureImageAssetId || '',
  canonicalUrlPolicy: publication.canonicalUrlPolicy || 'ghost',
  canonicalUrl: publication.canonicalUrl || ''
});
export interface GhostAuditEvent { eventId: string; actorId: string; action: string; targetId: string; correlationId: string; result: 'success' | 'failure'; at: string; beforeHash?: string; afterHash?: string; }
export interface GhostMediaMapping {
  mappingId: string;
  connectionId: string;
  creatorId: string;
  derivativeAssetId: string;
  ghostImageUrl: string;
  checksumSha256: string;
  alt?: string;
  caption?: string;
  createdAt: string;
}
export interface GhostEligibility {
  eligible: boolean;
  workId: string;
  creatorId: string;
  connectionId?: string;
  reasons: string[];
  checks: {
    workOwned: boolean;
    workPublishable: boolean;
    connectionHealthy: boolean;
    canonicalAssetReady: boolean;
    rendererSupported: boolean;
    safetyClear: boolean;
  };
}
export interface GhostExternalReferenceWork {
  referenceId: string;
  connectionId: string;
  creatorId: string;
  remoteId: string;
  type: 'post' | 'page';
  remoteUrl?: string;
  title: string;
  slug: string;
  excerpt?: string;
  tags: string[];
  authors: string[];
  visibility: GhostVisibility;
  remoteStatus: string;
  contentHash: string;
  sourceAvailability: 'metadata_only';
  mappingState: 'staged' | 'mapped';
  syncState: 'in_sync' | 'remote_changed' | 'missing';
  discoveryEnabled: false;
  notice: typeof GHOST_REFERENCE_NOTICE;
  importedAt: string;
  remoteUpdatedAt?: string;
}

type GhostRemoteItem = {
  id?: string;
  url?: string;
  title?: string;
  slug?: string;
  custom_excerpt?: string;
  excerpt?: string;
  lexical?: string;
  html?: string;
  status?: string;
  visibility?: GhostVisibility;
  updated_at?: string;
  published_at?: string;
  tags?: Array<{ name?: string }>;
  authors?: Array<{ name?: string }>;
  feature_image?: string;
  canonical_url?: string;
};

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
export const ghostAdminToken = (key: string, now = Math.floor(Date.now() / 1000)): string => {
  const [id, secret] = key.trim().split(':');
  if (!id || !secret || !/^[a-f0-9]+$/i.test(secret)) throw new Error('Ghost Admin API key must use the id:hex-secret format');
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT', kid: id })}.${b64({ iat: now, exp: now + 300, aud: '/admin/' })}`;
  return `${unsigned}.${createHmac('sha256', Buffer.from(secret, 'hex')).update(unsigned).digest('base64url')}`;
};

export const normalizeGhostAdminUrl = (input: string): string => {
  const url = new URL(input);
  if (url.protocol !== 'https:') throw new Error('Ghost Admin URL must use HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('Ghost Admin URL cannot contain credentials, query parameters, or fragments');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateHost = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '::1'
    || hostname.startsWith('fc')
    || hostname.startsWith('fd')
    || /^127\./.test(hostname)
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^169\.254\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
  if (privateHost) throw new Error('Ghost Admin URL cannot target a private or loopback host');
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/ghost\/api\/admin$/i, '')}/ghost/api/admin`;
  return url.toString().replace(/\/$/, '');
};

type GhostBlock = { type: 'paragraph' | 'heading' | 'image' | 'code' | 'link'; text?: string; level?: 2 | 3 | 4; src?: string; alt?: string; caption?: string; href?: string };
export const renderGhostLexical = (blocks: GhostBlock[], canonicalUrl: string): string => {
  const safeUrl = (value: string, image = false) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !image)) throw new Error('Only safe HTTP(S) URLs are supported');
    return value;
  };
  const children = blocks.map((block) => {
    if (block.type === 'paragraph' || block.type === 'code') return { type: block.type, version: 1, children: [{ type: 'text', version: 1, text: block.text || '' }] };
    if (block.type === 'heading') return { type: 'heading', version: 1, tag: `h${block.level || 2}`, children: [{ type: 'text', version: 1, text: block.text || '' }] };
    if (block.type === 'image') return { type: 'image', version: 1, src: safeUrl(block.src || '', true), altText: block.alt || '', caption: block.caption || '' };
    return { type: 'paragraph', version: 1, children: [{ type: 'link', version: 1, url: safeUrl(block.href || ''), children: [{ type: 'text', version: 1, text: block.text || block.href || '' }] }] };
  });
  children.push({ type: 'paragraph', version: 1, children: [{ type: 'link', version: 1, url: safeUrl(canonicalUrl), children: [{ type: 'text', version: 1, text: 'View the canonical Work on Ubeeq/Eversally' }] }] });
  return JSON.stringify({ root: { type: 'root', version: 1, children } });
};

const validateGhostLexical = (value: string): string => {
  let document: unknown;
  try {
    document = JSON.parse(value);
  } catch {
    throw new Error('Ghost Lexical content must be valid JSON');
  }
  const allowed = new Set(['root', 'paragraph', 'heading', 'text', 'image', 'code', 'link']);
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Ghost Lexical nodes must be objects');
    const record = node as Record<string, unknown>;
    if (typeof record.type !== 'string' || !allowed.has(record.type)) throw new Error(`Unsupported Ghost Lexical node: ${String(record.type)}`);
    if (record.type === 'link' || record.type === 'image') {
      const target = record.type === 'link' ? record.url : record.src;
      if (typeof target !== 'string') throw new Error(`Ghost Lexical ${record.type} requires a URL`);
      const url = new URL(target);
      if (record.type === 'image' ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Only safe HTTP(S) URLs are supported');
      }
    }
    if (record.children !== undefined) {
      if (!Array.isArray(record.children)) throw new Error('Ghost Lexical children must be an array');
      record.children.forEach(visit);
    }
  };
  const root = (document as { root?: unknown })?.root;
  visit(root);
  if ((root as { type?: string }).type !== 'root') throw new Error('Ghost Lexical document requires a root node');
  return JSON.stringify(document);
};

const publicationHash = (publication: Pick<GhostPublication, 'title' | 'slug' | 'excerpt' | 'lexical' | 'visibility' | 'tags' | 'scheduledAt' | 'featureImageAssetId' | 'canonicalUrlPolicy' | 'canonicalUrl'>) => createHash('sha256')
  .update(JSON.stringify({
    title: publication.title,
    slug: publication.slug || '',
    excerpt: publication.excerpt || '',
    lexical: publication.lexical,
    visibility: publication.visibility,
    tags: publication.tags,
    scheduledAt: publication.scheduledAt || '',
    featureImageAssetId: publication.featureImageAssetId || '',
    canonicalUrlPolicy: publication.canonicalUrlPolicy || 'ghost',
    canonicalUrl: publication.canonicalUrl || ''
  }))
  .digest('hex');

export class GhostIntegrationService {
  private connections = new Map<string, GhostConnection>();
  private publications = new Map<string, GhostPublication>();
  private references = new Map<string, GhostExternalReferenceWork>();
  private mediaMappings = new Map<string, GhostMediaMapping>();
  private remoteSnapshots = new Map<string, GhostComparablePublication>();
  private reconciliationBaselines = new Map<string, ReconciliationSnapshot>();
  private webhookEvents = new Set<string>();
  readonly audit: GhostAuditEvent[] = [];
  constructor(
    private secret: string | undefined,
    private request: typeof fetch = fetch,
    private pause: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  ) {}
  publicConnection(connection: GhostConnection) { const { encryptedKey: _key, webhookSecretHash: _webhookSecret, ...safe } = connection; return safe; }
  async connect(input: { creatorId: string; adminUrl: string; apiKey: string; mode?: GhostConnection['mode'] }, actorId = input.creatorId, managedApproved = false) {
    const mode = input.mode || 'CREATOR_OWNED';
    if (mode === 'MANAGED_SITE' && !managedApproved) throw new Error('Managed Ghost connections require platform approval');
    const adminUrl = normalizeGhostAdminUrl(input.adminUrl); const token = ghostAdminToken(input.apiKey);
    const response = await this.request(`${adminUrl}/site/`, { headers: { Authorization: `Ghost ${token}`, 'Accept-Version': GHOST_ACCEPT_VERSION } });
    if (!response.ok) throw new Error(`Ghost validation failed (${response.status})`);
    const payload = await response.json() as { site?: { uuid?: string; url?: string } };
    if (!payload.site?.uuid) throw new Error('Ghost did not return a site identity');
    const now = new Date().toISOString();
    const webhookSecret = randomBytes(32).toString('base64url');
    const connection: GhostConnection = { connectionId: randomUUID(), creatorId: input.creatorId, siteId: payload.site.uuid, adminUrl, apiVersion: GHOST_ACCEPT_VERSION, mode, state: 'ACTIVE', capabilities: ['posts', 'pages', 'images'], encryptedKey: encryptExternalCredential(input.apiKey, this.secret), webhookSecretHash: createHash('sha256').update(webhookSecret).digest('hex'), permittedTypes: ['post', 'page'], tagMappings: {}, authorMappings: {}, eligibility: mode === 'MANAGED_SITE' ? 'ALLOWED_MANAGED' : 'CREATOR_OWNED_REQUIRED', createdAt: now, updatedAt: now };
    this.connections.set(connection.connectionId, connection);
    this.recordTarget(actorId, 'connect', connection.connectionId, randomUUID());
    return { ...this.publicConnection(connection), webhookSecret };
  }
  getConnection(id: string) { return this.connections.get(id); }
  listConnections(creatorId: string) { return [...this.connections.values()].filter(x => x.creatorId === creatorId).map(x => this.publicConnection(x)); }
  configure(id: string, input: {
    capabilities?: Array<'posts' | 'pages' | 'images'>;
    permittedTypes?: Array<'post' | 'page'>;
    tagMappings?: Record<string, string>;
    authorMappings?: Record<string, string>;
  }, actorId: string) {
    const connection = this.requiredConnection(id);
    const capabilities = input.capabilities === undefined
      ? connection.capabilities
      : [...new Set(input.capabilities.filter((value) => ['posts', 'pages', 'images'].includes(value)))];
    const permittedTypes = input.permittedTypes === undefined
      ? connection.permittedTypes
      : [...new Set(input.permittedTypes.filter((value) => value === 'post' || value === 'page'))];
    if (!capabilities.length) throw new Error('At least one Ghost capability is required');
    if (!permittedTypes.length) throw new Error('At least one Ghost destination type is required');
    const normalizeMappings = (value: Record<string, string> | undefined, current: Record<string, string>) => value === undefined
      ? current
      : Object.fromEntries(Object.entries(value).flatMap(([source, destination]) => {
        const normalizedSource = source.trim().slice(0, 191);
        const normalizedDestination = destination.trim().slice(0, 191);
        return normalizedSource && normalizedDestination ? [[normalizedSource, normalizedDestination]] : [];
      }));
    connection.capabilities = capabilities;
    connection.permittedTypes = permittedTypes;
    connection.tagMappings = normalizeMappings(input.tagMappings, connection.tagMappings);
    connection.authorMappings = normalizeMappings(input.authorMappings, connection.authorMappings);
    connection.updatedAt = new Date().toISOString();
    this.recordTarget(actorId, 'configure', connection.connectionId, randomUUID(), createHash('sha256').update(JSON.stringify({ capabilities, permittedTypes, tagMappings: connection.tagMappings, authorMappings: connection.authorMappings })).digest('hex'));
    return this.publicConnection(connection);
  }
  async test(id: string) { const c = this.requiredConnection(id); await this.ghost(c, 'site/', { method: 'GET' }); c.lastSyncAt = new Date().toISOString(); return this.publicConnection(c); }
  async replaceKey(id: string, apiKey: string, actorId: string) {
    const connection = this.requiredConnection(id);
    const response = await this.request(`${connection.adminUrl}/site/`, { headers: { Authorization: `Ghost ${ghostAdminToken(apiKey)}`, 'Accept-Version': connection.apiVersion } });
    if (!response.ok) throw new Error(`Ghost key validation failed (${response.status})`);
    const payload = await response.json() as { site?: { uuid?: string } };
    if (payload.site?.uuid !== connection.siteId) throw new Error('Replacement key belongs to a different Ghost site');
    connection.encryptedKey = encryptExternalCredential(apiKey, this.secret);
    connection.state = 'ACTIVE';
    connection.lastError = undefined;
    connection.updatedAt = new Date().toISOString();
    this.recordTarget(actorId, 'key_replace', connection.connectionId, randomUUID());
    return this.publicConnection(connection);
  }
  disconnect(id: string, actorId = 'system') {
    const connection = this.requiredConnection(id);
    connection.encryptedKey = '';
    connection.state = 'DISCONNECTED';
    connection.updatedAt = new Date().toISOString();
    this.recordTarget(actorId, 'disconnect', connection.connectionId, randomUUID());
    return this.publicConnection(connection);
  }
  listReferences(connectionId: string) {
    return [...this.references.values()].filter((reference) => reference.connectionId === connectionId);
  }
  async sync(id: string, actorId: string) {
    const connection = this.requiredConnection(id);
    const seen = new Set<string>();
    let imported = 0;
    let changed = 0;

    for (const type of ['post', 'page'] as const) {
      const items = await this.listAll(connection, `${type}s/`, type);
      for (const item of items) {
        if (!item.id) continue;
        seen.add(`${type}:${item.id}`);
        const referenceId = `${connection.connectionId}:${type}:${item.id}`;
        const contentHash = createHash('sha256')
          .update(JSON.stringify({
            title: item.title || '',
            excerpt: item.custom_excerpt || item.excerpt || '',
            lexical: item.lexical || '',
            html: item.html || '',
            tags: item.tags || [],
            authors: item.authors || [],
            visibility: item.visibility || 'public',
            status: item.status || 'unknown'
          }))
          .digest('hex');
        const existing = this.references.get(referenceId);
        const now = new Date().toISOString();
        const reference: GhostExternalReferenceWork = {
          referenceId,
          connectionId: connection.connectionId,
          creatorId: connection.creatorId,
          remoteId: item.id,
          type,
          remoteUrl: item.url,
          title: item.title || 'Untitled Ghost content',
          slug: item.slug || item.id,
          excerpt: item.custom_excerpt || item.excerpt,
          tags: (item.tags || []).flatMap((tag) => tag.name ? [tag.name] : []),
          authors: (item.authors || []).flatMap((author) => author.name ? [author.name] : []),
          visibility: item.visibility || 'public',
          remoteStatus: item.status || 'unknown',
          contentHash,
          sourceAvailability: 'metadata_only',
          mappingState: existing?.mappingState || 'staged',
          syncState: existing && existing.contentHash !== contentHash ? 'remote_changed' : 'in_sync',
          discoveryEnabled: false,
          notice: GHOST_REFERENCE_NOTICE,
          importedAt: existing?.importedAt || now,
          remoteUpdatedAt: item.updated_at
        };
        if (!existing) imported += 1;
        else if (existing.contentHash !== contentHash) changed += 1;
        this.references.set(referenceId, reference);
      }
    }

    let missing = 0;
    for (const reference of this.listReferences(connection.connectionId)) {
      if (!seen.has(`${reference.type}:${reference.remoteId}`) && reference.syncState !== 'missing') {
        reference.syncState = 'missing';
        missing += 1;
      }
    }
    connection.lastSyncAt = new Date().toISOString();
    connection.lastError = undefined;
    connection.updatedAt = connection.lastSyncAt;
    this.recordTarget(actorId, 'sync', connection.connectionId, randomUUID(), createHash('sha256').update(JSON.stringify({ imported, changed, missing })).digest('hex'));
    return { imported, changed, missing, references: this.listReferences(connection.connectionId) };
  }
  createDraft(input: Omit<GhostPublication, 'publicationId' | 'contentHash' | 'idempotencyKey' | 'status' | 'createdAt' | 'updatedAt'>) {
    const connection = this.requiredConnection(input.connectionId);
    if (connection.creatorId !== input.creatorId) throw new Error('Ghost connection does not belong to this creator');
    if (!input.title?.trim()) throw new Error('A publication title is required');
    if (!['post', 'page'].includes(input.type)) throw new Error('Ghost publication type must be post or page');
    if (!connection.permittedTypes.includes(input.type)) throw new Error(`Ghost ${input.type} publishing is not enabled for this connection`);
    if (!['public', 'members', 'paid'].includes(input.visibility)) throw new Error('Unsupported Ghost visibility');
    const canonicalUrlPolicy = input.canonicalUrlPolicy || 'ghost';
    if (!['ghost', 'ubeeq', 'custom'].includes(canonicalUrlPolicy)) throw new Error('Unsupported canonical URL policy');
    if (canonicalUrlPolicy !== 'ghost') {
      if (!input.canonicalUrl) throw new Error('A canonical URL is required for this policy');
      const canonical = new URL(input.canonicalUrl);
      if (canonical.protocol !== 'https:') throw new Error('Canonical URL must use HTTPS');
    }
    const now = new Date().toISOString();
    const publication: GhostPublication = {
      ...input,
      title: input.title.trim(),
      lexical: validateGhostLexical(input.lexical),
      tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 50),
      canonicalUrlPolicy,
      publicationId: randomUUID(),
      contentHash: '',
      idempotencyKey: randomUUID(),
      status: 'draft',
      createdAt: now,
      updatedAt: now
    };
    publication.contentHash = publicationHash(publication);
    this.publications.set(publication.publicationId, publication);
    return publication;
  }
  getPublication(id: string) { return this.publications.get(id); }
  getMediaMapping(connectionId: string, derivativeAssetId: string) {
    return this.mediaMappings.get(`${connectionId}:${derivativeAssetId}`);
  }
  async uploadImage(input: {
    connectionId: string;
    creatorId: string;
    derivativeAssetId: string;
    bytes: Buffer;
    filename: string;
    contentType: string;
    alt?: string;
    caption?: string;
  }, actorId: string) {
    const connection = this.requiredConnection(input.connectionId);
    if (connection.creatorId !== input.creatorId) throw new Error('Ghost connection does not belong to this creator');
    if (!/^image\/(jpeg|png|gif|webp)$/.test(input.contentType)) throw new Error('Ghost image must be JPEG, PNG, GIF, or WebP');
    if (!input.bytes.length || input.bytes.length > 20 * 1024 * 1024) throw new Error('Ghost image must be between 1 byte and 20 MB');
    const checksumSha256 = createHash('sha256').update(input.bytes).digest('hex');
    const existing = this.getMediaMapping(input.connectionId, input.derivativeAssetId);
    if (existing?.checksumSha256 === checksumSha256) return existing;

    const form = new FormData();
    form.append('file', new Blob([Uint8Array.from(input.bytes)], { type: input.contentType }), input.filename || 'image');
    form.append('purpose', 'image');
    const response = await this.ghost(connection, 'images/upload/', { method: 'POST', body: form }, false) as { images?: Array<{ url?: string }> };
    const ghostImageUrl = response.images?.[0]?.url;
    if (!ghostImageUrl) throw new Error('Ghost did not return an uploaded image URL');
    const mapping: GhostMediaMapping = {
      mappingId: randomUUID(), connectionId: input.connectionId, creatorId: input.creatorId,
      derivativeAssetId: input.derivativeAssetId, ghostImageUrl, checksumSha256,
      alt: input.alt?.trim() || undefined, caption: input.caption?.trim() || undefined,
      createdAt: new Date().toISOString()
    };
    this.mediaMappings.set(`${input.connectionId}:${input.derivativeAssetId}`, mapping);
    this.recordTarget(actorId, 'image_upload', mapping.mappingId, randomUUID(), checksumSha256);
    return mapping;
  }
  updateDraft(id: string, changes: Partial<Pick<GhostPublication, 'title' | 'slug' | 'excerpt' | 'lexical' | 'visibility' | 'tags' | 'scheduledAt' | 'featureImageAssetId' | 'canonicalUrlPolicy' | 'canonicalUrl' | 'eligibilityCheckedAt' | 'eligibilityReasons'>>) {
    const publication = this.requiredPublication(id);
    if (changes.title !== undefined) {
      if (!changes.title.trim()) throw new Error('A publication title is required');
      publication.title = changes.title.trim();
    }
    if (changes.lexical !== undefined) publication.lexical = validateGhostLexical(changes.lexical);
    if (changes.visibility !== undefined) {
      if (!['public', 'members', 'paid'].includes(changes.visibility)) throw new Error('Unsupported Ghost visibility');
      publication.visibility = changes.visibility;
    }
    if (changes.tags !== undefined) publication.tags = [...new Set(changes.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 50);
    if (changes.slug !== undefined) publication.slug = changes.slug.trim() || undefined;
    if (changes.excerpt !== undefined) publication.excerpt = changes.excerpt.trim() || undefined;
    if (changes.scheduledAt !== undefined) publication.scheduledAt = changes.scheduledAt || undefined;
    if (changes.featureImageAssetId !== undefined) publication.featureImageAssetId = changes.featureImageAssetId.trim() || undefined;
    if (changes.canonicalUrlPolicy !== undefined) {
      if (!['ghost', 'ubeeq', 'custom'].includes(changes.canonicalUrlPolicy)) throw new Error('Unsupported canonical URL policy');
      publication.canonicalUrlPolicy = changes.canonicalUrlPolicy;
    }
    if (changes.canonicalUrl !== undefined) publication.canonicalUrl = changes.canonicalUrl.trim() || undefined;
    if (changes.eligibilityCheckedAt !== undefined) publication.eligibilityCheckedAt = changes.eligibilityCheckedAt;
    if (changes.eligibilityReasons !== undefined) publication.eligibilityReasons = [...changes.eligibilityReasons];
    if (publication.canonicalUrlPolicy !== 'ghost') {
      if (!publication.canonicalUrl || new URL(publication.canonicalUrl).protocol !== 'https:') throw new Error('A secure canonical URL is required for this policy');
    }
    publication.contentHash = publicationHash(publication);
    publication.updatedAt = new Date().toISOString();
    return publication;
  }
  diff(id: string) {
    const publication = this.requiredPublication(id);
    const remote = this.remoteSnapshots.get(id);
    const local = ghostReconciliationSnapshot(publication);
    const remoteSnapshot = remote ? ghostReconciliationSnapshot(remote) : undefined;
    const reconciliationFields = remoteSnapshot
      ? diffReconciliationSnapshots(this.reconciliationBaselines.get(id) || local, local, remoteSnapshot)
      : [];
    const status = reconciliationStatus(reconciliationFields);
    return {
      status,
      changed: Boolean(publication.remoteContentHash && publication.remoteContentHash !== publication.contentHash),
      localHash: publication.contentHash,
      remoteHash: publication.remoteContentHash,
      remoteUpdatedAt: publication.remoteUpdatedAt,
      resolutionRequired: publication.status === 'remote_changed' || status === 'remote_newer' || status === 'conflict',
      // Preserve the existing Ghost endpoint's small field shape while exposing
      // the richer shared contract for generic integration consumers.
      fields: reconciliationFields.map(({ field, local: localValue, remote: remoteValue }) => ({ field, local: localValue, remote: remoteValue })),
      reconciliation: { status, fields: reconciliationFields },
      choices: ['update_ghost', 'accept_remote', 'keep_ghost_unchanged', 'create_new_post'] as const
    };
  }
  resolveConflict(id: string, action: 'accept_remote' | 'keep_ghost_unchanged' | 'create_new_post', actorId: string, confirmed: boolean) {
    if (!confirmed) throw new Error('Explicit reconciliation confirmation is required');
    const publication = this.requiredPublication(id);
    if (publication.status !== 'remote_changed') throw new Error('Ghost publication has no remote conflict to resolve');
    const remote = this.remoteSnapshots.get(id);
    if (!remote) throw new Error('Reconcile the Ghost publication before resolving it');
    const resolvedAt = new Date().toISOString();
    const localSnapshot = ghostReconciliationSnapshot(publication);
    const remoteSnapshot = ghostReconciliationSnapshot(remote);
    const genericAction = action === 'accept_remote'
      ? 'accept_remote'
      : action === 'keep_ghost_unchanged'
        ? 'keep_local'
        : 'create_detached_copy';
    const resolution = resolveReconciliation(localSnapshot, remoteSnapshot, { action: genericAction, confirmed });

    if (action === 'accept_remote') {
      const resolved = resolution.local;
      publication.title = String(resolved.title || 'Untitled Ghost content');
      publication.slug = typeof resolved.slug === 'string' && resolved.slug ? resolved.slug : undefined;
      publication.excerpt = typeof resolved.excerpt === 'string' && resolved.excerpt ? resolved.excerpt : undefined;
      publication.lexical = typeof resolved.lexical === 'string' ? resolved.lexical : publication.lexical;
      publication.visibility = resolved.visibility === 'members' || resolved.visibility === 'paid' ? resolved.visibility : 'public';
      publication.tags = Array.isArray(resolved.tags) ? resolved.tags.filter((tag): tag is string => typeof tag === 'string') : [];
      publication.scheduledAt = typeof resolved.scheduledAt === 'string' && resolved.scheduledAt ? resolved.scheduledAt : undefined;
      publication.featureImageAssetId = typeof resolved.featureImageAssetId === 'string' && resolved.featureImageAssetId ? resolved.featureImageAssetId : undefined;
      publication.canonicalUrlPolicy = resolved.canonicalUrlPolicy === 'ubeeq' || resolved.canonicalUrlPolicy === 'custom' ? resolved.canonicalUrlPolicy : 'ghost';
      publication.canonicalUrl = typeof resolved.canonicalUrl === 'string' && resolved.canonicalUrl ? resolved.canonicalUrl : undefined;
      publication.contentHash = publicationHash(publication);
      publication.remoteContentHash = publication.contentHash;
      publication.status = remote.remoteStatus === 'scheduled' ? 'scheduled' : 'published';
    } else if (action === 'keep_ghost_unchanged') {
      publication.status = remote.remoteStatus === 'scheduled' ? 'scheduled' : 'published';
    } else if (action === 'create_new_post') {
      const clone: GhostPublication = {
        ...publication,
        publicationId: randomUUID(),
        remoteId: undefined,
        remoteUrl: undefined,
        remoteUpdatedAt: undefined,
        remoteContentHash: undefined,
        idempotencyKey: randomUUID(),
        status: 'draft',
        conflictResolution: undefined,
        conflictResolvedAt: undefined,
        createdAt: resolvedAt,
        updatedAt: resolvedAt
      };
      this.publications.set(clone.publicationId, clone);
      this.reconciliationBaselines.set(clone.publicationId, localSnapshot);
      publication.conflictResolution = action;
      publication.conflictResolvedAt = resolvedAt;
      publication.updatedAt = resolvedAt;
      this.record(actorId, 'resolve_create_new_post', publication);
      return { publication, newPublication: clone };
    } else {
      throw new Error('Unsupported Ghost reconciliation action');
    }

    publication.conflictResolution = action;
    publication.conflictResolvedAt = resolvedAt;
    publication.updatedAt = resolvedAt;
    this.reconciliationBaselines.set(publication.publicationId, ghostReconciliationSnapshot(publication));
    this.record(actorId, `resolve_${action}`, publication);
    return { publication };
  }
  async publish(id: string, actorId: string, confirmed: boolean) {
    if (!confirmed) throw new Error('Explicit publish confirmation is required'); const p = this.requiredPublication(id); const c = this.requiredConnection(p.connectionId);
    if (p.remoteId && !p.remoteUpdatedAt) throw new Error('Reconcile the Ghost publication before updating');
    const mappedTags = p.tags.map((name) => c.tagMappings[name] || name);
    const mappedAuthorId = c.authorMappings[p.creatorId];
    const featureImage = p.featureImageAssetId ? this.getMediaMapping(c.connectionId, p.featureImageAssetId) : undefined;
    if (p.featureImageAssetId && !featureImage) throw new Error('Upload the selected feature image derivative to Ghost before publishing');
    const body: Record<string, unknown> = { title: p.title, lexical: p.lexical, visibility: p.visibility, tags: mappedTags.map(name => ({ name })), ...(mappedAuthorId ? { authors: [{ id: mappedAuthorId }] } : {}), ...(featureImage ? { feature_image: featureImage.ghostImageUrl, feature_image_alt: featureImage.alt, feature_image_caption: featureImage.caption } : {}), ...(p.canonicalUrlPolicy !== 'ghost' && p.canonicalUrl ? { canonical_url: p.canonicalUrl } : {}), status: p.scheduledAt ? 'scheduled' : 'published', ...(p.remoteId && p.remoteUpdatedAt ? { updated_at: p.remoteUpdatedAt } : {}), ...(p.slug ? { slug: p.slug } : {}), ...(p.excerpt ? { custom_excerpt: p.excerpt } : {}), ...(p.scheduledAt ? { published_at: p.scheduledAt } : {}) };
    const result = await this.ghost(c, `${p.type}s/${p.remoteId ? `${p.remoteId}/` : ''}`, { method: p.remoteId ? 'PUT' : 'POST', body: JSON.stringify({ [`${p.type}s`]: [body] }) }) as Record<string, any>;
    const remote = result[`${p.type}s`]?.[0]; p.remoteId = remote?.id || p.remoteId; p.remoteUrl = remote?.url || p.remoteUrl; p.remoteUpdatedAt = remote?.updated_at; p.remoteContentHash = p.contentHash; p.status = p.scheduledAt ? 'scheduled' : 'published'; p.updatedAt = new Date().toISOString(); this.reconciliationBaselines.set(p.publicationId, ghostReconciliationSnapshot(p)); this.record(actorId, 'publish', p); return p;
  }
  async reconcile(id: string, actorId: string) {
    const publication = this.requiredPublication(id);
    if (!publication.remoteId) return { publication, diff: this.diff(id) };
    try {
      const result = await this.ghost(this.requiredConnection(publication.connectionId), `${publication.type}s/${publication.remoteId}/?include=tags,authors&formats=lexical`, { method: 'GET' }) as Record<string, GhostRemoteItem[]>;
      const remote = result[`${publication.type}s`]?.[0];
      if (!remote) throw new Error('Ghost publication not found');
      const connection = this.requiredConnection(publication.connectionId);
      const reverseTags = new Map(Object.entries(connection.tagMappings).map(([local, ghost]) => [ghost, local]));
      const remoteFeatureMapping = [...this.mediaMappings.values()].find((mapping) => mapping.connectionId === connection.connectionId && mapping.ghostImageUrl === remote.feature_image);
      const remoteComparable: GhostComparablePublication = {
        title: remote.title || '', slug: remote.slug, excerpt: remote.custom_excerpt || remote.excerpt,
        lexical: remote.lexical || '', visibility: remote.visibility || 'public' as GhostVisibility,
        tags: (remote.tags || []).flatMap((tag) => tag.name ? [reverseTags.get(tag.name) || tag.name] : []),
        scheduledAt: remote.status === 'scheduled' ? remote.published_at : undefined,
        // A Ghost-hosted image is not a canonical Ubeeq Asset. Only retain a
        // feature-image selection when it maps to an approved local derivative.
        featureImageAssetId: remoteFeatureMapping?.derivativeAssetId,
        canonicalUrlPolicy: remote.canonical_url ? (remote.canonical_url === publication.canonicalUrl ? publication.canonicalUrlPolicy : 'custom' as const) : 'ghost' as const,
        canonicalUrl: remote.canonical_url,
        remoteStatus: remote.status
      };
      this.remoteSnapshots.set(publication.publicationId, remoteComparable);
      publication.remoteContentHash = publicationHash(remoteComparable);
      publication.remoteUpdatedAt = remote.updated_at;
      publication.remoteUrl = remote.url || publication.remoteUrl;
      const local = ghostReconciliationSnapshot(publication);
      const remoteSnapshot = ghostReconciliationSnapshot(remoteComparable);
      const baseline = this.reconciliationBaselines.get(publication.publicationId) || local;
      const status = reconciliationStatus(diffReconciliationSnapshots(baseline, local, remoteSnapshot));
      publication.status = status === 'in_sync' ? (remote.status === 'scheduled' ? 'scheduled' : 'published') : 'remote_changed';
    } catch (error) {
      if (error instanceof GhostRequestError && error.status === 404) publication.status = 'missing';
      else throw error;
    }
    publication.updatedAt = new Date().toISOString();
    this.record(actorId, 'reconcile', publication);
    return { publication, diff: this.diff(id) };
  }
  async handleWebhook(input: { connectionId: string; secret: string; eventId: string; remoteId?: string; type?: 'post' | 'page' }) {
    const connection = this.requiredConnection(input.connectionId);
    const actual = Buffer.from(createHash('sha256').update(input.secret || '').digest('hex'));
    const expected = Buffer.from(connection.webhookSecretHash);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      connection.lastWebhookError = 'authentication_failed';
      throw new Error('Ghost webhook authentication failed');
    }
    const dedupeKey = `${connection.connectionId}:${input.eventId}`;
    if (this.webhookEvents.has(dedupeKey)) return { accepted: true, duplicate: true };
    this.webhookEvents.add(dedupeKey);
    connection.lastWebhookAt = new Date().toISOString();
    connection.lastWebhookError = undefined;
    const publications = [...this.publications.values()].filter((publication) => publication.connectionId === connection.connectionId
      && publication.remoteId === input.remoteId && (!input.type || publication.type === input.type));
    await Promise.all(publications.map((publication) => this.reconcile(publication.publicationId, 'ghost-webhook')));
    return { accepted: true, duplicate: false, reconciled: publications.length };
  }
  async unpublish(id: string, actorId: string, confirmed: boolean) { if (!confirmed) throw new Error('Explicit unpublish confirmation is required'); const p = this.requiredPublication(id); if (!p.remoteId) throw new Error('Publication has no Ghost remote ID'); if (!p.remoteUpdatedAt) throw new Error('Reconcile the Ghost publication before unpublishing'); await this.ghost(this.requiredConnection(p.connectionId), `${p.type}s/${p.remoteId}/`, { method: 'PUT', body: JSON.stringify({ [`${p.type}s`]: [{ status: 'draft', updated_at: p.remoteUpdatedAt }] }) }); p.status = 'unpublished'; p.updatedAt = new Date().toISOString(); this.record(actorId, 'unpublish', p); return p; }
  async remove(id: string, actorId: string, confirmed: boolean) { if (!confirmed) throw new Error('Explicit delete confirmation is required'); const p = this.requiredPublication(id); if (p.remoteId) await this.ghost(this.requiredConnection(p.connectionId), `${p.type}s/${p.remoteId}/`, { method: 'DELETE' }); this.publications.delete(id); this.record(actorId, 'delete', p); }
  private requiredConnection(id: string) { const value = this.connections.get(id); if (!value || value.state === 'DISCONNECTED') throw new Error('Active Ghost connection not found'); return value; }
  private requiredPublication(id: string) { const value = this.publications.get(id); if (!value) throw new Error('Ghost publication not found'); return value; }
  private async ghost(c: GhostConnection, path: string, init: RequestInit, json = true) {
    const key = decryptExternalCredential(c.encryptedKey, this.secret);
    const maximumAttempts = init.method === 'GET' ? 3 : 1;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const response = await this.request(`${c.adminUrl}/${path}`, {
        ...init,
        signal: init.signal || AbortSignal.timeout(15_000),
        headers: { Authorization: `Ghost ${ghostAdminToken(key)}`, 'Accept-Version': c.apiVersion, ...(json ? { 'Content-Type': 'application/json' } : {}), ...init.headers }
      });
      if (response.ok) return response.status === 204 ? {} : response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maximumAttempts) throw new GhostRequestError(response.status);
      const retryAfterHeader = response.headers?.get?.('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
      const delay = Number.isFinite(retryAfterSeconds)
        ? Math.min(30_000, Math.max(0, retryAfterSeconds * 1_000))
        : 250 * (2 ** (attempt - 1));
      await this.pause(delay);
    }
    throw new GhostRequestError(503);
  }
  private record(actorId: string, action: string, p: GhostPublication) { this.audit.push({ eventId: randomUUID(), actorId, action, targetId: p.publicationId, correlationId: p.idempotencyKey, result: 'success', afterHash: p.contentHash, at: new Date().toISOString() }); }
  private recordTarget(actorId: string, action: string, targetId: string, correlationId: string, afterHash?: string) {
    this.audit.push({ eventId: randomUUID(), actorId, action, targetId, correlationId, result: 'success', afterHash, at: new Date().toISOString() });
  }
  private async listAll(connection: GhostConnection, path: string, key: 'post' | 'page') {
    const result: GhostRemoteItem[] = [];
    let page = 1;
    while (page <= 100) {
      const payload = await this.ghost(connection, `${path}?limit=100&page=${page}&include=tags,authors&formats=lexical,html`, { method: 'GET' }) as {
        posts?: GhostRemoteItem[];
        pages?: GhostRemoteItem[];
        meta?: { pagination?: { next?: number | null } };
      };
      result.push(...(key === 'post' ? payload.posts || [] : payload.pages || []));
      const next = payload.meta?.pagination?.next;
      if (!next) break;
      page = next;
    }
    return result;
  }
}

class GhostRequestError extends Error {
  constructor(readonly status: number) {
    super(`Ghost request failed (${status})`);
  }
}

export const registerGhostRoutes = (
  app: Express,
  service: GhostIntegrationService,
  canAccessCreator: (req: Request, res: Response, creatorId: string) => Promise<boolean>,
  eligibilityForWork: (workId: string, connectionId?: string) => Promise<GhostEligibility>,
  canUploadDerivative: (creatorId: string, derivativeAssetId: string) => Promise<boolean>,
  canCreateManagedConnection: (req: Request) => boolean
) => {
  const fail = (res: Response, error: unknown) => res.status(error instanceof Error && /not found/i.test(error.message) ? 404 : 400).json({ message: error instanceof Error ? error.message : 'Ghost operation failed' });
  const requireEligibility = async (res: Response, workId: string, connectionId: string) => {
    const eligibility = await eligibilityForWork(workId, connectionId);
    if (!eligibility.eligible) {
      res.status(409).json({ message: 'Work is not eligible for Ghost publishing', eligibility });
      return null;
    }
    return eligibility;
  };
  app.get('/api/integrations/ghost/connections', requireAuth, async (req, res) => { const creatorId = String(req.query.creatorId || ''); if (!await canAccessCreator(req, res, creatorId)) return; res.json({ items: service.listConnections(creatorId) }); });
  app.post('/api/integrations/ghost/connections', requireAuth, async (req, res) => { try { if (!await canAccessCreator(req, res, req.body?.creatorId)) return; res.status(201).json(await service.connect(req.body, req.authUser!.userId, canCreateManagedConnection(req))); } catch (e) { fail(res, e); } });
  app.post('/api/integrations/ghost/connections/:id/test', requireAuth, async (req, res) => { try { const c = service.getConnection(req.params.id); if (!c || !await canAccessCreator(req, res, c.creatorId)) return; res.json(await service.test(c.connectionId)); } catch (e) { fail(res, e); } });
  app.patch('/api/integrations/ghost/connections/:id', requireAuth, async (req, res) => { try { const c = service.getConnection(req.params.id); if (!c || !await canAccessCreator(req, res, c.creatorId)) return; res.json(service.configure(c.connectionId, req.body || {}, req.authUser!.userId)); } catch (e) { fail(res, e); } });
  app.post('/api/integrations/ghost/connections/:id/key', requireAuth, async (req, res) => { try { const c = service.getConnection(req.params.id); if (!c || !await canAccessCreator(req, res, c.creatorId)) return; if (typeof req.body?.apiKey !== 'string') throw new Error('A Ghost Admin API key is required'); res.json(await service.replaceKey(c.connectionId, req.body.apiKey, req.authUser!.userId)); } catch (e) { fail(res, e); } });
  app.post('/api/integrations/ghost/connections/:id/sync', requireAuth, async (req, res) => { try { const c = service.getConnection(req.params.id); if (!c || !await canAccessCreator(req, res, c.creatorId)) return; res.json(await service.sync(c.connectionId, req.authUser!.userId)); } catch (e) { fail(res, e); } });
  app.get('/api/integrations/ghost/connections/:id/references', requireAuth, async (req, res) => { const c = service.getConnection(req.params.id); if (!c || !await canAccessCreator(req, res, c.creatorId)) return; res.json({ items: service.listReferences(c.connectionId) }); });
  app.delete('/api/integrations/ghost/connections/:id', requireAuth, async (req, res) => { try { const c = service.getConnection(req.params.id); if (!c || !await canAccessCreator(req, res, c.creatorId)) return; service.disconnect(c.connectionId, req.authUser!.userId); res.status(204).send(); } catch (e) { fail(res, e); } });
  app.get('/api/works/:workId/ghost/eligibility', requireAuth, async (req, res) => { try { const result = await eligibilityForWork(req.params.workId, typeof req.query.connectionId === 'string' ? req.query.connectionId : undefined); if (!result.checks.workOwned || !await canAccessCreator(req, res, result.creatorId)) return; res.json(result); } catch (e) { fail(res, e); } });
  app.post('/api/integrations/ghost/connections/:id/images', requireAuth, express.raw({ type: 'image/*', limit: '20mb' }), async (req, res) => { try { const c = service.getConnection(req.params.id); if (!c || !await canAccessCreator(req, res, c.creatorId)) return; if (!Buffer.isBuffer(req.body)) throw new Error('Image bytes are required'); const derivativeAssetId = String(req.query.derivativeAssetId || ''); if (!derivativeAssetId || !await canUploadDerivative(c.creatorId, derivativeAssetId)) throw new Error('A ready image derivative owned by this creator is required'); res.status(201).json(await service.uploadImage({ connectionId: c.connectionId, creatorId: c.creatorId, derivativeAssetId, bytes: req.body, filename: String(req.query.filename || 'image'), contentType: req.headers['content-type'] || '', alt: typeof req.query.alt === 'string' ? req.query.alt : undefined, caption: typeof req.query.caption === 'string' ? req.query.caption : undefined }, req.authUser!.userId)); } catch (e) { fail(res, e); } });
  app.post('/api/works/:workId/ghost/publications', requireAuth, async (req, res) => { try { const eligibility = await requireEligibility(res, req.params.workId, String(req.body?.connectionId || '')); if (!eligibility || !await canAccessCreator(req, res, eligibility.creatorId)) return; if (req.body?.creatorId && req.body.creatorId !== eligibility.creatorId) throw new Error('Work and creator do not match'); res.status(201).json(service.createDraft({ ...req.body, creatorId: eligibility.creatorId, workId: req.params.workId, eligibilityCheckedAt: new Date().toISOString(), eligibilityReasons: [] })); } catch (e) { fail(res, e); } });
  app.patch('/api/ghost/publications/:id', requireAuth, async (req, res) => { try { const p = service.getPublication(req.params.id); if (!p || !await canAccessCreator(req, res, p.creatorId)) return; const eligibility = await requireEligibility(res, p.workId, p.connectionId); if (!eligibility) return; res.json(service.updateDraft(p.publicationId, { ...(req.body || {}), eligibilityCheckedAt: new Date().toISOString(), eligibilityReasons: [] })); } catch (e) { fail(res, e); } });
  app.get('/api/ghost/publications/:id/diff', requireAuth, async (req, res) => { try { const p = service.getPublication(req.params.id); if (!p || !await canAccessCreator(req, res, p.creatorId)) return; res.json(service.diff(p.publicationId)); } catch (e) { fail(res, e); } });
  app.post('/api/ghost/publications/:id/reconcile', requireAuth, async (req, res) => { try { const p = service.getPublication(req.params.id); if (!p || !await canAccessCreator(req, res, p.creatorId)) return; res.json(await service.reconcile(p.publicationId, req.authUser!.userId)); } catch (e) { fail(res, e); } });
  app.post('/api/ghost/publications/:id/reconcile/resolve', requireAuth, async (req, res) => { try { const p = service.getPublication(req.params.id); if (!p || !await canAccessCreator(req, res, p.creatorId)) return; const action = req.body?.action; if (!['accept_remote', 'keep_ghost_unchanged', 'create_new_post'].includes(action)) throw new Error('Unsupported Ghost reconciliation action'); res.json(service.resolveConflict(p.publicationId, action, req.authUser!.userId, req.body?.confirm === true)); } catch (e) { fail(res, e); } });
  app.post('/api/ghost/publications/:id/publish', requireAuth, async (req, res) => { try { const p = service.getPublication(req.params.id); if (!p || !await canAccessCreator(req, res, p.creatorId)) return; const eligibility = await requireEligibility(res, p.workId, p.connectionId); if (!eligibility) return; res.json(await service.publish(p.publicationId, req.authUser!.userId, req.body?.confirm === true)); } catch (e) { fail(res, e); } });
  app.post('/api/ghost/publications/:id/unpublish', requireAuth, async (req, res) => { try { const p = service.getPublication(req.params.id); if (!p || !await canAccessCreator(req, res, p.creatorId)) return; res.json(await service.unpublish(p.publicationId, req.authUser!.userId, req.body?.confirm === true)); } catch (e) { fail(res, e); } });
  app.delete('/api/ghost/publications/:id', requireAuth, async (req, res) => { try { const p = service.getPublication(req.params.id); if (!p || !await canAccessCreator(req, res, p.creatorId)) return; await service.remove(p.publicationId, req.authUser!.userId, req.body?.confirm === true); res.status(204).send(); } catch (e) { fail(res, e); } });
  app.post('/webhooks/ghost/:connectionId', async (req, res) => { try { const event = req.body?.post || req.body?.page || req.body; const current = event?.current || event; const type = req.body?.post ? 'post' : req.body?.page ? 'page' : undefined; const eventId = String(req.headers['x-ghost-event-id'] || `${type || 'content'}:${current?.id || 'unknown'}:${current?.updated_at || current?.status || 'event'}`); const result = await service.handleWebhook({ connectionId: req.params.connectionId, secret: String(req.headers['x-ghost-webhook-secret'] || ''), eventId, remoteId: typeof current?.id === 'string' ? current.id : undefined, type }); res.status(202).json(result); } catch (e) { res.status(401).json({ message: e instanceof Error ? e.message : 'Ghost webhook rejected' }); } });
};
