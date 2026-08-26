import express from 'express';
import request from 'supertest';
import { createFederationAdminRouter } from '../src/federationAdminRouter';
import type { FederationAuditRole } from '../src/federationAudit';

const setup = (role?: FederationAuditRole) => {
  const service = { moderateProfile: jest.fn(() => ({ profileVisible: false })), blockSourceInstance: jest.fn(), moderatePublication: jest.fn(() => ({ localStatus: 'held' })), setLegalHold: jest.fn(() => ({ legalHold: true })) };
  const product = { operatorSnapshot: jest.fn(() => ({ projections: [], failedDeliveries: [], reconciliation: [] })), replayDelivery: jest.fn(() => ({ status: 'queued' })) };
  const audit = { list: jest.fn(async () => []), exportNdjson: jest.fn(async () => '{"id":"audit"}'), placeLegalHold: jest.fn(async () => undefined) };
  const app = express(); app.use(createFederationAdminRouter({ service: service as never, product: product as never, audit: audit as never, authorize: async () => role ? { reviewerId: 'reviewer', role } : undefined }));
  return { app, service, product, audit };
};

describe('federation operator HTTP controls', () => {
  test('requires authentication and role-specific authorization', async () => {
    await request(setup().app).get('/operator').expect(401);
    await request(setup('federation_operator').app).patch('/projections').send({ actorUri: 'https://home/actor', visible: false, reason: 'policy' }).expect(403);
    await request(setup('moderator').app).post('/instances/home/block').send({ confirmation: 'BLOCK home', reason: 'security' }).expect(403);
  });
  test('moderates projections and publications with reasons', async () => {
    const { app, service } = setup('moderator');
    await request(app).patch('/projections').send({ actorUri: 'https://home/actor', visible: false, moderationState: 'limited', reason: 'destination policy' }).expect(200);
    expect(service.moderateProfile).toHaveBeenCalledWith('https://home/actor', expect.objectContaining({ visible: false, reason: 'destination policy' }));
    await request(app).patch('/publications/publication/moderation').send({ status: 'held', reason: 'manual review' }).expect(200);
  });
  test('requires typed confirmation for destructive block, replay, and legal hold actions', async () => {
    const safety = setup('safety_investigator');
    await request(safety.app).post('/instances/home/block').send({ confirmation: 'wrong', reason: 'security' }).expect(400);
    await request(safety.app).post('/instances/home/block').send({ confirmation: 'BLOCK home', reason: 'security' }).expect(204);
    expect(safety.service.blockSourceInstance).toHaveBeenCalledWith('home', 'security');
    const operator = setup('federation_operator');
    await request(operator.app).post('/deliveries/job/replay').send({ confirmation: 'REPLAY job', reason: 'reconciled' }).expect(200);
    const legal = setup('legal_reviewer');
    await request(legal.app).post('/publications/publication/legal-hold').send({ active: true, confirmation: 'HOLD publication', reason: 'order' }).expect(200);
  });
  test('scopes audit reads to the principal and attributes legal holds', async () => {
    const { app, audit } = setup('legal_reviewer');
    await request(app).get('/audit').expect(200); expect(audit.list).toHaveBeenCalledWith('legal_reviewer', undefined, 100);
    await request(app).get('/audit/export.ndjson').expect(200).expect('Content-Type', /application\/x-ndjson/);
    await request(app).post('/audit/2026-08-26T12%3A00%3A00Z/audit/legal-hold').send({ confirmation: 'HOLD AUDIT audit', reason: 'preservation' }).expect(204);
    expect(audit.placeLegalHold).toHaveBeenCalledWith(expect.objectContaining({ reviewerId: 'reviewer', reason: 'preservation' }));
  });
});

