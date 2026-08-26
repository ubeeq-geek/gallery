import express from 'express';
import request from 'supertest';
import { createFederationHomeRouter, type HomeFederationCoordinator } from '../src/federationHomeRouter';

const coordinator = (): jest.Mocked<HomeFederationCoordinator> => {
  const service: HomeFederationCoordinator = {
    async dashboard(_creatorId) { return { actorUri: 'https://nightfra.me/.well-known/ubeeq/creators/01K', destinations: [{ instanceId: 'eversally', name: 'Eversally', policyVersion: 'phase-1', status: 'active', scopes: ['publication:create'] }], works: [{ sourceWorkUri: 'https://nightfra.me/works/1', destinations: [] }] }; },
    async workTitles(_creatorId, _uris) { return { 'https://nightfra.me/works/1': 'Pinned title' }; },
    async connect(_creatorId, _input) {}, async updateProfile(_creatorId, _destination, _input) {}, async publish(_creatorId, _input) {}, async withdraw(_creatorId, _publication) {}, async revoke(_creatorId, _destination) {}
  };
  for (const key of Object.keys(service) as Array<keyof HomeFederationCoordinator>) jest.spyOn(service, key);
  return service as jest.Mocked<HomeFederationCoordinator>;
};
const app = (service: HomeFederationCoordinator, authenticated = true, authorized = true) => {
  const instance = express();
  if (authenticated) instance.use((req, _res, next) => { req.authUser = { userId: 'user-1', displayName: 'Creator', groups: ['creator'] }; next(); });
  instance.use('/studio/federation', createFederationHomeRouter({ coordinator: service, authorizeCreator: async () => authorized }));
  return instance;
};

describe('creator federation HTTP controls', () => {
  it('requires authentication and creator ownership', async () => {
    const service = coordinator();
    await request(app(service, false)).get('/studio/federation/creator-1').expect(401);
    await request(app(service, true, false)).get('/studio/federation/creator-1').expect(403);
    expect(service.dashboard).not.toHaveBeenCalled();
  });

  it('returns a dashboard enriched only with owned canonical Work titles', async () => {
    const service = coordinator();
    const response = await request(app(service)).get('/studio/federation/creator-1').expect(200);
    expect(response.body.actorUri).toContain('nightfra.me');
    expect(response.body.works[0].title).toBe('Pinned title');
    expect(service.workTitles).toHaveBeenCalledWith('creator-1', ['https://nightfra.me/works/1']);
  });

  it('validates consent scopes and delegates creator actions', async () => {
    const service = coordinator();
    await request(app(service)).post('/studio/federation/creator-1/destinations').send({ destinationInstanceId: 'eversally', scopes: ['publication:create'], policyVersion: 'phase-1' }).expect(202);
    await request(app(service)).post('/studio/federation/creator-1/destinations').send({ destinationInstanceId: 'eversally', scopes: ['admin'], policyVersion: 'phase-1' }).expect(400);
    await request(app(service)).post('/studio/federation/creator-1/destinations').send({ destinationInstanceId: 'eversally', scopes: ['publication:create', 'publication:create'], policyVersion: 'phase-1' }).expect(400);
    await request(app(service)).post('/studio/federation/creator-1/destinations').send({ destinationInstanceId: 'eversally', scopes: ['publication:create'], policyVersion: 'phase-1', expiresAt: 'yesterday' }).expect(400);
    await request(app(service)).post('/studio/federation/creator-1/publications').send({ sourceWorkUri: 'https://nightfra.me/works/1', destinationInstanceId: 'eversally' }).expect(202);
    await request(app(service)).post('/studio/federation/creator-1/publications/publication-1/withdraw').send({}).expect(202);
    await request(app(service)).post('/studio/federation/creator-1/destinations/eversally/revoke').send({}).expect(202);
    expect(service.connect).toHaveBeenCalledTimes(1);
    expect(service.publish).toHaveBeenCalledWith('creator-1', { sourceWorkUri: 'https://nightfra.me/works/1', destinationInstanceId: 'eversally' });
    expect(service.withdraw).toHaveBeenCalledWith('creator-1', 'publication-1');
    expect(service.revoke).toHaveBeenCalledWith('creator-1', 'eversally');
  });
});
