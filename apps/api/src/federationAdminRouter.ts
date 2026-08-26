import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { FederationError, type FederationService, type ModerationState, type TrustState } from './federation';
import type { FederationAuditDynamoRepository, FederationAuditRole } from './federationAudit';
import type { FederationProductService } from './federationProduct';

type OperatorRole = FederationAuditRole;
const rank: Record<OperatorRole, number> = { federation_operator: 1, moderator: 2, safety_investigator: 3, legal_reviewer: 4 };
const text = (value: unknown, name: string): string => { if (typeof value !== 'string' || !value.trim()) throw new FederationError('invalid_operator_action', `${name} is required`); return value.trim(); };
const confirmation = (body: Record<string, unknown>, expected: string): string => {
  const reason = text(body.reason, 'reason');
  if (body.confirmation !== expected) throw new FederationError('confirmation_required', `Type ${expected} to confirm`);
  return reason;
};
const auditLimit = (value: unknown): number => { const parsed = Number(value ?? 100); if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) throw new FederationError('invalid_operator_action', 'limit must be an integer from 1 to 500'); return parsed; };

export const createFederationAdminRouter = (options: {
  service: FederationService; product: FederationProductService; audit: FederationAuditDynamoRepository;
  authorize(req: Request): Promise<{ reviewerId: string; role: OperatorRole } | undefined>;
}): Router => {
  const router = express.Router(); router.use(express.json({ limit: '64kb' }));
  router.use(async (req, res, next) => { try { const principal = await options.authorize(req); if (!principal) return res.status(401).json({ code: 'authentication_required' }); res.locals.federationPrincipal = principal; next(); } catch (error) { next(error); } });
  const requireRole = (minimum: OperatorRole) => (req: Request, res: Response, next: NextFunction) => {
    const principal = res.locals.federationPrincipal as { reviewerId: string; role: OperatorRole };
    if (rank[principal.role] < rank[minimum]) return res.status(403).json({ code: 'permission_denied' }); next();
  };

  router.get('/operator', requireRole('federation_operator'), (_req, res) => res.json(options.product.operatorSnapshot()));
  router.patch('/projections', requireRole('moderator'), (req, res) => {
    const actorUri = text(req.body?.actorUri, 'actorUri'); const reason = text(req.body?.reason, 'reason');
    const trustState = req.body?.trustState as TrustState | undefined; const moderationState = req.body?.moderationState as ModerationState | undefined;
    if (trustState && !['pending', 'trusted', 'restricted', 'blocked'].includes(trustState)) throw new FederationError('invalid_operator_action', 'Invalid trust state');
    if (moderationState && !['active', 'limited', 'suspended'].includes(moderationState)) throw new FederationError('invalid_operator_action', 'Invalid moderation state');
    res.json(options.service.moderateProfile(actorUri, { trustState, moderationState, visible: typeof req.body?.visible === 'boolean' ? req.body.visible : undefined, reason }));
  });
  router.post('/instances/:instanceId/block', requireRole('safety_investigator'), (req, res) => { const reason = confirmation(req.body ?? {}, `BLOCK ${req.params.instanceId}`); options.service.blockSourceInstance(req.params.instanceId, reason); res.status(204).end(); });
  router.patch('/publications/:publicationId/moderation', requireRole('moderator'), (req, res) => {
    const status = req.body?.status as 'published' | 'rejected' | 'held' | 'removed';
    if (!['published', 'rejected', 'held', 'removed'].includes(status)) throw new FederationError('invalid_operator_action', 'Invalid publication moderation status');
    res.json(options.service.moderatePublication(req.params.publicationId, status, text(req.body?.reason, 'reason')));
  });
  router.post('/publications/:publicationId/legal-hold', requireRole('legal_reviewer'), (req, res) => {
    const active = req.body?.active; if (typeof active !== 'boolean') throw new FederationError('invalid_operator_action', 'active must be boolean');
    const reason = confirmation(req.body ?? {}, `${active ? 'HOLD' : 'RELEASE'} ${req.params.publicationId}`);
    res.json(options.service.setLegalHold(req.params.publicationId, active, reason));
  });
  router.post('/deliveries/:deliveryId/replay', requireRole('federation_operator'), (req, res) => { confirmation(req.body ?? {}, `REPLAY ${req.params.deliveryId}`); res.json(options.product.replayDelivery(req.params.deliveryId)); });
  router.get('/audit', requireRole('federation_operator'), async (req, res, next) => { try { const principal = res.locals.federationPrincipal as { role: OperatorRole }; res.json({ items: await options.audit.list(principal.role, typeof req.query.from === 'string' ? req.query.from : undefined, auditLimit(req.query.limit)) }); } catch (error) { next(error); } });
  router.get('/audit/export.ndjson', requireRole('federation_operator'), async (req, res, next) => { try { const principal = res.locals.federationPrincipal as { role: OperatorRole }; res.type('application/x-ndjson').send(await options.audit.exportNdjson(principal.role, typeof req.query.from === 'string' ? req.query.from : undefined)); } catch (error) { next(error); } });
  router.post('/audit/:occurredAt/:auditId/legal-hold', requireRole('legal_reviewer'), async (req, res, next) => { try { const principal = res.locals.federationPrincipal as { reviewerId: string }; const reason = confirmation(req.body ?? {}, `HOLD AUDIT ${req.params.auditId}`); await options.audit.placeLegalHold({ occurredAt: req.params.occurredAt, auditId: req.params.auditId, reviewerId: principal.reviewerId, reason }); res.status(204).end(); } catch (error) { next(error); } });

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => error instanceof FederationError ? res.status(400).json({ code: error.code, message: error.message }) : res.status(500).json({ code: 'federation_admin_error' }));
  return router;
};
