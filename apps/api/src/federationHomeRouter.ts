import express from 'express';
import { FederationError, FEDERATION_SCOPES, type FederationScope } from './federation';
import type { FederationDashboard } from './federationProduct';

export interface HomeFederationCoordinator {
  dashboard(creatorId: string): Promise<FederationDashboard & { actorUri: string }>;
  connect(creatorId: string, input: { destinationInstanceId: string; scopes: FederationScope[]; policyVersion: string; expiresAt?: string }): Promise<void>;
  updateProfile(creatorId: string, destinationInstanceId: string, input: { displayName: string; handle: string; shortBio?: string }): Promise<void>;
  publish(creatorId: string, input: { sourceWorkUri: string; destinationInstanceId: string }): Promise<void>;
  withdraw(creatorId: string, publicationId: string): Promise<void>;
  revoke(creatorId: string, destinationInstanceId: string): Promise<void>;
  workTitles(creatorId: string, sourceWorkUris: string[]): Promise<Record<string, string>>;
}

const string = (value: unknown, name: string, optional = false): string | undefined => {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new FederationError('invalid_request', `${name} is required`);
  return value.trim();
};
const exact = (body: unknown, allowed: string[]): Record<string, unknown> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FederationError('invalid_request', 'A JSON object is required');
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new FederationError('invalid_request', `Unknown field: ${unknown}`);
  return record;
};
const futureDate = (value: unknown): string | undefined => {
  const candidate = string(value, 'expiresAt', true);
  if (!candidate) return undefined;
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw new FederationError('invalid_request', 'expiresAt must be a future ISO-8601 timestamp');
  return new Date(timestamp).toISOString();
};
const bounded = (value: unknown, name: string, maximum: number, optional = false): string | undefined => {
  const candidate = string(value, name, optional);
  if (candidate && candidate.length > maximum) throw new FederationError('invalid_request', `${name} exceeds ${maximum} characters`);
  return candidate;
};

/** Authenticated creator-facing federation controls. Instance-to-instance signing happens in the coordinator. */
export const createFederationHomeRouter = (options: {
  coordinator: HomeFederationCoordinator;
  authorizeCreator: (req: express.Request, creatorId: string) => Promise<boolean>;
}): express.Router => {
  const router = express.Router();
  const asyncRoute = (handler: (req: express.Request, res: express.Response) => Promise<void>) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => { void handler(req, res).catch(next); };
  router.use(express.json({ limit: '64kb' }));
  router.use('/:creatorId', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ code: 'authentication_required', message: 'Sign in to manage federation' });
      if (!(await options.authorizeCreator(req, req.params.creatorId))) return res.status(403).json({ code: 'creator_access_denied', message: 'You cannot manage federation for this creator' });
      next();
    } catch (error) { next(error); }
  });
  router.get('/:creatorId', asyncRoute(async (req, res) => {
    const dashboard = await options.coordinator.dashboard(req.params.creatorId);
    const titles = await options.coordinator.workTitles(req.params.creatorId, dashboard.works.map((work) => work.sourceWorkUri));
    res.json({ ...dashboard, works: dashboard.works.map((work) => ({ ...work, title: titles[work.sourceWorkUri] || 'Untitled Work' })) });
  }));
  router.post('/:creatorId/destinations', asyncRoute(async (req, res) => {
    const body = exact(req.body, ['destinationInstanceId', 'scopes', 'policyVersion', 'expiresAt']);
    if (!Array.isArray(body.scopes) || !body.scopes.length || new Set(body.scopes).size !== body.scopes.length || body.scopes.some((scope) => !FEDERATION_SCOPES.includes(scope as FederationScope))) throw new FederationError('invalid_scope', 'Unique supported federation scopes are required');
    await options.coordinator.connect(req.params.creatorId, { destinationInstanceId: bounded(body.destinationInstanceId, 'destinationInstanceId', 128)!, scopes: body.scopes as FederationScope[], policyVersion: bounded(body.policyVersion, 'policyVersion', 128)!, expiresAt: futureDate(body.expiresAt) });
    res.status(202).json({ status: 'pending' });
  }));
  router.put('/:creatorId/destinations/:destinationInstanceId/profile', asyncRoute(async (req, res) => {
    const body = exact(req.body, ['displayName', 'handle', 'shortBio']);
    const handle = bounded(body.handle, 'handle', 40)!;
    if (!/^[A-Za-z0-9._-]+$/.test(handle)) throw new FederationError('invalid_request', 'handle contains unsupported characters');
    await options.coordinator.updateProfile(req.params.creatorId, req.params.destinationInstanceId, { displayName: bounded(body.displayName, 'displayName', 80)!, handle, shortBio: bounded(body.shortBio, 'shortBio', 280, true) });
    res.status(202).json({ status: 'pending' });
  }));
  router.post('/:creatorId/publications', asyncRoute(async (req, res) => {
    const body = exact(req.body, ['sourceWorkUri', 'destinationInstanceId']);
    await options.coordinator.publish(req.params.creatorId, { sourceWorkUri: string(body.sourceWorkUri, 'sourceWorkUri')!, destinationInstanceId: string(body.destinationInstanceId, 'destinationInstanceId')! });
    res.status(202).json({ status: 'pending' });
  }));
  router.post('/:creatorId/publications/:publicationId/withdraw', asyncRoute(async (req, res) => { exact(req.body, []); await options.coordinator.withdraw(req.params.creatorId, req.params.publicationId); res.status(202).json({ status: 'pending' }); }));
  router.post('/:creatorId/destinations/:destinationInstanceId/revoke', asyncRoute(async (req, res) => { exact(req.body, []); await options.coordinator.revoke(req.params.creatorId, req.params.destinationInstanceId); res.status(202).json({ status: 'revoked' }); }));
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof FederationError) return res.status(400).json({ code: error.code, message: error.message });
    return res.status(500).json({ code: 'federation_home_error', message: 'Federation request failed' });
  });
  return router;
};
