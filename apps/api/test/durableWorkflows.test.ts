import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableWorkflowService, InMemoryWorkflowRepository, JsonWorkflowRepository } from '../src/durableWorkflows';
import { ProcessingOrchestrator } from '../src/processingOrchestrator';

describe('durable workflows', () => {
  it('deduplicates, leases, retries, dead-letters, and explicitly recovers jobs with audit history', async () => {
    let now = new Date('2026-08-27T00:00:00Z');
    const service = new DurableWorkflowService(new InMemoryWorkflowRepository(), () => now);
    const first = await service.enqueue({ tenantId: 'test', type: 'import', deduplicationKey: 'remote:42', maxAttempts: 2 });
    expect(await service.enqueue({ tenantId: 'test', type: 'import', deduplicationKey: 'remote:42' })).toEqual(first);
    expect(await service.lease('worker')).toMatchObject({ jobId: first.jobId, status: 'leased', attempt: 1 });
    expect(await service.fail(first.jobId, 'worker', { code: 'TIMEOUT', message: 'timed out' }, 1)).toMatchObject({ status: 'retry_wait' });
    now = new Date('2026-08-27T00:00:02Z');
    await service.lease('worker');
    expect(await service.fail(first.jobId, 'worker', { code: 'BAD_SOURCE', message: 'invalid', retryable: false })).toMatchObject({ status: 'dead_letter' });
    expect(await service.recover(first.jobId, 'operator', 'Source repaired')).toMatchObject({ status: 'queued', attempt: 0 });
    expect((await service.audit(first.jobId)).map(event => event.type)).toEqual(expect.arrayContaining(['job.enqueued', 'job.retry_wait', 'job.dead_letter', 'job.recovered']));
  });

  it('persists interrupted upload recovery across service instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-'));
    try {
      const filename = join(directory, 'state.json');
      const first = new DurableWorkflowService(new JsonWorkflowRepository(filename));
      await first.recordUpload({ uploadId: 'upload-1', tenantId: 'test', ownerId: 'creator', objectKey: 'incoming/1', expectedBytes: 10, receivedBytes: 4 });
      await first.markInterruptedUploads(new Date(Date.now() + 1_000));
      const second = new DurableWorkflowService(new JsonWorkflowRepository(filename));
      expect(await second.listInterruptedUploads()).toEqual([expect.objectContaining({ uploadId: 'upload-1', receivedBytes: 4 })]);
      expect(await second.recoverUpload('upload-1', 'operator')).toMatchObject({ status: 'receiving', receivedBytes: 4 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps policy outside the admission mechanism and publishes asset revisions idempotently', async () => {
    const service = new DurableWorkflowService(new InMemoryWorkflowRepository());
    const evidence = await service.ingestEvidence({ tenantId: 'test', targetType: 'asset', targetId: 'asset-1', source: 'scanner', facts: { label: 'review' } });
    const hold = await service.placeHold({ tenantId: 'test', targetType: 'asset', targetId: 'asset-1', admissionPoints: ['processing', 'publishing'], reasonCode: 'REVIEW_REQUIRED' }, 'system');
    await service.openCase({ tenantId: 'test', targetType: 'asset', targetId: 'asset-1', evidenceIds: [evidence.evidenceId], priority: 5 }, 'system');
    expect(await service.checkAdmission('test', ['asset-1'], 'publishing')).toMatchObject({ admitted: false, reasonCodes: ['REVIEW_REQUIRED'] });
    expect(await service.reviewerQueue('test')).toEqual([expect.not.objectContaining({ tenantId: expect.anything() })]);
    await service.releaseHold(hold.holdId, 'reviewer', 'Evidence cleared');
    expect(await service.checkAdmission('test', ['asset-1'], 'publishing')).toMatchObject({ admitted: true });

    const checksum = service.checksum(Buffer.from('source'));
    const request = await service.requestRendition('asset-1', checksum, 'preview');
    await service.completeRendition(request.requestId, { checksumSha256: 'result', objectKey: 'preview/1' });
    const input = { tenantId: 'test', assetId: 'asset-1', sourceChecksumSha256: checksum, metadata: { width: 10 }, renditions: [{ requestId: request.requestId, kind: 'preview', checksumSha256: 'result', objectKey: 'preview/1' }] };
    const revision = await service.publishAssetRevision(input);
    expect(await service.publishAssetRevision(input)).toEqual(revision);
  });

  it('orchestrates validation, metadata, renditions, admission, and job completion', async () => {
    const service = new DurableWorkflowService(new InMemoryWorkflowRepository());
    const job = await service.enqueue({ tenantId: 'test', type: 'processing', deduplicationKey: 'asset-2:v1' });
    await service.lease('worker');
    const render = jest.fn(async (_source, kind: string) => ({ kind, bytes: Buffer.from(kind), objectKey: `renditions/${kind}` }));
    const orchestrator = new ProcessingOrchestrator(service, {
      extractMetadata: async () => ({ width: 1200, height: 800 }),
      render
    });
    const revision = await orchestrator.execute({ jobId: job.jobId, workerId: 'worker', source: { tenantId: 'test', assetId: 'asset-2', bytes: Buffer.from('source') }, renditionKinds: ['preview', 'preview', 'thumbnail'] });
    expect(revision).toMatchObject({ revision: 1, metadata: { width: 1200, height: 800 } });
    expect(render).toHaveBeenCalledTimes(2);
    expect(await service.listJobs('succeeded')).toEqual([expect.objectContaining({ jobId: job.jobId })]);
  });
});
