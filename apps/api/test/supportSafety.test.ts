import { SupportSafetyService, SUPPORT_PUBLIC_IDENTITY } from '../src/supportSafety';
import { InMemorySupportSafetyRepository } from '../src/supportSafetyRepository';

describe('support and safety workflows', () => {
  it('creates a ticket under the shared identity and strips unsafe diagnostics', async () => {
    const service = new SupportSafetyService();
    const ticket = await service.createTicket({ requesterUserId: 'user-1', subject: 'Publishing failed', body: 'Please help', category: 'integration_publishing', priority: 'normal', diagnostics: { route: '/studio', errorCode: 'E42', accessToken: 'secret', authorization: 'Bearer secret' } });
    expect(ticket.ticketNumber).toBe('EVR-1042');
    expect(ticket.diagnostics).toEqual({ route: '/studio', errorCode: 'E42' });
    expect((await service.listMessages())[0]).toMatchObject({ publicAuthorName: SUPPORT_PUBLIC_IDENTITY, authoredBy: 'system', visibility: 'PUBLIC_TO_REQUESTER' });
  });

  it('never silently dismisses a flag with no automated hold', async () => {
    const service = new SupportSafetyService();
    const { flag, automationTask } = await service.createFlag({ reporterUserId: 'reporter', targetType: 'work', targetId: 'work-1', category: 'safety', report: 'Concerning context' });
    expect(automationTask.status).toBe('PENDING');
    const result = await service.completeAutomationReview(flag.flagId, { labels: [], uncertainty: 'low resolution', recommendation: 'human context review', reason: 'No threshold met', modelName: 'moderator', modelVersion: '1', policyVersion: '1' });
    expect(result.flag.status).toBe('NO_HOLD_HUMAN_REVIEW');
    expect(result.reviewCase).toMatchObject({ status: 'OPEN', restrictedSafety: false });
  });

  it('applies a safety lock across every route and blocks creator export', async () => {
    const service = new SupportSafetyService();
    const { flag } = await service.createFlag({ targetType: 'asset', targetId: 'asset-1', category: 'minor_safety', report: 'Credible risk' });
    const result = await service.completeAutomationReview(flag.flagId, { labels: [{ label: 'age-sensitive sexual context', confidence: 0.91 }], holdType: 'CSAM_SAFETY_LOCK', reason: 'Credible possibility; not a legal determination', modelName: 'risk-triage', modelVersion: '2', policyVersion: '3' });
    expect(result.reviewCase.restrictedSafety).toBe(true);
    expect(await service.accessPolicy([{ type: 'asset', id: 'asset-1' }])).toEqual({ public: false, privateLink: false, api: false, download: false, creatorView: false, export: false, activeHolds: ['CSAM_SAFETY_LOCK'] });
  });

  it('requires a qualified reviewer to decide and clear restricted safety cases', async () => {
    const service = new SupportSafetyService();
    const { flag } = await service.createFlag({ targetType: 'asset', targetId: 'asset-safety', category: 'minor_safety', report: 'Restricted report' });
    const { hold, reviewCase } = await service.completeAutomationReview(flag.flagId, { labels: [{ label: 'age-sensitive context', confidence: 0.9 }], holdType: 'CSAM_SAFETY_LOCK', reason: 'Restricted review required', modelName: 'triage', modelVersion: '1', policyVersion: '1' });
    await expect(service.releaseHold(hold!.holdId, 'Ordinary support clearance', 'support-admin')).rejects.toThrow('qualified safety reviewer');
    expect(await service.assignReviewCase(reviewCase.caseId, 'safety-reviewer')).toMatchObject({ status: 'ASSIGNED', assignedReviewerId: 'safety-reviewer' });
    await expect(service.decideReviewCase(reviewCase.caseId, { decision: 'CLEARED', rationale: 'Reviewed evidence' }, 'support-admin')).rejects.toThrow('qualified safety reviewer');
    const decided = await service.decideReviewCase(reviewCase.caseId, { decision: 'CLEARED', rationale: 'Qualified review found no safety violation' }, 'safety-reviewer', true);
    expect(decided).toMatchObject({ status: 'DECIDED', decision: 'CLEARED', assignedReviewerId: 'safety-reviewer' });
    expect((await service.accessPolicy([{ type: 'asset', id: 'asset-safety' }])).public).toBe(true);
  });

  it('allows lawful offboarding export and distinguishes scanner unavailability', async () => {
    const service = new SupportSafetyService();
    await service.applyHold({ type: 'EVERSALLY_POLICY_OFFBOARDING', targetType: 'creator', targetId: 'creator-1', reason: 'Hosted policy incompatibility', sourceId: 'case-1' }, { authoredBy: 'human', internalActorId: 'reviewer-1' });
    expect((await service.accessPolicy([{ type: 'creator', id: 'creator-1' }])).export).toBe(true);
    const scan = await service.recordScan({ targetId: 'external-work', provider: 'none', modelName: 'none', modelVersion: 'none', scanType: 'hash', labels: [], disposition: 'scan_unavailable', suitableForAutomatedAction: false });
    expect(scan.disposition).toBe('scan_unavailable');
  });

  it('requires a named human to execute billing work', async () => {
    const service = new SupportSafetyService();
    const task = await service.createBillingTask({ requesterUserId: 'user-1', requestedChange: 'Refund', currentState: 'paid', financialImpact: '$20', linkedTicketId: 'ticket-1' });
    expect(task.status).toBe('AWAITING_HUMAN');
    expect(await service.decideBillingTask(task.billingTaskId, 'EXECUTED', 'finance-reviewer')).toMatchObject({ status: 'EXECUTED', approvedBy: 'finance-reviewer' });
  });

  it('persists records across service instances and releases holds with an audit event', async () => {
    const repository = new InMemorySupportSafetyRepository();
    const firstInstance = new SupportSafetyService(repository);
    const ticket = await firstInstance.createTicket({ requesterUserId: 'user-1', subject: 'Persistent ticket', body: 'Keep this', category: 'bug_feature', priority: 'normal' });
    const hold = await firstInstance.applyHold({ type: 'CONTENT_REVIEW_HOLD', targetType: 'work', targetId: 'work-1', reason: 'Review needed', sourceId: ticket.ticketId }, { authoredBy: 'system' });

    const secondInstance = new SupportSafetyService(repository);
    expect(await secondInstance.listTickets()).toContainEqual(ticket);
    expect((await secondInstance.accessPolicy([{ type: 'work', id: 'work-1' }])).public).toBe(false);

    await secondInstance.releaseHold(hold.holdId, 'Human review cleared the work', 'reviewer-1');
    expect((await firstInstance.accessPolicy([{ type: 'work', id: 'work-1' }])).public).toBe(true);
    expect(await secondInstance.listAuditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'review_hold.released', internalActorId: 'reviewer-1' })
    ]));
  });

  it('quarantines attachments and separates restricted safety signals', async () => {
    const service = new SupportSafetyService();
    const ticket = await service.createTicket({ requesterUserId: 'user-1', subject: 'Report', body: 'See reference', category: 'safety_moderation', priority: 'high' });
    const attachment = await service.createAttachment({ ticketId: ticket.ticketId, uploadedByUserId: 'user-1', filename: '../reference.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 });
    expect(attachment).toMatchObject({ filename: '.._reference.jpg', status: 'QUARANTINED', malwareScan: 'pending', safetyScan: 'pending' });
    const restricted = await service.recordAttachmentScan(attachment.attachmentId, { malwareScan: 'clean', safetyScan: 'restricted_signal' });
    expect(restricted.status).toBe('RESTRICTED_SAFETY');
    expect(await service.listAuditEvents()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'support_attachment.scanned', newStatus: 'RESTRICTED_SAFETY' })]));
    await expect(service.createAttachment({ ticketId: ticket.ticketId, uploadedByUserId: 'user-1', filename: 'payload.exe', mimeType: 'application/octet-stream', sizeBytes: 10 })).rejects.toThrow('type is not allowed');
  });

  it('creates safe in-app notifications and enforces notification ownership', async () => {
    const service = new SupportSafetyService();
    const ticket = await service.createTicket({ requesterUserId: 'user-1', subject: 'Billing question', body: 'Please help', category: 'billing', priority: 'normal' });
    expect(await service.listNotifications()).toEqual([expect.objectContaining({ userId: 'user-1', ticketId: ticket.ticketId, type: 'TICKET_RECEIVED' })]);
    await service.addMessage(ticket.ticketId, 'A safe public response.', 'PUBLIC_TO_REQUESTER', { authoredBy: 'human', internalActorId: 'support-1' });
    const notifications = await service.listNotifications();
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toMatchObject({ type: 'SUPPORT_REPLY', body: 'The Ubeeq/ES Support Team replied to your request.' });
    await expect(service.markNotificationRead(notifications[1].notificationId, 'user-2')).rejects.toThrow('Notification not found');
    expect((await service.markNotificationRead(notifications[1].notificationId, 'user-1')).readAt).toBeDefined();
  });

  it('quarantines source media, calculates SHA-256, and records scan lifecycle results', async () => {
    const service = new SupportSafetyService();
    const job = await service.requestScan({ targetType: 'asset', targetId: 'asset-1', contentVersion: 'v1', requestedScanTypes: ['hash', 'image_moderation', 'hash'], sourceBytes: Buffer.from('media bytes') });
    expect(job).toMatchObject({ status: 'QUEUED', mediaState: 'QUARANTINED', attemptCount: 0, requestedScanTypes: ['hash', 'image_moderation'] });
    expect(job.contentHash).toMatch(/^[a-f0-9]{64}$/);

    expect(await service.startScan(job.scanJobId, 'rekognition')).toMatchObject({ status: 'RUNNING', mediaState: 'SCANNING', attemptCount: 1 });
    await expect(service.completeScan(job.scanJobId, { mediaState: 'CLEARED_FOR_POLICY_REVIEW', results: [{ provider: 'different-provider', modelName: 'sha256', modelVersion: 'v1', scanType: 'hash', labels: [], disposition: 'automated_no_match', suitableForAutomatedAction: true }] })).rejects.toThrow('requested types and active provider');
    const completed = await service.completeScan(job.scanJobId, { mediaState: 'CLEARED_FOR_POLICY_REVIEW', results: [
      { provider: 'rekognition', modelName: 'sha256', modelVersion: 'v1', scanType: 'hash', labels: [], disposition: 'automated_no_match', suitableForAutomatedAction: true },
      { provider: 'rekognition', modelName: 'DetectModerationLabels', modelVersion: 'v1', scanType: 'image_moderation', labels: [], disposition: 'automated_no_match', suitableForAutomatedAction: true }
    ] });
    expect(completed).toMatchObject({ status: 'COMPLETED', mediaState: 'CLEARED_FOR_POLICY_REVIEW' });
    expect(await service.listScanJobs()).toEqual([completed]);
    expect(await service.listAuditEvents()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'scan_job.completed', newStatus: 'CLEARED_FOR_POLICY_REVIEW' })]));
  });

  it('marks metadata-only media unavailable instead of falsely clearing it', async () => {
    const service = new SupportSafetyService();
    const job = await service.requestScan({ targetType: 'work', targetId: 'external-work', contentVersion: 'metadata-v1', requestedScanTypes: ['hash', 'video_moderation'] });
    expect(job).toMatchObject({ status: 'COMPLETED', mediaState: 'SCAN_UNAVAILABLE', contentHash: undefined });
    await expect(service.startScan(job.scanJobId, 'rekognition')).rejects.toThrow('Runnable scan job not found');
  });
});
