import { Router } from 'express';
import { requireAdmin, requireAuth, requireSafetyReviewer } from './auth';
import { SUPPORT_PUBLIC_IDENTITY, SupportSafetyService, type HoldType, type ScanType, type TargetType } from './supportSafety';

const categories = new Set(['account_access', 'space_creator_settings', 'work_asset_collection', 'integration_publishing', 'challenge_community', 'billing', 'safety_moderation', 'bug_feature']);
const targets = new Set<TargetType>(['work', 'asset', 'comment', 'creator', 'user', 'account', 'external_link']);
const holds = new Set<HoldType>(['CONTENT_REVIEW_HOLD', 'CREATOR_REVIEW_HOLD', 'ACCOUNT_REVIEW_HOLD', 'COMMENT_REVIEW_HOLD', 'CSAM_SAFETY_LOCK', 'NCII_SAFETY_LOCK', 'LEGAL_ORDER_HOLD', 'EVERSALLY_POLICY_OFFBOARDING']);
const scanTypes = new Set<ScanType>(['hash', 'image_moderation', 'video_moderation', 'face_age_signal', 'text_safety']);
const mediaScanStates = new Set(['CLEARED_FOR_POLICY_REVIEW', 'HELD', 'HUMAN_REVIEW_REQUIRED', 'SCAN_UNAVAILABLE']);

export const createSupportRouter = (service: SupportSafetyService): Router => {
  const router = Router();
  router.get('/identity', (_req, res) => res.json({ displayName: SUPPORT_PUBLIC_IDENTITY, automatedAssistance: true, humanReviewAvailable: true }));
  router.post('/tickets', requireAuth, async (req, res) => {
    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!subject || !body || !categories.has(req.body?.category)) return res.status(400).json({ message: 'Subject, body, and a valid category are required' });
    const ticket = await service.createTicket({ requesterUserId: req.authUser!.userId, subject, body, category: req.body.category,
      priority: ['low', 'high', 'urgent'].includes(req.body?.priority) ? req.body.priority : 'normal',
      creatorId: typeof req.body?.creatorId === 'string' ? req.body.creatorId : undefined, spaceId: typeof req.body?.spaceId === 'string' ? req.body.spaceId : undefined,
      references: Array.isArray(req.body?.references) ? req.body.references.filter((x: unknown) => x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string' && typeof (x as { id?: unknown }).id === 'string').slice(0, 20) : [],
      diagnostics: req.body?.diagnostics && typeof req.body.diagnostics === 'object' ? req.body.diagnostics : {} });
    return res.status(201).json({ ...ticket, publicResponder: SUPPORT_PUBLIC_IDENTITY });
  });
  router.get('/tickets', requireAuth, async (req, res) => res.json((await service.listTickets()).filter((ticket) => req.authUser!.groups.includes('Admins') || ticket.requesterUserId === req.authUser!.userId)));
  router.get('/notifications', requireAuth, async (req, res) => res.json((await service.listNotifications()).filter((item) => item.userId === req.authUser!.userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))));
  router.post('/notifications/:notificationId/read', requireAuth, async (req, res) => {
    try { return res.json(await service.markNotificationRead(req.params.notificationId, req.authUser!.userId)); }
    catch { return res.status(404).json({ message: 'Notification not found' }); }
  });
  router.get('/tickets/:ticketId/messages', requireAuth, async (req, res) => {
    const ticket = (await service.listTickets()).find((x) => x.ticketId === req.params.ticketId);
    const admin = req.authUser!.groups.includes('Admins');
    if (!ticket || (!admin && ticket.requesterUserId !== req.authUser!.userId)) return res.status(404).json({ message: 'Ticket not found' });
    return res.json((await service.listMessages()).filter((message) => message.ticketId === ticket.ticketId && message.visibility !== 'RESTRICTED_SAFETY_ONLY' && (admin || message.visibility === 'PUBLIC_TO_REQUESTER')));
  });
  router.post('/tickets/:ticketId/attachments', requireAuth, async (req, res) => {
    const ticket = (await service.listTickets()).find((item) => item.ticketId === req.params.ticketId);
    const admin = req.authUser!.groups.includes('Admins');
    if (!ticket || (!admin && ticket.requesterUserId !== req.authUser!.userId)) return res.status(404).json({ message: 'Ticket not found' });
    try {
      const attachment = await service.createAttachment({ ticketId: ticket.ticketId, uploadedByUserId: req.authUser!.userId, filename: String(req.body?.filename || ''), mimeType: String(req.body?.mimeType || ''), sizeBytes: Number(req.body?.sizeBytes) });
      return res.status(201).json({ attachmentId: attachment.attachmentId, status: attachment.status, uploadKey: attachment.quarantineKey, retentionUntil: attachment.retentionUntil });
    } catch (error) { return res.status(400).json({ message: (error as Error).message }); }
  });
  router.get('/tickets/:ticketId/attachments', requireAuth, async (req, res) => {
    const ticket = (await service.listTickets()).find((item) => item.ticketId === req.params.ticketId);
    const admin = req.authUser!.groups.includes('Admins');
    if (!ticket || (!admin && ticket.requesterUserId !== req.authUser!.userId)) return res.status(404).json({ message: 'Ticket not found' });
    const safetyReviewer = req.authUser!.groups.includes('SafetyReviewers');
    const attachments = (await service.listAttachments()).filter((item) => item.ticketId === ticket.ticketId && (safetyReviewer || item.status === 'AVAILABLE' || (admin && item.status !== 'RESTRICTED_SAFETY')));
    return res.json(attachments.map(({ quarantineKey, ...item }) => item));
  });
  router.post('/attachments/:attachmentId/scan-result', requireSafetyReviewer, async (req, res) => {
    if (!['pending', 'clean', 'detected', 'unavailable'].includes(req.body?.malwareScan) || !['pending', 'no_signal', 'restricted_signal', 'unavailable'].includes(req.body?.safetyScan)) return res.status(400).json({ message: 'Valid malware and safety scan results are required' });
    try { return res.json(await service.recordAttachmentScan(req.params.attachmentId, { malwareScan: req.body.malwareScan, safetyScan: req.body.safetyScan })); }
    catch (error) { return res.status(409).json({ message: (error as Error).message }); }
  });
  router.post('/flags', requireAuth, async (req, res) => {
    if (!targets.has(req.body?.targetType) || typeof req.body?.targetId !== 'string' || typeof req.body?.report !== 'string') return res.status(400).json({ message: 'A valid target and report are required' });
    const created = await service.createFlag({ reporterUserId: req.authUser!.userId, targetType: req.body.targetType, targetId: req.body.targetId, category: String(req.body.category || 'other'), report: req.body.report, linkedTicketId: typeof req.body.linkedTicketId === 'string' ? req.body.linkedTicketId : undefined });
    const { reporterUserId: _reporter, ...publicFlag } = created.flag;
    return res.status(201).json({ flag: publicFlag, automationTask: created.automationTask });
  });
  router.post('/flags/:flagId/automation-review', requireAdmin, async (req, res) => {
    if (req.body?.holdType !== undefined && !holds.has(req.body.holdType)) return res.status(400).json({ message: 'Invalid hold type' });
    try { return res.json(await service.completeAutomationReview(req.params.flagId, { labels: Array.isArray(req.body?.labels) ? req.body.labels : [], uncertainty: req.body?.uncertainty, recommendation: req.body?.recommendation, holdType: req.body?.holdType, reason: String(req.body?.reason || 'Automated policy review'), modelName: String(req.body?.modelName || 'unspecified'), modelVersion: String(req.body?.modelVersion || 'unspecified'), policyVersion: String(req.body?.policyVersion || 'support-safety-v1') })); }
    catch (error) { return res.status(404).json({ message: (error as Error).message }); }
  });
  router.post('/access-policy', requireAuth, async (req, res) => {
    const parsed = Array.isArray(req.body?.targets) ? req.body.targets.filter((x: unknown): x is { type: TargetType; id: string } => Boolean(x && typeof x === 'object' && targets.has((x as { type: TargetType }).type) && typeof (x as { id?: unknown }).id === 'string')) : [];
    if (!parsed.length) return res.status(400).json({ message: 'At least one target is required' });
    const decision = await service.accessPolicy(parsed);
    if (!req.authUser!.groups.includes('Admins')) {
      const { activeHolds: _restrictedDetails, ...publicDecision } = decision;
      return res.json(publicDecision);
    }
    return res.json(decision);
  });
  router.post('/holds/:holdId/release', requireAdmin, async (req, res) => {
    if (typeof req.body?.reason !== 'string' || !req.body.reason.trim()) return res.status(400).json({ message: 'A release reason is required' });
    try {
      const hold = await service.getHold(req.params.holdId);
      const safetyQualified = req.authUser!.groups.includes('SafetyReviewers');
      if (hold && ['CSAM_SAFETY_LOCK', 'NCII_SAFETY_LOCK'].includes(hold.type) && !safetyQualified) return res.status(403).json({ message: 'Authorized safety reviewer role required' });
      return res.json(await service.releaseHold(req.params.holdId, req.body.reason.trim(), req.authUser!.userId, safetyQualified));
    }
    catch (error) { return res.status(404).json({ message: (error as Error).message }); }
  });
  router.post('/scan-jobs', requireAdmin, async (req, res) => {
    const requestedScanTypes = Array.isArray(req.body?.requestedScanTypes) ? req.body.requestedScanTypes.filter((value: unknown): value is ScanType => scanTypes.has(value as ScanType)) : [];
    if (!['work', 'asset', 'support_attachment'].includes(req.body?.targetType) || typeof req.body?.targetId !== 'string' || typeof req.body?.contentVersion !== 'string' || !requestedScanTypes.length) return res.status(400).json({ message: 'A target, content version, and valid scan types are required' });
    try { return res.status(201).json(await service.requestScan({ targetType: req.body.targetType, targetId: req.body.targetId, contentVersion: req.body.contentVersion, requestedScanTypes, sourceBytesAvailable: req.body?.sourceBytesAvailable === true, contentHash: typeof req.body?.contentHash === 'string' ? req.body.contentHash : undefined })); }
    catch (error) { return res.status(400).json({ message: (error as Error).message }); }
  });
  router.post('/scan-jobs/:scanJobId/start', requireAdmin, async (req, res) => {
    if (typeof req.body?.provider !== 'string' || !req.body.provider.trim()) return res.status(400).json({ message: 'A provider is required' });
    try { return res.json(await service.startScan(req.params.scanJobId, req.body.provider.trim())); }
    catch (error) { return res.status(409).json({ message: (error as Error).message }); }
  });
  router.post('/scan-jobs/:scanJobId/complete', requireAdmin, async (req, res) => {
    if (!mediaScanStates.has(req.body?.mediaState) || !Array.isArray(req.body?.results)) return res.status(400).json({ message: 'A final media state and scan results are required' });
    try { return res.json(await service.completeScan(req.params.scanJobId, { mediaState: req.body.mediaState, results: req.body.results, errorCode: typeof req.body?.errorCode === 'string' ? req.body.errorCode : undefined })); }
    catch (error) { return res.status(409).json({ message: (error as Error).message }); }
  });
  router.post('/billing-tasks', requireAuth, async (req, res) => {
    if (typeof req.body?.linkedTicketId !== 'string' || typeof req.body?.requestedChange !== 'string') return res.status(400).json({ message: 'A linked ticket and requested change are required' });
    return res.status(201).json(await service.createBillingTask({ requesterUserId: req.authUser!.userId, linkedTicketId: req.body.linkedTicketId, requestedChange: req.body.requestedChange, currentState: String(req.body.currentState || ''), financialImpact: String(req.body.financialImpact || 'unknown') }));
  });
  router.post('/billing-tasks/:taskId/decision', requireAdmin, async (req, res) => {
    if (!['EXECUTED', 'REJECTED', 'MORE_INFORMATION', 'FAILED'].includes(req.body?.outcome)) return res.status(400).json({ message: 'A valid human outcome is required' });
    try { return res.json(await service.decideBillingTask(req.params.taskId, req.body.outcome, req.authUser!.userId)); } catch (error) { return res.status(404).json({ message: (error as Error).message }); }
  });
  router.get('/review-queue', requireAdmin, async (_req, res) => res.json((await service.listReviewCases()).filter((item) => !item.restrictedSafety)));
  router.get('/safety-review-queue', requireSafetyReviewer, async (_req, res) => res.json((await service.listReviewCases()).filter((item) => item.restrictedSafety)));
  router.post('/review-cases/:caseId/assign', requireAuth, async (req, res) => {
    const reviewCase = (await service.listReviewCases()).find((item) => item.caseId === req.params.caseId);
    if (!reviewCase) return res.status(404).json({ message: 'Review case not found' });
    const authorized = reviewCase.restrictedSafety ? req.authUser!.groups.includes('SafetyReviewers') : req.authUser!.groups.includes('Admins');
    if (!authorized) return res.status(403).json({ message: reviewCase.restrictedSafety ? 'Authorized safety reviewer role required' : 'Admin role required' });
    try { return res.json(await service.assignReviewCase(reviewCase.caseId, req.authUser!.userId)); }
    catch (error) { return res.status(409).json({ message: (error as Error).message }); }
  });
  router.post('/review-cases/:caseId/decision', requireAuth, async (req, res) => {
    const reviewCase = (await service.listReviewCases()).find((item) => item.caseId === req.params.caseId);
    if (!reviewCase) return res.status(404).json({ message: 'Review case not found' });
    const safetyQualified = req.authUser!.groups.includes('SafetyReviewers');
    if (reviewCase.restrictedSafety ? !safetyQualified : !req.authUser!.groups.includes('Admins')) return res.status(403).json({ message: reviewCase.restrictedSafety ? 'Authorized safety reviewer role required' : 'Admin role required' });
    if (!['CLEARED', 'CONFIRMED', 'ESCALATED'].includes(req.body?.decision) || typeof req.body?.rationale !== 'string') return res.status(400).json({ message: 'A valid decision and rationale are required' });
    try { return res.json(await service.decideReviewCase(reviewCase.caseId, { decision: req.body.decision, rationale: req.body.rationale, escalationDestination: typeof req.body?.escalationDestination === 'string' ? req.body.escalationDestination : undefined }, req.authUser!.userId, safetyQualified)); }
    catch (error) { return res.status(409).json({ message: (error as Error).message }); }
  });
  router.get('/audit', requireAdmin, async (_req, res) => res.json(await service.listAuditEvents()));
  return router;
};
