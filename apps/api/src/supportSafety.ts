import { createHash, randomUUID } from 'node:crypto';
import { InMemorySupportSafetyRepository, type SupportSafetyRepository } from './supportSafetyRepository';

export const SUPPORT_PUBLIC_IDENTITY = 'Ubeeq/ES Support Team';

export type ActorType = 'system' | 'llm' | 'human';
export type SupportTicketStatus = 'NEW' | 'AUTOMATED_HANDLING' | 'WAITING_FOR_USER' | 'HUMAN_ESCALATION' | 'SOLVED' | 'CLOSED';
export type MessageVisibility = 'PUBLIC_TO_REQUESTER' | 'VISIBLE_TO_AUTHORIZED_SPACE_ADMINS' | 'INTERNAL_SUPPORT_ONLY' | 'RESTRICTED_SAFETY_ONLY';
export type FlagStatus = 'RECEIVED' | 'AUTOMATION_REVIEW' | 'HOLD_APPLIED' | 'NO_HOLD_HUMAN_REVIEW' | 'HUMAN_REVIEW' | 'RESOLVED' | 'ESCALATED_EXTERNALLY';
export type HoldType = 'CONTENT_REVIEW_HOLD' | 'CREATOR_REVIEW_HOLD' | 'ACCOUNT_REVIEW_HOLD' | 'COMMENT_REVIEW_HOLD' | 'CSAM_SAFETY_LOCK' | 'NCII_SAFETY_LOCK' | 'LEGAL_ORDER_HOLD' | 'EVERSALLY_POLICY_OFFBOARDING';
export type TargetType = 'work' | 'asset' | 'comment' | 'creator' | 'user' | 'account' | 'external_link';
export type ScanDisposition = 'automated_no_match' | 'automated_signal' | 'human_cleared' | 'human_confirmed' | 'scan_unavailable' | 'error';
export type MediaScanState = 'QUARANTINED' | 'SCANNING' | 'CLEARED_FOR_POLICY_REVIEW' | 'HELD' | 'HUMAN_REVIEW_REQUIRED' | 'SCAN_UNAVAILABLE';
export type ScanType = 'hash' | 'image_moderation' | 'video_moderation' | 'face_age_signal' | 'text_safety';

export interface ActionAuthorship {
  authoredBy: ActorType;
  internalActorId?: string;
  modelName?: string;
  modelVersion?: string;
  actionPolicyVersion?: string;
}

export interface SupportTicket {
  ticketId: string;
  ticketNumber: string;
  requesterUserId: string;
  creatorId?: string;
  spaceId?: string;
  subject: string;
  body: string;
  category: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: SupportTicketStatus;
  references: Array<{ type: string; id: string }>;
  diagnostics: Record<string, string>;
  assignedReviewerId?: string;
  createdAt: string;
  updatedAt: string;
  solvedAt?: string;
  closedAt?: string;
}

export interface SupportMessage extends ActionAuthorship {
  messageId: string;
  ticketId: string;
  body: string;
  visibility: MessageVisibility;
  publicAuthorName: typeof SUPPORT_PUBLIC_IDENTITY;
  createdAt: string;
}

export interface SupportAttachment {
  attachmentId: string;
  ticketId: string;
  uploadedByUserId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  quarantineKey: string;
  status: 'QUARANTINED' | 'SCANNING' | 'AVAILABLE' | 'RESTRICTED_SAFETY' | 'REJECTED' | 'DELETED';
  malwareScan: 'pending' | 'clean' | 'detected' | 'unavailable';
  safetyScan: 'pending' | 'no_signal' | 'restricted_signal' | 'unavailable';
  retentionUntil: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupportNotification {
  notificationId: string;
  userId: string;
  ticketId: string;
  type: 'TICKET_RECEIVED' | 'SUPPORT_REPLY' | 'STATUS_CHANGED';
  title: string;
  body: string;
  readAt?: string;
  createdAt: string;
}

export interface ContentFlag {
  flagId: string;
  reporterUserId?: string;
  targetType: TargetType;
  targetId: string;
  category: string;
  report: string;
  status: FlagStatus;
  linkedTicketId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationReviewTask {
  taskId: string;
  flagId: string;
  status: 'PENDING' | 'COMPLETED';
  labels: Array<{ label: string; confidence: number }>;
  uncertainty?: string;
  recommendation?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ReviewHold {
  holdId: string;
  type: HoldType;
  targetType: TargetType;
  targetId: string;
  active: boolean;
  reason: string;
  sourceId: string;
  createdAt: string;
  releasedAt?: string;
}

export interface HumanReviewCase {
  caseId: string;
  caseType: 'FLAG_REVIEW' | 'RESTRICTED_SAFETY' | 'APPEAL';
  sourceId: string;
  targetType: TargetType;
  targetId: string;
  holdId?: string;
  status: 'OPEN' | 'ASSIGNED' | 'DECIDED';
  assignedReviewerId?: string;
  restrictedSafety: boolean;
  deadline: string;
  decision?: 'CLEARED' | 'CONFIRMED' | 'ESCALATED';
  decidedAt?: string;
  escalationDestination?: string;
  evidenceReferences: string[];
  rationale?: string;
  createdAt: string;
}

export interface ScanResult {
  scanResultId: string;
  targetId: string;
  provider: string;
  modelName: string;
  modelVersion: string;
  scanJobId?: string;
  scanType: ScanType;
  contentHash?: string;
  labels: Array<{ label: string; confidence: number; timestampMs?: number }>;
  disposition: ScanDisposition;
  suitableForAutomatedAction: boolean;
  createdAt: string;
}

export interface ScanJob {
  scanJobId: string;
  targetType: 'work' | 'asset' | 'support_attachment';
  targetId: string;
  contentVersion: string;
  contentHash?: string;
  sourceBytesAvailable: boolean;
  requestedScanTypes: ScanType[];
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  mediaState: MediaScanState;
  attemptCount: number;
  provider?: string;
  errorCode?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface BillingTask {
  billingTaskId: string;
  requesterUserId: string;
  accountId: string;
  changeType: 'REFUND' | 'CREDIT' | 'MANUAL_CHARGE' | 'VOID_INVOICE' | 'WRITE_OFF' | 'PLAN_OVERRIDE';
  reasonCode: 'DUPLICATE_CHARGE' | 'SERVICE_FAILURE' | 'GOODWILL' | 'FRAUD' | 'UNCOLLECTIBLE' | 'CONTRACT_CORRECTION' | 'OTHER';
  expectedState: string;
  currentAmountMinor: number;
  requestedAmountMinor: number;
  currency: 'USD' | 'EUR' | 'GBP';
  notes: string;
  evidenceReferences: string[];
  idempotencyKey: string;
  linkedTicketId: string;
  status: 'AWAITING_HUMAN' | 'EXECUTED' | 'REJECTED' | 'MORE_INFORMATION' | 'FAILED';
  approvedBy?: string;
  decisionReason?: string;
  providerOperationId?: string;
  resultingAmountMinor?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SafetyAuditEvent extends ActionAuthorship {
  eventId: string;
  action: string;
  sourceId?: string;
  targetType?: TargetType;
  targetId?: string;
  previousStatus?: string;
  newStatus?: string;
  reason?: string;
  confidence?: number;
  createdAt: string;
}

const safeDiagnosticKeys = new Set(['route', 'resource', 'applicationVersion', 'browser', 'operatingSystem', 'integrationType', 'integrationStatus', 'requestId', 'publicationId', 'errorCode']);
const safetyLocks = new Set<HoldType>(['CSAM_SAFETY_LOCK', 'NCII_SAFETY_LOCK']);

export class SupportSafetyService {
  constructor(private readonly repository: SupportSafetyRepository = new InMemorySupportSafetyRepository()) {}
  private now(): string { return new Date().toISOString(); }
  private async audit(event: Omit<SafetyAuditEvent, 'eventId' | 'createdAt'>): Promise<void> {
    const record = { eventId: randomUUID(), createdAt: this.now(), ...event };
    await this.repository.put('auditEvent', record.eventId, record);
  }
  listTickets(): Promise<SupportTicket[]> { return this.repository.list('ticket'); }
  listBillingTasks(): Promise<BillingTask[]> { return this.repository.list('billingTask'); }
  listMessages(): Promise<SupportMessage[]> { return this.repository.list('message'); }
  listAttachments(): Promise<SupportAttachment[]> { return this.repository.list('attachment'); }
  listNotifications(): Promise<SupportNotification[]> { return this.repository.list('notification'); }
  listReviewCases(): Promise<HumanReviewCase[]> { return this.repository.list('reviewCase'); }
  getHold(holdId: string): Promise<ReviewHold | null> { return this.repository.get('hold', holdId); }
  listScanJobs(): Promise<ScanJob[]> { return this.repository.list('scanJob'); }
  listAuditEvents(): Promise<SafetyAuditEvent[]> { return this.repository.list('auditEvent'); }

  async createTicket(input: Omit<SupportTicket, 'ticketId' | 'ticketNumber' | 'status' | 'diagnostics' | 'references' | 'createdAt' | 'updatedAt'> & { diagnostics?: Record<string, unknown>; references?: Array<{ type: string; id: string }> }): Promise<SupportTicket> {
    const now = this.now();
    const diagnostics = Object.fromEntries(Object.entries(input.diagnostics || {}).filter(([key, value]) => safeDiagnosticKeys.has(key) && typeof value === 'string').map(([key, value]) => [key, String(value).slice(0, 500)]));
    const sequence = await this.repository.nextTicketNumber();
    const ticket: SupportTicket = { ...input, ticketId: randomUUID(), ticketNumber: `EVR-${sequence}`, status: 'NEW', diagnostics, references: input.references || [], createdAt: now, updatedAt: now };
    await this.repository.put('ticket', ticket.ticketId, ticket);
    await this.addMessage(ticket.ticketId, 'We received your request and will help you here.', 'PUBLIC_TO_REQUESTER', { authoredBy: 'system', actionPolicyVersion: 'support-v1' });
    await this.createNotification(ticket.requesterUserId, ticket.ticketId, 'TICKET_RECEIVED', `Request ${ticket.ticketNumber} received`, 'Your request is in the Support Team queue.');
    await this.audit({ action: 'support_ticket.created', sourceId: ticket.ticketId, newStatus: ticket.status, authoredBy: 'system' });
    return ticket;
  }
  async addMessage(ticketId: string, body: string, visibility: MessageVisibility, authorship: ActionAuthorship): Promise<SupportMessage> {
    const ticket = await this.repository.get('ticket', ticketId);
    if (!ticket) throw new Error('Ticket not found');
    const message: SupportMessage = { messageId: randomUUID(), ticketId, body, visibility, publicAuthorName: SUPPORT_PUBLIC_IDENTITY, createdAt: this.now(), ...authorship };
    await this.repository.put('message', message.messageId, message);
    await this.audit({ action: 'support_message.created', sourceId: ticketId, ...authorship });
    if (visibility === 'PUBLIC_TO_REQUESTER' && authorship.internalActorId !== ticket.requesterUserId && authorship.authoredBy !== 'system') {
      await this.createNotification(ticket.requesterUserId, ticket.ticketId, 'SUPPORT_REPLY', `New reply on ${ticket.ticketNumber}`, 'The Ubeeq/ES Support Team replied to your request.');
    }
    return message;
  }
  private async createNotification(userId: string, ticketId: string, type: SupportNotification['type'], title: string, body: string): Promise<SupportNotification> {
    const notification: SupportNotification = { notificationId: randomUUID(), userId, ticketId, type, title, body, createdAt: this.now() };
    await this.repository.put('notification', notification.notificationId, notification);
    return notification;
  }
  async markNotificationRead(notificationId: string, userId: string): Promise<SupportNotification> {
    const notification = await this.repository.get('notification', notificationId);
    if (!notification || notification.userId !== userId) throw new Error('Notification not found');
    notification.readAt ||= this.now();
    await this.repository.put('notification', notification.notificationId, notification);
    return notification;
  }
  async createAttachment(input: { ticketId: string; uploadedByUserId: string; filename: string; mimeType: string; sizeBytes: number }): Promise<SupportAttachment> {
    if (!await this.repository.get('ticket', input.ticketId)) throw new Error('Ticket not found');
    if (!new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain', 'video/mp4']).has(input.mimeType)) throw new Error('Attachment type is not allowed');
    if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > 25 * 1024 * 1024) throw new Error('Attachment must be between 1 byte and 25 MB');
    const now = this.now(); const attachmentId = randomUUID();
    const filename = input.filename.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 180) || 'attachment';
    const attachment: SupportAttachment = { ...input, attachmentId, filename, quarantineKey: `support-quarantine/${input.ticketId}/${attachmentId}`, status: 'QUARANTINED', malwareScan: 'pending', safetyScan: 'pending', retentionUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(), createdAt: now, updatedAt: now };
    await this.repository.put('attachment', attachment.attachmentId, attachment);
    await this.audit({ action: 'support_attachment.quarantined', sourceId: attachment.attachmentId, newStatus: attachment.status, authoredBy: 'human', internalActorId: input.uploadedByUserId });
    return attachment;
  }
  async recordAttachmentScan(attachmentId: string, result: { malwareScan: SupportAttachment['malwareScan']; safetyScan: SupportAttachment['safetyScan'] }): Promise<SupportAttachment> {
    const attachment = await this.repository.get('attachment', attachmentId);
    if (!attachment || !['QUARANTINED', 'SCANNING'].includes(attachment.status)) throw new Error('Quarantined attachment not found');
    const previousStatus = attachment.status;
    attachment.malwareScan = result.malwareScan; attachment.safetyScan = result.safetyScan;
    attachment.status = result.malwareScan === 'detected' ? 'REJECTED' : result.safetyScan === 'restricted_signal' ? 'RESTRICTED_SAFETY' : result.malwareScan === 'clean' && result.safetyScan === 'no_signal' ? 'AVAILABLE' : 'SCANNING';
    attachment.updatedAt = this.now();
    await this.repository.put('attachment', attachment.attachmentId, attachment);
    await this.audit({ action: 'support_attachment.scanned', sourceId: attachment.attachmentId, previousStatus, newStatus: attachment.status, authoredBy: 'system' });
    return attachment;
  }
  async createFlag(input: Omit<ContentFlag, 'flagId' | 'status' | 'createdAt' | 'updatedAt'>): Promise<{ flag: ContentFlag; automationTask: AutomationReviewTask }> {
    const now = this.now();
    const flag: ContentFlag = { ...input, flagId: randomUUID(), status: 'AUTOMATION_REVIEW', createdAt: now, updatedAt: now };
    const automationTask: AutomationReviewTask = { taskId: randomUUID(), flagId: flag.flagId, status: 'PENDING', labels: [], createdAt: now };
    await Promise.all([this.repository.put('flag', flag.flagId, flag), this.repository.put('automationTask', automationTask.taskId, automationTask)]);
    await this.audit({ action: 'flag.created', sourceId: flag.flagId, targetType: flag.targetType, targetId: flag.targetId, newStatus: flag.status, authoredBy: 'system' });
    return { flag, automationTask };
  }
  async completeAutomationReview(flagId: string, result: { labels: Array<{ label: string; confidence: number }>; uncertainty?: string; recommendation?: string; holdType?: HoldType; reason: string; modelName: string; modelVersion: string; policyVersion: string }): Promise<{ flag: ContentFlag; hold?: ReviewHold; reviewCase: HumanReviewCase }> {
    const flag = await this.repository.get('flag', flagId);
    const task = (await this.repository.list('automationTask')).find((item) => item.flagId === flagId);
    if (!flag || !task) throw new Error('Flag not found');
    Object.assign(task, { labels: result.labels, uncertainty: result.uncertainty, recommendation: result.recommendation, status: 'COMPLETED', completedAt: this.now() });
    let hold: ReviewHold | undefined;
    if (result.holdType) { hold = await this.applyHold({ type: result.holdType, targetType: flag.targetType, targetId: flag.targetId, reason: result.reason, sourceId: flag.flagId }, { authoredBy: 'llm', modelName: result.modelName, modelVersion: result.modelVersion, actionPolicyVersion: result.policyVersion }); flag.status = 'HOLD_APPLIED'; }
    else flag.status = 'NO_HOLD_HUMAN_REVIEW';
    flag.updatedAt = this.now();
    const restrictedSafety = Boolean(hold && safetyLocks.has(hold.type));
    const reviewCase: HumanReviewCase = { caseId: randomUUID(), caseType: restrictedSafety ? 'RESTRICTED_SAFETY' : 'FLAG_REVIEW', sourceId: flag.flagId, targetType: flag.targetType, targetId: flag.targetId, holdId: hold?.holdId, status: 'OPEN', restrictedSafety, deadline: new Date(Date.now() + (restrictedSafety ? 4 : 48) * 3600_000).toISOString(), evidenceReferences: [], createdAt: this.now() };
    await Promise.all([this.repository.put('automationTask', task.taskId, task), this.repository.put('flag', flag.flagId, flag), this.repository.put('reviewCase', reviewCase.caseId, reviewCase)]);
    await this.audit({ action: 'automation_review.completed', sourceId: flag.flagId, targetType: flag.targetType, targetId: flag.targetId, previousStatus: 'AUTOMATION_REVIEW', newStatus: flag.status, reason: result.reason, authoredBy: 'llm', modelName: result.modelName, modelVersion: result.modelVersion, actionPolicyVersion: result.policyVersion });
    return { flag, hold, reviewCase };
  }
  async applyHold(input: Omit<ReviewHold, 'holdId' | 'active' | 'createdAt'>, actor: ActionAuthorship): Promise<ReviewHold> {
    const hold: ReviewHold = { ...input, holdId: randomUUID(), active: true, createdAt: this.now() };
    await this.repository.put('hold', hold.holdId, hold);
    await this.audit({ action: 'review_hold.applied', sourceId: input.sourceId, targetType: input.targetType, targetId: input.targetId, newStatus: input.type, reason: input.reason, ...actor });
    return hold;
  }
  async releaseHold(holdId: string, reason: string, humanActorId: string, safetyQualified = false): Promise<ReviewHold> {
    const hold = await this.repository.get('hold', holdId);
    if (!hold || !hold.active) throw new Error('Active hold not found');
    if (safetyLocks.has(hold.type) && !safetyQualified) throw new Error('A qualified safety reviewer is required');
    hold.active = false; hold.releasedAt = this.now();
    await this.repository.put('hold', hold.holdId, hold);
    await this.audit({ action: 'review_hold.released', sourceId: hold.sourceId, targetType: hold.targetType, targetId: hold.targetId, previousStatus: hold.type, newStatus: 'RELEASED', reason, authoredBy: 'human', internalActorId: humanActorId });
    return hold;
  }
  async assignReviewCase(caseId: string, reviewerId: string): Promise<HumanReviewCase> {
    const reviewCase = await this.repository.get('reviewCase', caseId);
    if (!reviewCase || reviewCase.status === 'DECIDED') throw new Error('Open review case not found');
    const previousStatus = reviewCase.status;
    Object.assign(reviewCase, { status: 'ASSIGNED', assignedReviewerId: reviewerId });
    await this.repository.put('reviewCase', reviewCase.caseId, reviewCase);
    await this.audit({ action: 'human_review.assigned', sourceId: reviewCase.caseId, targetType: reviewCase.targetType, targetId: reviewCase.targetId, previousStatus, newStatus: reviewCase.status, authoredBy: 'human', internalActorId: reviewerId });
    return reviewCase;
  }
  async decideReviewCase(caseId: string, input: { decision: NonNullable<HumanReviewCase['decision']>; rationale: string; escalationDestination?: string }, reviewerId: string, safetyQualified = false): Promise<HumanReviewCase> {
    const reviewCase = await this.repository.get('reviewCase', caseId);
    if (!reviewCase || reviewCase.status === 'DECIDED') throw new Error('Open review case not found');
    if (reviewCase.restrictedSafety && !safetyQualified) throw new Error('A qualified safety reviewer is required');
    if (!input.rationale.trim()) throw new Error('A review rationale is required');
    if (input.decision === 'ESCALATED' && !input.escalationDestination?.trim()) throw new Error('An escalation destination is required');
    const previousStatus = reviewCase.status; const now = this.now();
    Object.assign(reviewCase, { status: 'DECIDED', assignedReviewerId: reviewerId, decision: input.decision, rationale: input.rationale.trim(), escalationDestination: input.escalationDestination?.trim(), decidedAt: now });
    await this.repository.put('reviewCase', reviewCase.caseId, reviewCase);
    if (input.decision === 'CLEARED' && reviewCase.holdId) await this.releaseHold(reviewCase.holdId, input.rationale, reviewerId, safetyQualified);
    await this.audit({ action: 'human_review.decided', sourceId: reviewCase.caseId, targetType: reviewCase.targetType, targetId: reviewCase.targetId, previousStatus, newStatus: input.decision, reason: input.rationale, authoredBy: 'human', internalActorId: reviewerId });
    return reviewCase;
  }
  async accessPolicy(targets: Array<{ type: TargetType; id: string }>): Promise<{ public: boolean; privateLink: boolean; api: boolean; download: boolean; creatorView: boolean; export: boolean; activeHolds: HoldType[] }> {
    const active = (await this.repository.list('hold')).filter((hold) => hold.active && targets.some((target) => target.type === hold.targetType && target.id === hold.targetId));
    if (!active.length) return { public: true, privateLink: true, api: true, download: true, creatorView: true, export: true, activeHolds: [] };
    const types = active.map((hold) => hold.type); const locked = types.some((type) => safetyLocks.has(type));
    return { public: false, privateLink: false, api: false, download: false, creatorView: !locked, export: !locked, activeHolds: types };
  }
  async recordScan(input: Omit<ScanResult, 'scanResultId' | 'createdAt'>): Promise<ScanResult> {
    if (input.disposition === 'human_cleared' && input.provider === 'none') throw new Error('An unavailable scanner cannot produce a human clearance');
    const result = { ...input, scanResultId: randomUUID(), createdAt: this.now() };
    await this.repository.put('scanResult', result.scanResultId, result);
    await this.audit({ action: 'scan.recorded', sourceId: result.scanResultId, targetId: input.targetId, newStatus: input.disposition, authoredBy: 'system', modelName: input.modelName, modelVersion: input.modelVersion });
    return result;
  }
  async requestScan(input: { targetType: ScanJob['targetType']; targetId: string; contentVersion: string; requestedScanTypes: ScanType[]; sourceBytes?: Uint8Array; sourceBytesAvailable?: boolean; contentHash?: string }): Promise<ScanJob> {
    if (!input.targetId.trim() || !input.contentVersion.trim() || !input.requestedScanTypes.length) throw new Error('Target, content version, and scan types are required');
    const requestedScanTypes = [...new Set(input.requestedScanTypes)];
    const contentHash = input.sourceBytes ? createHash('sha256').update(input.sourceBytes).digest('hex') : input.contentHash?.toLowerCase();
    if (contentHash && !/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('Content hash must be a SHA-256 hex digest');
    const now = this.now();
    const sourceBytesAvailable = Boolean(input.sourceBytes || input.sourceBytesAvailable);
    if (sourceBytesAvailable && !contentHash) throw new Error('Available source bytes require a SHA-256 content hash');
    const unavailable = !sourceBytesAvailable;
    const job: ScanJob = { scanJobId: randomUUID(), targetType: input.targetType, targetId: input.targetId, contentVersion: input.contentVersion, contentHash, sourceBytesAvailable, requestedScanTypes, status: unavailable ? 'COMPLETED' : 'QUEUED', mediaState: unavailable ? 'SCAN_UNAVAILABLE' : 'QUARANTINED', attemptCount: 0, createdAt: now, completedAt: unavailable ? now : undefined, updatedAt: now };
    await this.repository.put('scanJob', job.scanJobId, job);
    if (unavailable) await this.recordScan({ scanJobId: job.scanJobId, targetId: job.targetId, provider: 'none', modelName: 'none', modelVersion: 'none', scanType: requestedScanTypes[0], labels: [], disposition: 'scan_unavailable', suitableForAutomatedAction: false });
    await this.audit({ action: 'scan_job.requested', sourceId: job.scanJobId, targetId: job.targetId, newStatus: job.mediaState, reason: unavailable ? 'Source bytes are unavailable' : undefined, authoredBy: 'system' });
    return job;
  }
  async startScan(scanJobId: string, provider: string): Promise<ScanJob> {
    const job = await this.repository.get('scanJob', scanJobId);
    if (!job || !['QUEUED', 'FAILED'].includes(job.status)) throw new Error('Runnable scan job not found');
    const previousStatus = job.mediaState; const now = this.now();
    Object.assign(job, { status: 'RUNNING', mediaState: 'SCANNING', provider, attemptCount: job.attemptCount + 1, startedAt: now, completedAt: undefined, errorCode: undefined, updatedAt: now });
    await this.repository.put('scanJob', job.scanJobId, job);
    await this.audit({ action: 'scan_job.started', sourceId: job.scanJobId, targetId: job.targetId, previousStatus, newStatus: job.mediaState, authoredBy: 'system' });
    return job;
  }
  async completeScan(scanJobId: string, input: { results: Array<Omit<ScanResult, 'scanResultId' | 'scanJobId' | 'targetId' | 'contentHash' | 'createdAt'>>; mediaState: Extract<MediaScanState, 'CLEARED_FOR_POLICY_REVIEW' | 'HELD' | 'HUMAN_REVIEW_REQUIRED' | 'SCAN_UNAVAILABLE'>; errorCode?: string }): Promise<ScanJob> {
    const job = await this.repository.get('scanJob', scanJobId);
    if (!job || job.status !== 'RUNNING') throw new Error('Running scan job not found');
    if (input.results.some((result) => !job.requestedScanTypes.includes(result.scanType) || result.provider !== job.provider)) throw new Error('Scan results must match the requested types and active provider');
    const completedTypes = new Set(input.results.map((result) => result.scanType));
    if (input.mediaState === 'CLEARED_FOR_POLICY_REVIEW' && (job.requestedScanTypes.some((type) => !completedTypes.has(type)) || input.results.some((result) => !['automated_no_match', 'human_cleared'].includes(result.disposition)))) throw new Error('Policy review clearance requires no-match or human-cleared results for every requested scan type');
    if (input.mediaState === 'SCAN_UNAVAILABLE' && !input.errorCode) throw new Error('Unavailable scans require an error code');
    for (const result of input.results) await this.recordScan({ ...result, scanJobId: job.scanJobId, targetId: job.targetId, contentHash: job.contentHash });
    const previousStatus = job.mediaState; const now = this.now();
    Object.assign(job, { status: input.mediaState === 'SCAN_UNAVAILABLE' ? 'FAILED' : 'COMPLETED', mediaState: input.mediaState, errorCode: input.errorCode, completedAt: now, updatedAt: now });
    await this.repository.put('scanJob', job.scanJobId, job);
    await this.audit({ action: 'scan_job.completed', sourceId: job.scanJobId, targetId: job.targetId, previousStatus, newStatus: job.mediaState, reason: input.errorCode, authoredBy: 'system' });
    return job;
  }
  async createBillingTask(input: Omit<BillingTask, 'billingTaskId' | 'status' | 'approvedBy' | 'decisionReason' | 'providerOperationId' | 'resultingAmountMinor' | 'createdAt' | 'updatedAt'>): Promise<BillingTask> {
    const ticket = await this.repository.get('ticket', input.linkedTicketId);
    if (!ticket || ticket.requesterUserId !== input.requesterUserId) throw new Error('Owned billing support ticket not found');
    if (!Number.isSafeInteger(input.currentAmountMinor) || !Number.isSafeInteger(input.requestedAmountMinor) || input.currentAmountMinor < 0 || input.requestedAmountMinor < 0 || !input.idempotencyKey.trim() || !input.notes.trim() || input.evidenceReferences.length > 20) throw new Error('Billing change request is invalid');
    const duplicate = (await this.repository.list('billingTask')).find((item) => item.requesterUserId === input.requesterUserId && item.idempotencyKey === input.idempotencyKey);
    if (duplicate) return duplicate;
    const now = this.now(); const task: BillingTask = { ...input, billingTaskId: randomUUID(), status: 'AWAITING_HUMAN', createdAt: now, updatedAt: now };
    await this.repository.put('billingTask', task.billingTaskId, task); await this.audit({ action: 'billing_task.created', sourceId: task.billingTaskId, newStatus: task.status, authoredBy: 'system' }); return task;
  }
  async decideBillingTask(taskId: string, input: { outcome: Exclude<BillingTask['status'], 'AWAITING_HUMAN'>; reason: string; providerOperationId?: string; resultingAmountMinor?: number }, humanActorId: string): Promise<BillingTask> {
    const task = await this.repository.get('billingTask', taskId); if (!task) throw new Error('Billing task not found');
    if (task.requesterUserId === humanActorId) throw new Error('Billing changes require a different human approver');
    if (task.status !== 'AWAITING_HUMAN' || !input.reason.trim() || (input.outcome === 'EXECUTED' && (!input.providerOperationId?.trim() || !Number.isSafeInteger(input.resultingAmountMinor) || input.resultingAmountMinor! < 0))) throw new Error('Billing decision is invalid');
    const previousStatus = task.status; Object.assign(task, { status: input.outcome, approvedBy: humanActorId, decisionReason: input.reason.trim(), providerOperationId: input.providerOperationId?.trim(), resultingAmountMinor: input.resultingAmountMinor, updatedAt: this.now() });
    await this.repository.put('billingTask', task.billingTaskId, task); await this.audit({ action: 'billing_task.decided', sourceId: taskId, previousStatus, newStatus: input.outcome, reason: input.reason.trim(), authoredBy: 'human', internalActorId: humanActorId }); return task;
  }
}
