import { randomUUID } from 'crypto';
import type { Express, Request } from 'express';
import { requireAuth } from './auth';
import type { AppConfig } from './config';
import type { CanonicalAsset, Work, WorkAsset } from './canonicalDomain';
import { evaluateTumblrEligibility, renderCanonicalWorkToTumblrV1, TumblrApiClient, verifyTumblrOAuthState, type TumblrApplicationCredentials, type TumblrConnector, type TumblrContentDeclarations, type TumblrPolicyRule, type TumblrPostState, type TumblrPublicationMode } from './tumblrIntegration';
import { decryptTumblrCreatorApplication, decryptTumblrOAuthGrant, encryptTumblrCreatorApplication, encryptTumblrOAuthGrant, publicTumblrConnector, TumblrOAuthStateService, type TumblrRepository } from './tumblrRepository';
import type { TumblrPublishQueue } from './tumblrPublishQueue';

interface TumblrRouteDependencies {
  app: Express;
  config: AppConfig;
  repository: TumblrRepository;
  hasCreatorAccess(userId: string, creatorId: string): Promise<boolean>;
  getWork(tenantId: string, workId: string): Promise<Work | null>;
  listAssets(tenantId: string, workId: string): Promise<Array<CanonicalAsset & { attachment: WorkAsset }>>;
  resolveAssetUrl(asset: CanonicalAsset, req: Request): Promise<string | undefined>;
  publishQueue: TumblrPublishQueue;
  audit?(req: Request, action: string, details: Record<string, unknown>): void;
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const callbackUrl = (config: AppConfig) => config.tumblrOAuthRedirectUri || '';
const policyRules = (config: AppConfig): TumblrPolicyRule[] => {
  if (!config.tumblrPolicyRulesJson) return [];
  try {
    const parsed = JSON.parse(config.tumblrPolicyRulesJson) as unknown;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed.filter((rule): rule is TumblrPolicyRule => Boolean(rule) && typeof rule === 'object' && typeof rule.id === 'string' && ['tumblr_api', 'managed_connector'].includes(rule.source) && ['creator_owned_required', 'platform_ineligible'].includes(rule.effect) && typeof rule.declaration === 'string' && typeof rule.message === 'string');
  } catch { throw new Error('TUMBLR_POLICY_RULES_JSON is invalid.'); }
};

const credentialsFor = (connector: TumblrConnector, config: AppConfig): TumblrApplicationCredentials => {
  if (connector.ownership === 'creator_owned') {
    return decryptTumblrCreatorApplication(connector, config.externalTokenEncryptionKey || '');
  }
  if (!config.tumblrClientId || !config.tumblrClientSecret || !callbackUrl(config)) throw new Error('Managed Tumblr OAuth is not configured.');
  return { clientId: config.tumblrClientId, clientSecret: config.tumblrClientSecret, redirectUri: callbackUrl(config) };
};

const parseIdentity = (payload: Record<string, unknown>) => {
  const user = payload.user && typeof payload.user === 'object' ? payload.user as Record<string, unknown> : payload;
  const name = text(user.name);
  if (!name) throw new Error('Tumblr account identity response was incomplete.');
  const blogs = Array.isArray(user.blogs) ? user.blogs.filter((blog): blog is Record<string, unknown> => Boolean(blog) && typeof blog === 'object') : [];
  return { name, id: text(user.uuid) || name, blogs };
};

export const registerTumblrRoutes = ({ app, config, repository, hasCreatorAccess, getWork, listAssets, resolveAssetUrl, publishQueue, audit }: TumblrRouteDependencies) => {
  const stateService = new TumblrOAuthStateService(repository, config.externalTokenEncryptionKey || '');

  app.get('/studio/integrations/tumblr/configuration', requireAuth, (_req, res) => res.json({
    platform: 'tumblr',
    managedConfigured: Boolean(config.tumblrClientId && config.tumblrClientSecret && callbackUrl(config) && config.externalTokenEncryptionKey),
    creatorOwnedConfigured: Boolean(callbackUrl(config) && config.externalTokenEncryptionKey),
    redirectUri: callbackUrl(config) || undefined
  }));

  app.get('/studio/integrations/tumblr', requireAuth, async (req, res) => {
    const creatorId = text(req.query.creatorId);
    if (!creatorId) return res.status(400).json({ message: 'creatorId is required.' });
    if (!(await hasCreatorAccess(req.authUser!.userId, creatorId))) return res.status(403).json({ message: 'Creator access required.' });
    return res.json((await repository.listConnectors(config.tenantId, req.authUser!.userId, creatorId)).map(publicTumblrConnector));
  });

  app.post('/studio/integrations/tumblr', requireAuth, async (req, res) => {
    const creatorId = text(req.body?.creatorId);
    const ownership = req.body?.ownership === 'creator_owned' ? 'creator_owned' : req.body?.ownership === 'managed' ? 'managed' : '';
    if (!creatorId || !ownership) return res.status(400).json({ message: 'creatorId and a valid ownership mode are required.' });
    if (!(await hasCreatorAccess(req.authUser!.userId, creatorId))) return res.status(403).json({ message: 'Creator access required.' });
    if (!config.externalTokenEncryptionKey || !callbackUrl(config)) return res.status(503).json({ message: 'Tumblr OAuth is not configured for this deployment.' });
    if (ownership === 'managed' && (!config.tumblrClientId || !config.tumblrClientSecret)) return res.status(503).json({ message: 'Managed Tumblr OAuth is not configured.' });
    let creatorApplicationEncrypted: TumblrConnector['creatorApplicationEncrypted'];
    if (ownership === 'creator_owned') {
      const clientId = text(req.body?.clientId);
      const clientSecret = text(req.body?.clientSecret);
      const redirectUri = text(req.body?.redirectUri);
      if (!clientId || !clientSecret || redirectUri !== callbackUrl(config)) return res.status(400).json({ message: 'Creator application credentials and the exact deployment redirect URI are required.' });
      creatorApplicationEncrypted = encryptTumblrCreatorApplication({ clientId, clientSecret, redirectUri }, config.externalTokenEncryptionKey);
    }
    const connector: TumblrConnector = { id: randomUUID(), tenantId: config.tenantId, userId: req.authUser!.userId, creatorId, ownership, authProtocol: 'oauth2', status: 'pending', ...(creatorApplicationEncrypted ? { creatorApplicationEncrypted } : {}), credentialsEncrypted: {}, scopes: [] };
    await repository.putConnector(connector);
    audit?.(req, 'tumblr.connector.created', { connectorId: connector.id, creatorId, ownership });
    return res.status(201).json(publicTumblrConnector(connector));
  });

  app.post('/studio/integrations/tumblr/:id/oauth/start', requireAuth, async (req, res) => {
    const connector = await repository.getConnector(config.tenantId, req.params.id);
    if (!connector || connector.userId !== req.authUser!.userId || !(await hasCreatorAccess(req.authUser!.userId, connector.creatorId))) return res.status(404).json({ message: 'Tumblr connector not found.' });
    try {
      const state = await stateService.issue({ tenantId: config.tenantId, userId: connector.userId, creatorId: connector.creatorId, connectorId: connector.id, ownership: connector.ownership });
      return res.json({ authorizationUrl: new TumblrApiClient(credentialsFor(connector, config), config.tumblrApiBaseUrl).authorizationUrl(state) });
    } catch (error) {
      return res.status(409).json({ message: error instanceof Error ? error.message : 'Tumblr authorization could not be started.' });
    }
  });

  app.post('/studio/integrations/tumblr/:id/test', requireAuth, async (req, res) => {
    const connector = await repository.getConnector(config.tenantId, req.params.id);
    if (!connector || connector.userId !== req.authUser!.userId || !(await hasCreatorAccess(req.authUser!.userId, connector.creatorId))) return res.status(404).json({ message: 'Tumblr connector not found.' });
    try {
      const identity = parseIdentity(await new TumblrApiClient(credentialsFor(connector, config), config.tumblrApiBaseUrl).userInfo(decryptTumblrOAuthGrant(connector, config.externalTokenEncryptionKey || '').accessToken));
      const now = new Date().toISOString();
      await repository.putConnector({ ...connector, status: 'connected', tumblrUserId: identity.id, tumblrUserName: identity.name, lastValidatedAt: now });
      return res.json({ connected: true, tumblrUserId: identity.id, tumblrUserName: identity.name, blogCount: identity.blogs.length, scopes: connector.scopes || [], lastValidatedAt: now });
    } catch (error) { return res.status(409).json({ connected: false, message: error instanceof Error ? error.message : 'Tumblr connection test failed.' }); }
  });

  app.post('/studio/integrations/tumblr/:id/refresh', requireAuth, async (req, res) => {
    const connector = await repository.getConnector(config.tenantId, req.params.id);
    if (!connector || connector.userId !== req.authUser!.userId || !(await hasCreatorAccess(req.authUser!.userId, connector.creatorId))) return res.status(404).json({ message: 'Tumblr connector not found.' });
    try {
      const grant = decryptTumblrOAuthGrant(connector, config.externalTokenEncryptionKey || '');
      if (!grant.refreshToken) return res.status(409).json({ message: 'Tumblr did not provide a refresh token. Reauthorize this connector.' });
      const refreshed = await new TumblrApiClient(credentialsFor(connector, config), config.tumblrApiBaseUrl).refreshAccessToken(grant.refreshToken);
      const nextGrant = { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken || grant.refreshToken, ...(refreshed.expiresIn ? { expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000).toISOString() } : {}), scopes: refreshed.scopes.length ? refreshed.scopes : grant.scopes };
      const now = new Date().toISOString();
      const updated = { ...connector, credentialsEncrypted: encryptTumblrOAuthGrant(nextGrant, config.externalTokenEncryptionKey || ''), scopes: nextGrant.scopes, status: 'connected' as const, lastValidatedAt: now };
      await repository.putConnector(updated);
      audit?.(req, 'tumblr.connector.credentials.updated', { connectorId: connector.id, creatorId: connector.creatorId });
      return res.json(publicTumblrConnector(updated));
    } catch (error) {
      await repository.putConnector({ ...connector, status: 'expired', lastValidatedAt: new Date().toISOString() });
      return res.status(409).json({ message: error instanceof Error ? error.message : 'Tumblr authorization could not be refreshed.' });
    }
  });

  app.get('/integrations/tumblr/callback', async (req, res) => {
    const stateToken = text(req.query.state);
    let unconsumed;
    // The callback does not depend on a browser session: the signed state binds
    // the initiating user, and the persisted nonce is atomically consumed once.
    try {
      const signed = verifyTumblrOAuthState(stateToken, config.externalTokenEncryptionKey || '');
      unconsumed = await stateService.consume(stateToken, { tenantId: config.tenantId, userId: signed.userId });
    } catch { return res.status(400).json({ message: 'The Tumblr connection request is invalid, expired, or already used.' }); }
    const returnToStudio = (result: string) => config.appOrigin
      ? res.redirect(302, new URL(`/studio/workspace?section=integrations&tumblr=${result}`, config.appOrigin).toString())
      : res.json({ tumblr: result });
    if (text(req.query.error)) return returnToStudio('cancelled');
    const code = text(req.query.code);
    if (!code) return res.status(400).json({ message: 'Tumblr authorization code is missing.' });
    const connector = await repository.getConnector(config.tenantId, unconsumed.connectorId);
    if (!connector || connector.userId !== unconsumed.userId || connector.creatorId !== unconsumed.creatorId || connector.ownership !== unconsumed.ownership || !(await hasCreatorAccess(unconsumed.userId, connector.creatorId))) return res.status(403).json({ message: 'This Tumblr connector is no longer authorized.' });
    try {
      const client = new TumblrApiClient(credentialsFor(connector, config), config.tumblrApiBaseUrl);
      const tokens = await client.exchangeCode(code);
      const identity = parseIdentity(await client.userInfo(tokens.accessToken));
      const now = new Date().toISOString();
      await repository.putConnector({ ...connector, status: 'connected', tumblrUserId: identity.id, tumblrUserName: identity.name, credentialsEncrypted: encryptTumblrOAuthGrant({ accessToken: tokens.accessToken, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}), ...(tokens.expiresIn ? { expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString() } : {}), scopes: tokens.scopes }, config.externalTokenEncryptionKey || ''), scopes: tokens.scopes, connectedAt: now, lastValidatedAt: now });
      await Promise.all(identity.blogs.map(async (blog) => {
        const identifier = text(blog.name) || text(blog.uuid);
        if (!identifier) return;
        await repository.putDestination({ id: randomUUID(), tenantId: config.tenantId, connectorId: connector.id, creatorId: connector.creatorId, tumblrBlogId: text(blog.uuid) || undefined, identifier, name: text(blog.name) || undefined, title: text(blog.title) || undefined, url: text(blog.url) || undefined, enabled: false });
      }));
      audit?.(req, 'tumblr.connector.connected', { connectorId: connector.id, creatorId: connector.creatorId, blogCount: identity.blogs.length });
      return returnToStudio('connected');
    } catch {
      await repository.putConnector({ ...connector, status: 'error' });
      return returnToStudio('failed');
    }
  });

  app.get('/studio/integrations/tumblr/:id/blogs', requireAuth, async (req, res) => {
    const connector = await repository.getConnector(config.tenantId, req.params.id);
    if (!connector || connector.userId !== req.authUser!.userId || !(await hasCreatorAccess(req.authUser!.userId, connector.creatorId))) return res.status(404).json({ message: 'Tumblr connector not found.' });
    return res.json(await repository.listDestinations(config.tenantId, connector.id));
  });

  app.patch('/studio/integrations/tumblr/:id/blogs/:blogId', requireAuth, async (req, res) => {
    const connector = await repository.getConnector(config.tenantId, req.params.id);
    const destination = await repository.getDestination(config.tenantId, req.params.blogId);
    if (!connector || connector.userId !== req.authUser!.userId || !destination || destination.connectorId !== connector.id || !(await hasCreatorAccess(req.authUser!.userId, connector.creatorId))) return res.status(404).json({ message: 'Tumblr blog destination not found.' });
    const defaults = req.body?.defaults && typeof req.body.defaults === 'object' ? {
      publicationMode: ['full', 'selected_assets', 'announcement'].includes(req.body.defaults.publicationMode) ? req.body.defaults.publicationMode : destination.defaults?.publicationMode,
      postState: ['published', 'draft', 'queue', 'private'].includes(req.body.defaults.postState) ? req.body.defaults.postState : destination.defaults?.postState,
      includeSourceLink: typeof req.body.defaults.includeSourceLink === 'boolean' ? req.body.defaults.includeSourceLink : destination.defaults?.includeSourceLink,
      includeWorkTitle: typeof req.body.defaults.includeWorkTitle === 'boolean' ? req.body.defaults.includeWorkTitle : destination.defaults?.includeWorkTitle,
      includeDescription: typeof req.body.defaults.includeDescription === 'boolean' ? req.body.defaults.includeDescription : destination.defaults?.includeDescription,
      includeTags: typeof req.body.defaults.includeTags === 'boolean' ? req.body.defaults.includeTags : destination.defaults?.includeTags,
      appendDefaultTags: Array.isArray(req.body.defaults.appendDefaultTags) ? req.body.defaults.appendDefaultTags.map(text).filter(Boolean).slice(0, 30) : destination.defaults?.appendDefaultTags
    } : destination.defaults;
    const updated = { ...destination, enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : destination.enabled, ...(defaults ? { defaults } : {}) };
    await repository.putDestination(updated);
    audit?.(req, updated.enabled ? 'tumblr.blog.enabled' : 'tumblr.blog.disabled', { connectorId: connector.id, destinationId: destination.id, creatorId: connector.creatorId });
    return res.json(updated);
  });

  app.post('/studio/works/:workId/preview/tumblr', requireAuth, async (req, res) => {
    const work = await getWork(config.tenantId, req.params.workId);
    if (!work || !(await hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Work not found.' });
    const connector = await repository.getConnector(config.tenantId, text(req.body?.connectorId));
    const destination = await repository.getDestination(config.tenantId, text(req.body?.destinationId));
    if (!connector || connector.userId !== req.authUser!.userId || connector.creatorId !== work.creatorId || !destination || destination.connectorId !== connector.id || destination.creatorId !== work.creatorId || !destination.enabled) return res.status(404).json({ message: 'Enabled Tumblr destination not found.' });
    const declarations = req.body?.declarations && typeof req.body.declarations === 'object' ? req.body.declarations as TumblrContentDeclarations : {};
    let eligibility;
    try { eligibility = evaluateTumblrEligibility(declarations, connector.ownership, policyRules(config)); }
    catch (error) { return res.status(503).json({ message: error instanceof Error ? error.message : 'Tumblr policy is unavailable.' }); }
    const canonicalUrl = text(req.body?.canonicalUrl);
    if (canonicalUrl && (!canonicalUrl.startsWith('https://') || canonicalUrl.length > 2000)) return res.status(400).json({ message: 'canonicalUrl must be an HTTPS URL.' });
    const manualPublishing = { title: work.title, description: work.description || '', tags: Array.isArray(req.body?.tags) ? req.body.tags.map(text).filter(Boolean) : work.tags, assetIds: Array.isArray(req.body?.selectedAssetIds) ? req.body.selectedAssetIds.map(text).filter(Boolean) : [], editorUrl: 'https://www.tumblr.com/new' };
    if (!eligibility.allowed) return res.status(422).json({ eligibility, manualPublishing });
    const assets = await Promise.all((await listAssets(config.tenantId, work.workId)).map(async (asset) => ({ ...asset, url: await resolveAssetUrl(asset, req) })));
    const defaults = destination.defaults || {};
    const mode = (['full', 'selected_assets', 'announcement'].includes(req.body?.mode) ? req.body.mode : defaults.publicationMode || 'full') as TumblrPublicationMode;
    const state = (['published', 'draft', 'queue', 'private'].includes(req.body?.state) ? req.body.state : defaults.postState || 'published') as TumblrPostState;
    try {
      const npf = renderCanonicalWorkToTumblrV1({ work, assets, mode, state, selectedAssetIds: Array.isArray(req.body?.selectedAssetIds) ? req.body.selectedAssetIds.map(text).filter(Boolean) : undefined, canonicalUrl: canonicalUrl || undefined, includeTitle: typeof req.body?.includeTitle === 'boolean' ? req.body.includeTitle : defaults.includeWorkTitle, includeDescription: typeof req.body?.includeDescription === 'boolean' ? req.body.includeDescription : defaults.includeDescription, includeSourceLink: typeof req.body?.includeSourceLink === 'boolean' ? req.body.includeSourceLink : defaults.includeSourceLink, tags: Array.isArray(req.body?.tags) ? req.body.tags.map(text).filter(Boolean) : defaults.includeTags === false ? [] : [...work.tags, ...(defaults.appendDefaultTags || [])], maxMediaBlocks: config.tumblrMediaBlockLimit });
      return res.json({ rendererVersion: 1, eligibility, destination, npf, manualPublishing });
    } catch (error) {
      return res.status(422).json({ message: error instanceof Error ? error.message : 'Tumblr preview could not be rendered.', code: error && typeof error === 'object' && 'code' in error ? error.code : 'validation', eligibility, manualPublishing });
    }
  });

  app.post('/studio/works/:workId/publish/tumblr', requireAuth, async (req, res) => {
    const work = await getWork(config.tenantId, req.params.workId);
    if (!work || !(await hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Work not found.' });
    const connector = await repository.getConnector(config.tenantId, text(req.body?.connectorId));
    const destination = await repository.getDestination(config.tenantId, text(req.body?.destinationId));
    if (!connector || connector.status !== 'connected' || connector.userId !== req.authUser!.userId || connector.creatorId !== work.creatorId || !destination || destination.connectorId !== connector.id || !destination.enabled) return res.status(404).json({ message: 'Connected Tumblr destination not found.' });
    const declarations = req.body?.declarations && typeof req.body.declarations === 'object' ? req.body.declarations as TumblrContentDeclarations : {};
    let eligibility;
    try { eligibility = evaluateTumblrEligibility(declarations, connector.ownership, policyRules(config)); }
    catch (error) { return res.status(503).json({ message: error instanceof Error ? error.message : 'Tumblr policy is unavailable.' }); }
    if (!eligibility.allowed) return res.status(422).json({ eligibility });
    const defaults = destination.defaults || {};
    const mode = (['full', 'selected_assets', 'announcement'].includes(req.body?.mode) ? req.body.mode : defaults.publicationMode || 'full') as TumblrPublicationMode;
    const state = (['published', 'draft', 'queue', 'private'].includes(req.body?.state) ? req.body.state : defaults.postState || 'published') as TumblrPostState;
    const canonicalUrl = text(req.body?.canonicalUrl);
    if (canonicalUrl && (!canonicalUrl.startsWith('https://') || canonicalUrl.length > 2000)) return res.status(400).json({ message: 'canonicalUrl must be an HTTPS URL.' });
    try {
      const assets = await Promise.all((await listAssets(config.tenantId, work.workId)).map(async (asset) => ({ ...asset, url: await resolveAssetUrl(asset, req) })));
      const selectedAssetIds = Array.isArray(req.body?.selectedAssetIds) ? req.body.selectedAssetIds.map(text).filter(Boolean) : undefined;
      const npf = renderCanonicalWorkToTumblrV1({ work, assets, mode, state, selectedAssetIds, canonicalUrl: canonicalUrl || undefined, includeTitle: typeof req.body?.includeTitle === 'boolean' ? req.body.includeTitle : defaults.includeWorkTitle, includeDescription: typeof req.body?.includeDescription === 'boolean' ? req.body.includeDescription : defaults.includeDescription, includeSourceLink: typeof req.body?.includeSourceLink === 'boolean' ? req.body.includeSourceLink : defaults.includeSourceLink, tags: Array.isArray(req.body?.tags) ? req.body.tags.map(text).filter(Boolean) : defaults.includeTags === false ? [] : [...work.tags, ...(defaults.appendDefaultTags || [])], maxMediaBlocks: config.tumblrMediaBlockLimit });
      const now = new Date().toISOString();
      const publication = { id: randomUUID(), tenantId: config.tenantId, creatorId: work.creatorId, workId: work.workId, connectorId: connector.id, destinationId: destination.id, mode, ...(selectedAssetIds ? { selectedAssetIds } : {}), status: 'pending' as const, requestSnapshot: { rendererVersion: 1, workRevision: work.revision, declarations, eligibility, npf }, updatedAt: now };
      await repository.putPublication(publication);
      try { await publishQueue.enqueue(publication.id); }
      catch (error) {
        await repository.putPublication({ ...publication, status: 'failed', responseSnapshot: { errorType: 'platform', message: error instanceof Error ? error.message : 'Tumblr queue is unavailable.' } });
        return res.status(503).json({ message: 'Tumblr publishing queue is unavailable.' });
      }
      audit?.(req, 'tumblr.publish.requested', { publicationId: publication.id, workId: work.workId, connectorId: connector.id, destinationId: destination.id });
      return res.status(202).json(publication);
    } catch (error) { return res.status(422).json({ message: error instanceof Error ? error.message : 'Tumblr publication could not be prepared.' }); }
  });

  app.get('/studio/works/:workId/publications/tumblr', requireAuth, async (req, res) => {
    const work = await getWork(config.tenantId, req.params.workId);
    if (!work || !(await hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Work not found.' });
    return res.json(await repository.listPublications(config.tenantId, work.workId));
  });

  app.get('/studio/works/:workId/publications/:publicationId/tumblr/remote', requireAuth, async (req, res) => {
    const work = await getWork(config.tenantId, req.params.workId);
    const publication = await repository.getPublication(config.tenantId, req.params.publicationId);
    if (!work || !publication || publication.workId !== work.workId || !(await hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Tumblr publication not found.' });
    const connector = await repository.getConnector(config.tenantId, publication.connectorId);
    const destination = await repository.getDestination(config.tenantId, publication.destinationId);
    if (!connector || connector.userId !== req.authUser!.userId || !destination || !publication.tumblrPostId) return res.status(404).json({ message: 'Remote Tumblr post not found.' });
    try {
      const remote = await new TumblrApiClient(credentialsFor(connector, config), config.tumblrApiBaseUrl).getPost(destination.identifier, publication.tumblrPostId, decryptTumblrOAuthGrant(connector, config.externalTokenEncryptionKey || '').accessToken);
      return res.json({ publication, remote });
    } catch (error) {
      if (error instanceof Error && 'status' in error && (error as { status?: number }).status === 404) {
        await repository.putPublication({ ...publication, status: 'remote_missing', updatedAt: new Date().toISOString() });
        return res.status(404).json({ message: 'The Tumblr post no longer exists.', status: 'remote_missing' });
      }
      return res.status(502).json({ message: error instanceof Error ? error.message : 'Tumblr could not validate the remote post.' });
    }
  });

  app.patch('/studio/works/:workId/publications/:publicationId/tumblr', requireAuth, async (req, res) => {
    const work = await getWork(config.tenantId, req.params.workId);
    const publication = await repository.getPublication(config.tenantId, req.params.publicationId);
    if (!work || !publication || publication.workId !== work.workId || !(await hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Tumblr publication not found.' });
    const connector = await repository.getConnector(config.tenantId, publication.connectorId);
    const destination = await repository.getDestination(config.tenantId, publication.destinationId);
    if (!connector || connector.userId !== req.authUser!.userId || connector.status !== 'connected' || !destination || !publication.tumblrPostId) return res.status(409).json({ message: 'The Tumblr destination is not available for updates.' });
    const client = new TumblrApiClient(credentialsFor(connector, config), config.tumblrApiBaseUrl);
    const accessToken = decryptTumblrOAuthGrant(connector, config.externalTokenEncryptionKey || '').accessToken;
    try {
      const remote = await client.getPost(destination.identifier, publication.tumblrPostId, accessToken);
      if (req.body?.confirmRemoteOverwrite !== true) return res.status(409).json({ message: 'Review the current Tumblr post before replacing it.', code: 'remote_confirmation_required', remote });
      const snapshot = publication.requestSnapshot || {};
      const npf = snapshot.npf;
      if (!npf || typeof npf !== 'object' || !Array.isArray((npf as { content?: unknown }).content)) return res.status(422).json({ message: 'The stored Tumblr publication cannot be rendered for an update.' });
      const updatedRemote = await client.updatePost(destination.identifier, publication.tumblrPostId, npf as Parameters<TumblrApiClient['updatePost']>[2], accessToken);
      const updated = { ...publication, responseSnapshot: { ...(publication.responseSnapshot || {}), updateResponse: updatedRemote }, updatedAt: new Date().toISOString() };
      await repository.putPublication(updated);
      audit?.(req, 'tumblr.post.updated', { publicationId: publication.id, workId: work.workId, destinationId: destination.id });
      return res.json(updated);
    } catch (error) { return res.status(502).json({ message: error instanceof Error ? error.message : 'Tumblr could not update the post.' }); }
  });

  app.delete('/studio/works/:workId/publications/:publicationId/tumblr', requireAuth, async (req, res) => {
    const work = await getWork(config.tenantId, req.params.workId);
    const publication = await repository.getPublication(config.tenantId, req.params.publicationId);
    if (!work || !publication || publication.workId !== work.workId || !(await hasCreatorAccess(req.authUser!.userId, work.creatorId))) return res.status(404).json({ message: 'Tumblr publication not found.' });
    const connector = await repository.getConnector(config.tenantId, publication.connectorId);
    const destination = await repository.getDestination(config.tenantId, publication.destinationId);
    if (!connector || connector.userId !== req.authUser!.userId || !destination || !publication.tumblrPostId) return res.status(409).json({ message: 'The Tumblr destination is not available for deletion.' });
    try {
      await new TumblrApiClient(credentialsFor(connector, config), config.tumblrApiBaseUrl).deletePost(destination.identifier, publication.tumblrPostId, decryptTumblrOAuthGrant(connector, config.externalTokenEncryptionKey || '').accessToken);
      const now = new Date().toISOString();
      const deleted = { ...publication, status: 'deleted' as const, deletedAt: now, updatedAt: now };
      await repository.putPublication(deleted);
      audit?.(req, 'tumblr.post.deleted', { publicationId: publication.id, workId: work.workId, destinationId: destination.id });
      return res.json(deleted);
    } catch (error) { return res.status(502).json({ message: error instanceof Error ? error.message : 'Tumblr could not delete the post.' }); }
  });

  app.delete('/studio/integrations/tumblr/:id', requireAuth, async (req, res) => {
    const connector = await repository.getConnector(config.tenantId, req.params.id);
    if (!connector || connector.userId !== req.authUser!.userId || !(await hasCreatorAccess(req.authUser!.userId, connector.creatorId))) return res.status(404).json({ message: 'Tumblr connector not found.' });
    const now = new Date().toISOString();
    // Preserve connector/publication history, but destroy the OAuth grant and
    // disable every destination so queued work cannot use a disconnected grant.
    await Promise.all((await repository.listDestinations(config.tenantId, connector.id)).map((destination) => repository.putDestination({ ...destination, enabled: false })));
    await repository.putConnector({ ...connector, status: 'revoked', credentialsEncrypted: {}, scopes: [], disconnectedAt: now, lastValidatedAt: now });
    audit?.(req, 'tumblr.connector.revoked', { connectorId: connector.id, creatorId: connector.creatorId, credentialsPurged: true });
    return res.status(204).end();
  });
};
