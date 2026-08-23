import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { RequestHandler, Router } from 'express';
import express from 'express';
import type { AppConfig } from './config';
import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import { requireAuth } from './auth';
import type { DataStore } from './store';

export const PATREON_API_VERSION = '2';
export const PATREON_CAPABILITIES = Object.freeze({
  campaignRead: true, tierRead: true, postRead: true, membershipRead: true,
  webhooks: true, postWrite: false, paymentProcessing: false
});

export type PatreonConnectionState = 'PENDING_OAUTH' | 'CONNECTED' | 'REAUTH_REQUIRED' |
  'INSUFFICIENT_SCOPE' | 'CAMPAIGN_NOT_FOUND' | 'WEBHOOK_DEGRADED' | 'RATE_LIMITED' |
  'DISCONNECTED' | 'ERROR';
export type PatreonCapability = 'campaign_sync' | 'post_reference_sync' | 'tier_mapping' | 'patreon_backed_access' | 'webhooks';

export interface PatreonConnection {
  id: string; ownerId: string; mode: 'STUDIO_MANAGED' | 'CREATOR_OWNED';
  credential: string; scopes: string[]; state: PatreonConnectionState;
  selectedCampaignIds: string[]; capabilities: PatreonCapability[]; apiVersion: '2';
  lastSuccessfulSync?: string; webhookState: 'DISABLED' | 'ACTIVE' | 'DEGRADED'; policyVersion: string;
  createdAt: string; updatedAt: string;
}
export interface PatreonCampaign { connectionId: string; id: string; creatorAccountId: string; url?: string; name: string; active: boolean; lastSync: string; }
export interface PatreonTier { campaignId: string; id: string; benefitIds: string[]; title: string; amountCents?: number; currency?: string; state: 'published' | 'archived'; lastSync: string; }
export interface PatreonPostReference { id: string; connectionId: string; campaignId: string; remotePostId: string; remoteUrl?: string; title: string; excerpt?: string; metadataHash?: string; acknowledgedMetadataHash?: string; publishedAt?: string; accessRuleIds: string[]; state: 'ACTIVE' | 'MISSING' | 'REMOTE_CHANGED'; workId?: string; }
export interface PatreonAccessMapping { id: string; ownerId: string; campaignId: string; selectorIds: string[]; accessGroupId: string; active: boolean; graceSeconds: number; version: number; safetyHold: boolean; createdAt: string; updatedAt: string; }
export interface PatreonPatronLink { accountId: string; subjectHash: string; credential: string; scopes: string[]; state: 'LINKED' | 'DISCONNECTED'; campaignIds: string[]; lastVerificationTime?: string; purgeTime?: string; }
export interface ExternalEntitlementGrant { id: string; accountId: string; provider: 'patreon'; campaignId: string; accessGroupId: string; state: 'ACTIVE' | 'REVOKED' | 'EXPIRED'; evidenceHash: string; checkedAt: string; recheckAt?: string; expiresAt: string; revokedAt?: string; mappingVersion: number; }
export interface AccessGroup { id: string; ownerId: string; creatorId: string; name: string; state: 'ACTIVE' | 'ARCHIVED'; createdAt: string; updatedAt: string; }
export interface AccessGroupTarget { id: string; accessGroupId: string; targetType: 'work' | 'collection' | 'gallery' | 'asset' | 'download'; targetId: string; previewsPublic: boolean; createdAt: string; }
export interface PatreonCompanionTask { id: string; ownerId: string; workId: string; campaignId: string; title: string; description?: string; previewUrl?: string; canonicalUrl: string; selectorIds: string[]; state: 'OPEN' | 'MAPPED'; remotePostReferenceId?: string; checklist: string[]; createdAt: string; updatedAt: string; }

type OAuthPurpose = 'creator' | 'patron';
interface OAuthState { nonce: string; verifier: string; ownerId: string; purpose: OAuthPurpose; mode?: PatreonConnection['mode']; connectionId?: string; returnPath: string; clientId: string; clientSecretEncrypted: string; expiresAt: number; }
export type PatreonRepositorySnapshot = Record<string, unknown>;
export interface PatreonPersistence { load(): Promise<PatreonRepositorySnapshot | null>; save(snapshot: PatreonRepositorySnapshot): Promise<void>; }

export class PatreonRepository {
  readonly connections = new Map<string, PatreonConnection>();
  readonly campaigns = new Map<string, PatreonCampaign>();
  readonly tiers = new Map<string, PatreonTier>();
  readonly posts = new Map<string, PatreonPostReference>();
  readonly mappings = new Map<string, PatreonAccessMapping>();
  readonly links = new Map<string, PatreonPatronLink>();
  readonly grants = new Map<string, ExternalEntitlementGrant>();
  readonly accessGroups = new Map<string, AccessGroup>();
  readonly accessGroupTargets = new Map<string, AccessGroupTarget>();
  readonly companionTasks = new Map<string, PatreonCompanionTask>();
  readonly oauthStates = new Map<string, OAuthState>();
  readonly webhookEvents = new Map<string, { type: string; connectionId?: string; receivedAt: string; expiresAt: string; result: string }>();
  readonly audits: Array<{ actor: string; action: string; target?: string; result: string; correlationId: string; at: string }> = [];
  private readonly readyPromise: Promise<void>;
  constructor(private readonly persistence?: PatreonPersistence) {
    this.readyPromise = persistence ? persistence.load().then(snapshot => { if (snapshot) this.restore(snapshot); }) : Promise.resolve();
  }
  ready() { return this.readyPromise; }
  async flush() { if (this.persistence) { await this.readyPromise; await this.persistence.save(this.snapshot()); } }
  private snapshot(): PatreonRepositorySnapshot {
    return { connections: [...this.connections], campaigns: [...this.campaigns], tiers: [...this.tiers], posts: [...this.posts], mappings: [...this.mappings], links: [...this.links], grants: [...this.grants], accessGroups: [...this.accessGroups], accessGroupTargets: [...this.accessGroupTargets], companionTasks: [...this.companionTasks], oauthStates: [...this.oauthStates], webhookEvents: [...this.webhookEvents], audits: this.audits };
  }
  private restore(snapshot: PatreonRepositorySnapshot) {
    const restoreMap = (target: Map<string, any>, key: string) => { const entries = snapshot[key]; if (Array.isArray(entries)) for (const entry of entries) if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string') target.set(entry[0], entry[1]); };
    restoreMap(this.connections, 'connections'); restoreMap(this.campaigns, 'campaigns'); restoreMap(this.tiers, 'tiers'); restoreMap(this.posts, 'posts'); restoreMap(this.mappings, 'mappings'); restoreMap(this.links, 'links'); restoreMap(this.grants, 'grants'); restoreMap(this.accessGroups, 'accessGroups'); restoreMap(this.accessGroupTargets, 'accessGroupTargets'); restoreMap(this.companionTasks, 'companionTasks'); restoreMap(this.oauthStates, 'oauthStates'); restoreMap(this.webhookEvents, 'webhookEvents');
    if (Array.isArray(snapshot.audits)) this.audits.push(...snapshot.audits as typeof this.audits);
  }
  audit(actor: string, action: string, target?: string, result = 'SUCCESS') {
    this.audits.push({ actor, action, target, result, correlationId: randomUUID(), at: new Date().toISOString() });
  }
  purgeExpired(now = Date.now()) {
    for (const [key, state] of this.oauthStates) if (state.expiresAt <= now) this.oauthStates.delete(key);
    for (const [key, event] of this.webhookEvents) if (Date.parse(event.expiresAt) <= now) this.webhookEvents.delete(key);
    for (const grant of this.grants.values()) if (grant.state === 'ACTIVE' && Date.parse(grant.expiresAt) <= now) { grant.state = 'EXPIRED'; this.audit(grant.accountId, 'patreon.grant.expired', grant.id); }
  }
}

interface PatreonJsonApi<T = Record<string, unknown>> { data: T; included?: Array<Record<string, any>>; links?: { next?: string }; }
interface StoredPatreonCredential {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  clientSecret: string;
  expiresAt?: string;
}
const apiBase = 'https://www.patreon.com/api/oauth2/v2';
const ENTITLEMENT_TTL_MS = 6 * 60 * 60 * 1000;
const SUPPORTED_WEBHOOK_EVENTS = new Set([
  'members:create', 'members:update', 'members:delete',
  'members:pledge:create', 'members:pledge:update', 'members:pledge:delete',
  'posts:publish', 'posts:update', 'posts:delete'
]);

export class PatreonProvider {
  readonly platform = 'patreon' as const;
  readonly capabilities = PATREON_CAPABILITIES;
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  authorizationUrl(clientId: string, redirectUri: string, state: string, challenge: string, scopes: string[]) {
    const url = new URL('https://www.patreon.com/oauth2/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, scope: scopes.join(' '), code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return url.toString();
  }
  async exchangeCode(input: { code: string; verifier: string; clientId: string; clientSecret: string; redirectUri: string }) {
    const response = await this.fetcher('https://www.patreon.com/api/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: input.code, grant_type: 'authorization_code', client_id: input.clientId, client_secret: input.clientSecret, redirect_uri: input.redirectUri, code_verifier: input.verifier }) });
    if (!response.ok) throw new Error(`Patreon token exchange failed (${response.status})`);
    return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }>;
  }
  async refreshToken(input: { refreshToken: string; clientId: string; clientSecret: string }) {
    const response = await this.fetcher('https://www.patreon.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: input.refreshToken,
        grant_type: 'refresh_token',
        client_id: input.clientId,
        client_secret: input.clientSecret
      })
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'REAUTH_REQUIRED' : `Patreon token refresh failed (${response.status})`);
    return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }>;
  }
  private async get<T>(accessToken: string, path: string): Promise<PatreonJsonApi<T>> {
    const response = await this.fetcher(path.startsWith('http') ? path : `${apiBase}${path}`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (response.status === 401) throw new Error('REAUTH_REQUIRED');
    if (response.status === 429) throw new Error('RATE_LIMITED');
    if (!response.ok) throw new Error(`Patreon API request failed (${response.status})`);
    return response.json() as Promise<PatreonJsonApi<T>>;
  }
  identity(token: string) { return this.get<Record<string, any>>(token, '/identity?fields[user]=full_name&include=memberships.campaign,memberships.currently_entitled_tiers'); }
  campaigns(token: string) { return this.get<Array<Record<string, any>>>(token, '/campaigns?fields[campaign]=creation_name,url,patron_count&include=creator,tiers,tiers.benefits'); }
  async posts(token: string, campaignId: string) {
    // Post bodies and media bytes are intentionally not requested: imported
    // posts are metadata-only external references, never source backups.
    let page: string | undefined = `/campaigns/${encodeURIComponent(campaignId)}/posts?fields[post]=title,excerpt,url,published_at,is_public&include=access_rules&sort=-published_at`;
    const data: Array<Record<string, any>> = [];
    const included: Array<Record<string, any>> = [];
    const visited = new Set<string>();
    while (page && !visited.has(page)) {
      visited.add(page);
      const response: PatreonJsonApi<Array<Record<string, any>>> = await this.get<Array<Record<string, any>>>(token, page);
      data.push(...(response.data || []));
      included.push(...(response.included || []));
      page = response.links?.next;
    }
    return { data, included };
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const jsonId = (value: any) => typeof value?.id === 'string' ? value.id : '';
const attributes = (value: any): Record<string, any> => value?.attributes && typeof value.attributes === 'object' ? value.attributes : {};
// Email and detailed member profile scopes are deliberately excluded in v1.
const creatorScopes = ['identity', 'campaigns', 'campaigns.members'];
const patronScopes = ['identity', 'identity.memberships'];

const parseCredential = (config: AppConfig, encrypted: string): StoredPatreonCredential =>
  JSON.parse(decryptExternalCredential(encrypted, config.externalTokenEncryptionKey!));
const encryptCredential = (config: AppConfig, credential: StoredPatreonCredential): string =>
  encryptExternalCredential(JSON.stringify(credential), config.externalTokenEncryptionKey!);
const safeConnection = (connection: PatreonConnection) => ({ ...connection, credential: undefined, capabilitiesSupported: PATREON_CAPABILITIES });
const redirectUri = (config: AppConfig, purpose: OAuthPurpose) => purpose === 'creator' ? config.patreonOAuthRedirectUri! : config.patreonPatronOAuthRedirectUri!;
const patronLinkResponse = (repository: PatreonRepository, link: PatreonPatronLink) => ({
  linked: link.state === 'LINKED',
  lastChecked: link.lastVerificationTime,
  connectedCreators: link.campaignIds.map(campaignId => repository.campaigns.get(campaignId)).filter(Boolean).map(campaign => ({ campaignId: campaign!.id, displayName: campaign!.name })),
  unlocked: [...repository.grants.values()].filter(grant => grant.accountId === link.accountId && grant.state === 'ACTIVE').map(grant => ({ accessGroupId: grant.accessGroupId, name: repository.accessGroups.get(grant.accessGroupId)?.name || 'Creator access', expiresAt: grant.expiresAt, lastChecked: grant.checkedAt }))
});

interface EntitlementEvidence { campaignId: string; selectorIds: string[] }
const entitlementEvidence = (identity: PatreonJsonApi<Record<string, any>>): EntitlementEvidence[] => {
  const evidence: EntitlementEvidence[] = [];
  for (const member of identity.included || []) {
    if (member.type !== 'member') continue;
    const campaignId = jsonId(member.relationships?.campaign?.data);
    if (!campaignId) continue;
    evidence.push({
      campaignId,
      selectorIds: (member.relationships?.currently_entitled_tiers?.data || []).map(jsonId).filter(Boolean)
    });
  }
  return evidence;
};

/** Used by a scheduled worker to select links without exposing patron profile data. */
export const patreonAccountsDueForEntitlementRecheck = (repository: PatreonRepository, now = Date.now()): string[] => {
  repository.purgeExpired(now);
  const due = new Set<string>();
  for (const grant of repository.grants.values()) {
    if (grant.state === 'ACTIVE' && Date.parse(grant.recheckAt || grant.expiresAt) <= now) due.add(grant.accountId);
  }
  for (const link of repository.links.values()) {
    if (link.state === 'LINKED' && !link.lastVerificationTime) due.add(link.accountId);
  }
  return [...due];
};

export const evaluatePatreonTargetAccess = (
  repository: PatreonRepository,
  accountId: string | undefined,
  targetType: AccessGroupTarget['targetType'],
  targetId: string,
  delivery: 'preview' | 'full',
  now = Date.now()
): { authorized: boolean; result: 'PUBLIC_PREVIEW' | 'ACTIVE' | 'AUTHENTICATION_REQUIRED' | 'ENTITLEMENT_REQUIRED'; expiresAt?: string } => {
  repository.purgeExpired(now);
  const assignments = [...repository.accessGroupTargets.values()].filter(target => target.targetType === targetType && target.targetId === targetId);
  if (delivery === 'preview' && assignments.some(target => target.previewsPublic)) return { authorized: true, result: 'PUBLIC_PREVIEW' };
  if (!accountId) return { authorized: false, result: 'AUTHENTICATION_REQUIRED' };
  const groupIds = new Set(assignments.map(target => target.accessGroupId));
  const grant = [...repository.grants.values()].find(item => item.accountId === accountId && groupIds.has(item.accessGroupId) && item.state === 'ACTIVE' && Date.parse(item.expiresAt) > now);
  return grant ? { authorized: true, result: 'ACTIVE', expiresAt: grant.expiresAt } : { authorized: false, result: 'ENTITLEMENT_REQUIRED' };
};

const workSlug = (value: string): string => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || 'patreon-post';

export const createPatreonRouter = (config: AppConfig, repository = new PatreonRepository(), provider = new PatreonProvider(), store?: DataStore): Router => {
  const router = express.Router();
  router.use(async (_req, res, next) => {
    try { await repository.ready(); } catch { return res.status(503).json({ message: 'Patreon integration storage is unavailable' }); }
    const end = res.end.bind(res); let ending = false;
    res.end = ((...args: Parameters<typeof res.end>) => { if (ending) return res; ending = true; void repository.flush().then(() => end(...args)).catch(next); return res; }) as typeof res.end;
    return next();
  });
  const configured = () => Boolean(config.patreonClientId && config.patreonClientSecret && config.externalTokenEncryptionKey && config.patreonOAuthRedirectUri && config.patreonPatronOAuthRedirectUri);
  const ownsCampaign = (ownerId: string, campaignId: string) => {
    const campaign = repository.campaigns.get(campaignId);
    const connection = campaign && repository.connections.get(campaign.connectionId);
    return Boolean(connection && connection.ownerId === ownerId && connection.state !== 'DISCONNECTED');
  };
  const validAccessToken = async (
    encryptedCredential: string,
    save: (encrypted: string) => void
  ): Promise<string> => {
    const credential = parseCredential(config, encryptedCredential);
    const expiresSoon = credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now() + 60_000;
    if (!expiresSoon) return credential.accessToken;
    if (!credential.refreshToken || !credential.clientId || !credential.clientSecret) throw new Error('REAUTH_REQUIRED');
    const refreshed = await provider.refreshToken({
      refreshToken: credential.refreshToken,
      clientId: credential.clientId,
      clientSecret: credential.clientSecret
    });
    const next: StoredPatreonCredential = {
      ...credential,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || credential.refreshToken,
      expiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : undefined
    };
    const encrypted = encryptCredential(config, next);
    save(encrypted);
    return next.accessToken;
  };
  const start = (purpose: OAuthPurpose): RequestHandler => (req, res) => {
    if (!configured()) return res.status(503).json({ message: 'Patreon integration is not configured' });
    const ownerId = req.authUser!.userId;
    const mode = purpose === 'creator' && req.body?.mode === 'CREATOR_OWNED' ? 'CREATOR_OWNED' : 'STUDIO_MANAGED';
    const clientId = mode === 'CREATOR_OWNED' ? String(req.body?.clientId || '').trim() : config.patreonClientId!;
    const clientSecret = mode === 'CREATOR_OWNED' ? String(req.body?.clientSecret || '') : config.patreonClientSecret!;
    if (!clientId || !clientSecret) return res.status(400).json({ message: 'A creator-owned Patreon client ID and secret are required for CREATOR_OWNED mode' });
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    repository.oauthStates.set(sha256(state), { nonce, verifier, ownerId, purpose, mode, connectionId: typeof req.body?.reauthorizeConnectionId === 'string' ? req.body.reauthorizeConnectionId : undefined, clientId, clientSecretEncrypted: encryptExternalCredential(clientSecret, config.externalTokenEncryptionKey!), returnPath: typeof req.body?.returnPath === 'string' && req.body.returnPath.startsWith('/') ? req.body.returnPath : '/', expiresAt: Date.now() + 10 * 60_000 });
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    res.json({ authorizationUrl: provider.authorizationUrl(clientId, redirectUri(config, purpose), state, challenge, purpose === 'creator' ? creatorScopes : patronScopes), requestedScopes: purpose === 'creator' ? creatorScopes : patronScopes, nonce });
  };
  const callback = (purpose: OAuthPurpose): RequestHandler => async (req, res) => {
    const stateKey = sha256(String(req.query.state || ''));
    const state = repository.oauthStates.get(stateKey);
    repository.oauthStates.delete(stateKey);
    if (!state || state.purpose !== purpose || state.expiresAt < Date.now() || typeof req.query.code !== 'string') return res.status(400).json({ message: 'OAuth state is invalid or expired' });
    try {
      const clientSecret = decryptExternalCredential(state.clientSecretEncrypted, config.externalTokenEncryptionKey!);
      const tokens = await provider.exchangeCode({ code: req.query.code, verifier: state.verifier, clientId: state.clientId, clientSecret, redirectUri: redirectUri(config, purpose) });
      const encrypted = encryptCredential(config, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        clientId: state.clientId,
        clientSecret,
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined
      });
      if (purpose === 'creator') {
        const previous = state.connectionId ? repository.connections.get(state.connectionId) : undefined;
        if (previous && previous.ownerId !== state.ownerId) return res.status(403).json({ message: 'Connection ownership changed during authorization' });
        const id = previous?.id || randomUUID(); const now = new Date().toISOString();
        repository.connections.set(id, { id, ownerId: state.ownerId, mode: state.mode!, credential: encrypted, scopes: (tokens.scope || '').split(/\s+/).filter(Boolean), state: 'CONNECTED', selectedCampaignIds: previous?.selectedCampaignIds || [], capabilities: previous?.capabilities || ['campaign_sync'], apiVersion: '2', webhookState: previous?.webhookState || 'DISABLED', policyVersion: '2026-08-23', createdAt: previous?.createdAt || now, updatedAt: now });
        repository.audit(state.ownerId, 'patreon.connection.created', id);
        return res.redirect(new URL(state.returnPath + `?patreon=connected&connectionId=${id}`, config.appOrigin).toString());
      }
      const identity = await provider.identity(tokens.access_token); const subject = jsonId(identity.data);
      if (!subject) throw new Error('Patreon identity missing');
      const existing = [...repository.links.values()].find((link) => link.subjectHash === sha256(subject) && link.accountId !== state.ownerId && link.state === 'LINKED');
      if (existing) return res.status(409).json({ message: 'This Patreon identity is already linked to another account' });
      repository.links.set(state.ownerId, { accountId: state.ownerId, subjectHash: sha256(subject), credential: encrypted, scopes: (tokens.scope || '').split(/\s+/).filter(Boolean), state: 'LINKED', campaignIds: [], lastVerificationTime: new Date().toISOString() });
      repository.audit(state.ownerId, 'patreon.patron_link.created');
      return res.redirect(new URL(state.returnPath + '?patreon=linked', config.appOrigin).toString());
    } catch { return res.status(502).json({ message: 'Patreon authorization could not be completed' }); }
  };

  router.post('/integrations/patreon/connections/start', requireAuth, start('creator'));
  router.get('/integrations/patreon/oauth/callback', callback('creator'));
  router.post('/me/patreon-link/start', requireAuth, start('patron'));
  router.get('/me/patreon-link/callback', callback('patron'));
  router.get('/integrations/patreon/connections/:id', requireAuth, (req, res) => { const item = repository.connections.get(req.params.id); return !item || item.ownerId !== req.authUser!.userId ? res.status(404).json({ message: 'Connection not found' }) : res.json(safeConnection(item)); });
  router.get('/integrations/patreon/connections/:id/health', requireAuth, (req, res) => {
    repository.purgeExpired();
    const item = repository.connections.get(req.params.id);
    if (!item || item.ownerId !== req.authUser!.userId) return res.status(404).json({ message: 'Connection not found' });
    const campaigns = [...repository.campaigns.values()].filter(campaign => campaign.connectionId === item.id);
    const campaignIds = new Set(campaigns.map(campaign => campaign.id));
    const posts = [...repository.posts.values()].filter(post => post.connectionId === item.id);
    const mappings = [...repository.mappings.values()].filter(mapping => campaignIds.has(mapping.campaignId));
    const grants = [...repository.grants.values()].filter(grant => campaignIds.has(grant.campaignId));
    const latestWebhook = [...repository.webhookEvents.values()].filter(event => event.connectionId === item.id).sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))[0];
    return res.json({
      connection: safeConnection(item),
      counts: { campaigns: campaigns.length, tiers: [...repository.tiers.values()].filter(tier => campaignIds.has(tier.campaignId)).length, posts: posts.length, mappings: mappings.length, activeGrants: grants.filter(grant => grant.state === 'ACTIVE').length },
      attention: { remoteChanges: posts.filter(post => post.state === 'REMOTE_CHANGED').length, missingPosts: posts.filter(post => post.state === 'MISSING').length, safetyHolds: mappings.filter(mapping => mapping.safetyHold).length },
      webhook: { state: item.webhookState, lastReceivedAt: latestWebhook?.receivedAt, lastResult: latestWebhook?.result },
      reauthorizationRequired: item.state === 'REAUTH_REQUIRED' || item.state === 'INSUFFICIENT_SCOPE'
    });
  });
  router.get('/integrations/patreon/connections/:id/audit', requireAuth, (req, res) => {
    const item = repository.connections.get(req.params.id);
    if (!item || item.ownerId !== req.authUser!.userId) return res.status(404).json({ message: 'Connection not found' });
    const campaignIds = new Set([...repository.campaigns.values()].filter(campaign => campaign.connectionId === item.id).map(campaign => campaign.id));
    const relatedTargets = new Set<string>([item.id, ...campaignIds]);
    for (const post of repository.posts.values()) if (post.connectionId === item.id) relatedTargets.add(post.id);
    for (const mapping of repository.mappings.values()) if (campaignIds.has(mapping.campaignId)) relatedTargets.add(mapping.id);
    return res.json(repository.audits.filter(event => event.actor === item.ownerId || (event.target && relatedTargets.has(event.target))).slice(-100).reverse());
  });
  router.post('/integrations/patreon/connections/:id/reauthorize', requireAuth, (req, res) => {
    const item = repository.connections.get(req.params.id);
    if (!item || item.ownerId !== req.authUser!.userId) return res.status(404).json({ message: 'Connection not found' });
    item.state = 'REAUTH_REQUIRED';
    item.updatedAt = new Date().toISOString();
    repository.audit(item.ownerId, 'patreon.connection.reauthorization_requested', item.id);
    req.body = { ...req.body, mode: item.mode, reauthorizeConnectionId: item.id };
    return start('creator')(req, res, () => undefined);
  });
  router.patch('/integrations/patreon/connections/:id/capabilities', requireAuth, (req, res) => {
    const item = repository.connections.get(req.params.id); if (!item || item.ownerId !== req.authUser!.userId) return res.status(404).json({ message: 'Connection not found' });
    const allowed: PatreonCapability[] = ['campaign_sync', 'post_reference_sync', 'tier_mapping', 'patreon_backed_access', 'webhooks'];
    const requested = Array.isArray(req.body?.capabilities) ? req.body.capabilities.filter((x: unknown): x is PatreonCapability => allowed.includes(x as PatreonCapability)) : [];
    item.capabilities = requested; item.selectedCampaignIds = Array.isArray(req.body?.campaignIds) ? req.body.campaignIds.filter((x: unknown) => typeof x === 'string') : item.selectedCampaignIds; item.updatedAt = new Date().toISOString();
    repository.audit(item.ownerId, 'patreon.connection.capabilities_updated', item.id); return res.json(safeConnection(item));
  });
  router.post('/integrations/patreon/connections/:id/sync', requireAuth, async (req, res) => {
    const item = repository.connections.get(req.params.id); if (!item || item.ownerId !== req.authUser!.userId) return res.status(404).json({ message: 'Connection not found' });
    try {
      const accessToken = await validAccessToken(item.credential, encrypted => { item.credential = encrypted; }); const remote = await provider.campaigns(accessToken); const now = new Date().toISOString();
      for (const campaign of remote.data || []) { const a = attributes(campaign); const id = jsonId(campaign); if (!id) continue; repository.campaigns.set(id, { connectionId: item.id, id, creatorAccountId: jsonId(campaign.relationships?.creator?.data), url: a.url, name: a.creation_name || 'Patreon campaign', active: true, lastSync: now }); }
      for (const included of remote.included || []) if (included.type === 'tier') { const a = attributes(included); repository.tiers.set(included.id, { campaignId: String(included.relationships?.campaign?.data?.id || item.selectedCampaignIds[0] || ''), id: included.id, benefitIds: (included.relationships?.benefits?.data || []).map(jsonId).filter(Boolean), title: a.title || 'Patreon tier', amountCents: Number.isFinite(a.amount_cents) ? a.amount_cents : undefined, currency: a.currency, state: a.published === false ? 'archived' : 'published', lastSync: now }); }
      if (item.capabilities.includes('post_reference_sync')) for (const campaignId of item.selectedCampaignIds) {
        const posts = await provider.posts(accessToken, campaignId);
        const seen = new Set<string>();
        for (const post of posts.data || []) {
          const a = attributes(post); const key = `${item.id}:${post.id}`; const old = repository.posts.get(key);
          seen.add(post.id);
          const title = a.title || 'Untitled Patreon post';
          const metadataHash = sha256(JSON.stringify({ title, excerpt: a.excerpt || '', publishedAt: a.published_at || '', accessRuleIds: (post.relationships?.access_rules?.data || []).map(jsonId).filter(Boolean).sort() }));
          const changed = Boolean(old?.workId && old.metadataHash && old.metadataHash !== metadataHash && old.acknowledgedMetadataHash !== metadataHash);
          repository.posts.set(key, { id: old?.id || randomUUID(), connectionId: item.id, campaignId, remotePostId: post.id, remoteUrl: a.url, title, excerpt: a.excerpt, metadataHash, acknowledgedMetadataHash: old?.acknowledgedMetadataHash, publishedAt: a.published_at, accessRuleIds: (post.relationships?.access_rules?.data || []).map(jsonId).filter(Boolean), state: changed ? 'REMOTE_CHANGED' : 'ACTIVE', workId: old?.workId });
        }
        for (const reference of repository.posts.values()) {
          if (reference.connectionId === item.id && reference.campaignId === campaignId && !seen.has(reference.remotePostId)) reference.state = 'MISSING';
        }
      }
      item.lastSuccessfulSync = now; item.state = 'CONNECTED'; item.updatedAt = now; repository.audit(item.ownerId, 'patreon.connection.synced', item.id); return res.status(202).json({ connection: safeConnection(item), campaigns: [...repository.campaigns.values()].filter(x => x.connectionId === item.id).length });
    } catch (error) { item.state = error instanceof Error && ['REAUTH_REQUIRED', 'RATE_LIMITED'].includes(error.message) ? error.message as PatreonConnectionState : 'ERROR'; return res.status(502).json({ message: 'Patreon synchronization failed', state: item.state }); }
  });
  router.delete('/integrations/patreon/connections/:id', requireAuth, (req, res) => { const item = repository.connections.get(req.params.id); if (!item || item.ownerId !== req.authUser!.userId) return res.status(404).json({ message: 'Connection not found' }); item.credential = ''; item.state = 'DISCONNECTED'; item.webhookState = 'DISABLED'; item.updatedAt = new Date().toISOString(); for (const campaign of repository.campaigns.values()) if (campaign.connectionId === item.id) campaign.active = false; for (const mapping of repository.mappings.values()) if (item.selectedCampaignIds.includes(mapping.campaignId)) mapping.active = false; for (const grant of repository.grants.values()) if (item.selectedCampaignIds.includes(grant.campaignId) && grant.state === 'ACTIVE') { grant.state = 'REVOKED'; grant.revokedAt = item.updatedAt; } repository.audit(item.ownerId, 'patreon.connection.disconnected', item.id); return res.status(204).send(); });
  router.get('/integrations/patreon/campaigns', requireAuth, (req, res) => { const ids = new Set([...repository.connections.values()].filter(x => x.ownerId === req.authUser!.userId).map(x => x.id)); return res.json([...repository.campaigns.values()].filter(x => ids.has(x.connectionId))); });
  router.get('/integrations/patreon/campaigns/:campaignId/tiers', requireAuth, (req, res) => ownsCampaign(req.authUser!.userId, req.params.campaignId) ? res.json([...repository.tiers.values()].filter(x => x.campaignId === req.params.campaignId)) : res.status(404).json({ message: 'Campaign not found' }));
  router.get('/integrations/patreon/campaigns/:campaignId/posts', requireAuth, (req, res) => ownsCampaign(req.authUser!.userId, req.params.campaignId) ? res.json([...repository.posts.values()].filter(x => x.campaignId === req.params.campaignId)) : res.status(404).json({ message: 'Campaign not found' }));
  router.post('/integrations/patreon/post-references/:id/map', requireAuth, (req, res) => { const post = [...repository.posts.values()].find(x => x.id === req.params.id); if (!post || !ownsCampaign(req.authUser!.userId, post.campaignId) || typeof req.body?.workId !== 'string') return res.status(404).json({ message: 'Post reference not found' }); post.workId = req.body.workId; repository.audit(req.authUser!.userId, 'patreon.post_reference.mapped', post.id); return res.json(post); });
  router.post('/integrations/patreon/post-references/:id/resolve', requireAuth, async (req, res) => {
    if (!store) return res.status(501).json({ message: 'Canonical Work storage is unavailable' });
    const post = [...repository.posts.values()].find(item => item.id === req.params.id);
    if (!post || !post.workId || !ownsCampaign(req.authUser!.userId, post.campaignId)) return res.status(404).json({ message: 'Mapped post reference not found' });
    const work = await store.getWork(config.tenantId, post.workId);
    if (!work || !(await store.hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Mapped Work not found' });
    const strategy = req.body?.strategy;
    if (!['keep_local', 'accept_remote', 'field_by_field'].includes(strategy)) return res.status(400).json({ message: 'Choose keep_local, accept_remote, or field_by_field' });
    const fields = strategy === 'accept_remote' ? ['title', 'description'] : strategy === 'field_by_field' && Array.isArray(req.body?.fields) ? req.body.fields : [];
    if (fields.some((field: unknown) => field !== 'title' && field !== 'description')) return res.status(400).json({ message: 'Only title and description can be accepted from a Patreon reference' });
    if (fields.length) {
      const updated = { ...work, title: fields.includes('title') ? post.title : work.title, description: fields.includes('description') ? post.excerpt : work.description, revision: work.revision + 1, updatedAt: new Date().toISOString() };
      await store.updateWork(updated);
    }
    post.acknowledgedMetadataHash = post.metadataHash;
    post.state = 'ACTIVE';
    repository.audit(req.authUser!.userId, `patreon.post_reference.${strategy}`, post.id);
    return res.json({ postReference: post, acceptedFields: fields, localAssetsChanged: false, publicationSettingsChanged: false, discoveryChanged: false });
  });
  router.post('/integrations/patreon/post-references/:id/import', requireAuth, async (req, res) => {
    if (!store) return res.status(501).json({ message: 'Canonical Work storage is unavailable' });
    const post = [...repository.posts.values()].find(item => item.id === req.params.id);
    if (!post || !ownsCampaign(req.authUser!.userId, post.campaignId)) return res.status(404).json({ message: 'Post reference not found' });
    const creatorId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    if (!creatorId || !(await store.hasCreatorAccess(req.authUser!.userId, creatorId))) return res.status(403).json({ message: 'Creator access required' });
    if (post.workId) {
      const existing = await store.getWork(config.tenantId, post.workId);
      if (existing) return res.json({ work: existing, postReference: post, created: false });
    }
    const existing = (await store.listWorksByCreator(config.tenantId, creatorId)).find(work => work.origin.platform === 'patreon' && work.origin.remoteId === post.remotePostId);
    if (existing) {
      post.workId = existing.workId;
      return res.json({ work: existing, postReference: post, created: false });
    }
    const now = new Date().toISOString();
    const baseSlug = workSlug(post.title);
    const usedSlugs = new Set((await store.listWorksByCreator(config.tenantId, creatorId)).flatMap(work => work.slugHistory));
    let slug = baseSlug;
    for (let suffix = 2; usedSlugs.has(slug); suffix++) slug = `${baseSlug}-${suffix}`;
    const workId = randomUUID();
    const work = {
      workId, tenantId: config.tenantId, creatorId, kind: 'article' as const, title: post.title,
      slug, slugHistory: [slug], description: post.excerpt, tags: [], contentRating: 'general' as const,
      aiDisclosure: 'none' as const, heavyTopics: [], status: 'draft' as const,
      origin: { type: 'import' as const, platform: 'patreon' as const, integrationAccountId: post.connectionId, remoteId: post.remotePostId, remoteUrl: post.remoteUrl, importedAt: now },
      revision: 1, createdAt: now, updatedAt: now
    };
    await store.createWork(work);
    if (post.remoteUrl) {
      const assetId = randomUUID();
      await store.createCanonicalAsset({ assetId, tenantId: config.tenantId, creatorId, kind: 'document', status: 'ready', mimeType: 'text/html', storage: { mode: 'external', externalUrl: post.remoteUrl }, metadata: { provider: 'patreon', remotePostId: post.remotePostId, referenceOnly: true }, createdAt: now, updatedAt: now });
      await store.attachAssetToWork(config.tenantId, { workId, assetId, role: 'preview', position: 0 });
    }
    await store.upsertWorkDiscoveryParticipation({ workId, tenantId: config.tenantId, creatorId, state: 'none', updatedAt: now });
    post.workId = workId;
    repository.audit(req.authUser!.userId, 'patreon.post_reference.imported', post.id);
    return res.status(201).json({ work, postReference: post, created: true, sourceBackup: false, discoveryEnabled: false });
  });
  router.post('/access/groups', requireAuth, async (req, res) => {
    if (!store) return res.status(501).json({ message: 'Access Group storage is unavailable' });
    const creatorId = typeof req.body?.creatorId === 'string' ? req.body.creatorId.trim() : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
    if (!creatorId || !name) return res.status(400).json({ message: 'creatorId and name are required' });
    if (!(await store.hasCreatorAccess(req.authUser!.userId, creatorId))) return res.status(403).json({ message: 'Creator access required' });
    const now = new Date().toISOString();
    const group: AccessGroup = { id: randomUUID(), ownerId: req.authUser!.userId, creatorId, name, state: 'ACTIVE', createdAt: now, updatedAt: now };
    repository.accessGroups.set(group.id, group); repository.audit(group.ownerId, 'access_group.created', group.id);
    return res.status(201).json(group);
  });
  router.get('/access/groups', requireAuth, (req, res) => res.json([...repository.accessGroups.values()].filter(group => group.ownerId === req.authUser!.userId)));
  router.post('/access/groups/:id/targets', requireAuth, async (req, res) => {
    const group = repository.accessGroups.get(req.params.id);
    if (!group || group.ownerId !== req.authUser!.userId) return res.status(404).json({ message: 'Access Group not found' });
    const targetType = req.body?.targetType; const targetId = typeof req.body?.targetId === 'string' ? req.body.targetId.trim() : '';
    if (!['work', 'collection', 'gallery', 'asset', 'download'].includes(targetType) || !targetId) return res.status(400).json({ message: 'A supported targetType and targetId are required' });
    if (targetType === 'work' && store) { const work = await store.getWork(config.tenantId, targetId); if (!work || work.creatorId !== group.creatorId) return res.status(404).json({ message: 'Work not found for this Creator' }); }
    const key = `${group.id}:${targetType}:${targetId}`; const target: AccessGroupTarget = { id: repository.accessGroupTargets.get(key)?.id || randomUUID(), accessGroupId: group.id, targetType, targetId, previewsPublic: req.body?.previewsPublic !== false, createdAt: repository.accessGroupTargets.get(key)?.createdAt || new Date().toISOString() };
    repository.accessGroupTargets.set(key, target); repository.audit(group.ownerId, 'access_group.target_assigned', target.id); return res.status(201).json(target);
  });
  router.get('/works/:workId/patreon/eligibility', requireAuth, async (req, res) => {
    if (!store) return res.status(501).json({ message: 'Canonical Work storage is unavailable' });
    const work = await store.getWork(config.tenantId, req.params.workId);
    if (!work || !(await store.hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Work not found' });
    const publications = await store.listPublicationsByWork(config.tenantId, work.workId);
    const hosted = publications.some(publication => publication.destination === 'eversally' && ['live', 'scheduled'].includes(publication.status));
    const eligible = hosted && work.status !== 'deleted';
    return res.json({ workId: work.workId, eligible, result: eligible ? 'ALLOWED_MANAGED' : 'PLATFORM_INELIGIBLE', reasons: eligible ? [] : [work.status === 'deleted' ? 'Deleted Works cannot receive new Patreon-backed access.' : 'Patreon-backed access applies only to Eversally-hosted content.'], accessGroups: [...repository.accessGroupTargets.values()].filter(target => target.targetType === 'work' && target.targetId === work.workId).map(target => repository.accessGroups.get(target.accessGroupId)).filter(Boolean) });
  });
  router.post('/works/:workId/patreon/companion-task', requireAuth, async (req, res) => {
    if (!store) return res.status(501).json({ message: 'Canonical Work storage is unavailable' });
    const work = await store.getWork(config.tenantId, req.params.workId);
    if (!work || !(await store.hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Work not found' });
    const campaignId = typeof req.body?.campaignId === 'string' ? req.body.campaignId.trim() : '';
    if (!ownsCampaign(req.authUser!.userId, campaignId)) return res.status(404).json({ message: 'Campaign not found' });
    const publications = await store.listPublicationsByWork(config.tenantId, work.workId);
    const hosted = publications.find(publication => publication.destination === 'eversally' && publication.status === 'live');
    if (!hosted?.remoteUrl) return res.status(409).json({ message: 'Publish this Work to Eversally before preparing a Patreon companion task' });
    const selectors: string[] = Array.isArray(req.body?.selectorIds) ? req.body.selectorIds.filter((value: unknown): value is string => typeof value === 'string') : [];
    const campaignSelectorIds = new Set([...repository.tiers.values()].filter(tier => tier.campaignId === campaignId).flatMap(tier => [tier.id, ...tier.benefitIds]));
    if (selectors.some(selector => !campaignSelectorIds.has(selector))) return res.status(400).json({ message: 'One or more tier or benefit references are not part of this campaign' });
    let previewUrl: string | undefined;
    if (typeof req.body?.previewUrl === 'string') {
      try { const parsed = new URL(req.body.previewUrl); if (parsed.origin !== new URL(config.appOrigin!).origin) return res.status(400).json({ message: 'Preview URL must use the configured Eversally origin' }); previewUrl = parsed.toString(); } catch { return res.status(400).json({ message: 'Preview URL is invalid' }); }
    }
    const now = new Date().toISOString();
    const task: PatreonCompanionTask = { id: randomUUID(), ownerId: req.authUser!.userId, workId: work.workId, campaignId, title: work.title, description: work.description, previewUrl, canonicalUrl: hosted.remoteUrl, selectorIds: selectors, state: 'OPEN', checklist: ['Review the copy and permitted preview URL.', 'Open Patreon and create the post manually.', 'Select the intended Patreon audience.', 'Publish in Patreon, then synchronize and map the resulting post.'], createdAt: now, updatedAt: now };
    repository.companionTasks.set(task.id, task); repository.audit(task.ownerId, 'patreon.companion_task.created', task.id);
    return res.status(201).json({ ...task, remotePublicationCreated: false, providerCapabilities: { postWrite: false } });
  });
  router.post('/works/:workId/patreon/companion-task/:taskId/map', requireAuth, (req, res) => {
    const task = repository.companionTasks.get(req.params.taskId);
    const reference = [...repository.posts.values()].find(post => post.id === req.body?.postReferenceId);
    if (!task || task.workId !== req.params.workId || task.ownerId !== req.authUser!.userId || !reference || reference.campaignId !== task.campaignId) return res.status(404).json({ message: 'Companion task or Patreon post reference not found' });
    reference.workId = task.workId; task.state = 'MAPPED'; task.remotePostReferenceId = reference.id; task.updatedAt = new Date().toISOString(); repository.audit(task.ownerId, 'patreon.companion_task.mapped', task.id);
    return res.json({ ...task, remotePublicationCreated: false });
  });
  router.get('/access/patreon/authorize', (req, res) => {
    const targetType = typeof req.query.targetType === 'string' ? req.query.targetType : '';
    const targetId = typeof req.query.targetId === 'string' ? req.query.targetId.trim() : '';
    const delivery = req.query.delivery === 'preview' ? 'preview' : 'full';
    if (!['work', 'collection', 'gallery', 'asset', 'download'].includes(targetType) || !targetId) return res.status(400).json({ message: 'A supported targetType and targetId are required' });
    const result = evaluatePatreonTargetAccess(repository, req.authUser?.userId, targetType as AccessGroupTarget['targetType'], targetId, delivery);
    return res.status(result.authorized ? 200 : result.result === 'AUTHENTICATION_REQUIRED' ? 401 : 403).json(result);
  });
  router.get('/access/groups/:id/authorization', requireAuth, (req, res) => {
    repository.purgeExpired(); const group = repository.accessGroups.get(req.params.id);
    if (!group || group.state !== 'ACTIVE') return res.status(404).json({ message: 'Access Group not found' });
    const grant = [...repository.grants.values()].find(item => item.accountId === req.authUser!.userId && item.accessGroupId === group.id && item.state === 'ACTIVE' && Date.parse(item.expiresAt) > Date.now());
    return res.status(grant ? 200 : 403).json({ authorized: Boolean(grant), accessGroupId: group.id, expiresAt: grant?.expiresAt, result: grant ? 'ACTIVE' : 'ENTITLEMENT_REQUIRED' });
  });
  router.post('/access/patreon/mappings', requireAuth, (req, res) => { if (!req.body?.campaignId || !req.body?.accessGroupId || !Array.isArray(req.body?.selectorIds)) return res.status(400).json({ message: 'campaignId, selectorIds, and accessGroupId are required' }); if (!ownsCampaign(req.authUser!.userId, req.body.campaignId)) return res.status(404).json({ message: 'Campaign not found' }); const group = repository.accessGroups.get(req.body.accessGroupId); if (!group || group.ownerId !== req.authUser!.userId || group.state !== 'ACTIVE') return res.status(404).json({ message: 'Access Group not found' }); const now = new Date().toISOString(); const mapping: PatreonAccessMapping = { id: randomUUID(), ownerId: req.authUser!.userId, campaignId: req.body.campaignId, selectorIds: req.body.selectorIds.filter((x: unknown) => typeof x === 'string'), accessGroupId: req.body.accessGroupId, active: false, graceSeconds: Math.min(Math.max(Number(req.body.graceSeconds) || 0, 0), 604800), version: 1, safetyHold: false, createdAt: now, updatedAt: now }; repository.mappings.set(mapping.id, mapping); repository.audit(mapping.ownerId, 'patreon.mapping.created', mapping.id); return res.status(201).json(mapping); });
  router.patch('/access/patreon/mappings/:id', requireAuth, (req, res) => { const m = repository.mappings.get(req.params.id); if (!m || m.ownerId !== req.authUser!.userId) return res.status(404).json({ message: 'Mapping not found' }); if (req.body?.active === true && m.safetyHold) return res.status(409).json({ message: 'Safety hold blocks new Patreon-backed grants', result: 'SAFETY_HOLD' }); if (typeof req.body?.active === 'boolean') m.active = req.body.active; if (Array.isArray(req.body?.selectorIds)) m.selectorIds = req.body.selectorIds; m.version++; m.updatedAt = new Date().toISOString(); repository.audit(m.ownerId, 'patreon.mapping.updated', m.id); return res.json(m); });
  router.delete('/access/patreon/mappings/:id', requireAuth, (req, res) => { const m = repository.mappings.get(req.params.id); if (!m || m.ownerId !== req.authUser!.userId) return res.status(404).json({ message: 'Mapping not found' }); repository.mappings.delete(m.id); for (const g of repository.grants.values()) if (g.campaignId === m.campaignId && g.accessGroupId === m.accessGroupId) { g.state = 'REVOKED'; g.revokedAt = new Date().toISOString(); } repository.audit(m.ownerId, 'patreon.mapping.deleted', m.id); return res.status(204).send(); });
  router.get('/me/patreon-link', requireAuth, (req, res) => { const link = repository.links.get(req.authUser!.userId); return res.json(link ? patronLinkResponse(repository, link) : null); });
  router.post('/me/patreon-link/recheck', requireAuth, async (req, res) => {
    const accountId = req.authUser!.userId;
    const link = repository.links.get(accountId);
    if (!link || link.state !== 'LINKED') return res.status(404).json({ message: 'Patreon is not linked' });
    try {
      const accessToken = await validAccessToken(link.credential, encrypted => { link.credential = encrypted; });
      const identity = await provider.identity(accessToken);
      const evidence = entitlementEvidence(identity);
      const now = new Date();
      const eligibleMappings = [...repository.mappings.values()].filter(mapping => mapping.active && !mapping.safetyHold);
      const eligibleKeys = new Set<string>();
      for (const mapping of eligibleMappings) {
        const match = evidence.find(item => item.campaignId === mapping.campaignId && mapping.selectorIds.some(selector => item.selectorIds.includes(selector)));
        if (!match) continue;
        const key = `${accountId}:${mapping.campaignId}:${mapping.accessGroupId}`;
        eligibleKeys.add(key);
        const checkedAt = now.toISOString();
        const graceMs = mapping.graceSeconds * 1000;
        const previousGrant = repository.grants.get(key);
        const grant: ExternalEntitlementGrant = {
          id: previousGrant?.id || randomUUID(),
          accountId,
          provider: 'patreon',
          campaignId: mapping.campaignId,
          accessGroupId: mapping.accessGroupId,
          state: 'ACTIVE',
          evidenceHash: sha256(JSON.stringify({ campaignId: match.campaignId, selectorIds: [...match.selectorIds].sort(), mappingVersion: mapping.version })),
          checkedAt,
          recheckAt: new Date(now.getTime() + ENTITLEMENT_TTL_MS).toISOString(),
          expiresAt: new Date(now.getTime() + ENTITLEMENT_TTL_MS + graceMs).toISOString(),
          mappingVersion: mapping.version
        };
        repository.grants.set(key, grant);
        repository.audit(accountId, previousGrant ? 'patreon.grant.renewed' : 'patreon.grant.created', grant.id);
      }
      for (const [key, grant] of repository.grants) {
        if (grant.accountId !== accountId || grant.state !== 'ACTIVE' || eligibleKeys.has(key)) continue;
        grant.state = 'REVOKED';
        grant.revokedAt = now.toISOString();
        repository.audit(accountId, 'patreon.grant.revoked', grant.id);
      }
      link.campaignIds = [...new Set(evidence.map(item => item.campaignId))];
      link.lastVerificationTime = now.toISOString();
      repository.audit(accountId, 'patreon.entitlements.rechecked', undefined);
      return res.json({
        state: 'VERIFIED',
        ...patronLinkResponse(repository, link)
      });
    } catch {
      const now = Date.now();
      for (const grant of repository.grants.values()) {
        if (grant.accountId === accountId && grant.state === 'ACTIVE' && Date.parse(grant.expiresAt) <= now) { grant.state = 'EXPIRED'; repository.audit(accountId, 'patreon.grant.expired', grant.id); }
      }
      const retainedUntil = [...repository.grants.values()].filter(grant => grant.accountId === accountId && grant.state === 'ACTIVE').map(grant => grant.expiresAt).sort()[0];
      repository.audit(accountId, 'patreon.entitlements.recheck_failed', undefined, 'ENTITLEMENT_UNKNOWN');
      return res.status(503).json({ message: 'Entitlement could not be verified; no new access was granted', result: 'ENTITLEMENT_UNKNOWN', existingAccessRetainedUntil: retainedUntil });
    }
  });
  router.get('/me/patreon-link/audit', requireAuth, (req, res) => {
    const accountId = req.authUser!.userId;
    const grantIds = new Set([...repository.grants.values()].filter(grant => grant.accountId === accountId).map(grant => grant.id));
    return res.json(repository.audits.filter(event => event.actor === accountId && (event.action.startsWith('patreon.entitlements.') || event.action.startsWith('patreon.patron_link.') || (event.target && grantIds.has(event.target)))).slice(-100).reverse().map(event => ({ action: event.action, result: event.result, correlationId: event.correlationId, at: event.at, accessGroupId: event.target ? [...repository.grants.values()].find(grant => grant.id === event.target)?.accessGroupId : undefined })));
  });
  router.delete('/me/patreon-link', requireAuth, (req, res) => { const link = repository.links.get(req.authUser!.userId); if (link) { link.credential = ''; link.state = 'DISCONNECTED'; link.purgeTime = new Date().toISOString(); for (const g of repository.grants.values()) if (g.accountId === link.accountId) { g.state = 'REVOKED'; g.revokedAt = link.purgeTime; repository.audit(link.accountId, 'patreon.grant.revoked_on_unlink', g.id); } repository.audit(link.accountId, 'patreon.patron_link.disconnected'); } return res.status(204).send(); });
  return router;
};

export const createPatreonWebhookHandler = (config: AppConfig, repository: PatreonRepository): RequestHandler => async (req, res) => {
  try { await repository.ready(); } catch { return res.status(503).send(); }
  if (!config.patreonWebhookSecret || !Buffer.isBuffer(req.body)) return res.status(503).send();
  const supplied = String(req.header('x-patreon-signature') || ''); const expected = createHmac('md5', config.patreonWebhookSecret).update(req.body).digest('hex');
  const valid = supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) { repository.audit('patreon', 'patreon.webhook.rejected', undefined, 'WEBHOOK_REJECTED'); return res.status(401).send(); }
  const eventType = String(req.header('x-patreon-event') || '');
  if (!SUPPORTED_WEBHOOK_EVENTS.has(eventType)) {
    repository.audit('patreon', 'patreon.webhook.ignored', eventType, 'UNSUPPORTED_EVENT');
    return res.status(202).send();
  }
  let payload: any; try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send(); }
  const eventId = String(req.header('x-patreon-event-id') || sha256(`${req.header('x-patreon-event')}:${req.body.toString('base64')}`));
  if (repository.webhookEvents.has(eventId)) return res.status(202).send();
  const campaignId = jsonId(payload?.data?.relationships?.campaign?.data) || jsonId(payload?.included?.find?.((item: any) => item.type === 'campaign'));
  const connectionId = [...repository.connections.values()].find(connection => connection.selectedCampaignIds.includes(campaignId))?.id;
  repository.webhookEvents.set(eventId, { type: eventType, connectionId, receivedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), result: connectionId ? 'QUEUED' : 'UNMATCHED_CAMPAIGN' });
  // Only the identifiers needed by an asynchronous reconciliation are retained; raw payloads are discarded.
  repository.audit('patreon', 'patreon.webhook.verified', String(payload?.data?.id || eventId));
  await repository.flush(); res.status(202).send();
  if (!connectionId) return;
  const remoteId = jsonId(payload?.data);
  const patronSubjectId = jsonId(payload?.data?.relationships?.user?.data)
    || jsonId(payload?.included?.find?.((item: any) => item.type === 'user'));
  queueMicrotask(() => {
    const envelope = repository.webhookEvents.get(eventId);
    if (!envelope || envelope.result !== 'QUEUED') return;
    if (eventType === 'posts:delete') {
      for (const post of repository.posts.values()) if (post.connectionId === connectionId && post.remotePostId === remoteId) post.state = 'MISSING';
    }
    if (['members:delete', 'members:pledge:delete'].includes(eventType) && patronSubjectId) {
      const link = [...repository.links.values()].find(item => item.subjectHash === sha256(patronSubjectId) && item.state === 'LINKED');
      if (link) for (const grant of repository.grants.values()) if (grant.accountId === link.accountId && grant.campaignId === campaignId && grant.state === 'ACTIVE') { grant.state = 'REVOKED'; grant.revokedAt = new Date().toISOString(); repository.audit(link.accountId, 'patreon.grant.revoked_by_webhook', grant.id); }
    }
    envelope.result = 'PROCESSED';
    repository.audit('patreon', 'patreon.webhook.processed', eventId);
    void repository.flush();
  });
};
