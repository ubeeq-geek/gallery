import express from 'express';
import request from 'supertest';
import { DurableWorkflowService, InMemoryWorkflowRepository } from '../src/durableWorkflows';
import { createWorkflowRouter } from '../src/workflowRoutes';

const buildApp = (service: DurableWorkflowService) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUser = {
      userId: String(req.headers['x-user-id'] || 'operator'),
      displayName: 'Operator',
      groups: req.headers['x-admin'] === 'true' ? ['Admins'] : []
    };
    next();
  });
  app.use('/studio/operations/workflows', createWorkflowRouter(service, 'tenant-a'));
  return app;
};

describe('workflow operations API', () => {
  it('limits job listings to the mounted tenant and protects operator mutations', async () => {
    const service = new DurableWorkflowService(new InMemoryWorkflowRepository());
    const own = await service.enqueue({ tenantId: 'tenant-a', type: 'export', deduplicationKey: 'own' });
    await service.enqueue({ tenantId: 'tenant-b', type: 'export', deduplicationKey: 'other' });
    const app = buildApp(service);

    const jobs = await request(app).get('/studio/operations/workflows/jobs').set('x-admin', 'true').expect(200);
    expect(jobs.body.map((job: { jobId: string }) => job.jobId)).toEqual([own.jobId]);
    await request(app).post(`/studio/operations/workflows/jobs/${own.jobId}/cancel`).send({ reason: 'stop' }).expect(403);
    await request(app).post(`/studio/operations/workflows/jobs/${own.jobId}/cancel`).set('x-admin', 'true').send({ reason: 'stop' }).expect(200);
  });

  it('exposes neutral moderation records and enforces admission holds', async () => {
    const service = new DurableWorkflowService(new InMemoryWorkflowRepository());
    const app = buildApp(service);
    const admin = { 'x-admin': 'true' };
    const evidence = await request(app).post('/studio/operations/workflows/moderation/evidence').set(admin).send({ targetType: 'asset', targetId: 'asset-1', source: 'scanner', facts: { signal: true } }).expect(201);
    await request(app).post('/studio/operations/workflows/moderation/holds').set(admin).send({ targetType: 'asset', targetId: 'asset-1', reasonCode: 'REVIEW', admissionPoints: ['delivery'] }).expect(201);
    await request(app).post('/studio/operations/workflows/moderation/cases').set(admin).send({ targetType: 'asset', targetId: 'asset-1', evidenceIds: [evidence.body.evidenceId], priority: 10 }).expect(201);
    const queue = await request(app).get('/studio/operations/workflows/review-queue').set(admin).expect(200);
    expect(queue.body).toEqual([expect.not.objectContaining({ tenantId: expect.anything(), facts: expect.anything() })]);
    await request(app).post('/studio/operations/workflows/admission-check').send({ point: 'delivery', targetIds: ['asset-1'] }).expect(409);
  });
});
