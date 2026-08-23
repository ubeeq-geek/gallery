import express from 'express';
import request from 'supertest';
import { createHash, createHmac } from 'crypto';
import { PATREON_CAPABILITIES, PatreonProvider, PatreonRepository, createPatreonRouter, createPatreonWebhookHandler, evaluatePatreonTargetAccess, patreonAccountsDueForEntitlementRecheck, type PatreonRepositorySnapshot } from '../src/patreon';
import type { AppConfig } from '../src/config';
import { encryptExternalCredential } from '../src/externalCredentials';
import type { DataStore } from '../src/store';

const config = { patreonClientId: 'client', patreonClientSecret: 'secret', patreonOAuthRedirectUri: 'https://api.test/api/integrations/patreon/oauth/callback', patreonPatronOAuthRedirectUri: 'https://api.test/api/me/patreon-link/callback', patreonWebhookSecret: 'hook', externalTokenEncryptionKey: 'test-encryption-key-that-is-long-enough', appOrigin: 'https://app.test' } as AppConfig;

describe('Patreon API v2 integration', () => {
  it('advertises read-only capabilities and creates a PKCE authorization request', async () => {
    expect(PATREON_CAPABILITIES).toMatchObject({ campaignRead: true, postRead: true, postWrite: false, paymentProcessing: false });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.authUser = { userId: 'creator-1', displayName: 'Creator', groups: ['Creators'] }; next(); }); app.use('/api', createPatreonRouter(config, new PatreonRepository(), new PatreonProvider()));
    const response = await request(app).post('/api/integrations/patreon/connections/start').send({ returnPath: '/studio/integrations' }).expect(200);
    const url = new URL(response.body.authorizationUrl);
    expect(url.origin).toBe('https://www.patreon.com'); expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(url.searchParams.get('state')).toBeTruthy(); expect(response.body).not.toHaveProperty('codeVerifier');
  });

  it('rejects invalid webhook signatures and deduplicates verified events', async () => {
    const repository = new PatreonRepository(); const app = express(); app.post('/webhooks/patreon', express.raw({ type: 'application/json' }), createPatreonWebhookHandler(config, repository));
    const body = JSON.stringify({ data: { id: 'member-1' } });
    await request(app).post('/webhooks/patreon').set('content-type', 'application/json').set('x-patreon-signature', 'bad').send(body).expect(401);
    const signature = createHmac('md5', 'hook').update(body).digest('hex');
    await request(app).post('/webhooks/patreon').set('content-type', 'application/json').set('x-patreon-event', 'members:update').set('x-patreon-event-id', 'evt-1').set('x-patreon-signature', signature).send(body).expect(202);
    await request(app).post('/webhooks/patreon').set('content-type', 'application/json').set('x-patreon-event-id', 'evt-1').set('x-patreon-signature', signature).send(body).expect(202);
    expect(repository.webhookEvents.size).toBe(1); expect(repository.audits.some(x => x.result === 'WEBHOOK_REJECTED')).toBe(true);
  });

  it('creates mappings inactive and blocks activation during a safety hold', async () => {
    const repository = new PatreonRepository(); const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.authUser = { userId: 'creator-1', displayName: 'Creator', groups: ['Creators'] }; next(); }); app.use('/api', createPatreonRouter(config, repository));
    const now = new Date().toISOString();
    repository.connections.set('connection-1', { id: 'connection-1', ownerId: 'creator-1', mode: 'STUDIO_MANAGED', credential: 'encrypted', scopes: [], state: 'CONNECTED', selectedCampaignIds: ['c1'], capabilities: [], apiVersion: '2', webhookState: 'DISABLED', policyVersion: 'test', createdAt: now, updatedAt: now });
    repository.campaigns.set('c1', { connectionId: 'connection-1', id: 'c1', creatorAccountId: 'creator-remote', name: 'Campaign', active: true, lastSync: now });
    repository.accessGroups.set('supporters', { id: 'supporters', ownerId: 'creator-1', creatorId: 'creator-local', name: 'Supporters', state: 'ACTIVE', createdAt: now, updatedAt: now });
    const created = await request(app).post('/api/access/patreon/mappings').send({ campaignId: 'c1', selectorIds: ['tier-1'], accessGroupId: 'supporters' }).expect(201);
    expect(created.body.active).toBe(false); repository.mappings.get(created.body.id)!.safetyHold = true;
    await request(app).patch(`/api/access/patreon/mappings/${created.body.id}`).send({ active: true }).expect(409);
  });

  it('grants only currently entitled access groups during a server-side recheck', async () => {
    const repository = new PatreonRepository();
    const provider = new PatreonProvider(async () => new Response(JSON.stringify({
      data: { type: 'user', id: 'patron-1' },
      included: [{
        type: 'member', id: 'member-1',
        relationships: {
          campaign: { data: { type: 'campaign', id: 'campaign-1' } },
          currently_entitled_tiers: { data: [{ type: 'tier', id: 'tier-1' }] }
        }
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    repository.links.set('ever-1', {
      accountId: 'ever-1',
      subjectHash: 'opaque',
      credential: encryptExternalCredential(JSON.stringify({ accessToken: 'token' }), config.externalTokenEncryptionKey!),
      scopes: ['identity', 'identity.memberships'],
      state: 'LINKED',
      campaignIds: []
    });
    const now = new Date().toISOString();
    repository.mappings.set('mapping-1', { id: 'mapping-1', ownerId: 'creator-1', campaignId: 'campaign-1', selectorIds: ['tier-1'], accessGroupId: 'supporters', active: true, graceSeconds: 0, version: 1, safetyHold: false, createdAt: now, updatedAt: now });
    repository.mappings.set('mapping-held', { id: 'mapping-held', ownerId: 'creator-1', campaignId: 'campaign-1', selectorIds: ['tier-1'], accessGroupId: 'held', active: true, graceSeconds: 0, version: 1, safetyHold: true, createdAt: now, updatedAt: now });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.authUser = { userId: 'ever-1', displayName: 'Ever', groups: [] }; next(); }); app.use('/api', createPatreonRouter(config, repository, provider));

    const response = await request(app).post('/api/me/patreon-link/recheck').expect(200);
    expect(response.body.unlocked).toHaveLength(1);
    expect(response.body.unlocked[0]).toMatchObject({ accessGroupId: 'supporters', name: 'Creator access' });
    expect(response.body.unlocked[0]).not.toHaveProperty('evidenceHash');
    expect(response.body).not.toHaveProperty('credential'); expect(response.body).not.toHaveProperty('subjectHash');
    const audit = await request(app).get('/api/me/patreon-link/audit').expect(200);
    expect(audit.body.some((event: any) => event.action === 'patreon.grant.created' && event.accessGroupId === 'supporters')).toBe(true);
    expect(JSON.stringify(audit.body)).not.toContain('tier-1');
  });

  it('marks removed remote posts missing without deleting their local Work mapping', async () => {
    const repository = new PatreonRepository();
    const provider = new PatreonProvider();
    jest.spyOn(provider, 'campaigns').mockResolvedValue({ data: [] });
    jest.spyOn(provider, 'posts').mockResolvedValue({ data: [], included: [] });
    const now = new Date().toISOString();
    repository.connections.set('connection-1', {
      id: 'connection-1', ownerId: 'creator-1', mode: 'STUDIO_MANAGED',
      credential: encryptExternalCredential(JSON.stringify({ accessToken: 'token', clientId: 'client', clientSecret: 'secret' }), config.externalTokenEncryptionKey!),
      scopes: ['campaigns'], state: 'CONNECTED', selectedCampaignIds: ['campaign-1'],
      capabilities: ['campaign_sync', 'post_reference_sync'], apiVersion: '2', webhookState: 'DISABLED', policyVersion: 'test', createdAt: now, updatedAt: now
    });
    repository.posts.set('connection-1:post-1', {
      id: 'reference-1', connectionId: 'connection-1', campaignId: 'campaign-1', remotePostId: 'post-1',
      title: 'Original', accessRuleIds: [], state: 'ACTIVE', workId: 'work-1'
    });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.authUser = { userId: 'creator-1', displayName: 'Creator', groups: ['Creators'] }; next(); }); app.use('/api', createPatreonRouter(config, repository, provider));

    await request(app).post('/api/integrations/patreon/connections/connection-1/sync').expect(202);
    expect(repository.posts.get('connection-1:post-1')).toMatchObject({ state: 'MISSING', workId: 'work-1' });
  });

  it('imports a post as a private metadata-only external-reference Work', async () => {
    const repository = new PatreonRepository(); const now = new Date().toISOString();
    repository.connections.set('connection-1', { id: 'connection-1', ownerId: 'creator-user', mode: 'STUDIO_MANAGED', credential: 'encrypted', scopes: [], state: 'CONNECTED', selectedCampaignIds: ['campaign-1'], capabilities: [], apiVersion: '2', webhookState: 'DISABLED', policyVersion: 'test', createdAt: now, updatedAt: now });
    repository.campaigns.set('campaign-1', { connectionId: 'connection-1', id: 'campaign-1', creatorAccountId: 'remote-creator', name: 'Campaign', active: true, lastSync: now });
    repository.posts.set('connection-1:post-1', { id: 'reference-1', connectionId: 'connection-1', campaignId: 'campaign-1', remotePostId: 'post-1', remoteUrl: 'https://www.patreon.com/posts/1', title: 'Early preview', excerpt: 'Reference metadata', accessRuleIds: ['tier-1'], state: 'ACTIVE' });
    const works: any[] = []; const assets: any[] = []; const attachments: any[] = []; const discovery: any[] = [];
    const store = {
      hasCreatorAccess: jest.fn().mockResolvedValue(true), listWorksByCreator: jest.fn().mockImplementation(async () => works),
      getWork: jest.fn().mockImplementation(async (_tenant, id) => works.find(work => work.workId === id) || null),
      createWork: jest.fn().mockImplementation(async work => { works.push(work); }),
      createCanonicalAsset: jest.fn().mockImplementation(async asset => { assets.push(asset); }),
      attachAssetToWork: jest.fn().mockImplementation(async (_tenant, attachment) => { attachments.push(attachment); }),
      upsertWorkDiscoveryParticipation: jest.fn().mockImplementation(async item => { discovery.push(item); })
    } as unknown as DataStore;
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.authUser = { userId: 'creator-user', displayName: 'Creator', groups: ['Creators'] }; next(); }); app.use('/api', createPatreonRouter(config, repository, new PatreonProvider(), store));

    const response = await request(app).post('/api/integrations/patreon/post-references/reference-1/import').send({ creatorId: 'creator-1' }).expect(201);
    expect(response.body).toMatchObject({ created: true, sourceBackup: false, discoveryEnabled: false });
    expect(works[0]).toMatchObject({ status: 'draft', origin: { type: 'import', platform: 'patreon', remoteId: 'post-1' } });
    expect(assets[0]).toMatchObject({ storage: { mode: 'external', externalUrl: 'https://www.patreon.com/posts/1' }, metadata: { referenceOnly: true } });
    expect(attachments[0]).toMatchObject({ role: 'preview' }); expect(discovery[0]).toMatchObject({ state: 'none' });
  });

  it('requires explicit field-level resolution before remote metadata changes a Work', async () => {
    const repository = new PatreonRepository(); const now = new Date().toISOString();
    repository.connections.set('connection-1', { id: 'connection-1', ownerId: 'creator-user', mode: 'STUDIO_MANAGED', credential: 'encrypted', scopes: [], state: 'CONNECTED', selectedCampaignIds: ['campaign-1'], capabilities: [], apiVersion: '2', webhookState: 'DISABLED', policyVersion: 'test', createdAt: now, updatedAt: now });
    repository.campaigns.set('campaign-1', { connectionId: 'connection-1', id: 'campaign-1', creatorAccountId: 'remote', name: 'Campaign', active: true, lastSync: now });
    repository.posts.set('connection-1:post-1', { id: 'reference-1', connectionId: 'connection-1', campaignId: 'campaign-1', remotePostId: 'post-1', title: 'Remote title', excerpt: 'Remote excerpt', metadataHash: 'remote-hash', accessRuleIds: [], state: 'REMOTE_CHANGED', workId: 'work-1' });
    let work: any = { workId: 'work-1', tenantId: 'default', creatorId: 'creator-1', title: 'Local title', description: 'Local description', revision: 3 };
    const store = { getWork: jest.fn().mockImplementation(async () => work), hasCreatorAccess: jest.fn().mockResolvedValue(true), updateWork: jest.fn().mockImplementation(async value => { work = value; }) } as unknown as DataStore;
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.authUser = { userId: 'creator-user', displayName: 'Creator', groups: ['Creators'] }; next(); }); app.use('/api', createPatreonRouter(config, repository, new PatreonProvider(), store));

    await request(app).post('/api/integrations/patreon/post-references/reference-1/resolve').send({ strategy: 'keep_local' }).expect(200);
    expect(work).toMatchObject({ title: 'Local title', description: 'Local description', revision: 3 });
    repository.posts.get('connection-1:post-1')!.state = 'REMOTE_CHANGED';
    const accepted = await request(app).post('/api/integrations/patreon/post-references/reference-1/resolve').send({ strategy: 'field_by_field', fields: ['title'] }).expect(200);
    expect(work).toMatchObject({ title: 'Remote title', description: 'Local description', revision: 4 });
    expect(accepted.body).toMatchObject({ acceptedFields: ['title'], localAssetsChanged: false, discoveryChanged: false });
  });

  it('reports private connector health and safely disables access on disconnect', async () => {
    const repository = new PatreonRepository(); const now = new Date().toISOString();
    repository.connections.set('connection-1', { id: 'connection-1', ownerId: 'creator-user', mode: 'STUDIO_MANAGED', credential: 'encrypted-secret', scopes: ['campaigns'], state: 'CONNECTED', selectedCampaignIds: ['campaign-1'], capabilities: ['campaign_sync'], apiVersion: '2', lastSuccessfulSync: now, webhookState: 'ACTIVE', policyVersion: 'test', createdAt: now, updatedAt: now });
    repository.campaigns.set('campaign-1', { connectionId: 'connection-1', id: 'campaign-1', creatorAccountId: 'remote', name: 'Campaign', active: true, lastSync: now });
    repository.mappings.set('mapping-1', { id: 'mapping-1', ownerId: 'creator-user', campaignId: 'campaign-1', selectorIds: ['tier-1'], accessGroupId: 'supporters', active: true, graceSeconds: 0, version: 1, safetyHold: false, createdAt: now, updatedAt: now });
    repository.grants.set('grant-key', { id: 'grant-1', accountId: 'ever-1', provider: 'patreon', campaignId: 'campaign-1', accessGroupId: 'supporters', state: 'ACTIVE', evidenceHash: 'hash', checkedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), mappingVersion: 1 });
    repository.audit('creator-user', 'patreon.connection.synced', 'connection-1');
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.authUser = { userId: 'creator-user', displayName: 'Creator', groups: ['Creators'] }; next(); }); app.use('/api', createPatreonRouter(config, repository));

    const health = await request(app).get('/api/integrations/patreon/connections/connection-1/health').expect(200);
    expect(health.body).toMatchObject({ counts: { campaigns: 1, mappings: 1, activeGrants: 1 }, reauthorizationRequired: false });
    expect(JSON.stringify(health.body)).not.toContain('encrypted-secret');
    const audit = await request(app).get('/api/integrations/patreon/connections/connection-1/audit').expect(200);
    expect(audit.body[0]).toMatchObject({ action: 'patreon.connection.synced' });
    await request(app).delete('/api/integrations/patreon/connections/connection-1').expect(204);
    expect(repository.connections.get('connection-1')).toMatchObject({ credential: '', state: 'DISCONNECTED', webhookState: 'DISABLED' });
    expect(repository.campaigns.get('campaign-1')?.active).toBe(false); expect(repository.mappings.get('mapping-1')?.active).toBe(false); expect(repository.grants.get('grant-key')?.state).toBe('REVOKED');
  });

  it('defines provider-neutral Access Groups and fails closed without an active grant', async () => {
    const repository = new PatreonRepository(); const works = [{ workId: 'work-1', creatorId: 'creator-1', status: 'ready' }];
    const store = { hasCreatorAccess: jest.fn().mockResolvedValue(true), getWork: jest.fn().mockImplementation(async (_tenant, id) => works.find(work => work.workId === id) || null), listPublicationsByWork: jest.fn().mockResolvedValue([{ destination: 'eversally', status: 'live' }]) } as unknown as DataStore;
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.authUser = { userId: 'creator-user', displayName: 'Creator', groups: ['Creators'] }; next(); }); app.use('/api', createPatreonRouter(config, repository, new PatreonProvider(), store));
    const group = await request(app).post('/api/access/groups').send({ creatorId: 'creator-1', name: 'Supporters' }).expect(201);
    await request(app).post(`/api/access/groups/${group.body.id}/targets`).send({ targetType: 'work', targetId: 'work-1', previewsPublic: true }).expect(201);
    const eligibility = await request(app).get('/api/works/work-1/patreon/eligibility').expect(200);
    expect(eligibility.body).toMatchObject({ eligible: true, result: 'ALLOWED_MANAGED', accessGroups: [{ name: 'Supporters' }] });
    await request(app).get(`/api/access/groups/${group.body.id}/authorization`).expect(403);
    repository.grants.set('grant', { id: 'grant', accountId: 'creator-user', provider: 'patreon', campaignId: 'campaign-1', accessGroupId: group.body.id, state: 'ACTIVE', evidenceHash: 'hash', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), mappingVersion: 1 });
    const authorized = await request(app).get(`/api/access/groups/${group.body.id}/authorization`).expect(200);
    expect(authorized.body).toMatchObject({ authorized: true, result: 'ACTIVE' });
  });

  it('processes verified negative webhooks asynchronously and revokes matching grants', async () => {
    const repository = new PatreonRepository(); const now = new Date().toISOString();
    repository.connections.set('connection-1', { id: 'connection-1', ownerId: 'creator', mode: 'STUDIO_MANAGED', credential: 'encrypted', scopes: [], state: 'CONNECTED', selectedCampaignIds: ['campaign-1'], capabilities: ['webhooks'], apiVersion: '2', webhookState: 'ACTIVE', policyVersion: 'test', createdAt: now, updatedAt: now });
    repository.links.set('ever-1', { accountId: 'ever-1', subjectHash: createHash('sha256').update('patron-1').digest('hex'), credential: 'encrypted', scopes: [], state: 'LINKED', campaignIds: ['campaign-1'] });
    repository.grants.set('grant', { id: 'grant', accountId: 'ever-1', provider: 'patreon', campaignId: 'campaign-1', accessGroupId: 'supporters', state: 'ACTIVE', evidenceHash: 'hash', checkedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), mappingVersion: 1 });
    const app = express(); app.post('/webhooks/patreon', express.raw({ type: 'application/json' }), createPatreonWebhookHandler(config, repository));
    const body = JSON.stringify({ data: { type: 'member', id: 'member-1', relationships: { campaign: { data: { type: 'campaign', id: 'campaign-1' } }, user: { data: { type: 'user', id: 'patron-1' } } } } });
    const signature = createHmac('md5', 'hook').update(body).digest('hex');
    await request(app).post('/webhooks/patreon').set('content-type', 'application/json').set('x-patreon-event', 'members:delete').set('x-patreon-event-id', 'evt-delete').set('x-patreon-signature', signature).send(body).expect(202);
    await new Promise(resolve => setImmediate(resolve));
    expect(repository.grants.get('grant')).toMatchObject({ state: 'REVOKED' });
    expect(repository.webhookEvents.get('evt-delete')).toMatchObject({ connectionId: 'connection-1', result: 'PROCESSED' });
  });

  it('retains existing access only inside explicit grace and exposes due scheduled checks', async () => {
    const repository = new PatreonRepository(); const now = Date.now();
    repository.links.set('ever-1', { accountId: 'ever-1', subjectHash: 'opaque', credential: encryptExternalCredential(JSON.stringify({ accessToken: 'token', clientId: 'client', clientSecret: 'secret' }), config.externalTokenEncryptionKey!), scopes: [], state: 'LINKED', campaignIds: ['campaign-1'], lastVerificationTime: new Date(now - 7 * 60 * 60_000).toISOString() });
    repository.grants.set('grant', { id: 'grant', accountId: 'ever-1', provider: 'patreon', campaignId: 'campaign-1', accessGroupId: 'supporters', state: 'ACTIVE', evidenceHash: 'hash', checkedAt: new Date(now - 7 * 60 * 60_000).toISOString(), recheckAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), mappingVersion: 1 });
    expect(patreonAccountsDueForEntitlementRecheck(repository, now)).toEqual(['ever-1']);
    const provider = new PatreonProvider(); jest.spyOn(provider, 'identity').mockRejectedValue(new Error('provider unavailable'));
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.authUser = { userId: 'ever-1', displayName: 'Ever', groups: [] }; next(); }); app.use('/api', createPatreonRouter(config, repository, provider));
    const unknown = await request(app).post('/api/me/patreon-link/recheck').expect(503);
    expect(unknown.body).toMatchObject({ result: 'ENTITLEMENT_UNKNOWN', existingAccessRetainedUntil: repository.grants.get('grant')!.expiresAt });
    expect(repository.grants.get('grant')?.state).toBe('ACTIVE');
    repository.grants.get('grant')!.expiresAt = new Date(now - 1).toISOString();
    await request(app).post('/api/me/patreon-link/recheck').expect(503);
    expect(repository.grants.get('grant')?.state).toBe('EXPIRED');
  });

  it('authorizes every assigned target server-side and keeps only configured previews public', async () => {
    const repository = new PatreonRepository(); const now = new Date();
    repository.accessGroups.set('group-1', { id: 'group-1', ownerId: 'creator', creatorId: 'creator-1', name: 'Supporters', state: 'ACTIVE', createdAt: now.toISOString(), updatedAt: now.toISOString() });
    repository.accessGroupTargets.set('group-1:asset:asset-1', { id: 'target-1', accessGroupId: 'group-1', targetType: 'asset', targetId: 'asset-1', previewsPublic: true, createdAt: now.toISOString() });
    expect(evaluatePatreonTargetAccess(repository, undefined, 'asset', 'asset-1', 'preview', now.getTime())).toEqual({ authorized: true, result: 'PUBLIC_PREVIEW' });
    expect(evaluatePatreonTargetAccess(repository, undefined, 'asset', 'asset-1', 'full', now.getTime())).toEqual({ authorized: false, result: 'AUTHENTICATION_REQUIRED' });
    expect(evaluatePatreonTargetAccess(repository, 'ever-1', 'asset', 'asset-1', 'full', now.getTime())).toEqual({ authorized: false, result: 'ENTITLEMENT_REQUIRED' });
    repository.grants.set('grant', { id: 'grant', accountId: 'ever-1', provider: 'patreon', campaignId: 'campaign-1', accessGroupId: 'group-1', state: 'ACTIVE', evidenceHash: 'hash', checkedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), mappingVersion: 1 });
    expect(evaluatePatreonTargetAccess(repository, 'ever-1', 'asset', 'asset-1', 'full', now.getTime())).toMatchObject({ authorized: true, result: 'ACTIVE' });
    expect(evaluatePatreonTargetAccess(repository, 'ever-1', 'download', 'unassigned', 'full', now.getTime())).toEqual({ authorized: false, result: 'ENTITLEMENT_REQUIRED' });
  });

  it('creates a manual Patreon companion task without claiming remote publication', async () => {
    const repository = new PatreonRepository(); const now = new Date().toISOString();
    repository.connections.set('connection-1', { id: 'connection-1', ownerId: 'creator-user', mode: 'STUDIO_MANAGED', credential: 'encrypted', scopes: [], state: 'CONNECTED', selectedCampaignIds: ['campaign-1'], capabilities: [], apiVersion: '2', webhookState: 'DISABLED', policyVersion: 'test', createdAt: now, updatedAt: now });
    repository.campaigns.set('campaign-1', { connectionId: 'connection-1', id: 'campaign-1', creatorAccountId: 'remote', name: 'Campaign', active: true, lastSync: now });
    repository.tiers.set('tier-1', { campaignId: 'campaign-1', id: 'tier-1', benefitIds: ['benefit-1'], title: 'Supporters', state: 'published', lastSync: now });
    repository.posts.set('connection-1:post-1', { id: 'reference-1', connectionId: 'connection-1', campaignId: 'campaign-1', remotePostId: 'post-1', title: 'Patreon companion', accessRuleIds: ['tier-1'], state: 'ACTIVE' });
    const store = { getWork: jest.fn().mockResolvedValue({ workId: 'work-1', creatorId: 'creator-1', title: 'New work', description: 'Copy-ready summary' }), hasCreatorAccess: jest.fn().mockResolvedValue(true), listPublicationsByWork: jest.fn().mockResolvedValue([{ destination: 'eversally', status: 'live', remoteUrl: 'https://app.test/creator/works/new-work' }]) } as unknown as DataStore;
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.authUser = { userId: 'creator-user', displayName: 'Creator', groups: ['Creators'] }; next(); }); app.use('/api', createPatreonRouter(config, repository, new PatreonProvider(), store));
    const created = await request(app).post('/api/works/work-1/patreon/companion-task').send({ campaignId: 'campaign-1', selectorIds: ['tier-1'], previewUrl: 'https://app.test/previews/work-1' }).expect(201);
    expect(created.body).toMatchObject({ state: 'OPEN', remotePublicationCreated: false, canonicalUrl: 'https://app.test/creator/works/new-work', providerCapabilities: { postWrite: false } });
    const mapped = await request(app).post(`/api/works/work-1/patreon/companion-task/${created.body.id}/map`).send({ postReferenceId: 'reference-1' }).expect(200);
    expect(mapped.body).toMatchObject({ state: 'MAPPED', remotePostReferenceId: 'reference-1', remotePublicationCreated: false }); expect(repository.posts.get('connection-1:post-1')?.workId).toBe('work-1');
  });

  it('restores isolated integration state from persistent storage', async () => {
    let persisted: PatreonRepositorySnapshot | null = null;
    const persistence = { load: jest.fn().mockImplementation(async () => persisted), save: jest.fn().mockImplementation(async snapshot => { persisted = snapshot; }) };
    const repository = new PatreonRepository(persistence); await repository.ready(); const now = new Date().toISOString();
    const encrypted = encryptExternalCredential(JSON.stringify({ accessToken: 'access-secret', refreshToken: 'refresh-secret', clientId: 'client', clientSecret: 'client-secret' }), config.externalTokenEncryptionKey!);
    repository.connections.set('connection-1', { id: 'connection-1', ownerId: 'creator', mode: 'STUDIO_MANAGED', credential: encrypted, scopes: [], state: 'CONNECTED', selectedCampaignIds: [], capabilities: [], apiVersion: '2', webhookState: 'DISABLED', policyVersion: 'test', createdAt: now, updatedAt: now });
    await repository.flush(); expect(JSON.stringify(persisted)).not.toContain('access-secret'); expect(JSON.stringify(persisted)).not.toContain('refresh-secret');
    const restored = new PatreonRepository(persistence); await restored.ready();
    expect(restored.connections.get('connection-1')).toMatchObject({ ownerId: 'creator', credential: encrypted, state: 'CONNECTED' });
  });
});
