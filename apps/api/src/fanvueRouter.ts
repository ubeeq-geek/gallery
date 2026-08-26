import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { AppConfig } from './config';
import { requireAuth } from './auth';
import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import { deriveIntegrationAccountHealth, nativeIntegrationHealthConnection } from './integrationAccountHealth';
import { createFanvuePkce, evaluateFanvueEligibility, FanvueClient, FanvueWebhookVerifier, hashFanvueSnapshot, newFanvuePublication, type FanvueConnection, type FanvueExternalReferenceWork, type FanvuePublication, type FanvueRightsEligibility, type FanvueWebhookEnvelope } from './fanvue';
import { InMemoryFanvueRepository, minimizeFanvueWebhook, type FanvueRepository } from './fanvueRepository';
import type { CanonicalAsset, Work, WorkAsset } from './canonicalDomain';

type OAuthState = {
  purpose: 'fanvue_oauth'; connectionId: string; ownerId: string; nonce: string; codeVerifier: string;
};

const safeConnection = (connection: FanvueConnection) => {
  const { encryptedCredentialReference: _secret, ...safe } = connection;
  return {
    ...safe,
    health: deriveIntegrationAccountHealth(nativeIntegrationHealthConnection({
      platform: 'fanvue',
      connectionStatus: connection.state === 'CONNECTED' ? 'connected'
        : connection.state === 'REAUTH_REQUIRED' ? 'authentication_required'
          : connection.state === 'FANVUE_RESTRICTED' ? 'disabled' : 'temporarily_unavailable',
      lastSuccessfulSyncAt: connection.lastSyncAt,
      lastIssue: connection.accountHealth?.status === 'attention'
        ? { code: 'sync_failed', message: 'Fanvue requires account attention.', remediation: 'Review the account health details and retry.' }
        : undefined
    }))
  };
};

const requestedScopes = ['creator.read', 'posts.read', 'posts.write', 'media.write'];
const capabilityScope = {
  read_posts: 'posts.read', publish_posts: 'posts.write', manage_mapped_posts: 'posts.write', account_health: 'creator.read'
} as const;

export const createFanvueRouter = (
  config: AppConfig,
  repository: FanvueRepository = new InMemoryFanvueRepository(),
  canManageOwner: (userId: string, ownerId: string) => Promise<boolean> = async (userId, ownerId) => userId === ownerId,
  getWorkContext: (workId: string) => Promise<null | { work: Work; assets: Array<CanonicalAsset & { attachment: WorkAsset }>; activeSafetyHold: boolean }> = async () => null,
  canApproveManagedEligibility: (userId: string) => Promise<boolean> = async () => false,
  loadAssetBody: (asset: CanonicalAsset) => Promise<Buffer> = async () => { throw new Error('Asset loading is not configured.'); },
  requireAdmission: (input: { operation: 'connect' | 'import' | 'publish' | 'update_remote' | 'delete_remote'; ownerId: string; connectionId?: string; workId?: string }) => Promise<void> = async () => undefined
) => {
  const router = express.Router();
  const stateSecret = config.externalTokenEncryptionKey;
  const apiBaseUrl = config.fanvueApiBaseUrl || 'https://api.fanvue.com';
  const authorizeEndpoint = config.fanvueAuthorizeUrl || 'https://auth.fanvue.com/oauth/authorize';
  const apiVersion = config.fanvueApiVersion || '2026-08-01';

  const storedEligibility = async (
    context: { work: Work; assets: Array<CanonicalAsset & { attachment: WorkAsset }>; activeSafetyHold: boolean },
    connection: FanvueConnection
  ) => {
    const record = await repository.getRightsEligibility(context.work.creatorId, context.work.workId);
    const currentAssetIds = context.assets.map((asset) => asset.assetId).sort();
    const recordAssetIds = [...(record?.assetIds || [])].sort();
    const assetSetMatches = Boolean(record && JSON.stringify(currentAssetIds) === JSON.stringify(recordAssetIds));
    const recordCurrent = Boolean(record && assetSetMatches && !record.revokedAt && (!record.expiresAt || Date.parse(record.expiresAt) > Date.now()));
    const assetsReady = context.assets.length > 0 && context.assets.every((asset) =>
      asset.status === 'ready' && asset.storage.mode === 'hosted' && ['image', 'video'].includes(asset.kind) && Boolean(asset.checksumSha256)
    );
    const result = evaluateFanvueEligibility({
      rightsManifestReference: recordCurrent ? record!.rightsManifestReference : undefined,
      ownershipAttested: recordCurrent ? record!.ownershipAttested : false,
      everyParticipantAdultAttested: recordCurrent ? record!.everyParticipantAdultAttested : false,
      consentAttested: recordCurrent ? record!.consentAttested : false,
      aiGenerated: context.work.aiDisclosure === 'ai-generated', aiDisclosureConfirmed: recordCurrent ? record!.aiDisclosureConfirmed : false,
      realPersonLikenessCleared: recordCurrent ? record!.realPersonLikenessCleared : false, activeSafetyHold: context.activeSafetyHold,
      platformPolicy: recordCurrent ? record!.platformPolicy : 'CREATOR_OWNED_REQUIRED', connectionMode: connection.mode, mediaSupported: assetsReady
    });
    const reasons = [...result.reasons, ...(!record ? ['ELIGIBILITY_ATTESTATION_REQUIRED']
      : !assetSetMatches ? ['RIGHTS_ASSET_SET_CHANGED'] : !recordCurrent ? ['ELIGIBILITY_ATTESTATION_EXPIRED_OR_REVOKED'] : [])];
    return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], record, assetIds: currentAssetIds };
  };

  router.post('/api/integrations/fanvue/connections/start', requireAuth, async (req, res) => {
    if (!config.fanvueClientId || !config.fanvueClientSecret || !config.fanvueOAuthRedirectUri || !stateSecret) {
      return res.status(503).json({ message: 'Fanvue is not configured.', requiredConfiguration: [
        ...(!config.fanvueClientId ? ['FANVUE_CLIENT_ID'] : []),
        ...(!config.fanvueClientSecret ? ['FANVUE_CLIENT_SECRET'] : []),
        ...(!config.fanvueOAuthRedirectUri ? ['FANVUE_OAUTH_REDIRECT_URI'] : []),
        ...(!stateSecret ? ['EXTERNAL_TOKEN_ENCRYPTION_KEY'] : [])
      ] });
    }
    const ownerId = typeof req.body?.ownerId === 'string' ? req.body.ownerId.trim() : '';
    const ownerType = req.body?.ownerType === 'studio' ? 'studio' : 'creator';
    const mode = req.body?.mode === 'CREATOR_OWNED' ? 'CREATOR_OWNED' : 'STUDIO_MANAGED';
    if (!ownerId) return res.status(400).json({ message: 'ownerId is required.' });
    if (!(await canManageOwner(req.authUser!.userId, ownerId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    await requireAdmission({ operation: 'connect', ownerId });
    // Creator-owned secret collection is deliberately not approximated in the studio pilot.
    if (mode === 'CREATOR_OWNED') return res.status(409).json({ message: 'Creator-owned OAuth applications require the reviewed credential-vault flow.' });

    const now = new Date().toISOString();
    const connection: FanvueConnection = {
      connectionId: randomUUID(), ownerId, ownerType, mode, scopes: [], capabilities: [],
      state: 'PENDING_OAUTH', apiVersion, verificationStatus: 'unknown',
      webhookSubscriptions: [], policyVersion: 'fanvue-v1-2026-08-22', createdAt: now, updatedAt: now
    };
    await repository.putConnection(connection);
    const pkce = createFanvuePkce();
    const nonce = randomUUID();
    const state = jwt.sign({ purpose: 'fanvue_oauth', connectionId: connection.connectionId, ownerId, nonce, codeVerifier: pkce.verifier } satisfies OAuthState, stateSecret, {
      algorithm: 'HS256', expiresIn: '10m', issuer: 'ubeeq-fanvue', audience: 'fanvue-oauth'
    });
    const authorizeUrl = new URL(authorizeEndpoint);
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code', client_id: config.fanvueClientId, redirect_uri: config.fanvueOAuthRedirectUri,
      scope: requestedScopes.join(' '), state, nonce, code_challenge: pkce.challenge, code_challenge_method: 'S256'
    }).toString();
    return res.status(201).json({ connection: safeConnection(connection), authorizeUrl: authorizeUrl.toString(), requestedScopes });
  });

  router.get('/api/integrations/fanvue/oauth/callback', async (req, res) => {
    try {
      if (!stateSecret || !config.fanvueClientId || !config.fanvueClientSecret || !config.fanvueOAuthRedirectUri) throw new Error('Fanvue is not configured.');
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!state || !code) return res.status(400).json({ message: 'OAuth code and state are required.' });
      const claim = jwt.verify(state, stateSecret, { algorithms: ['HS256'], issuer: 'ubeeq-fanvue', audience: 'fanvue-oauth' }) as OAuthState;
      if (claim.purpose !== 'fanvue_oauth' || !claim.nonce || !claim.codeVerifier) throw new Error('Invalid OAuth state.');
      const connection = await repository.getConnection(claim.connectionId);
      if (!connection || connection.ownerId !== claim.ownerId || connection.state !== 'PENDING_OAUTH') throw new Error('OAuth connection is no longer pending.');

      const tokenResponse = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: config.fanvueClientId,
          client_secret: config.fanvueClientSecret, redirect_uri: config.fanvueOAuthRedirectUri, code_verifier: claim.codeVerifier })
      });
      const tokens = await tokenResponse.json() as { access_token?: string; refresh_token?: string; scope?: string; expires_in?: number };
      if (!tokenResponse.ok || !tokens.access_token) throw new Error('Fanvue token exchange failed.');
      const accountResponse = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/users/me`, {
        headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json', 'fanvue-api-version': apiVersion }
      });
      const account = await accountResponse.json() as { uuid?: string; verification_status?: string };
      if (!accountResponse.ok || !account.uuid) throw new Error('Fanvue account lookup failed.');
      const scopes = (tokens.scope || '').split(/\s+/).filter(Boolean);
      const connected: FanvueConnection = {
        ...connection, fanvueUserUuid: account.uuid,
        encryptedCredentialReference: encryptExternalCredential(JSON.stringify({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined }), stateSecret),
        scopes, state: requestedScopes.every((scope) => scopes.includes(scope)) ? 'CONNECTED' : 'INSUFFICIENT_SCOPE',
        verificationStatus: account.verification_status === 'verified' ? 'verified' : account.verification_status === 'restricted' ? 'restricted' : 'unknown',
        updatedAt: new Date().toISOString()
      };
      await repository.putConnection(connected);
      await repository.putAuditEvent({ auditEventId: randomUUID(), actorId: claim.ownerId, action: 'fanvue.connection.connected',
        connectionId: connected.connectionId, afterHash: createHash('sha256').update(JSON.stringify(safeConnection(connected))).digest('hex'),
        result: 'SUCCESS', correlationId: randomUUID(), createdAt: new Date().toISOString() });
      return res.json({ connection: safeConnection(connected) });
    } catch {
      return res.status(400).json({ message: 'Fanvue OAuth callback could not be validated.' });
    }
  });

  router.get('/api/integrations/fanvue/connections/:id', requireAuth, async (req, res) => {
    const connection = await repository.getConnection(req.params.id);
    if (!connection) return res.status(404).json({ message: 'Fanvue connection not found.' });
    if (!(await canManageOwner(req.authUser!.userId, connection.ownerId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    return res.json({ connection: safeConnection(connection) });
  });

  router.get('/api/integrations/fanvue/connections', requireAuth, async (req, res) => {
    const ownerId = typeof req.query.ownerId === 'string' ? req.query.ownerId : '';
    if (!ownerId) return res.status(400).json({ message: 'ownerId is required.' });
    if (!(await canManageOwner(req.authUser!.userId, ownerId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    return res.json({ items: (await repository.listConnections(ownerId)).map(safeConnection) });
  });

  router.post('/api/integrations/fanvue/connections/:id/account-health', requireAuth, async (req, res) => {
    const connection = await repository.getConnection(req.params.id);
    if (!connection) return res.status(404).json({ message: 'Fanvue connection not found.' });
    if (!(await canManageOwner(req.authUser!.userId, connection.ownerId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    if (!connection.capabilities.includes('account_health')) return res.status(409).json({ message: 'Enable account health before refreshing this private summary.' });
    if (connection.state !== 'CONNECTED' || !connection.encryptedCredentialReference || !stateSecret) {
      return res.status(409).json({ message: 'The Fanvue connection must be reauthorized.' });
    }
    try {
      const credential = JSON.parse(decryptExternalCredential(connection.encryptedCredentialReference, stateSecret)) as { accessToken?: string };
      if (!credential.accessToken) throw new Error('Missing access token.');
      const client = new FanvueClient(credential.accessToken, connection.apiVersion, fetch as never, apiBaseUrl);
      const remote = await client.getAccountHealth();
      const status = remote.postingRestricted || remote.status === 'restricted' ? 'restricted'
        : remote.status === 'attention' || (remote.moderationFlagCount || 0) > 0 ? 'attention'
          : remote.status === 'healthy' ? 'healthy' : 'unknown';
      const checkedAt = new Date().toISOString();
      const accountHealth: NonNullable<FanvueConnection['accountHealth']> = {
        status, checkedAt,
        ...(Number.isInteger(remote.moderationFlagCount) ? { moderationFlagCount: Math.max(0, remote.moderationFlagCount!) } : {}),
        ...(typeof remote.postingRestricted === 'boolean' ? { postingRestricted: remote.postingRestricted } : {}),
        ...(typeof remote.summaryCode === 'string' && remote.summaryCode.length <= 100 ? { summaryCode: remote.summaryCode } : {})
      };
      const updated: FanvueConnection = { ...connection, accountHealth,
        state: status === 'restricted' ? 'FANVUE_RESTRICTED' : connection.state, updatedAt: checkedAt };
      await repository.putConnection(updated);
      await repository.putAuditEvent({ auditEventId: randomUUID(), actorId: req.authUser!.userId, action: 'fanvue.account_health.refreshed',
        connectionId: connection.connectionId, afterHash: hashFanvueSnapshot(accountHealth), result: 'SUCCESS', correlationId: randomUUID(), createdAt: checkedAt });
      return res.json({ connection: safeConnection(updated), accountHealth });
    } catch (error) {
      const code = (error as { code?: string }).code || 'ACCOUNT_HEALTH_FAILED';
      if (code === 'REAUTH_REQUIRED') await repository.putConnection({ ...connection, state: 'REAUTH_REQUIRED', updatedAt: new Date().toISOString() });
      return res.status(code === 'REAUTH_REQUIRED' ? 401 : 502).json({ message: 'Fanvue account health could not be refreshed.', code });
    }
  });

  router.patch('/api/integrations/fanvue/connections/:id/capabilities', requireAuth, async (req, res) => {
    const connection = await repository.getConnection(req.params.id);
    if (!connection) return res.status(404).json({ message: 'Fanvue connection not found.' });
    if (!(await canManageOwner(req.authUser!.userId, connection.ownerId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    const requested: unknown[] = Array.isArray(req.body?.capabilities) ? req.body.capabilities : [];
    const capabilities: Array<keyof typeof capabilityScope> = [...new Set(requested.filter((value: unknown): value is keyof typeof capabilityScope =>
      typeof value === 'string' && Object.prototype.hasOwnProperty.call(capabilityScope, value)
    ))];
    const missingScopes = capabilities.map((item) => capabilityScope[item]).filter((scope) => !connection.scopes.includes(scope));
    if (missingScopes.length) return res.status(409).json({ message: 'Fanvue connection has insufficient scope.', missingScopes });
    if (connection.verificationStatus !== 'verified' && capabilities.some((item) => item === 'publish_posts' || item === 'manage_mapped_posts')) {
      return res.status(409).json({ message: 'Publishing remains disabled until Fanvue reports the creator account as verified.' });
    }
    const updated = { ...connection, capabilities, updatedAt: new Date().toISOString() };
    await repository.putConnection(updated);
    await repository.putAuditEvent({ auditEventId: randomUUID(), actorId: req.authUser!.userId, action: 'fanvue.connection.capabilities.updated',
      connectionId: connection.connectionId, beforeHash: createHash('sha256').update(JSON.stringify(connection.capabilities)).digest('hex'),
      afterHash: createHash('sha256').update(JSON.stringify(capabilities)).digest('hex'), result: 'SUCCESS', correlationId: randomUUID(), createdAt: updated.updatedAt });
    return res.json({ connection: safeConnection(updated) });
  });

  router.post('/api/integrations/fanvue/connections/:id/sync', requireAuth, async (req, res) => {
    const connection = await repository.getConnection(req.params.id);
    if (!connection) return res.status(404).json({ message: 'Fanvue connection not found.' });
    if (!(await canManageOwner(req.authUser!.userId, connection.ownerId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    await requireAdmission({ operation: 'import', ownerId: connection.ownerId, connectionId: connection.connectionId });
    if (!connection.capabilities.includes('read_posts')) return res.status(409).json({ message: 'Enable read posts before synchronizing.' });
    if (!connection.encryptedCredentialReference || !stateSecret) return res.status(409).json({ message: 'Fanvue reauthorization is required.' });
    if (connection.state !== 'CONNECTED') return res.status(409).json({ message: 'Fanvue connection is not ready to synchronize.', state: connection.state });

    try {
      const credential = JSON.parse(decryptExternalCredential(connection.encryptedCredentialReference, stateSecret)) as { accessToken?: string };
      if (!credential.accessToken) throw new Error('Missing access token.');
      const client = new FanvueClient(credential.accessToken, connection.apiVersion, fetch as never, apiBaseUrl);
      const seen = new Set<string>();
      let cursor: string | undefined;
      let imported = 0;
      let changed = 0;
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        const page = await client.listPosts(cursor);
        if (!Array.isArray(page.items)) throw new Error('Invalid Fanvue post-list response.');
        for (const post of page.items) {
          if (!post.uuid) continue;
          seen.add(post.uuid);
          const snapshot = {
            remotePostUuid: post.uuid, canonicalUrl: post.url, title: post.title, caption: post.text,
            publicationState: post.state, accessSummary: post.access?.type, publishedAt: post.publishedAt,
            scheduledAt: post.scheduledAt, collectionUuid: post.collectionUuid,
            remoteMedia: (post.media || []).filter((media) => Boolean(media.uuid)).map((media) => ({
              mediaUuid: media.uuid, mediaType: media.type, processingState: media.state
            })), remoteVersion: post.updatedAt
          };
          const metadataHash = hashFanvueSnapshot(snapshot);
          const existing = await repository.getExternalReferenceByRemotePost(connection.connectionId, post.uuid);
          const now = new Date().toISOString();
          const reference: FanvueExternalReferenceWork = {
            externalReferenceId: existing?.externalReferenceId || randomUUID(), connectionId: connection.connectionId,
            ownerId: connection.ownerId, sourcePlatform: 'fanvue', ...snapshot, metadataHash,
            ...(existing?.mappedWorkId ? { mappedWorkId: existing.mappedWorkId, match: existing.match } : {}),
            syncStatus: existing && existing.metadataHash !== metadataHash ? 'REMOTE_CHANGED' : 'IN_SYNC',
            importedAt: existing?.importedAt || now, updatedAt: now
          };
          if (!existing) imported += 1;
          else if (reference.syncStatus === 'REMOTE_CHANGED') changed += 1;
          await repository.putExternalReference(reference);
        }
        cursor = page.nextCursor;
        if (!cursor) break;
        if (pageNumber === 99) throw new Error('Fanvue reconciliation exceeded the page limit.');
      }
      const existingReferences = await repository.listExternalReferences(connection.connectionId);
      let removed = 0;
      for (const reference of existingReferences) if (!seen.has(reference.remotePostUuid) && reference.syncStatus !== 'REMOTE_REMOVED') {
        await repository.putExternalReference({ ...reference, syncStatus: 'REMOTE_REMOVED', updatedAt: new Date().toISOString() });
        removed += 1;
      }
      const updated = { ...connection, lastSyncAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await repository.putConnection(updated);
      await repository.putAuditEvent({ auditEventId: randomUUID(), actorId: req.authUser!.userId, action: 'fanvue.connection.synchronized',
        connectionId: connection.connectionId, result: 'SUCCESS', correlationId: randomUUID(), createdAt: updated.updatedAt });
      return res.json({ imported, changed, removed, lastSyncAt: updated.lastSyncAt });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'REAUTH_REQUIRED') {
        await repository.putConnection({ ...connection, state: 'REAUTH_REQUIRED', updatedAt: new Date().toISOString() });
      }
      return res.status(code === 'REAUTH_REQUIRED' ? 401 : 502).json({ message: 'Fanvue synchronization failed.', code: code || 'SYNC_FAILED' });
    }
  });

  router.get('/api/integrations/fanvue/connections/:id/external-references', requireAuth, async (req, res) => {
    const connection = await repository.getConnection(req.params.id);
    if (!connection) return res.status(404).json({ message: 'Fanvue connection not found.' });
    if (!(await canManageOwner(req.authUser!.userId, connection.ownerId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    return res.json({ items: await repository.listExternalReferences(connection.connectionId) });
  });

  router.put('/api/works/:workId/fanvue/eligibility', requireAuth, async (req, res) => {
    const context = await getWorkContext(req.params.workId);
    if (!context) return res.status(404).json({ message: 'Work not found.' });
    if (!(await canManageOwner(req.authUser!.userId, context.work.creatorId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    const body = req.body || {};
    const requiredBooleans = ['ownershipAttested', 'everyParticipantAdultAttested', 'consentAttested', 'realPersonLikenessCleared', 'aiDisclosureConfirmed'] as const;
    if (requiredBooleans.some((key) => typeof body[key] !== 'boolean')) return res.status(400).json({ message: 'Every rights and participant attestation must be explicitly answered.' });
    const rightsManifestReference = typeof body.rightsManifestReference === 'string' ? body.rightsManifestReference.trim() : '';
    if (!rightsManifestReference || rightsManifestReference.length > 500) return res.status(400).json({ message: 'A valid rights manifest reference is required.' });
    const platformPolicy = ['ELIGIBLE', 'CREATOR_OWNED_REQUIRED', 'PLATFORM_INELIGIBLE'].includes(body.platformPolicy)
      ? body.platformPolicy as FanvueRightsEligibility['platformPolicy'] : 'CREATOR_OWNED_REQUIRED';
    if (platformPolicy === 'ELIGIBLE' && !(await canApproveManagedEligibility(req.authUser!.userId))) {
      return res.status(403).json({ message: 'Managed-connection eligibility requires an operations reviewer.' });
    }
    if (body.expiresAt !== undefined && (typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt)))) {
      return res.status(400).json({ message: 'expiresAt must be a valid timestamp.' });
    }
    const now = new Date().toISOString();
    const eligibility: FanvueRightsEligibility = {
      eligibilityId: randomUUID(), ownerId: context.work.creatorId, workId: context.work.workId,
      assetIds: context.assets.map((asset) => asset.assetId), rightsManifestReference,
      ownershipAttested: body.ownershipAttested, everyParticipantAdultAttested: body.everyParticipantAdultAttested,
      consentAttested: body.consentAttested, realPersonLikenessCleared: body.realPersonLikenessCleared,
      aiDisclosureConfirmed: body.aiDisclosureConfirmed, platformPolicy, reviewerId: req.authUser!.userId,
      reviewedAt: now, ...(typeof body.expiresAt === 'string' ? { expiresAt: body.expiresAt } : {}), updatedAt: now
    };
    await repository.putRightsEligibility(eligibility);
    await repository.putAuditEvent({ auditEventId: randomUUID(), actorId: req.authUser!.userId, action: 'fanvue.rights_eligibility.attested',
      connectionId: `owner:${context.work.creatorId}`, afterHash: hashFanvueSnapshot(eligibility), result: 'SUCCESS', correlationId: randomUUID(), createdAt: now });
    return res.json({ eligibility });
  });

  router.get('/api/works/:workId/fanvue/eligibility', requireAuth, async (req, res) => {
    const context = await getWorkContext(req.params.workId);
    if (!context) return res.status(404).json({ message: 'Work not found.' });
    if (!(await canManageOwner(req.authUser!.userId, context.work.creatorId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    const connectionId = typeof req.query.connectionId === 'string' ? req.query.connectionId : '';
    const connection = connectionId ? await repository.getConnection(connectionId) : null;
    if (!connection || connection.ownerId !== context.work.creatorId) return res.status(400).json({ message: 'A Fanvue connection for this Work owner is required.' });
    const result = await storedEligibility(context, connection);
    return res.json({ eligible: result.eligible, reasons: result.reasons, eligibility: result.record, assetIds: result.assetIds });
  });

  router.post('/api/works/:workId/fanvue/publications', requireAuth, async (req, res) => {
    const context = await getWorkContext(req.params.workId);
    if (!context) return res.status(404).json({ message: 'Work not found.' });
    if (!(await canManageOwner(req.authUser!.userId, context.work.creatorId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    const connectionId = typeof req.body?.connectionId === 'string' ? req.body.connectionId : '';
    const connection = connectionId ? await repository.getConnection(connectionId) : null;
    if (!connection || connection.ownerId !== context.work.creatorId) return res.status(400).json({ message: 'A Fanvue connection for this Work owner is required.' });
    await requireAdmission({ operation: 'publish', ownerId: context.work.creatorId, connectionId: connection.connectionId, workId: context.work.workId });
    if (connection.state !== 'CONNECTED' || connection.verificationStatus !== 'verified' || !connection.capabilities.includes('publish_posts')) {
      return res.status(409).json({ message: 'The Fanvue connection is not ready for publishing.' });
    }
    const eligibility = await storedEligibility(context, connection);
    if (!eligibility.eligible) return res.status(422).json({ message: 'This Work is not eligible for Fanvue.', reasons: eligibility.reasons });
    const selectedIds = Array.isArray(req.body?.assetIds)
      ? [...new Set<string>((req.body.assetIds as unknown[]).filter((value: unknown): value is string => typeof value === 'string'))] : [];
    const selected = selectedIds.map((id) => context.assets.find((asset) => asset.assetId === id));
    if (!selectedIds.length || selected.some((asset) => !asset)) return res.status(400).json({ message: 'Select one or more Assets attached to this Work.' });
    const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim() : '';
    if (!caption || caption.length > 5000) return res.status(400).json({ message: 'Caption must be between 1 and 5000 characters.' });
    const accessType = req.body?.access?.type;
    if (!['free', 'subscriber', 'paid'].includes(accessType)) return res.status(400).json({ message: 'A supported Fanvue access type is required.' });
    const priceMinor = req.body?.access?.priceMinor;
    const currency = typeof req.body?.access?.currency === 'string' ? req.body.access.currency.toUpperCase() : undefined;
    if (accessType === 'paid' && (!Number.isInteger(priceMinor) || priceMinor <= 0 || !currency || !/^[A-Z]{3}$/.test(currency))) {
      return res.status(400).json({ message: 'Paid access requires a positive minor-unit price and ISO currency.' });
    }
    const scheduleAt = typeof req.body?.scheduleAt === 'string' ? req.body.scheduleAt : undefined;
    if (scheduleAt && (!Number.isFinite(Date.parse(scheduleAt)) || Date.parse(scheduleAt) <= Date.now())) {
      return res.status(400).json({ message: 'Scheduled publication must use a future timestamp.' });
    }
    const preview = {
      caption, media: selected.map((asset) => ({ assetId: asset!.assetId, kind: asset!.kind, filename: asset!.originalFilename })),
      access: { type: accessType, ...(accessType === 'paid' ? { priceMinor, currency } : {}) }, scheduleAt,
      collectionUuid: typeof req.body?.collectionUuid === 'string' ? req.body.collectionUuid.trim() : undefined,
      aiGenerated: context.work.aiDisclosure === 'ai-generated'
    };
    const publication = newFanvuePublication({
      connectionId: connection.connectionId, workId: context.work.workId, captionSnapshot: caption,
      workRevision: context.work.revision, eligibilityId: eligibility.record!.eligibilityId, preview,
      ...(scheduleAt ? { scheduleAt } : {}), access: { type: accessType, ...(accessType === 'paid' ? { priceMinor, currency } : {}) },
      ...(typeof req.body?.collectionUuid === 'string' && req.body.collectionUuid.trim() ? { collectionUuid: req.body.collectionUuid.trim() } : {}),
      media: selected.map((asset) => ({ assetId: asset!.assetId, derivativeId: asset!.assetId,
        checksum: asset!.checksumSha256!, state: 'NOT_UPLOADED' }))
    });
    await repository.putPublication(publication);
    await repository.putAuditEvent({ auditEventId: randomUUID(), actorId: req.authUser!.userId, action: 'fanvue.publication.draft.created',
      connectionId: connection.connectionId, publicationId: publication.publicationId, afterHash: hashFanvueSnapshot(publication),
      result: 'SUCCESS', correlationId: randomUUID(), createdAt: publication.createdAt });
    return res.status(201).json({ publication, preview, confirmationRequired: true });
  });

  router.patch('/api/fanvue/publications/:id', requireAuth, async (req, res) => {
    const publication = await repository.getPublication(req.params.id);
    if (!publication) return res.status(404).json({ message: 'Fanvue publication not found.' });
    const connection = await repository.getConnection(publication.connectionId);
    const context = await getWorkContext(publication.workId);
    if (!connection || !context) return res.status(409).json({ message: 'The publication source is no longer available.' });
    if (!(await canManageOwner(req.authUser!.userId, context.work.creatorId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    await requireAdmission({ operation: 'update_remote', ownerId: context.work.creatorId, connectionId: connection.connectionId, workId: context.work.workId });
    if (['UPLOADING', 'PROCESSING', 'FLAGGED', 'REMOVED'].includes(publication.state)) {
      return res.status(409).json({ message: 'This Fanvue publication cannot be edited in its current state.' });
    }
    const assessment = await storedEligibility(context, connection);
    if (!assessment.eligible || !assessment.record) return res.status(422).json({ message: 'This Work is not eligible for Fanvue.', reasons: assessment.reasons });
    const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim() : publication.captionSnapshot;
    if (!caption || caption.length > 5000) return res.status(400).json({ message: 'Caption must be between 1 and 5000 characters.' });
    const accessType = req.body?.access === undefined ? publication.access.type : req.body.access?.type;
    if (!['free', 'subscriber', 'paid'].includes(accessType)) return res.status(400).json({ message: 'A supported Fanvue access type is required.' });
    const priceMinor = accessType === 'paid' ? Number(req.body?.access?.priceMinor ?? publication.access.priceMinor) : undefined;
    const currencyValue = req.body?.access?.currency ?? publication.access.currency;
    const currency = typeof currencyValue === 'string' ? currencyValue.toUpperCase() : undefined;
    if (accessType === 'paid' && (!Number.isInteger(priceMinor) || priceMinor! <= 0 || !currency || !/^[A-Z]{3}$/.test(currency))) {
      return res.status(400).json({ message: 'Paid access requires a positive minor-unit price and ISO currency.' });
    }
    const scheduleAt = req.body?.scheduleAt === null ? undefined
      : typeof req.body?.scheduleAt === 'string' ? req.body.scheduleAt : publication.scheduleAt;
    if (scheduleAt && (!Number.isFinite(Date.parse(scheduleAt)) || Date.parse(scheduleAt) <= Date.now())) {
      return res.status(400).json({ message: 'Scheduled publication must use a future timestamp.' });
    }
    const collectionUuid = req.body?.collectionUuid === null ? undefined
      : typeof req.body?.collectionUuid === 'string' ? req.body.collectionUuid.trim() || undefined : publication.collectionUuid;
    const assets = publication.media.map((mapping) => context.assets.find((asset) => asset.assetId === mapping.assetId));
    if (assets.some((asset) => !asset)) return res.status(409).json({ message: 'A selected Asset is no longer attached to this Work.' });
    const access = { type: accessType as 'free' | 'subscriber' | 'paid', ...(accessType === 'paid' ? { priceMinor, currency } : {}) };
    const preview = { caption, media: assets.map((asset) => ({ assetId: asset!.assetId, kind: asset!.kind, filename: asset!.originalFilename })),
      access, scheduleAt, collectionUuid, aiGenerated: context.work.aiDisclosure === 'ai-generated' };
    const now = new Date().toISOString();
    const updated: FanvuePublication = { ...publication, state: 'DRAFT', captionSnapshot: caption,
      captionHash: hashFanvueSnapshot(caption), previewHash: hashFanvueSnapshot(preview), workRevision: context.work.revision,
      eligibilityId: assessment.record.eligibilityId, scheduleAt, access, collectionUuid,
      activeIdempotencyKey: undefined, activeMutation: undefined, updatedAt: now };
    await repository.putPublication(updated);
    await repository.putAuditEvent({ auditEventId: randomUUID(), actorId: req.authUser!.userId, action: 'fanvue.publication.update_draft.created',
      connectionId: connection.connectionId, publicationId: updated.publicationId, beforeHash: publication.previewHash,
      afterHash: updated.previewHash, result: 'SUCCESS', correlationId: randomUUID(), createdAt: now });
    return res.json({ publication: updated, preview, confirmationRequired: true,
      remoteChanges: { caption: publication.captionHash !== updated.captionHash, access: hashFanvueSnapshot(publication.access) !== hashFanvueSnapshot(updated.access),
        schedule: publication.scheduleAt !== updated.scheduleAt, collection: publication.collectionUuid !== updated.collectionUuid } });
  });

  router.get('/api/fanvue/publications', requireAuth, async (req, res) => {
    const connectionId = typeof req.query.connectionId === 'string' ? req.query.connectionId : '';
    const connection = connectionId ? await repository.getConnection(connectionId) : null;
    if (!connection) return res.status(404).json({ message: 'Fanvue connection not found.' });
    if (!(await canManageOwner(req.authUser!.userId, connection.ownerId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    const items = await repository.listPublications(connection.connectionId);
    return res.json({ items: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
  });

  router.post('/api/fanvue/publications/:id/publish', requireAuth, async (req, res) => {
    const publication = await repository.getPublication(req.params.id);
    if (!publication) return res.status(404).json({ message: 'Fanvue publication not found.' });
    const connection = await repository.getConnection(publication.connectionId);
    const context = await getWorkContext(publication.workId);
    if (!connection || !context) return res.status(409).json({ message: 'The publication source is no longer available.' });
    if (!(await canManageOwner(req.authUser!.userId, context.work.creatorId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    await requireAdmission({ operation: 'publish', ownerId: context.work.creatorId, connectionId: connection.connectionId, workId: context.work.workId });
    if (req.body?.confirmed !== true || req.body?.previewHash !== publication.previewHash) {
      return res.status(409).json({ message: 'Confirm the exact Fanvue preview before publishing.', previewHash: publication.previewHash });
    }
    if (publication.remotePostUuid && ['PUBLISHED', 'SCHEDULED'].includes(publication.state)) return res.json({ publication, idempotentReplay: true });
    if (!connection.capabilities.includes('publish_posts') || connection.state !== 'CONNECTED' || !connection.encryptedCredentialReference || !stateSecret) {
      return res.status(409).json({ message: 'The Fanvue connection is not ready for publishing.' });
    }
    const assessment = await storedEligibility(context, connection);
    const assetsById = new Map(context.assets.map((asset) => [asset.assetId, asset]));
    const bindingsValid = context.work.revision === publication.workRevision
      && assessment.eligible && assessment.record?.eligibilityId === publication.eligibilityId
      && publication.media.every((mapping) => assetsById.get(mapping.assetId)?.checksumSha256 === mapping.checksum);
    if (!bindingsValid) return res.status(409).json({ message: 'The Work, rights decision, or selected Assets changed. Create and confirm a new preview.' });

    let working: FanvuePublication = { ...publication, state: 'UPLOADING', updatedAt: new Date().toISOString() };
    await repository.putPublication(working);
    try {
      const credential = JSON.parse(decryptExternalCredential(connection.encryptedCredentialReference, stateSecret)) as { accessToken?: string };
      if (!credential.accessToken) throw new Error('Missing access token.');
      const client = new FanvueClient(credential.accessToken, connection.apiVersion, fetch as never, apiBaseUrl);
      const media = [...working.media];
      for (let index = 0; index < media.length; index += 1) {
        if (media[index].remoteMediaUuid && media[index].state === 'FINALIZED') continue;
        const asset = assetsById.get(media[index].assetId)!;
        const body = await loadAssetBody(asset);
        if (createHash('sha256').update(body).digest('hex') !== media[index].checksum) throw Object.assign(new Error('Asset checksum changed.'), { code: 'CHECKSUM_MISMATCH' });
        const session = await client.createMultipartUpload({ filename: asset.originalFilename || `${asset.assetId}.${asset.kind}`,
          contentType: asset.mimeType, byteSize: body.byteLength, checksum: media[index].checksum });
        if (!session.parts?.length) throw new Error('Fanvue returned no multipart destinations.');
        const partSize = session.partSize || Math.ceil(body.byteLength / session.parts.length);
        const completed: Array<{ partNumber: number; etag: string }> = [];
        for (const part of session.parts) {
          const start = (part.partNumber - 1) * partSize;
          const chunk = body.subarray(start, Math.min(start + partSize, body.byteLength));
          if (!chunk.byteLength) throw new Error('Fanvue multipart plan exceeds the Asset size.');
          completed.push({ partNumber: part.partNumber, etag: await client.uploadPart(part.url, chunk) });
        }
        const complete = await client.completeMultipartUpload(session.uploadId, completed);
        media[index] = { ...media[index], remoteMediaUuid: complete.mediaUuid || session.mediaUuid, state: 'PROCESSING' };
        working = { ...working, media, state: 'PROCESSING', updatedAt: new Date().toISOString() };
        await repository.putPublication(working);
        let finalized = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const status = await client.getMedia(media[index].remoteMediaUuid!);
          if (status.moderation) throw Object.assign(new Error('Fanvue flagged the uploaded media.'), { code: 'MODERATION_REJECTION' });
          if (status.state === 'failed') throw new Error('Fanvue media processing failed.');
          if (status.state === 'finalized') { finalized = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!finalized) throw Object.assign(new Error('Fanvue media processing is still pending.'), { code: 'PROCESSING_TIMEOUT' });
        media[index] = { ...media[index], state: 'FINALIZED' };
        working = { ...working, media, updatedAt: new Date().toISOString() };
        await repository.putPublication(working);
      }
      const idempotencyKey = working.activeMutation === 'publish' && working.activeIdempotencyKey ? working.activeIdempotencyKey : randomUUID();
      if (working.activeMutation !== 'publish' || !working.activeIdempotencyKey) {
        working = { ...working, activeIdempotencyKey: idempotencyKey, activeMutation: 'publish',
          idempotencyKeys: [...working.idempotencyKeys, idempotencyKey], updatedAt: new Date().toISOString() };
        await repository.putPublication(working);
      }
      const remote = await client.mutatePost({ text: working.captionSnapshot, mediaUuids: working.media.map((item) => item.remoteMediaUuid),
        access: working.access, collectionUuid: working.collectionUuid, scheduledAt: working.scheduleAt }, idempotencyKey, working.remotePostUuid);
      const completed = { ...working, remotePostUuid: remote.uuid, remoteUrl: remote.url,
        activeIdempotencyKey: undefined, activeMutation: undefined,
        state: working.scheduleAt ? 'SCHEDULED' as const : 'PUBLISHED' as const, updatedAt: new Date().toISOString() };
      await repository.putPublication(completed);
      await repository.putAuditEvent({ auditEventId: randomUUID(), actorId: req.authUser!.userId, action: 'fanvue.publication.published',
        connectionId: connection.connectionId, publicationId: completed.publicationId, beforeHash: publication.previewHash,
        afterHash: hashFanvueSnapshot(completed), result: 'SUCCESS', correlationId: randomUUID(), createdAt: completed.updatedAt });
      return res.json({ publication: completed });
    } catch (error) {
      const code = (error as { code?: string }).code || 'PUBLISH_FAILED';
      const failed = { ...working, state: code === 'MODERATION_REJECTION' ? 'FLAGGED' as const : 'FAILED' as const, updatedAt: new Date().toISOString() };
      await repository.putPublication(failed);
      await repository.putAuditEvent({ auditEventId: randomUUID(), actorId: req.authUser!.userId, action: 'fanvue.publication.publish_failed',
        connectionId: connection.connectionId, publicationId: failed.publicationId, result: 'FAILURE', errorCode: code,
        correlationId: randomUUID(), createdAt: failed.updatedAt });
      return res.status(code === 'MODERATION_REJECTION' ? 422 : 502).json({ message: 'Fanvue publication failed.', code, publication: failed });
    }
  });

  const removeRemotePublication = async (req: express.Request, res: express.Response, action: 'unpublish' | 'delete') => {
    const publication = await repository.getPublication(req.params.id);
    if (!publication) return res.status(404).json({ message: 'Fanvue publication not found.' });
    const connection = await repository.getConnection(publication.connectionId);
    const context = await getWorkContext(publication.workId);
    if (!connection || !context) return res.status(409).json({ message: 'The publication source is no longer available.' });
    if (!(await canManageOwner(req.authUser!.userId, context.work.creatorId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    await requireAdmission({ operation: 'delete_remote', ownerId: context.work.creatorId, connectionId: connection.connectionId, workId: context.work.workId });
    if (req.body?.confirmed !== true || req.body?.remotePostUuid !== publication.remotePostUuid) {
      return res.status(409).json({ message: `Confirm the exact remote post before ${action}.`, remotePostUuid: publication.remotePostUuid });
    }
    if (!connection.capabilities.includes('manage_mapped_posts')) return res.status(409).json({ message: 'Enable manage mapped posts before removing remote material.' });
    if (!publication.remotePostUuid) {
      if (action === 'unpublish') return res.status(409).json({ message: 'This draft has no remote Fanvue post.' });
      const now = new Date().toISOString();
      const removed = { ...publication, state: 'REMOVED' as const, deletedAt: now, updatedAt: now };
      await repository.putPublication(removed);
      return res.json({ publication: removed, remoteMutation: false });
    }
    if (publication.state === 'REMOVED' && (action === 'unpublish' || publication.deletedAt)) {
      return res.json({ publication, idempotentReplay: true });
    }
    if (connection.state !== 'CONNECTED' || !connection.encryptedCredentialReference || !stateSecret) {
      return res.status(409).json({ message: 'The Fanvue connection must be reauthorized before remote removal.' });
    }
    const idempotencyKey = publication.activeMutation === action && publication.activeIdempotencyKey ? publication.activeIdempotencyKey : randomUUID();
    let working: FanvuePublication = publication.activeMutation === action && publication.activeIdempotencyKey ? publication : {
      ...publication, activeIdempotencyKey: idempotencyKey, activeMutation: action,
      idempotencyKeys: [...publication.idempotencyKeys, idempotencyKey], updatedAt: new Date().toISOString()
    };
    await repository.putPublication(working);
    try {
      const credential = JSON.parse(decryptExternalCredential(connection.encryptedCredentialReference, stateSecret)) as { accessToken?: string };
      if (!credential.accessToken) throw new Error('Missing access token.');
      const client = new FanvueClient(credential.accessToken, connection.apiVersion, fetch as never, apiBaseUrl);
      if (action === 'unpublish') await client.unpublishPost(publication.remotePostUuid, idempotencyKey);
      else await client.deletePost(publication.remotePostUuid, idempotencyKey);
      const now = new Date().toISOString();
      working = { ...working, state: 'REMOVED', activeIdempotencyKey: undefined, activeMutation: undefined, updatedAt: now,
        ...(action === 'unpublish' ? { unpublishedAt: now } : { deletedAt: now }) };
      await repository.putPublication(working);
      await repository.putAuditEvent({ auditEventId: randomUUID(), actorId: req.authUser!.userId,
        action: `fanvue.publication.${action === 'delete' ? 'deleted' : 'unpublished'}`, connectionId: connection.connectionId,
        publicationId: working.publicationId, beforeHash: hashFanvueSnapshot(publication), afterHash: hashFanvueSnapshot(working),
        result: 'SUCCESS', correlationId: randomUUID(), createdAt: now });
      return res.json({ publication: working, remoteMutation: true });
    } catch (error) {
      const code = (error as { code?: string }).code || 'REMOTE_REMOVAL_FAILED';
      await repository.putAuditEvent({ auditEventId: randomUUID(), actorId: req.authUser!.userId,
        action: `fanvue.publication.${action}_failed`, connectionId: connection.connectionId, publicationId: working.publicationId,
        result: 'FAILURE', errorCode: code, correlationId: randomUUID(), createdAt: new Date().toISOString() });
      return res.status(502).json({ message: `Fanvue ${action} failed.`, code });
    }
  };

  router.post('/api/fanvue/publications/:id/unpublish', requireAuth, (req, res) => removeRemotePublication(req, res, 'unpublish'));
  router.delete('/api/fanvue/publications/:id', requireAuth, (req, res) => removeRemotePublication(req, res, 'delete'));

  router.delete('/api/integrations/fanvue/connections/:id', requireAuth, async (req, res) => {
    const connection = await repository.getConnection(req.params.id);
    if (!connection) return res.status(404).json({ message: 'Fanvue connection not found.' });
    if (!(await canManageOwner(req.authUser!.userId, connection.ownerId))) return res.status(403).json({ message: 'Owner or manager access required.' });
    await repository.deleteCredentials(connection);
    await repository.putAuditEvent({ auditEventId: randomUUID(), actorId: req.authUser!.userId, action: 'fanvue.connection.disconnected',
      connectionId: connection.connectionId, result: 'SUCCESS', correlationId: randomUUID(), createdAt: new Date().toISOString() });
    return res.status(204).send();
  });

  router.post('/webhooks/fanvue', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    if (!config.fanvueWebhookSecret) return res.status(503).send();
    const rawBody = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body)));
    try {
      new FanvueWebhookVerifier(config.fanvueWebhookSecret).verify(rawBody, req.header('fanvue-signature'), req.header('fanvue-timestamp'));
      const envelope = JSON.parse(rawBody.toString('utf8')) as Partial<FanvueWebhookEnvelope>;
      if (!envelope.eventId || !envelope.eventType || !envelope.occurredAt || !envelope.connectionId || !envelope.payload) return res.status(400).send();
      const allowedEvents = new Set(['creator.post.published', 'creator.post.updated', 'creator.post.unpublished', 'creator.post.deleted',
        'creator.media.finalized', 'creator.media.flagged', 'creator.account.restricted', 'creator.account.verified']);
      const occurredAtMs = Date.parse(envelope.occurredAt);
      if (!allowedEvents.has(envelope.eventType) || !Number.isFinite(occurredAtMs) || occurredAtMs > Date.now() + 5 * 60_000) return res.status(400).send();
      const connection = await repository.getConnection(envelope.connectionId);
      const accountUuid = typeof envelope.payload.accountUuid === 'string' ? envelope.payload.accountUuid : '';
      if (!connection || !accountUuid || accountUuid !== connection.fanvueUserUuid) return res.status(403).send();
      const accepted = await repository.putWebhookEvent(minimizeFanvueWebhook(envelope as FanvueWebhookEnvelope));
      if (!accepted) return res.status(202).send();
      try {
        if (envelope.eventType.startsWith('creator.account.')) {
          if (connection.lastWebhookEventAt && connection.lastWebhookEventAt >= envelope.occurredAt) {
            await repository.updateWebhookOutcome(envelope.eventId, 'IGNORED');
            return res.status(202).send();
          }
          await repository.putConnection({ ...connection,
            verificationStatus: envelope.eventType === 'creator.account.verified' ? 'verified' : 'restricted',
            state: envelope.eventType === 'creator.account.restricted' ? 'FANVUE_RESTRICTED'
              : connection.state === 'FANVUE_RESTRICTED' ? 'CONNECTED' : connection.state,
            lastWebhookEventAt: envelope.occurredAt,
            updatedAt: new Date().toISOString() });
        } else {
          const postUuid = typeof envelope.payload.postUuid === 'string' ? envelope.payload.postUuid : '';
          const mediaUuid = typeof envelope.payload.mediaUuid === 'string' ? envelope.payload.mediaUuid : '';
          const publications = await repository.listPublications(connection.connectionId);
          const publication = publications.find((item) => item.remotePostUuid === postUuid
            || (mediaUuid && item.media.some((mapping) => mapping.remoteMediaUuid === mediaUuid)));
          if (!publication || (publication.lastRemoteEventAt && publication.lastRemoteEventAt >= envelope.occurredAt)) {
            await repository.updateWebhookOutcome(envelope.eventId, 'IGNORED');
            return res.status(202).send();
          }
          let state = publication.state;
          if (envelope.eventType === 'creator.post.published') state = 'PUBLISHED';
          if (envelope.eventType === 'creator.post.unpublished' || envelope.eventType === 'creator.post.deleted') state = 'REMOVED';
          if (envelope.eventType === 'creator.post.updated') state = 'REMOTE_CHANGED';
          if (envelope.eventType === 'creator.media.flagged') state = 'FLAGGED';
          const media = publication.media.map((mapping) => mapping.remoteMediaUuid !== mediaUuid ? mapping : {
            ...mapping, state: envelope.eventType === 'creator.media.flagged' ? 'FLAGGED'
              : envelope.eventType === 'creator.media.finalized' ? 'FINALIZED' : mapping.state
          });
          await repository.putPublication({ ...publication, state, media, lastRemoteEventAt: envelope.occurredAt,
            ...(envelope.eventType === 'creator.post.deleted' ? { deletedAt: envelope.occurredAt } : {}),
            ...(envelope.eventType === 'creator.post.unpublished' ? { unpublishedAt: envelope.occurredAt } : {}),
            updatedAt: new Date().toISOString() });
        }
        await repository.updateWebhookOutcome(envelope.eventId, 'PROCESSED');
      } catch {
        await repository.updateWebhookOutcome(envelope.eventId, 'FAILED');
      }
      return res.status(202).send();
    } catch { return res.status(401).send(); }
  });

  return router;
};

declare global {
  namespace Express { interface Request { rawBody?: Buffer } }
}
