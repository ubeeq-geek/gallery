import { Router } from 'express';
import { requireAdmin, requireAuth } from './auth';
import { DurableWorkflowService, type AdmissionPoint, type WorkflowJobStatus, type WorkflowJobType } from './durableWorkflows';

const jobTypes = new Set<WorkflowJobType>(['upload', 'processing', 'import', 'export']);
const jobStatuses = new Set<WorkflowJobStatus>(['queued', 'leased', 'retry_wait', 'succeeded', 'cancelled', 'dead_letter']);
const admissionPoints = new Set<AdmissionPoint>(['processing', 'publishing', 'delivery', 'export']);

/** Operator and worker endpoints deliberately expose no moderation policy outcome logic. */
export const createWorkflowRouter = (service: DurableWorkflowService, tenantId: string): Router => {
  const router = Router();
  router.get('/jobs', requireAdmin, async (req, res) => {
    const status = typeof req.query.status === 'string' && jobStatuses.has(req.query.status as WorkflowJobStatus) ? req.query.status as WorkflowJobStatus : undefined;
    return res.json(await service.listJobs(status, tenantId));
  });
  router.get('/failed-jobs', requireAdmin, async (_req, res) => res.json(await service.listJobs('dead_letter', tenantId)));
  router.post('/jobs', requireAdmin, async (req, res) => {
    if (!jobTypes.has(req.body?.type) || typeof req.body?.deduplicationKey !== 'string') return res.status(400).json({ message: 'A valid job type and deduplication key are required' });
    try { return res.status(201).json(await service.enqueue({ tenantId, type: req.body.type, deduplicationKey: req.body.deduplicationKey, payload: req.body.payload && typeof req.body.payload === 'object' ? req.body.payload : {}, maxAttempts: Number(req.body.maxAttempts) || undefined }, req.authUser!.userId)); }
    catch (error) { return res.status(400).json({ message: (error as Error).message }); }
  });
  router.post('/jobs/lease', requireAdmin, async (req, res) => {
    const types = Array.isArray(req.body?.types) ? req.body.types.filter((type: unknown): type is WorkflowJobType => jobTypes.has(type as WorkflowJobType)) : undefined;
    const job = await service.lease(String(req.body?.workerId || req.authUser!.userId), Number(req.body?.leaseSeconds) || 60, types);
    return job ? res.json(job) : res.status(204).send();
  });
  router.post('/jobs/:jobId/heartbeat', requireAdmin, async (req, res) => { try { return res.json(await service.heartbeat(req.params.jobId, String(req.body?.workerId || ''), Number(req.body?.leaseSeconds) || 60)); } catch (error) { return res.status(409).json({ message: (error as Error).message }); } });
  router.post('/jobs/:jobId/succeed', requireAdmin, async (req, res) => { try { return res.json(await service.succeed(req.params.jobId, String(req.body?.workerId || ''), req.body?.details || {})); } catch (error) { return res.status(409).json({ message: (error as Error).message }); } });
  router.post('/jobs/:jobId/fail', requireAdmin, async (req, res) => { try { return res.json(await service.fail(req.params.jobId, String(req.body?.workerId || ''), { code: String(req.body?.code || 'WORK_FAILED'), message: String(req.body?.message || 'Work failed'), retryable: req.body?.retryable !== false })); } catch (error) { return res.status(409).json({ message: (error as Error).message }); } });
  router.post('/jobs/:jobId/cancel', requireAdmin, async (req, res) => { try { return res.json(await service.cancel(req.params.jobId, req.authUser!.userId, String(req.body?.reason || 'Requested by operator'))); } catch (error) { return res.status(404).json({ message: (error as Error).message }); } });
  router.post('/failed-jobs/:jobId/recover', requireAdmin, async (req, res) => { try { return res.json(await service.recover(req.params.jobId, req.authUser!.userId, String(req.body?.reason || 'Operator redrive'))); } catch (error) { return res.status(409).json({ message: (error as Error).message }); } });
  router.get('/jobs/:jobId/audit', requireAdmin, async (req, res) => res.json(await service.audit(req.params.jobId)));
  router.get('/interrupted-uploads', requireAdmin, async (_req, res) => res.json(await service.listInterruptedUploads()));
  router.post('/interrupted-uploads/:uploadId/recover', requireAdmin, async (req, res) => { try { return res.json(await service.recoverUpload(req.params.uploadId, req.authUser!.userId)); } catch (error) { return res.status(404).json({ message: (error as Error).message }); } });
  router.post('/admission-check', requireAuth, async (req, res) => {
    if (!admissionPoints.has(req.body?.point) || !Array.isArray(req.body?.targetIds)) return res.status(400).json({ message: 'A valid admission point and targets are required' });
    const decision = await service.checkAdmission(tenantId, req.body.targetIds.filter((id: unknown): id is string => typeof id === 'string'), req.body.point);
    return res.status(decision.admitted ? 200 : 409).json(decision);
  });
  router.get('/review-queue', requireAdmin, async (_req, res) => res.json(await service.reviewerQueue(tenantId)));
  router.post('/moderation/evidence', requireAdmin, async (req, res) => {
    if (typeof req.body?.targetType !== 'string' || typeof req.body?.targetId !== 'string' || typeof req.body?.source !== 'string' || !req.body?.facts || typeof req.body.facts !== 'object') return res.status(400).json({ message: 'A target, evidence source, and facts are required' });
    return res.status(201).json(await service.ingestEvidence({ tenantId, targetType: req.body.targetType, targetId: req.body.targetId, source: req.body.source, contentHash: typeof req.body.contentHash === 'string' ? req.body.contentHash : undefined, facts: req.body.facts }, req.authUser!.userId));
  });
  router.post('/moderation/holds', requireAdmin, async (req, res) => {
    const points = Array.isArray(req.body?.admissionPoints) ? req.body.admissionPoints.filter((point: unknown): point is AdmissionPoint => admissionPoints.has(point as AdmissionPoint)) : [];
    if (typeof req.body?.targetType !== 'string' || typeof req.body?.targetId !== 'string' || typeof req.body?.reasonCode !== 'string' || !points.length) return res.status(400).json({ message: 'A target, reason code, and admission points are required' });
    return res.status(201).json(await service.placeHold({ tenantId, targetType: req.body.targetType, targetId: req.body.targetId, reasonCode: req.body.reasonCode, admissionPoints: points }, req.authUser!.userId));
  });
  router.post('/moderation/cases', requireAdmin, async (req, res) => {
    if (typeof req.body?.targetType !== 'string' || typeof req.body?.targetId !== 'string' || !Array.isArray(req.body?.evidenceIds)) return res.status(400).json({ message: 'A target and evidence references are required' });
    try { return res.status(201).json(await service.openCase({ tenantId, targetType: req.body.targetType, targetId: req.body.targetId, evidenceIds: req.body.evidenceIds.filter((id: unknown): id is string => typeof id === 'string'), priority: Number(req.body.priority) || 0 }, req.authUser!.userId)); }
    catch (error) { return res.status(409).json({ message: (error as Error).message }); }
  });
  router.post('/moderation/cases/:caseId/decision', requireAdmin, async (req, res) => {
    if (!['allow', 'deny', 'escalate'].includes(req.body?.decision) || typeof req.body?.rationale !== 'string') return res.status(400).json({ message: 'A decision and rationale are required' });
    try { return res.json(await service.decideCase(req.params.caseId, req.authUser!.userId, req.body.decision, req.body.rationale)); }
    catch (error) { return res.status(409).json({ message: (error as Error).message }); }
  });
  router.post('/moderation/holds/:holdId/release', requireAdmin, async (req, res) => {
    if (typeof req.body?.rationale !== 'string' || !req.body.rationale.trim()) return res.status(400).json({ message: 'A rationale is required' });
    try { return res.json(await service.releaseHold(req.params.holdId, req.authUser!.userId, req.body.rationale)); }
    catch (error) { return res.status(404).json({ message: (error as Error).message }); }
  });
  return router;
};
