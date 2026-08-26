import express from 'express';
import request from 'supertest';
import { createFederationRouter } from '../src/federationRouter';
import type { FederationInstanceMetadata } from '../src/federation';

const instance: FederationInstanceMetadata = {
  metadataRevision: 1, metadataUpdatedAt: '2026-08-25T00:00:00.000Z',
  instanceId: 'eversally-production', brand: 'eversally', name: 'Eversally', origin: 'https://eversally.com',
  actorBaseUrl: 'https://eversally.com/.well-known/ubeeq/creators', policyVersion: '2026-08', status: 'trusted', keys: []
};
const envelope = (operation: string, payload: Record<string, unknown>) => ({
  version: 1, requestId: 'request', idempotencyKey: 'idem', sourceInstanceId: 'nightframe-production',
  destinationInstanceId: instance.instanceId, keyId: 'key', issuedAt: '2026-08-26T00:00:00Z', expiresAt: '2026-08-26T00:05:00Z',
  nonce: 'nonce', operation, payload, signature: 'signature'
});

const setup = (limit = 120) => {
  const service = {
    requestGrant: jest.fn((value) => ({ id: value.payload.id, status: 'pending' })),
    updateGrant: jest.fn(), revokeGrant: jest.fn(), grantStatus: jest.fn(), publishProfile: jest.fn(),
    createPublication: jest.fn(), updatePublication: jest.fn(), withdrawPublication: jest.fn(), publicationStatus: jest.fn()
  };
  service.grantStatus.mockImplementation((value) => ({ id: value.payload.grantId, status: 'active' }));
  service.publicationStatus.mockImplementation((value) => ({ id: value.payload.publicationId, localStatus: 'published' }));
  const product = { federatedCreatorPage: jest.fn(), recordHomeProfileConsent: jest.fn() };
  const receiveCallback = jest.fn(async () => undefined);
  const app = express();
  app.use('/federation', createFederationRouter({ instance, service: service as never, product: product as never, receiveCallback, resolveActor: async (actorUri) => actorUri.endsWith('/known') ? { actorUri, homeInstanceId: instance.instanceId } : undefined, maximumRequestsPerMinute: limit }));
  return { app, service, product, receiveCallback };
};

describe('signed federation HTTP contract', () => {
  test('publishes versioned discovery and actor resolution', async () => {
    const { app } = setup();
    await request(app).get('/federation/.well-known/ubeeq').expect(200).expect(({ body }) => expect(body).toMatchObject({ protocolVersions: [1], instance: { instanceId: instance.instanceId } }));
    await request(app).get('/federation/v1/actors').query({ actorUri: `${instance.actorBaseUrl}/known` }).expect(200);
    await request(app).get('/federation/v1/actors').query({ actorUri: `${instance.actorBaseUrl}/missing` }).expect(404);
  });

  test('validates exact operation, schema, content type, and path identity', async () => {
    const { app, service } = setup();
    await request(app).post('/federation/v1/grants').send(envelope('grant.request', { id: 'grant', actorUri: 'https://nightfra.me/actor', scopes: ['profile:publish'], policyVersionAccepted: '2026-08' })).expect(202);
    expect(service.requestGrant).toHaveBeenCalledTimes(1);
    await request(app).post('/federation/v1/grants').send(envelope('publication.create', { id: 'grant' })).expect(400).expect(({ body }) => expect(body.code).toBe('operation_mismatch'));
    await request(app).post('/federation/v1/grants').send(envelope('grant.request', { id: 'grant', scopes: ['profile:publish'], administrator: true })).expect(400).expect(({ body }) => expect(body.code).toBe('invalid_request'));
    await request(app).post('/federation/v1/grants').set('Content-Type', 'text/plain').send('no').expect(415);
    await request(app).post('/federation/v1/grants').send(envelope('grant.request', { id: 'large', scopes: ['profile:publish'], padding: 'x'.repeat(300 * 1024) })).expect(413);
    await request(app).put('/federation/v1/grants/path-grant').send(envelope('grant.update', { grantId: 'other', scopes: ['profile:publish'], policyVersionAccepted: '2026-08' })).expect(400).expect(({ body }) => expect(body.code).toBe('identity_mismatch'));
  });

  test('keeps grant and publication status behind signed, resource-bound requests', async () => {
    const { app, service } = setup();
    await request(app).get('/federation/v1/grants/grant').expect(404);
    await request(app).get('/federation/v1/publications/publication').expect(404);
    await request(app).post('/federation/v1/grants/grant/status').send(envelope('grant.status', { grantId: 'grant' })).expect(200).expect(({ body }) => expect(body).toMatchObject({ id: 'grant', status: 'active' }));
    await request(app).post('/federation/v1/publications/publication/status').send(envelope('publication.status', { grantId: 'grant', publicationId: 'publication' })).expect(200).expect(({ body }) => expect(body).toMatchObject({ id: 'publication' }));
    expect(service.grantStatus).toHaveBeenCalledTimes(1); expect(service.publicationStatus).toHaveBeenCalledTimes(1);
    await request(app).post('/federation/v1/publications/publication/status').send(envelope('publication.status', { grantId: 'grant', publicationId: 'other' })).expect(400).expect(({ body }) => expect(body.code).toBe('identity_mismatch'));
    await request(app).post('/federation/v1/publications/publication/status').send(envelope('publication.status', { grantId: 'grant', publicationId: 'publication', internalNotes: true })).expect(400).expect(({ body }) => expect(body.code).toBe('invalid_request'));
  });

  test('binds profile publication to a canonical immutable actor URI', async () => {
    const { app, service } = setup();
    const actorUri = 'https://nightfra.me/.well-known/ubeeq/creators/artist';
    const actorId = Buffer.from(actorUri).toString('base64url');
    await request(app).put(`/federation/v1/profiles/${actorId}`).send(envelope('profile.publish', { grantId: 'grant', actorUri, remoteCreatorId: 'remote', snapshot: {} })).expect(200);
    expect(service.publishProfile).toHaveBeenCalledTimes(1);
    await request(app).put(`/federation/v1/profiles/${actorId}`).send(envelope('profile.publish', { grantId: 'grant', actorUri: `${actorUri}-other`, remoteCreatorId: 'remote', snapshot: {} })).expect(400).expect(({ body }) => expect(body.code).toBe('identity_mismatch'));
    await request(app).put('/federation/v1/profiles/not-base64').send(envelope('profile.publish', { grantId: 'grant', actorUri, remoteCreatorId: 'remote', snapshot: {} })).expect(400).expect(({ body }) => expect(body.code).toBe('invalid_actor'));
  });

  test('returns stable authentication and rate-limit errors', async () => {
    const { app, service } = setup(1);
    service.requestGrant.mockImplementationOnce(() => { throw Object.assign(new Error('bad signature'), { code: 'invalid_signature' }); });
    // Non-Federation errors are deliberately hidden.
    await request(app).post('/federation/v1/grants').send(envelope('grant.request', { id: 'one', scopes: ['profile:publish'] })).expect(500).expect(({ body }) => expect(body.code).toBe('federation_internal_error'));
    await request(app).post('/federation/v1/grants').send(envelope('grant.request', { id: 'two', scopes: ['profile:publish'] })).expect(429).expect('Retry-After', '60').expect(({ body }) => expect(body).toMatchObject({ code: 'rate_limited', retryable: true }));
  });
  test('cannot evade admission limits by rotating an unverified source identity', async () => {
    const { app } = setup(2);
    await request(app).post('/federation/v1/grants').send({ ...envelope('grant.request', { id: 'one', scopes: ['profile:publish'] }), sourceInstanceId: 'claimed-one' }).expect(202);
    await request(app).post('/federation/v1/grants').send({ ...envelope('grant.request', { id: 'two', scopes: ['profile:publish'] }), sourceInstanceId: 'claimed-two' }).expect(202);
    await request(app).post('/federation/v1/grants').send({ ...envelope('grant.request', { id: 'three', scopes: ['profile:publish'] }), sourceInstanceId: 'claimed-three' }).expect(429);
  });
  test('accepts status callbacks only through the injected authenticated receiver', async () => {
    const { app, receiveCallback } = setup();
    await request(app).post('/federation/v1/callbacks').send(envelope('status.callback', { callbackId: 'callback' })).expect(202).expect({ accepted: true });
    expect(receiveCallback).toHaveBeenCalledTimes(1);
  });
  test('records home-link consent against the server-derived destination domain', async () => {
    const { app, product } = setup();
    await request(app).post('/federation/v1/creators/home-link-consent').send({ actorUri: 'https://nightfra.me/actors/creator' }).expect(204);
    expect(product.recordHomeProfileConsent).toHaveBeenCalledWith('https://nightfra.me/actors/creator', 'eversally.com');
  });
});
