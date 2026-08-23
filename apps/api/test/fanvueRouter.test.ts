import express from 'express';
import request from 'supertest';
import type { AppConfig } from '../src/config';
import { createFanvueRouter } from '../src/fanvueRouter';
import { InMemoryFanvueRepository } from '../src/fanvueRepository';
import { encryptExternalCredential } from '../src/externalCredentials';
import { createHash, createHmac } from 'node:crypto';

const config = {
  fanvueClientId: 'client-id', fanvueClientSecret: 'client-secret',
  fanvueOAuthRedirectUri: 'https://api.example.test/api/integrations/fanvue/oauth/callback',
  fanvueWebhookSecret: 'webhook-secret', fanvueApiBaseUrl: 'https://api.fanvue.test',
  fanvueAuthorizeUrl: 'https://auth.fanvue.test/oauth/authorize', fanvueApiVersion: '2026-08-01',
  externalTokenEncryptionKey: Buffer.alloc(32, 7).toString('base64')
} as AppConfig;

const testApp = (repository = new InMemoryFanvueRepository(), allowed = true, workContext: Parameters<typeof createFanvueRouter>[3] = async () => null, approveManaged = false, loadAsset: Parameters<typeof createFanvueRouter>[5] = async () => { throw new Error('not configured'); }) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authUser = { userId: 'user-1', displayName: 'Creator', groups: ['Creators'] }; next(); });
  app.use(createFanvueRouter(config, repository, async () => allowed, workContext, async () => approveManaged, loadAsset));
  return { app, repository };
};

describe('Fanvue API routes', () => {
  test('starts an explicit studio OAuth connection with state, nonce, and S256 PKCE', async () => {
    const { app, repository } = testApp();
    const response = await request(app).post('/api/integrations/fanvue/connections/start').send({
      ownerId: 'creator-1', ownerType: 'creator', mode: 'STUDIO_MANAGED'
    }).expect(201);
    const authorizeUrl = new URL(response.body.authorizeUrl);
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('state')).toBeTruthy();
    expect(authorizeUrl.searchParams.get('nonce')).toBeTruthy();
    expect(response.body.connection.encryptedCredentialReference).toBeUndefined();
    expect(repository.connections.size).toBe(1);
  });

  test('rejects connection creation without owner authorization', async () => {
    const { app, repository } = testApp(undefined, false);
    await request(app).post('/api/integrations/fanvue/connections/start').send({ ownerId: 'another-creator' }).expect(403);
    expect(repository.connections.size).toBe(0);
  });

  test('does not silently accept creator-owned credentials before the reviewed vault flow exists', async () => {
    const { app } = testApp();
    const response = await request(app).post('/api/integrations/fanvue/connections/start').send({
      ownerId: 'creator-1', mode: 'CREATOR_OWNED', clientSecret: 'must-not-be-stored'
    }).expect(409);
    expect(JSON.stringify(response.body)).not.toContain('must-not-be-stored');
  });

  test('disconnect purges the credential reference while preserving the connection history', async () => {
    const { app, repository } = testApp();
    const now = new Date().toISOString();
    await repository.putConnection({
      connectionId: 'connection-1', ownerId: 'creator-1', ownerType: 'creator', mode: 'STUDIO_MANAGED',
      encryptedCredentialReference: 'ciphertext', scopes: [], capabilities: [], state: 'CONNECTED', apiVersion: 'v1',
      verificationStatus: 'verified', webhookSubscriptions: ['creator.post.updated'], policyVersion: 'v1', createdAt: now, updatedAt: now
    });
    await request(app).delete('/api/integrations/fanvue/connections/connection-1').expect(204);
    expect(await repository.getConnection('connection-1')).toMatchObject({
      state: 'DISCONNECTED', webhookSubscriptions: [], encryptedCredentialReference: undefined
    });
    expect(repository.auditEvents).toHaveLength(1);
  });

  test('does not enable publishing without verification or required scope', async () => {
    const { app, repository } = testApp();
    const now = new Date().toISOString();
    await repository.putConnection({
      connectionId: 'pending-verification', ownerId: 'creator-1', ownerType: 'creator', mode: 'STUDIO_MANAGED',
      scopes: ['posts.read'], capabilities: [], state: 'CONNECTED', apiVersion: 'v1', verificationStatus: 'unknown',
      webhookSubscriptions: [], policyVersion: 'v1', createdAt: now, updatedAt: now
    });
    const missingScope = await request(app).patch('/api/integrations/fanvue/connections/pending-verification/capabilities')
      .send({ capabilities: ['publish_posts'] }).expect(409);
    expect(missingScope.body.missingScopes).toEqual(['posts.write']);
    await repository.putConnection({ ...(await repository.getConnection('pending-verification'))!, scopes: ['posts.write'] });
    const unverified = await request(app).patch('/api/integrations/fanvue/connections/pending-verification/capabilities')
      .send({ capabilities: ['publish_posts'] }).expect(409);
    expect(unverified.body.message).toMatch(/verified/);
  });

  test('imports remote posts as metadata-only external references and detects remote changes', async () => {
    const { app, repository } = testApp();
    const now = new Date().toISOString();
    await repository.putConnection({
      connectionId: 'sync-connection', ownerId: 'creator-1', ownerType: 'creator', mode: 'STUDIO_MANAGED',
      encryptedCredentialReference: encryptExternalCredential(JSON.stringify({ accessToken: 'access-token' }), config.externalTokenEncryptionKey!),
      scopes: ['posts.read'], capabilities: ['read_posts'], state: 'CONNECTED', apiVersion: 'v1', verificationStatus: 'verified',
      webhookSubscriptions: [], policyVersion: 'v1', createdAt: now, updatedAt: now
    });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200, headers: new Headers(), json: async () => ({ items: [{
        uuid: 'remote-post-1', url: 'https://fanvue.example/post/1', text: 'First caption', state: 'published',
        media: [{ uuid: 'remote-media-1', type: 'image', previewUrl: 'https://signed.example/private?token=secret' }]
      }] })
    } as Response);
    const imported = await request(app).post('/api/integrations/fanvue/connections/sync-connection/sync').expect(200);
    expect(imported.body).toEqual({ imported: 1, changed: 0, removed: 0, lastSyncAt: expect.any(String) });
    const reference = await repository.getExternalReferenceByRemotePost('sync-connection', 'remote-post-1');
    expect(reference).toMatchObject({ sourcePlatform: 'fanvue', caption: 'First caption', syncStatus: 'IN_SYNC' });
    expect(JSON.stringify(reference)).not.toContain('token=secret');

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({ items: [{
      uuid: 'remote-post-1', text: 'Changed remotely', state: 'published', media: []
    }] }) } as Response);
    const changed = await request(app).post('/api/integrations/fanvue/connections/sync-connection/sync').expect(200);
    expect(changed.body).toMatchObject({ imported: 0, changed: 1, removed: 0 });
    expect((await repository.getExternalReferenceByRemotePost('sync-connection', 'remote-post-1'))?.syncStatus).toBe('REMOTE_CHANGED');
    fetchMock.mockRestore();
  });

  test('fails eligibility closed until explicit rights attestations exist and honors safety holds', async () => {
    const now = new Date().toISOString();
    const repository = new InMemoryFanvueRepository();
    const assetBody = Buffer.from('approved-asset-body');
    const assetChecksum = createHash('sha256').update(assetBody).digest('hex');
    await repository.putConnection({
      connectionId: 'eligibility-connection', ownerId: 'creator-1', ownerType: 'creator', mode: 'STUDIO_MANAGED',
      encryptedCredentialReference: encryptExternalCredential(JSON.stringify({ accessToken: 'access-token' }), config.externalTokenEncryptionKey!),
      scopes: [], capabilities: [], state: 'CONNECTED', apiVersion: 'v1', verificationStatus: 'verified',
      webhookSubscriptions: [], policyVersion: 'v1', createdAt: now, updatedAt: now
    });
    let safetyHold = false;
    const { app } = testApp(repository, true, async () => ({
      work: { workId: 'work-1', tenantId: 'test', creatorId: 'creator-1', kind: 'image', title: 'Work', slug: 'work',
        slugHistory: [], tags: [], contentRating: 'general', aiDisclosure: 'none', heavyTopics: [], status: 'ready',
        origin: { type: 'local' }, revision: 1, createdAt: now, updatedAt: now },
      assets: [{ assetId: 'asset-1', tenantId: 'test', creatorId: 'creator-1', kind: 'image', status: 'ready',
        mimeType: 'image/jpeg', checksumSha256: assetChecksum, storage: { mode: 'hosted', objectKey: 'works/asset-1' },
        createdAt: now, updatedAt: now, attachment: { workId: 'work-1', assetId: 'asset-1', role: 'primary', position: 0 } }],
      activeSafetyHold: safetyHold
    }), true, async () => assetBody);
    const before = await request(app).get('/api/works/work-1/fanvue/eligibility?connectionId=eligibility-connection').expect(200);
    expect(before.body.eligible).toBe(false);
    expect(before.body.reasons).toContain('ELIGIBILITY_ATTESTATION_REQUIRED');

    await request(app).put('/api/works/work-1/fanvue/eligibility').send({
      rightsManifestReference: 'manifest:sha256:abc', ownershipAttested: true, everyParticipantAdultAttested: true,
      consentAttested: true, realPersonLikenessCleared: true, aiDisclosureConfirmed: true, platformPolicy: 'ELIGIBLE'
    }).expect(200);
    const eligible = await request(app).get('/api/works/work-1/fanvue/eligibility?connectionId=eligibility-connection').expect(200);
    expect(eligible.body).toMatchObject({ eligible: true, reasons: [] });
    await repository.putConnection({ ...(await repository.getConnection('eligibility-connection'))!, capabilities: ['publish_posts', 'manage_mapped_posts', 'account_health'] });
    const draft = await request(app).post('/api/works/work-1/fanvue/publications').send({
      connectionId: 'eligibility-connection', assetIds: ['asset-1'], caption: 'Exact remote caption',
      access: { type: 'subscriber' }
    }).expect(201);
    expect(draft.body).toMatchObject({
      confirmationRequired: true,
      publication: { state: 'DRAFT', workRevision: 1, media: [{ assetId: 'asset-1', state: 'NOT_UPLOADED' }] },
      preview: { caption: 'Exact remote caption', access: { type: 'subscriber' }, aiGenerated: false }
    });
    expect(repository.publications.size).toBe(1);
    const publicationId = draft.body.publication.publicationId as string;
    const remoteFetch = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({
        uploadId: 'upload-1', mediaUuid: 'media-1', partSize: assetBody.byteLength, parts: [{ partNumber: 1, url: 'https://upload.example/part-1' }]
      }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers({ etag: 'etag-1' }), json: async () => ({}) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({ mediaUuid: 'media-1', state: 'processing' }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({ mediaUuid: 'media-1', state: 'finalized' }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: async () => ({ uuid: 'post-1', url: 'https://fanvue.example/posts/1', state: 'published' }) } as Response);
    const published = await request(app).post(`/api/fanvue/publications/${publicationId}/publish`).send({
      confirmed: true, previewHash: draft.body.publication.previewHash
    }).expect(200);
    expect(published.body.publication).toMatchObject({ state: 'PUBLISHED', remotePostUuid: 'post-1',
      media: [{ remoteMediaUuid: 'media-1', state: 'FINALIZED' }] });
    expect(remoteFetch).toHaveBeenCalledTimes(5);
    remoteFetch.mockRestore();
    const originalKey = (await repository.getPublication(publicationId))!.idempotencyKeys[0];
    const updateDraft = await request(app).patch(`/api/fanvue/publications/${publicationId}`).send({ caption: 'Explicitly updated caption' }).expect(200);
    expect(updateDraft.body).toMatchObject({ confirmationRequired: true, publication: { state: 'DRAFT', remotePostUuid: 'post-1' },
      remoteChanges: { caption: true, access: false, schedule: false, collection: false } });
    const updateFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(),
      json: async () => ({ uuid: 'post-1', url: 'https://fanvue.example/posts/1', state: 'published' }) } as Response);
    await request(app).post(`/api/fanvue/publications/${publicationId}/publish`).send({
      confirmed: true, previewHash: updateDraft.body.publication.previewHash
    }).expect(200);
    expect(updateFetch).toHaveBeenCalledWith('https://api.fanvue.test/posts/post-1', expect.objectContaining({ method: 'PATCH' }));
    const updatedPublication = (await repository.getPublication(publicationId))!;
    expect(updatedPublication.idempotencyKeys).toHaveLength(2);
    expect(updatedPublication.idempotencyKeys[1]).not.toBe(originalKey);
    updateFetch.mockRestore();
    const unpublishFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(),
      json: async () => ({ uuid: 'post-1', state: 'unpublished' }) } as Response);
    const unpublished = await request(app).post(`/api/fanvue/publications/${publicationId}/unpublish`).send({
      confirmed: true, remotePostUuid: 'post-1'
    }).expect(200);
    expect(unpublished.body).toMatchObject({ remoteMutation: true, publication: { state: 'REMOVED', remotePostUuid: 'post-1' } });
    expect(unpublishFetch).toHaveBeenCalledWith('https://api.fanvue.test/posts/post-1/unpublish', expect.objectContaining({ method: 'POST' }));
    unpublishFetch.mockRestore();
    const deleteFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers(), json: async () => ({}) } as Response);
    const deleted = await request(app).delete(`/api/fanvue/publications/${publicationId}`).send({
      confirmed: true, remotePostUuid: 'post-1'
    }).expect(200);
    expect(deleted.body).toMatchObject({ remoteMutation: true, publication: { state: 'REMOVED', deletedAt: expect.any(String) } });
    expect(deleteFetch).toHaveBeenCalledWith('https://api.fanvue.test/posts/post-1', expect.objectContaining({ method: 'DELETE' }));
    deleteFetch.mockRestore();
    const healthFetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(),
      json: async () => ({ status: 'attention', moderationFlagCount: 2, postingRestricted: false, summaryCode: 'MEDIA_REVIEW' }) } as Response);
    const health = await request(app).post('/api/integrations/fanvue/connections/eligibility-connection/account-health').expect(200);
    expect(health.body.accountHealth).toMatchObject({ status: 'attention', moderationFlagCount: 2, postingRestricted: false, summaryCode: 'MEDIA_REVIEW' });
    expect(health.body.connection.encryptedCredentialReference).toBeUndefined();
    healthFetch.mockRestore();
    const connections = await request(app).get('/api/integrations/fanvue/connections?ownerId=creator-1').expect(200);
    expect(connections.body.items).toHaveLength(1);
    expect(JSON.stringify(connections.body)).not.toContain('access-token');
    const publications = await request(app).get('/api/fanvue/publications?connectionId=eligibility-connection').expect(200);
    expect(publications.body.items).toHaveLength(1);
    safetyHold = true;
    const held = await request(app).get('/api/works/work-1/fanvue/eligibility?connectionId=eligibility-connection').expect(200);
    expect(held.body).toMatchObject({ eligible: false });
    expect(held.body.reasons).toContain('ACTIVE_SAFETY_HOLD');
    const blockedDraft = await request(app).post('/api/works/work-1/fanvue/publications').send({
      connectionId: 'eligibility-connection', assetIds: ['asset-1'], caption: 'Must not publish', access: { type: 'free' }
    }).expect(422);
    expect(blockedDraft.body.reasons).toContain('ACTIVE_SAFETY_HOLD');
    expect(repository.publications.size).toBe(1);
    await repository.putConnection({ ...(await repository.getConnection('eligibility-connection'))!, fanvueUserUuid: 'fanvue-user-1' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const webhookBody = JSON.stringify({ eventId: 'event-1', eventType: 'creator.post.updated',
      occurredAt: new Date().toISOString(), connectionId: 'eligibility-connection',
      payload: { accountUuid: 'fanvue-user-1', postUuid: 'post-1', privateMessage: 'must-not-persist' } });
    const signature = createHmac('sha256', config.fanvueWebhookSecret!).update(`${timestamp}.`).update(webhookBody).digest('hex');
    await request(app).post('/webhooks/fanvue').set('content-type', 'application/json').set('fanvue-timestamp', timestamp)
      .set('fanvue-signature', signature).send(webhookBody).expect(202);
    expect((await repository.getPublication(publicationId))?.state).toBe('REMOTE_CHANGED');
    expect(repository.webhookEvents.get('event-1')).toMatchObject({ outcome: 'PROCESSED', subjectIds: { postUuid: 'post-1', accountUuid: 'fanvue-user-1' } });
    expect(JSON.stringify(repository.webhookEvents.get('event-1'))).not.toContain('must-not-persist');
    await request(app).post('/webhooks/fanvue').set('content-type', 'application/json').set('fanvue-timestamp', timestamp)
      .set('fanvue-signature', signature).send(webhookBody).expect(202);
    expect(repository.webhookEvents.size).toBe(1);
  });
});
