import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type WorkflowJobType = 'upload' | 'processing' | 'import' | 'export';
export type WorkflowJobStatus = 'queued' | 'leased' | 'retry_wait' | 'succeeded' | 'cancelled' | 'dead_letter';
export type AdmissionPoint = 'processing' | 'publishing' | 'delivery' | 'export';

export interface WorkflowJob {
  jobId: string; tenantId: string; type: WorkflowJobType; deduplicationKey: string;
  status: WorkflowJobStatus; payload: Record<string, unknown>; attempt: number; maxAttempts: number;
  availableAt: string; leaseOwner?: string; leaseExpiresAt?: string; cancellationRequestedAt?: string;
  lastError?: { code: string; message: string; retryable: boolean; at: string };
  createdAt: string; updatedAt: string; completedAt?: string;
}
export interface WorkflowEvent {
  eventId: string; jobId?: string; targetId?: string; type: string; actorId: string;
  details: Record<string, unknown>; occurredAt: string;
}
export interface InterruptedUpload {
  uploadId: string; tenantId: string; ownerId: string; objectKey: string; expectedBytes: number;
  receivedBytes: number; checksumSha256?: string; status: 'receiving' | 'interrupted' | 'complete' | 'abandoned';
  lastActivityAt: string; createdAt: string;
}
export interface ModerationEvidence {
  evidenceId: string; tenantId: string; targetType: string; targetId: string; source: string;
  contentHash?: string; facts: Record<string, unknown>; ingestedAt: string;
}
export interface ModerationHold {
  holdId: string; tenantId: string; targetType: string; targetId: string; admissionPoints: AdmissionPoint[];
  reasonCode: string; active: boolean; createdAt: string; releasedAt?: string;
}
export interface ModerationCase {
  caseId: string; tenantId: string; targetType: string; targetId: string; evidenceIds: string[];
  status: 'open' | 'assigned' | 'decided'; priority: number; assignedReviewerId?: string;
  decision?: 'allow' | 'deny' | 'escalate'; rationale?: string; createdAt: string; decidedAt?: string;
}
export interface AssetRevision {
  revisionId: string; tenantId: string; assetId: string; revision: number; sourceChecksumSha256: string;
  metadata: Record<string, string | number | boolean | null>; renditions: Array<{ requestId: string; kind: string; checksumSha256: string; objectKey: string }>;
  publishedAt: string;
}
export interface RenditionRequest {
  requestId: string; assetId: string; sourceChecksumSha256: string; kind: string;
  status: 'requested' | 'complete' | 'failed'; result?: { checksumSha256: string; objectKey: string }; createdAt: string; updatedAt: string;
}
export interface CollectionMembership { tenantId: string; collectionId: string; workId: string; position: number; addedAt: string; }
export interface CollectionPublication { tenantId: string; collectionId: string; destination: string; desiredRevision: number; publishedRevision?: number; status: 'pending' | 'in_sync' | 'diverged'; updatedAt: string; }

interface WorkflowState {
  jobs: WorkflowJob[]; events: WorkflowEvent[]; uploads: InterruptedUpload[]; evidence: ModerationEvidence[];
  holds: ModerationHold[]; cases: ModerationCase[]; assetRevisions: AssetRevision[];
  renditionRequests: RenditionRequest[]; memberships: CollectionMembership[]; collectionPublications: CollectionPublication[];
}
const emptyState = (): WorkflowState => ({ jobs: [], events: [], uploads: [], evidence: [], holds: [], cases: [], assetRevisions: [], renditionRequests: [], memberships: [], collectionPublications: [] });
const copy = <T>(value: T): T => structuredClone(value);

export interface WorkflowRepository { read(): Promise<WorkflowState>; update<T>(fn: (state: WorkflowState) => T | Promise<T>): Promise<T>; }

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

/**
 * Durable storage for a local installation. Mutations are protected by a
 * cross-process lock and committed with an atomic rename, so two API/worker
 * processes cannot silently overwrite one another's state.
 */
export class JsonWorkflowRepository implements WorkflowRepository {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly filename: string) {}
  async read(): Promise<WorkflowState> {
    try { return { ...emptyState(), ...JSON.parse(await readFile(this.filename, 'utf8')) } as WorkflowState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(); throw error; }
  }
  update<T>(fn: (state: WorkflowState) => T | Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => {
      const lock = `${this.filename}.lock`;
      await mkdir(dirname(this.filename), { recursive: true });
      for (let attempt = 0; ; attempt += 1) {
        try { await mkdir(lock); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const age = Date.now() - (await stat(lock)).mtimeMs;
          if (age > 30_000) { await rm(lock, { recursive: true, force: true }); continue; }
          if (attempt >= 200) throw new Error('Timed out waiting for the workflow state lock');
          await sleep(10);
        }
      }
      try {
        const state = await this.read();
        const result = await fn(state);
        const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
        await rename(temporary, this.filename);
        return copy(result);
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    });
    this.tail = operation.catch(() => undefined); return operation;
  }
}

export class InMemoryWorkflowRepository implements WorkflowRepository {
  private state = emptyState(); private tail: Promise<unknown> = Promise.resolve();
  async read() { return copy(this.state); }
  update<T>(fn: (state: WorkflowState) => T | Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => { const result = await fn(this.state); return copy(result); });
    this.tail = operation.catch(() => undefined); return operation;
  }
}

export class DurableWorkflowService {
  constructor(private readonly repository: WorkflowRepository, private readonly clock: () => Date = () => new Date()) {}
  private now() { return this.clock().toISOString(); }
  private event(state: WorkflowState, type: string, actorId: string, details: Record<string, unknown>, refs: { jobId?: string; targetId?: string } = {}) {
    state.events.push({ eventId: randomUUID(), type, actorId, details: copy(details), occurredAt: this.now(), ...refs });
  }
  async enqueue(input: { tenantId: string; type: WorkflowJobType; deduplicationKey: string; payload?: Record<string, unknown>; maxAttempts?: number }, actorId = 'system') {
    if (!input.deduplicationKey.trim()) throw new Error('A deduplication key is required');
    return this.repository.update(state => {
      const existing = state.jobs.find(job => job.tenantId === input.tenantId && job.type === input.type && job.deduplicationKey === input.deduplicationKey);
      if (existing) return existing;
      const now = this.now(); const job: WorkflowJob = { ...input, payload: copy(input.payload || {}), jobId: randomUUID(), status: 'queued', attempt: 0, maxAttempts: Math.max(1, input.maxAttempts || 5), availableAt: now, createdAt: now, updatedAt: now };
      state.jobs.push(job); this.event(state, 'job.enqueued', actorId, { type: job.type, deduplicationKey: job.deduplicationKey }, { jobId: job.jobId }); return job;
    });
  }
  async lease(workerId: string, leaseSeconds = 60, types?: WorkflowJobType[]) {
    if (!workerId.trim()) throw new Error('A worker id is required');
    return this.repository.update(state => {
      const now = this.clock(); const nowIso = now.toISOString();
      for (const job of state.jobs) if (job.status === 'leased' && job.leaseExpiresAt! <= nowIso) {
        job.status = job.cancellationRequestedAt ? 'cancelled' : 'queued'; delete job.leaseOwner; delete job.leaseExpiresAt; job.updatedAt = nowIso;
        this.event(state, 'job.lease_expired', 'system', {}, { jobId: job.jobId });
      }
      const job = state.jobs.filter(item => ['queued', 'retry_wait'].includes(item.status) && item.availableAt <= nowIso && (!types || types.includes(item.type))).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!job) return null;
      job.status = 'leased'; job.attempt += 1; job.leaseOwner = workerId; job.leaseExpiresAt = new Date(now.getTime() + Math.max(1, leaseSeconds) * 1000).toISOString(); job.updatedAt = nowIso;
      this.event(state, 'job.leased', workerId, { attempt: job.attempt, leaseExpiresAt: job.leaseExpiresAt }, { jobId: job.jobId }); return job;
    });
  }
  async heartbeat(jobId: string, workerId: string, leaseSeconds = 60) { return this.repository.update(state => { const job = this.assertLease(state, jobId, workerId); job.leaseExpiresAt = new Date(this.clock().getTime() + leaseSeconds * 1000).toISOString(); job.updatedAt = this.now(); return job; }); }
  async succeed(jobId: string, workerId: string, details: Record<string, unknown> = {}) { return this.repository.update(state => { const job = this.assertLease(state, jobId, workerId); const now = this.now(); job.status = job.cancellationRequestedAt ? 'cancelled' : 'succeeded'; job.completedAt = now; job.updatedAt = now; delete job.leaseOwner; delete job.leaseExpiresAt; this.event(state, `job.${job.status}`, workerId, details, { jobId }); return job; }); }
  async fail(jobId: string, workerId: string, error: { code: string; message: string; retryable?: boolean }, baseDelaySeconds = 30) {
    return this.repository.update(state => { const job = this.assertLease(state, jobId, workerId); const now = this.clock(); const retryable = error.retryable !== false;
      job.lastError = { ...error, retryable, at: now.toISOString() }; delete job.leaseOwner; delete job.leaseExpiresAt;
      if (job.cancellationRequestedAt) job.status = 'cancelled'; else if (!retryable || job.attempt >= job.maxAttempts) job.status = 'dead_letter'; else { job.status = 'retry_wait'; job.availableAt = new Date(now.getTime() + baseDelaySeconds * (2 ** (job.attempt - 1)) * 1000).toISOString(); }
      job.updatedAt = now.toISOString(); if (['cancelled', 'dead_letter'].includes(job.status)) job.completedAt = job.updatedAt;
      this.event(state, `job.${job.status}`, workerId, { ...job.lastError, availableAt: job.availableAt }, { jobId }); return job; });
  }
  async cancel(jobId: string, actorId: string, reason: string) { return this.repository.update(state => { const job = this.findJob(state, jobId); if (['succeeded', 'dead_letter', 'cancelled'].includes(job.status)) return job; const now = this.now(); job.cancellationRequestedAt = now; job.updatedAt = now; if (job.status !== 'leased') { job.status = 'cancelled'; job.completedAt = now; } this.event(state, 'job.cancellation_requested', actorId, { reason }, { jobId }); return job; }); }
  async recover(jobId: string, actorId: string, reason: string) { return this.repository.update(state => { const job = this.findJob(state, jobId); if (!['dead_letter', 'cancelled'].includes(job.status)) throw new Error('Only failed or cancelled jobs can be recovered'); const previousStatus = job.status; job.status = 'queued'; job.attempt = 0; job.availableAt = this.now(); job.updatedAt = job.availableAt; delete job.completedAt; delete job.cancellationRequestedAt; delete job.lastError; this.event(state, 'job.recovered', actorId, { reason, previousStatus }, { jobId }); return job; }); }
  async listJobs(status?: WorkflowJobStatus, tenantId?: string) { const state = await this.repository.read(); return copy(state.jobs.filter(job => (!status || job.status === status) && (!tenantId || job.tenantId === tenantId))); }
  async audit(jobId?: string) { const state = await this.repository.read(); return copy(state.events.filter(event => !jobId || event.jobId === jobId)); }
  private findJob(state: WorkflowState, jobId: string) { const job = state.jobs.find(item => item.jobId === jobId); if (!job) throw new Error('Job not found'); return job; }
  private assertLease(state: WorkflowState, jobId: string, workerId: string) { const job = this.findJob(state, jobId); if (job.status !== 'leased' || job.leaseOwner !== workerId || job.leaseExpiresAt! <= this.now()) throw new Error('The job lease is not owned by this worker'); return job; }

  async recordUpload(input: Omit<InterruptedUpload, 'status' | 'createdAt' | 'lastActivityAt'>) { return this.repository.update(state => { const existing = state.uploads.find(x => x.uploadId === input.uploadId); if (existing) return existing; const now = this.now(); const upload: InterruptedUpload = { ...input, status: input.receivedBytes >= input.expectedBytes ? 'complete' : 'receiving', createdAt: now, lastActivityAt: now }; state.uploads.push(upload); this.event(state, 'upload.started', input.ownerId, { expectedBytes: input.expectedBytes }, { targetId: input.uploadId }); return upload; }); }
  async updateUpload(uploadId: string, receivedBytes: number, checksumSha256?: string) { return this.repository.update(state => { const upload = state.uploads.find(x => x.uploadId === uploadId); if (!upload) throw new Error('Upload not found'); if (upload.status === 'abandoned') throw new Error('Upload was abandoned'); upload.receivedBytes = Math.max(upload.receivedBytes, Math.min(receivedBytes, upload.expectedBytes)); upload.checksumSha256 = checksumSha256 || upload.checksumSha256; upload.status = upload.receivedBytes === upload.expectedBytes ? 'complete' : 'receiving'; upload.lastActivityAt = this.now(); this.event(state, upload.status === 'complete' ? 'upload.completed' : 'upload.progressed', upload.ownerId, { receivedBytes: upload.receivedBytes }, { targetId: uploadId }); return upload; }); }
  async markInterruptedUploads(olderThan: Date) { return this.repository.update(state => { const affected = state.uploads.filter(x => x.status === 'receiving' && x.lastActivityAt < olderThan.toISOString()); for (const upload of affected) { upload.status = 'interrupted'; this.event(state, 'upload.interrupted', 'system', { receivedBytes: upload.receivedBytes }, { targetId: upload.uploadId }); } return affected; }); }
  async listInterruptedUploads() { return copy((await this.repository.read()).uploads.filter(x => x.status === 'interrupted')); }
  async recoverUpload(uploadId: string, actorId: string) { return this.repository.update(state => { const upload = state.uploads.find(x => x.uploadId === uploadId); if (!upload || upload.status !== 'interrupted') throw new Error('Interrupted upload not found'); upload.status = 'receiving'; upload.lastActivityAt = this.now(); this.event(state, 'upload.recovered', actorId, { resumeOffset: upload.receivedBytes }, { targetId: uploadId }); return upload; }); }

  async ingestEvidence(input: Omit<ModerationEvidence, 'evidenceId' | 'ingestedAt'>, actorId = 'system') { return this.repository.update(state => { const now = this.now(); const evidence: ModerationEvidence = { ...input, evidenceId: randomUUID(), ingestedAt: now }; state.evidence.push(evidence); this.event(state, 'moderation.evidence_ingested', actorId, { source: evidence.source }, { targetId: evidence.targetId }); return evidence; }); }
  async placeHold(input: Omit<ModerationHold, 'holdId' | 'active' | 'createdAt'>, actorId: string) { return this.repository.update(state => { const existing = state.holds.find(h => h.active && h.tenantId === input.tenantId && h.targetType === input.targetType && h.targetId === input.targetId && h.reasonCode === input.reasonCode); if (existing) return existing; const hold: ModerationHold = { ...input, admissionPoints: [...new Set(input.admissionPoints)], holdId: randomUUID(), active: true, createdAt: this.now() }; state.holds.push(hold); this.event(state, 'moderation.hold_placed', actorId, { reasonCode: hold.reasonCode, admissionPoints: hold.admissionPoints }, { targetId: hold.targetId }); return hold; }); }
  async checkAdmission(tenantId: string, targetIds: string[], point: AdmissionPoint) { const state = await this.repository.read(); const holds = state.holds.filter(h => h.active && h.tenantId === tenantId && targetIds.includes(h.targetId) && h.admissionPoints.includes(point)); return { admitted: holds.length === 0, point, holdIds: holds.map(h => h.holdId), reasonCodes: [...new Set(holds.map(h => h.reasonCode))] }; }
  async openCase(input: Omit<ModerationCase, 'caseId' | 'status' | 'createdAt'>, actorId: string) { return this.repository.update(state => { for (const id of input.evidenceIds) if (!state.evidence.some(e => e.evidenceId === id && e.targetId === input.targetId)) throw new Error(`Evidence ${id} does not belong to the target`); const reviewCase: ModerationCase = { ...input, evidenceIds: [...new Set(input.evidenceIds)], caseId: randomUUID(), status: 'open', createdAt: this.now() }; state.cases.push(reviewCase); this.event(state, 'moderation.case_opened', actorId, { evidenceIds: reviewCase.evidenceIds }, { targetId: reviewCase.targetId }); return reviewCase; }); }
  async reviewerQueue(tenantId: string) { const state = await this.repository.read(); return copy(state.cases.filter(c => c.tenantId === tenantId && c.status !== 'decided').sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt)).map(({ tenantId: _tenant, ...reviewCase }) => reviewCase)); }
  async decideCase(caseId: string, reviewerId: string, decision: ModerationCase['decision'], rationale: string) { if (!decision || !rationale.trim()) throw new Error('A decision and rationale are required'); return this.repository.update(state => { const reviewCase = state.cases.find(c => c.caseId === caseId); if (!reviewCase || reviewCase.status === 'decided') throw new Error('Open review case not found'); reviewCase.status = 'decided'; reviewCase.assignedReviewerId = reviewerId; reviewCase.decision = decision; reviewCase.rationale = rationale; reviewCase.decidedAt = this.now(); this.event(state, 'moderation.case_decided', reviewerId, { decision, rationale }, { targetId: reviewCase.targetId }); return reviewCase; }); }
  async releaseHold(holdId: string, actorId: string, rationale: string) { return this.repository.update(state => { const hold = state.holds.find(h => h.holdId === holdId); if (!hold || !hold.active) throw new Error('Active hold not found'); hold.active = false; hold.releasedAt = this.now(); this.event(state, 'moderation.hold_released', actorId, { rationale }, { targetId: hold.targetId }); return hold; }); }

  checksum(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
  validateSource(input: { bytes: Uint8Array; expectedChecksumSha256?: string; maxBytes?: number }) { if (!input.bytes.byteLength) throw new Error('Source is empty'); if (input.maxBytes && input.bytes.byteLength > input.maxBytes) throw new Error('Source exceeds the maximum size'); const checksumSha256 = this.checksum(input.bytes); if (input.expectedChecksumSha256 && checksumSha256 !== input.expectedChecksumSha256.toLowerCase()) throw new Error('Source checksum does not match'); return { sizeBytes: input.bytes.byteLength, checksumSha256 }; }
  async requestRendition(assetId: string, sourceChecksumSha256: string, kind: string) { return this.repository.update(state => { const existing = state.renditionRequests.find(r => r.assetId === assetId && r.sourceChecksumSha256 === sourceChecksumSha256 && r.kind === kind); if (existing) return existing; const now = this.now(); const request: RenditionRequest = { requestId: randomUUID(), assetId, sourceChecksumSha256, kind, status: 'requested', createdAt: now, updatedAt: now }; state.renditionRequests.push(request); return request; }); }
  async completeRendition(requestId: string, result: RenditionRequest['result']) { if (!result) throw new Error('A rendition result is required'); return this.repository.update(state => { const request = state.renditionRequests.find(r => r.requestId === requestId); if (!request) throw new Error('Rendition request not found'); if (request.status === 'complete') { if (JSON.stringify(request.result) !== JSON.stringify(result)) throw new Error('Rendition result is immutable'); return request; } request.status = 'complete'; request.result = copy(result); request.updatedAt = this.now(); return request; }); }
  async publishAssetRevision(input: Omit<AssetRevision, 'revisionId' | 'revision' | 'publishedAt'>) { return this.repository.update(state => { const existing = state.assetRevisions.find(r => r.tenantId === input.tenantId && r.assetId === input.assetId && r.sourceChecksumSha256 === input.sourceChecksumSha256); if (existing) return existing; const requests = input.renditions.map(r => state.renditionRequests.find(x => x.requestId === r.requestId)); if (requests.some(r => r?.status !== 'complete')) throw new Error('Every rendition must be complete before publication'); const revision: AssetRevision = { ...copy(input), revisionId: randomUUID(), revision: Math.max(0, ...state.assetRevisions.filter(r => r.tenantId === input.tenantId && r.assetId === input.assetId).map(r => r.revision)) + 1, publishedAt: this.now() }; state.assetRevisions.push(revision); this.event(state, 'asset.revision_published', 'system', { revision: revision.revision, checksumSha256: revision.sourceChecksumSha256 }, { targetId: revision.assetId }); return revision; }); }
  async setCollectionMemberships(tenantId: string, collectionId: string, works: Array<{ workId: string; position: number }>, actorId: string) { return this.repository.update(state => { const unique = new Set(works.map(w => w.workId)); if (unique.size !== works.length) throw new Error('A work can only appear once in a collection'); state.memberships = state.memberships.filter(m => !(m.tenantId === tenantId && m.collectionId === collectionId)); const now = this.now(); const memberships = works.map(w => ({ tenantId, collectionId, ...w, addedAt: now })); state.memberships.push(...memberships); this.event(state, 'collection.membership_replaced', actorId, { workIds: works.map(w => w.workId) }, { targetId: collectionId }); return memberships; }); }
  async reconcileCollectionPublication(input: Omit<CollectionPublication, 'status' | 'updatedAt'>) { return this.repository.update(state => { let publication = state.collectionPublications.find(p => p.tenantId === input.tenantId && p.collectionId === input.collectionId && p.destination === input.destination); const status = input.publishedRevision === input.desiredRevision ? 'in_sync' : input.publishedRevision === undefined ? 'pending' : 'diverged'; if (!publication) { publication = { ...input, status, updatedAt: this.now() }; state.collectionPublications.push(publication); } else Object.assign(publication, input, { status, updatedAt: this.now() }); return publication; }); }
}
