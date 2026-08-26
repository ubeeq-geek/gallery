import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { Express, Request } from 'express';
import type { AppConfig } from './config';
import type { DataStore } from './store';
import { requireAuth } from './auth';
import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import { nativeConnectionHealth } from './integrationAccountHealth';
import { VimeoApiError, VimeoProvider } from './vimeoProvider';
import type { CanonicalAsset, Work } from './canonicalDomain';
import type { VimeoQueue } from './vimeoQueue';

export const VIMEO_REFERENCE_NOTICE = 'Vimeo reference only — Ubeeq does not hold the original video. Upload the original directly to Ubeeq if you want it retained under your control.';
export const VIMEO_POLICY_VERSION = '2026-08-23.v1';
export type VimeoCapability = 'metadata_import' | 'video_publish' | 'metadata_update' | 'privacy_update' | 'embed_reference' | 'insights';
export type VimeoPrivacy = 'anybody' | 'nobody' | 'unlisted' | 'disable' | 'users' | 'password';
export interface VimeoConnection {
  id: string;
  ownerId: string;
  mode: 'EVERSALLY_MANAGED' | 'CREATOR_OWNED';
  remoteAccountId?: string;
  applicationClientId?: string;
  /** Encrypted creator-owned application secret. */
  applicationCredentialRef?: string;
  /** Encrypted OAuth token envelope. This field must never be serialized to a client. */
  credentialRef?: string;
  capabilities: VimeoCapability[];
  state: 'PENDING' | 'CONNECTED' | 'REAUTHORIZATION_REQUIRED' | 'DISCONNECTED';
  createdAt: string;
  updatedAt: string;
}

export interface VimeoOAuthAttempt {
  ownerId: string;
  connectionId: string;
  expiresAt: number;
}

export interface VimeoPublication {
  id: string;
  ownerId: string;
  connectionId: string;
  workId: string;
  sourceAssetId: string;
  sourceHash: string;
  intentVersion: string;
  idempotencyKey: string;
  state: 'DRAFT' | 'QUEUED' | 'UPLOADING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'MISSING' | 'ARCHIVED';
  privacy: VimeoPrivacy;
  embedDomains: string[];
  downloadsAllowed: boolean;
  remoteVideoId?: string;
  remoteUrl?: string;
  /** Encrypted, short-lived tus URL, accessible only to workers. */
  uploadAuthorization?: string;
  uploadOffset?: number;
  sourceDecisions?: Array<{
    fromAssetId: string;
    toAssetId: string;
    strategy: 'LEAVE_UNCHANGED' | 'CREATE_NEW_VIDEO' | 'REPLACE_SOURCE';
    result: 'UNCHANGED' | 'NEW_PUBLICATION_CREATED' | 'DENIED_BY_LAUNCH_POLICY';
    actorId: string;
    decidedAt: string;
  }>;
  lastError?: string;
  lastFailureRetryable?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VimeoExternalReferenceWork {
  id: string;
  ownerId: string;
  connectionId: string;
  remoteVideoId: string;
  remoteUrl?: string;
  mappedWorkId?: string;
  title: string;
  description?: string;
  privacy?: string;
  durationSeconds?: number;
  metadataHash: string;
  syncState: 'STAGED' | 'IN_SYNC' | 'REMOTE_CHANGED' | 'MISSING';
  notice: typeof VIMEO_REFERENCE_NOTICE;
  updatedAt: string;
}

export interface VimeoEmbedPolicy {
  publicationId: string;
  ownerId: string;
  enabled: boolean;
  allowedDomains: string[];
  lastVerifiedAt?: string;
  state: 'DISABLED' | 'READY' | 'DEGRADED';
  degradedReason?: string;
}

export interface VimeoInsightSnapshot {
  id: string;
  publicationId: string;
  metric: 'plays' | 'finishes' | 'likes';
  value: number;
  capturedAt: string;
  expiresAt: string;
}

export interface VimeoAuditEvent {
  id: string;
  ownerId: string;
  actorId: string;
  action: string;
  result: 'SUCCESS' | 'DENIED' | 'FAILED';
  correlationId: string;
  publicationId?: string;
  connectionId?: string;
  detail?: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface VimeoRepository {
  connection(id: string): Promise<VimeoConnection | undefined>;
  saveConnection(value: VimeoConnection): Promise<void>;
  publication(id: string): Promise<VimeoPublication | undefined>;
  publicationByKey(key: string): Promise<VimeoPublication | undefined>;
  publicationByRemoteVideoId(connectionId: string, remoteVideoId: string): Promise<VimeoPublication | undefined>;
  reconciliationCandidates(limit?: number): Promise<VimeoPublication[]>;
  createPublicationIfAbsent(value: VimeoPublication): Promise<VimeoPublication>;
  savePublication(value: VimeoPublication): Promise<void>;
  saveExternalReference(value: VimeoExternalReferenceWork): Promise<void>;
  externalReferences(connectionId: string): Promise<VimeoExternalReferenceWork[]>;
  embedPolicy(publicationId: string): Promise<VimeoEmbedPolicy | undefined>;
  saveEmbedPolicy(value: VimeoEmbedPolicy): Promise<void>;
  saveInsight(value: VimeoInsightSnapshot): Promise<void>;
  saveAudit(value: VimeoAuditEvent): Promise<void>;
  rememberOAuth(stateHash: string, attempt: VimeoOAuthAttempt): Promise<void>;
  consumeOAuth(stateHash: string): Promise<VimeoOAuthAttempt | undefined>;
  rememberWebhook(eventId: string): Promise<boolean>;
}

/** Local adapter used by tests/development. Deployments should provide a durable encrypted adapter. */
export class MemoryVimeoRepository implements VimeoRepository {
  private connections = new Map<string, VimeoConnection>();
  private publications = new Map<string, VimeoPublication>();
  private references = new Map<string, VimeoExternalReferenceWork>();
  private embeds = new Map<string, VimeoEmbedPolicy>();
  private insights: VimeoInsightSnapshot[] = [];
  private audits: VimeoAuditEvent[] = [];
  private oauth = new Map<string, VimeoOAuthAttempt>();
  private events = new Set<string>();

  async connection(id: string) { return this.connections.get(id); }
  async saveConnection(value: VimeoConnection) { this.connections.set(value.id, value); }
  async publication(id: string) { return this.publications.get(id); }
  async publicationByKey(key: string) { return [...this.publications.values()].find((p) => p.idempotencyKey === key); }
  async savePublication(value: VimeoPublication) { this.publications.set(value.id, value); }
  async publicationByRemoteVideoId(connectionId: string, remoteVideoId: string) { return [...this.publications.values()].find((value) => value.connectionId === connectionId && value.remoteVideoId === remoteVideoId); }
  async reconciliationCandidates(limit = 100) { return [...this.publications.values()].filter((value) => Boolean(value.remoteUrl) && ['PROCESSING', 'PUBLISHED'].includes(value.state)).slice(0, limit); }
  async createPublicationIfAbsent(value: VimeoPublication) { const existing = await this.publicationByKey(value.idempotencyKey); if (existing) return existing; await this.savePublication(value); return value; }
  async saveExternalReference(value: VimeoExternalReferenceWork) { this.references.set(value.id, value); }
  async externalReferences(connectionId: string) { return [...this.references.values()].filter((value) => value.connectionId === connectionId); }
  async embedPolicy(publicationId: string) { return this.embeds.get(publicationId); }
  async saveEmbedPolicy(value: VimeoEmbedPolicy) { this.embeds.set(value.publicationId, value); }
  async saveInsight(value: VimeoInsightSnapshot) { this.insights.push(value); }
  async saveAudit(value: VimeoAuditEvent) { this.audits.push(value); }
  async rememberOAuth(hash: string, attempt: VimeoOAuthAttempt) { this.oauth.set(hash, attempt); }
  async consumeOAuth(hash: string) { const value = this.oauth.get(hash); this.oauth.delete(hash); return value && value.expiresAt >= Date.now() ? value : undefined; }
  async rememberWebhook(id: string) { if (this.events.has(id)) return false; this.events.add(id); return true; }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const owns = (req: Request, ownerId: string) => req.authUser?.userId === ownerId;
const normalizedDomains = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.map(String).map((v) => v.trim().toLowerCase()).filter((v) => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(v)))].sort() : [];
export const vimeoEligibility = (rating?: string, safetyHold = false, mode: VimeoConnection['mode'] = 'EVERSALLY_MANAGED') => ({ result: safetyHold ? 'SAFETY_HOLD' : rating === 'adult' && mode === 'EVERSALLY_MANAGED' ? 'DESTINATION_POLICY_DENIED' : 'ALLOWED_MANAGED', policyVersion: VIMEO_POLICY_VERSION, source: 'UBEEQ_VIMEO_OUTPUT_POLICY', reviewedAt: new Date().toISOString() });
export const vimeoPreflight = (work: Work, asset: CanonicalAsset, connection: VimeoConnection) => {
  const errors: string[] = [];
  const eligibility = vimeoEligibility(work.contentRating, false, connection.mode);
  if (eligibility.result !== 'ALLOWED_MANAGED') errors.push(eligibility.result);
  if (connection.state !== 'CONNECTED') errors.push('CONNECTION_UNAVAILABLE');
  if (!connection.capabilities.includes('video_publish')) errors.push('CAPABILITY_DISABLED');
  if (work.status !== 'ready') errors.push('WORK_NOT_READY');
  if (asset.kind !== 'video' || asset.status !== 'ready') errors.push('VIDEO_NOT_READY');
  if (asset.storage.mode !== 'hosted' || !asset.storage.objectKey) errors.push('CANONICAL_SOURCE_REQUIRED');
  if (!asset.checksumSha256) errors.push('CHECKSUM_REQUIRED');
  if (!asset.sizeBytes || asset.sizeBytes <= 0) errors.push('SIZE_REQUIRED');
  if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(asset.mimeType)) errors.push('UNSUPPORTED_MIME_TYPE');
  return { allowed: errors.length === 0, errors, eligibility };
};
export const createVimeoPublication = async (repo: VimeoRepository, input: Omit<VimeoPublication, 'id' | 'idempotencyKey' | 'state' | 'createdAt' | 'updatedAt'>) => {
  const key = digest([input.workId, input.connectionId, input.intentVersion].join(':'));
  const existing = await repo.publicationByKey(key);
  if (existing) return existing;
  const now = new Date().toISOString();
  const publication: VimeoPublication = { ...input, id: randomUUID(), idempotencyKey: key, state: 'DRAFT', createdAt: now, updatedAt: now };
  return repo.createPublicationIfAbsent(publication);
};
export const verifyVimeoWebhook = (
  raw: Buffer,
  signature: string | undefined,
  secret: string,
  timestamp: string | undefined,
  now = Date.now()
) => {
  const timestampSeconds = Number(timestamp);
  if (!signature || !timestamp || !Number.isSafeInteger(timestampSeconds) || Math.abs(now - timestampSeconds * 1000) > 5 * 60_000) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
  const supplied = signature.replace(/^sha256=/, '');
  return supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
};

export const publicVimeoConnection = ({ credentialRef: _credential, applicationCredentialRef: _applicationCredential, ...connection }: VimeoConnection) => ({
  ...connection,
  health: nativeConnectionHealth({ platform: 'vimeo', state: connection.state, connectedStates: ['CONNECTED'], reauthorizationStates: ['REAUTHORIZATION_REQUIRED'] })
});
export const publicVimeoPublication = ({ uploadAuthorization: _authorization, ...publication }: VimeoPublication) => publication;

export const installVimeoRoutes = (
  app: Express,
  config: AppConfig,
  store: DataStore,
  repo: VimeoRepository = new MemoryVimeoRepository(),
  provider = new VimeoProvider(),
  queue?: VimeoQueue
) => {
  app.post('/webhooks/vimeo', async (req, res) => {
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const signature = typeof req.headers['x-vimeo-signature'] === 'string' ? req.headers['x-vimeo-signature'] : undefined;
    const timestamp = typeof req.headers['x-vimeo-timestamp'] === 'string' ? req.headers['x-vimeo-timestamp'] : undefined;
    if (!rawBody || !config.vimeoWebhookSecret || !verifyVimeoWebhook(rawBody, signature, config.vimeoWebhookSecret, timestamp)) return res.status(401).json({ message: 'Invalid Vimeo webhook signature' });
    const eventId = typeof req.headers['x-vimeo-event-id'] === 'string' ? req.headers['x-vimeo-event-id'] : String(req.body?.id || '');
    if (!eventId) return res.status(400).json({ message: 'Vimeo webhook event ID is required' });
    if (!(await repo.rememberWebhook(eventId))) return res.status(204).send();
    const connectionId = String(req.body?.connection_id || '');
    const remoteVideoId = String(req.body?.video_id || req.body?.data?.uri || '').split('/').pop() || '';
    const publication = connectionId && remoteVideoId ? await repo.publicationByRemoteVideoId(connectionId, remoteVideoId) : undefined;
    if (publication) {
      const eventType = String(req.body?.type || req.body?.event || '');
      publication.state = /delete|remove/i.test(eventType) ? 'MISSING' : 'PROCESSING';
      publication.updatedAt = new Date().toISOString();
      await repo.savePublication(publication);
    }
    return res.status(202).json({ accepted: true });
  });
  app.post('/api/integrations/vimeo/connections/start', requireAuth, async (req, res) => {
    if (!config.vimeoOAuthRedirectUri || !config.externalTokenEncryptionKey) return res.status(503).json({ message: 'Vimeo credential storage is not configured' });
    const mode: VimeoConnection['mode'] = req.body?.mode === 'CREATOR_OWNED' ? 'CREATOR_OWNED' : 'EVERSALLY_MANAGED';
    const clientId = mode === 'CREATOR_OWNED' ? String(req.body?.clientId || '').trim() : config.vimeoClientId;
    const clientSecret = mode === 'CREATOR_OWNED' ? String(req.body?.clientSecret || '') : config.vimeoClientSecret;
    if (!clientId || !clientSecret || clientId.length > 256 || clientSecret.length < 8 || clientSecret.length > 1024) return res.status(422).json({ message: 'Valid Vimeo application credentials are required' });
    const now = new Date().toISOString();
    const connection: VimeoConnection = {
      id: randomUUID(), ownerId: req.authUser!.userId, mode, applicationClientId: clientId,
      applicationCredentialRef: mode === 'CREATOR_OWNED' ? encryptExternalCredential(clientSecret, config.externalTokenEncryptionKey) : undefined,
      capabilities: [], state: 'PENDING', createdAt: now, updatedAt: now
    };
    await repo.saveConnection(connection);
    const state = randomBytes(32).toString('base64url');
    await repo.rememberOAuth(digest(state), { ownerId: connection.ownerId, connectionId: connection.id, expiresAt: Date.now() + 10 * 60_000 });
    const url = new URL('https://api.vimeo.com/oauth/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: config.vimeoOAuthRedirectUri, scope: 'public private edit upload video_files', state }).toString();
    return res.status(201).json({ connection: publicVimeoConnection(connection), authorizationUrl: url.toString(), notice: VIMEO_REFERENCE_NOTICE });
  });
  app.get('/api/integrations/vimeo/oauth/callback', async (req, res) => {
    const attempt = await repo.consumeOAuth(digest(String(req.query.state || '')));
    if (!attempt || !req.query.code) return res.status(400).json({ message: 'Invalid or expired OAuth state' });
    if (!config.vimeoOAuthRedirectUri || !config.externalTokenEncryptionKey) {
      return res.status(503).json({ message: 'Vimeo credential storage is not configured' });
    }
    const connection = await repo.connection(attempt.connectionId);
    if (!connection || connection.ownerId !== attempt.ownerId || connection.state === 'DISCONNECTED') return res.status(400).json({ message: 'Vimeo connection attempt is no longer valid' });
    const clientId = connection.applicationClientId || config.vimeoClientId;
    const clientSecret = connection.mode === 'CREATOR_OWNED' && connection.applicationCredentialRef
      ? decryptExternalCredential(connection.applicationCredentialRef, config.externalTokenEncryptionKey)
      : config.vimeoClientSecret;
    if (!clientId || !clientSecret) return res.status(503).json({ message: 'Vimeo application credentials are unavailable' });
    try {
      const tokens = await provider.exchangeCode({
        code: String(req.query.code),
        clientId,
        clientSecret,
        redirectUri: config.vimeoOAuthRedirectUri
      });
      const account = await provider.account(tokens.accessToken);
      connection.remoteAccountId = account.id;
      connection.credentialRef = encryptExternalCredential(JSON.stringify(tokens), config.externalTokenEncryptionKey);
      connection.state = 'CONNECTED';
      connection.updatedAt = new Date().toISOString();
      await repo.saveConnection(connection);
      return res.status(201).json({ ...publicVimeoConnection(connection), account });
    } catch (error) {
      const status = error instanceof VimeoApiError && error.status === 401 ? 401 : 502;
      return res.status(status).json({ message: 'Vimeo authorization failed' });
    }
  });
  app.get('/api/integrations/vimeo/connections/:id', requireAuth, async (req, res) => { const c = await repo.connection(req.params.id); return !c || !owns(req, c.ownerId) ? res.status(404).json({ message: 'Connection not found' }) : res.json(publicVimeoConnection(c)); });
  app.post('/api/integrations/vimeo/connections/:id/reauthorize', requireAuth, async (req, res) => {
    const connection = await repo.connection(req.params.id);
    if (!connection || !owns(req, connection.ownerId)) return res.status(404).json({ message: 'Connection not found' });
    if (!config.vimeoOAuthRedirectUri) return res.status(503).json({ message: 'Vimeo OAuth is not configured' });
    const clientId = connection.applicationClientId || config.vimeoClientId;
    if (!clientId || (connection.mode === 'CREATOR_OWNED' && !connection.applicationCredentialRef)) return res.status(409).json({ message: 'Vimeo application credentials are unavailable' });
    const state = randomBytes(32).toString('base64url');
    await repo.rememberOAuth(digest(state), { ownerId: connection.ownerId, connectionId: connection.id, expiresAt: Date.now() + 10 * 60_000 });
    const url = new URL('https://api.vimeo.com/oauth/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: config.vimeoOAuthRedirectUri, scope: 'public private edit upload video_files', state }).toString();
    await repo.saveAudit({ id: randomUUID(), ownerId: connection.ownerId, actorId: req.authUser!.userId, action: 'vimeo.connection.reauthorize', result: 'SUCCESS', correlationId: String(req.headers['x-correlation-id'] || randomUUID()), connectionId: connection.id, createdAt: new Date().toISOString() });
    return res.json({ authorizationUrl: url.toString() });
  });
  app.patch('/api/integrations/vimeo/connections/:id/capabilities', requireAuth, async (req, res) => { const c = await repo.connection(req.params.id); if (!c || !owns(req, c.ownerId)) return res.status(404).json({ message: 'Connection not found' }); const allowed: VimeoCapability[] = ['metadata_import','video_publish','metadata_update','privacy_update','embed_reference','insights']; c.capabilities = allowed.filter((x) => req.body?.capabilities?.includes(x)); c.updatedAt = new Date().toISOString(); await repo.saveConnection(c); return res.json(publicVimeoConnection(c)); });
  app.delete('/api/integrations/vimeo/connections/:id', requireAuth, async (req, res) => {
    const connection = await repo.connection(req.params.id);
    if (!connection || !owns(req, connection.ownerId)) return res.status(404).json({ message: 'Connection not found' });
    if (connection.credentialRef) {
      try {
        const tokens = JSON.parse(decryptExternalCredential(connection.credentialRef, config.externalTokenEncryptionKey)) as { accessToken: string };
        await provider.revokeAccessToken(tokens.accessToken);
      } catch {
        // Local credential destruction is mandatory even when remote revocation is unavailable.
      }
    }
    connection.state = 'DISCONNECTED';
    connection.credentialRef = undefined;
    connection.applicationCredentialRef = undefined;
    connection.capabilities = [];
    connection.updatedAt = new Date().toISOString();
    await repo.saveConnection(connection);
    return res.status(204).send();
  });
  app.post('/api/integrations/vimeo/connections/:id/sync', requireAuth, async (req, res) => {
    const connection = await repo.connection(req.params.id);
    if (!connection || !owns(req, connection.ownerId)) return res.status(404).json({ message: 'Connection not found' });
    if (!connection.credentialRef || !connection.capabilities.includes('metadata_import')) return res.status(409).json({ message: 'Metadata import is not enabled' });
    const tokens = JSON.parse(decryptExternalCredential(connection.credentialRef, config.externalTokenEncryptionKey)) as { accessToken: string };
    const existing = await repo.externalReferences(connection.id);
    const seen = new Set<string>();
    let page: number | undefined = 1;
    let imported = 0;
    do {
      const remotePage = await provider.listVideos(tokens.accessToken, page);
      for (const remote of remotePage.videos) {
        if (!remote.id) continue;
        seen.add(remote.id);
        const prior = existing.find((value) => value.remoteVideoId === remote.id);
        const metadataHash = digest(JSON.stringify({ title: remote.title, description: remote.description, duration: remote.durationSeconds, privacy: remote.privacy, modifiedAt: remote.modifiedAt }));
        await repo.saveExternalReference({
          id: prior?.id || randomUUID(),
          ownerId: connection.ownerId,
          connectionId: connection.id,
          remoteVideoId: remote.id,
          remoteUrl: remote.link,
          mappedWorkId: prior?.mappedWorkId,
          title: remote.title,
          description: remote.description,
          privacy: remote.privacy,
          durationSeconds: remote.durationSeconds,
          metadataHash,
          syncState: prior && prior.metadataHash !== metadataHash ? 'REMOTE_CHANGED' : prior?.syncState === 'STAGED' ? 'STAGED' : 'IN_SYNC',
          notice: VIMEO_REFERENCE_NOTICE,
          updatedAt: new Date().toISOString()
        });
        const publication = await repo.publicationByRemoteVideoId(connection.id, remote.id);
        if (publication && connection.capabilities.includes('insights')) {
          const capturedAt = new Date().toISOString();
          const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60_000).toISOString();
          for (const [metric, value] of Object.entries(remote.stats)) {
            if (typeof value === 'number' && ['plays', 'finishes', 'likes'].includes(metric)) await repo.saveInsight({ id: randomUUID(), publicationId: publication.id, metric: metric as VimeoInsightSnapshot['metric'], value, capturedAt, expiresAt });
          }
        }
        imported += 1;
      }
      page = remotePage.nextPage;
    } while (page && imported < 1000);
    for (const prior of existing.filter((value) => !seen.has(value.remoteVideoId))) await repo.saveExternalReference({ ...prior, syncState: 'MISSING', updatedAt: new Date().toISOString() });
    connection.updatedAt = new Date().toISOString();
    await repo.saveConnection(connection);
    return res.json({ imported, references: await repo.externalReferences(connection.id), notice: VIMEO_REFERENCE_NOTICE });
  });
  app.post('/api/integrations/vimeo/connections/:id/external-references/:referenceId/map', requireAuth, async (req, res) => {
    const connection = await repo.connection(req.params.id);
    if (!connection || !owns(req, connection.ownerId)) return res.status(404).json({ message: 'Connection not found' });
    if (req.body?.confirmed !== true) return res.status(422).json({ message: 'Explicit creator confirmation is required' });
    const reference = (await repo.externalReferences(connection.id)).find((value) => value.id === req.params.referenceId);
    if (!reference) return res.status(404).json({ message: 'Vimeo reference not found' });
    const work = await store.getWork(config.tenantId, String(req.body?.workId || ''));
    if (!work || !(await store.hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Work not found' });
    reference.mappedWorkId = work.workId;
    reference.syncState = 'IN_SYNC';
    reference.updatedAt = new Date().toISOString();
    await repo.saveExternalReference(reference);
    await repo.saveAudit({
      id: randomUUID(), ownerId: connection.ownerId, actorId: req.authUser!.userId,
      action: 'vimeo.external_reference.map', result: 'SUCCESS', correlationId: String(req.headers['x-correlation-id'] || randomUUID()),
      connectionId: connection.id, detail: { referenceId: reference.id, workId: work.workId }, createdAt: new Date().toISOString()
    });
    return res.json(reference);
  });
  app.get('/api/works/:workId/vimeo/eligibility', requireAuth, async (req, res) => { const work = await store.getWork(config.tenantId, req.params.workId); if (!work) return res.status(404).json({ message: 'Work not found' }); return res.json(vimeoEligibility((work as { contentRating?: string }).contentRating)); });
  app.post('/api/works/:workId/vimeo/publications', requireAuth, async (req, res) => {
    const connection = await repo.connection(String(req.body?.connectionId));
    if (!connection || !owns(req, connection.ownerId)) return res.status(404).json({ message: 'Connection not found' });
    const work = await store.getWork(config.tenantId, req.params.workId);
    if (!work || !(await store.hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Work not found' });
    const assets = await store.listCanonicalAssetsByWork(config.tenantId, req.params.workId);
    const asset = assets.find((candidate) => candidate.assetId === req.body?.sourceAssetId);
    if (!asset) return res.status(422).json({ message: 'A canonical video asset is required' });
    const preflight = vimeoPreflight(work, asset, connection);
    if (!preflight.allowed) return res.status(422).json({ message: 'Vimeo preflight failed', preflight });
    if (!req.body?.intentVersion) return res.status(422).json({ message: 'A publication intent version is required' });
    const publication = await createVimeoPublication(repo, {
      ownerId: req.authUser!.userId,
      connectionId: connection.id,
      workId: req.params.workId,
      sourceAssetId: asset.assetId,
      sourceHash: asset.checksumSha256!,
      intentVersion: String(req.body.intentVersion),
      privacy: req.body?.privacy || 'nobody',
      embedDomains: normalizedDomains(req.body?.embedDomains),
      downloadsAllowed: req.body?.downloadsAllowed === true
    });
    return res.status(201).json(publicVimeoPublication(publication));
  });
  app.patch('/api/vimeo/publications/:id', requireAuth, async (req, res) => {
    const publication = await repo.publication(req.params.id);
    if (!publication || !owns(req, publication.ownerId)) return res.status(404).json({ message: 'Publication not found' });
    if (req.body?.confirmed !== true) return res.status(422).json({ message: 'Explicit creator confirmation is required' });
    if (!['DRAFT', 'PUBLISHED'].includes(publication.state)) return res.status(409).json({ message: 'Publication cannot be changed while an operation is active' });
    const privacyValues: VimeoPrivacy[] = ['anybody', 'nobody', 'unlisted', 'disable', 'users', 'password'];
    if (req.body?.privacy !== undefined && !privacyValues.includes(req.body.privacy)) return res.status(422).json({ message: 'Unsupported Vimeo privacy mode' });
    const updated = { ...publication, embedDomains: [...publication.embedDomains] };
    if (req.body?.privacy !== undefined) updated.privacy = req.body.privacy;
    if (req.body?.embedDomains !== undefined) updated.embedDomains = normalizedDomains(req.body.embedDomains);
    if (req.body?.downloadsAllowed !== undefined) updated.downloadsAllowed = req.body.downloadsAllowed === true;
    if (publication.state === 'PUBLISHED') {
      const connection = await repo.connection(publication.connectionId);
      if (!connection?.credentialRef || !connection.capabilities.includes('privacy_update') || !publication.remoteUrl) return res.status(409).json({ message: 'Vimeo privacy updates are not enabled for this connection' });
      try {
        const tokens = JSON.parse(decryptExternalCredential(connection.credentialRef, config.externalTokenEncryptionKey)) as { accessToken: string };
        await provider.configurePrivacy(tokens.accessToken, publication.remoteUrl, { privacy: updated.privacy, embedDomains: updated.embedDomains, downloadsAllowed: updated.downloadsAllowed });
      } catch { return res.status(502).json({ message: 'Vimeo privacy update failed; publication settings were not saved' }); }
    }
    updated.updatedAt = new Date().toISOString();
    await repo.savePublication(updated);
    await repo.saveAudit({ id: randomUUID(), ownerId: updated.ownerId, actorId: req.authUser!.userId, action: 'vimeo.publication.privacy_update', result: 'SUCCESS', correlationId: String(req.headers['x-correlation-id'] || randomUUID()), publicationId: updated.id, createdAt: updated.updatedAt });
    return res.json(publicVimeoPublication(updated));
  });
  app.post('/api/vimeo/publications/:id/publish', requireAuth, async (req, res) => {
    const publication = await repo.publication(req.params.id);
    if (!publication || !owns(req, publication.ownerId)) return res.status(404).json({ message: 'Publication not found' });
    if (req.body?.confirmed !== true) return res.status(422).json({ message: 'Explicit creator confirmation is required' });
    if (publication.state !== 'DRAFT' && publication.state !== 'FAILED') return res.status(409).json(publicVimeoPublication(publication));
    const work = await store.getWork(config.tenantId, publication.workId);
    const asset = (await store.listCanonicalAssetsByWork(config.tenantId, publication.workId)).find((value) => value.assetId === publication.sourceAssetId);
    if (!work || !asset) return res.status(409).json({ message: 'Canonical source is no longer available' });
    const connection = await repo.connection(publication.connectionId);
    if (!connection) return res.status(409).json({ message: 'Vimeo connection is no longer available' });
    const preflight = vimeoPreflight(work, asset, connection);
    if (!preflight.allowed || asset.checksumSha256 !== publication.sourceHash) return res.status(422).json({ message: 'Vimeo preflight changed; review publication before retrying', preflight });
    if (!asset.storage.objectKey || !asset.sizeBytes) return res.status(422).json({ message: 'Canonical source cannot be streamed' });
    const correlationId = String(req.headers['x-correlation-id'] || randomUUID());
    publication.state = 'QUEUED';
    publication.updatedAt = new Date().toISOString();
    await repo.savePublication(publication);
    try {
      await queue?.enqueue({ publicationId: publication.id, tenantId: config.tenantId, sourceAssetId: asset.assetId, objectKey: asset.storage.objectKey, sizeBytes: asset.sizeBytes, title: work.title, description: work.description, correlationId });
    } catch {
      publication.state = 'FAILED';
      publication.lastError = 'QUEUE_UNAVAILABLE';
      publication.updatedAt = new Date().toISOString();
      await repo.savePublication(publication);
      return res.status(503).json({ message: 'Vimeo upload queue is unavailable' });
    }
    await repo.saveAudit({ id: randomUUID(), ownerId: publication.ownerId, actorId: req.authUser!.userId, action: 'vimeo.publication.queue', result: 'SUCCESS', correlationId, publicationId: publication.id, createdAt: publication.updatedAt });
    return res.status(202).json(publicVimeoPublication(publication));
  });
  app.post('/api/vimeo/publications/:id/reconcile', requireAuth, async (req, res) => {
    const publication = await repo.publication(req.params.id);
    if (!publication || !owns(req, publication.ownerId)) return res.status(404).json({ message: 'Publication not found' });
    const connection = await repo.connection(publication.connectionId);
    if (!connection?.credentialRef || !publication.remoteUrl) return res.status(409).json({ message: 'Publication has no remote video to reconcile' });
    try {
      const tokens = JSON.parse(decryptExternalCredential(connection.credentialRef, config.externalTokenEncryptionKey)) as { accessToken: string };
      const remote = await provider.video(tokens.accessToken, publication.remoteUrl);
      const transcode = (remote.transcode as { status?: string } | undefined)?.status;
      publication.state = transcode === 'complete' ? 'PUBLISHED' : transcode === 'error' ? 'FAILED' : 'PROCESSING';
    } catch (error) {
      if (error instanceof VimeoApiError && error.status === 404) publication.state = 'MISSING';
      else return res.status(502).json({ message: 'Vimeo reconciliation failed' });
    }
    publication.updatedAt = new Date().toISOString();
    await repo.savePublication(publication);
    return res.json(publicVimeoPublication(publication));
  });
  app.post('/api/vimeo/publications/:id/replace-source', requireAuth, async (req, res) => {
    const publication = await repo.publication(req.params.id);
    if (!publication || !owns(req, publication.ownerId)) return res.status(404).json({ message: 'Publication not found' });
    if (req.body?.confirmed !== true) return res.status(422).json({ message: 'Explicit creator confirmation is required' });
    const strategy = String(req.body?.strategy || '');
    if (!['LEAVE_UNCHANGED', 'CREATE_NEW_VIDEO', 'REPLACE_SOURCE'].includes(strategy)) return res.status(422).json({ message: 'A valid source revision strategy is required' });
    const work = await store.getWork(config.tenantId, publication.workId);
    if (!work || !(await store.hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Work not found' });
    const connection = await repo.connection(publication.connectionId);
    const assets = await store.listCanonicalAssetsByWork(config.tenantId, publication.workId);
    const nextAsset = assets.find((value) => value.assetId === req.body?.sourceAssetId);
    if (!connection || !nextAsset) return res.status(422).json({ message: 'The selected canonical source asset was not found' });
    const preflight = vimeoPreflight(work, nextAsset, connection);
    if (!preflight.allowed) return res.status(422).json({ message: 'Vimeo preflight failed', preflight });
    if (nextAsset.assetId === publication.sourceAssetId || nextAsset.checksumSha256 === publication.sourceHash) return res.status(409).json({ message: 'The selected source is already mapped to this publication' });
    const decidedAt = new Date().toISOString();
    const correlationId = String(req.headers['x-correlation-id'] || randomUUID());
    if (strategy === 'REPLACE_SOURCE') {
      publication.sourceDecisions = [...(publication.sourceDecisions || []), { fromAssetId: publication.sourceAssetId, toAssetId: nextAsset.assetId, strategy: 'REPLACE_SOURCE', result: 'DENIED_BY_LAUNCH_POLICY', actorId: req.authUser!.userId, decidedAt }];
      await repo.savePublication(publication);
      await repo.saveAudit({ id: randomUUID(), ownerId: publication.ownerId, actorId: req.authUser!.userId, action: 'vimeo.source.replace', result: 'DENIED', correlationId, publicationId: publication.id, detail: { policy: 'NEW_VIDEO_ONLY_V1' }, createdAt: decidedAt });
      return res.status(409).json({ message: 'Source replacement is not enabled at launch; choose create new Vimeo video or leave unchanged', policy: 'NEW_VIDEO_ONLY_V1' });
    }
    if (strategy === 'LEAVE_UNCHANGED') {
      publication.sourceDecisions = [...(publication.sourceDecisions || []), { fromAssetId: publication.sourceAssetId, toAssetId: nextAsset.assetId, strategy: 'LEAVE_UNCHANGED', result: 'UNCHANGED', actorId: req.authUser!.userId, decidedAt }];
      await repo.savePublication(publication);
      await repo.saveAudit({ id: randomUUID(), ownerId: publication.ownerId, actorId: req.authUser!.userId, action: 'vimeo.source.leave_unchanged', result: 'SUCCESS', correlationId, publicationId: publication.id, createdAt: decidedAt });
      return res.json(publicVimeoPublication(publication));
    }
    if (!req.body?.intentVersion) return res.status(422).json({ message: 'A new publication intent version is required' });
    const created = await createVimeoPublication(repo, {
      ownerId: publication.ownerId, connectionId: publication.connectionId, workId: publication.workId,
      sourceAssetId: nextAsset.assetId, sourceHash: nextAsset.checksumSha256!, intentVersion: String(req.body.intentVersion),
      privacy: publication.privacy, embedDomains: publication.embedDomains, downloadsAllowed: publication.downloadsAllowed
    });
    publication.sourceDecisions = [...(publication.sourceDecisions || []), { fromAssetId: publication.sourceAssetId, toAssetId: nextAsset.assetId, strategy: 'CREATE_NEW_VIDEO', result: 'NEW_PUBLICATION_CREATED', actorId: req.authUser!.userId, decidedAt }];
    await repo.savePublication(publication);
    await repo.saveAudit({ id: randomUUID(), ownerId: publication.ownerId, actorId: req.authUser!.userId, action: 'vimeo.source.create_new', result: 'SUCCESS', correlationId, publicationId: publication.id, detail: { newPublicationId: created.id }, createdAt: decidedAt });
    return res.status(201).json({ prior: publicVimeoPublication(publication), publication: publicVimeoPublication(created) });
  });
  app.post('/api/vimeo/publications/:id/archive', requireAuth, async (req, res) => {
    const publication = await repo.publication(req.params.id);
    if (!publication || !owns(req, publication.ownerId)) return res.status(404).json({ message: 'Publication not found' });
    if (req.body?.confirmed !== true) return res.status(422).json({ message: 'Explicit creator confirmation is required' });
    publication.state = 'ARCHIVED';
    publication.uploadAuthorization = undefined;
    publication.updatedAt = new Date().toISOString();
    await repo.savePublication(publication);
    return res.json(publicVimeoPublication(publication));
  });
  app.patch('/api/vimeo/publications/:id/embed-policy', requireAuth, async (req, res) => {
    const publication = await repo.publication(req.params.id);
    if (!publication || !owns(req, publication.ownerId)) return res.status(404).json({ message: 'Publication not found' });
    if (req.body?.confirmed !== true) return res.status(422).json({ message: 'Explicit creator confirmation is required' });
    const enabled = req.body?.enabled === true;
    const domains = normalizedDomains(req.body?.allowedDomains);
    const connection = await repo.connection(publication.connectionId);
    let state: VimeoEmbedPolicy['state'] = enabled ? 'DEGRADED' : 'DISABLED';
    let degradedReason: string | undefined = enabled ? 'REMOTE_NOT_VERIFIED' : undefined;
    if (enabled && connection?.credentialRef && publication.remoteUrl && connection.capabilities.includes('embed_reference')) {
      try {
        const tokens = JSON.parse(decryptExternalCredential(connection.credentialRef, config.externalTokenEncryptionKey)) as { accessToken: string };
        const remote = await provider.video(tokens.accessToken, publication.remoteUrl);
        const privacy = (remote.privacy as { view?: string } | undefined)?.view;
        const remoteDomains = Array.isArray((remote.embed as { domains?: unknown[] } | undefined)?.domains) ? (remote.embed as { domains: unknown[] }).domains.filter((value): value is string => typeof value === 'string').map((value) => value.toLowerCase()) : [];
        const missingDomains = domains.filter((domain) => !remoteDomains.includes(domain));
        if (privacy === 'nobody' || privacy === 'disable') degradedReason = 'VIMEO_PRIVACY_BLOCKS_EMBED';
        else if (missingDomains.length) degradedReason = 'VIMEO_DOMAIN_NOT_ALLOWED';
        else { state = 'READY'; degradedReason = undefined; }
      } catch { degradedReason = 'REMOTE_VERIFICATION_FAILED'; }
    }
    const policy: VimeoEmbedPolicy = { publicationId: publication.id, ownerId: publication.ownerId, enabled, allowedDomains: domains, lastVerifiedAt: enabled ? new Date().toISOString() : undefined, state, degradedReason };
    await repo.saveEmbedPolicy(policy);
    return res.json(policy);
  });
  app.delete('/api/vimeo/publications/:id', requireAuth, async (req, res) => {
    const publication = await repo.publication(req.params.id);
    if (!publication || !owns(req, publication.ownerId)) return res.status(404).json({ message: 'Publication not found' });
    if (req.body?.confirmed !== true) return res.status(422).json({ message: 'Explicit creator confirmation is required' });
    const connection = await repo.connection(publication.connectionId);
    if (publication.remoteUrl && connection?.credentialRef) {
      try {
        const tokens = JSON.parse(decryptExternalCredential(connection.credentialRef, config.externalTokenEncryptionKey)) as { accessToken: string };
        await provider.deleteVideo(tokens.accessToken, publication.remoteUrl);
      } catch (error) {
        if (!(error instanceof VimeoApiError && error.status === 404)) return res.status(502).json({ message: 'Vimeo deletion failed; canonical content was not changed' });
      }
    }
    publication.state = 'ARCHIVED';
    publication.uploadAuthorization = undefined;
    publication.updatedAt = new Date().toISOString();
    await repo.savePublication(publication);
    return res.status(204).send();
  });
  return repo;
};
