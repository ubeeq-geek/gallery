import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { FederationError, FEDERATION_SCOPES, type FederationInstanceMetadata, type FederationService, type SignedFederationRequest } from './federation';
import type { FederationProductService } from './federationProduct';

export interface FederationRouterOptions {
  instance: FederationInstanceMetadata;
  service: FederationService;
  product: FederationProductService;
  resolveActor(actorUri: string): Promise<{ actorUri: string; homeInstanceId: string } | undefined>;
  receiveCallback?(request: SignedFederationRequest<Record<string, unknown>>): Promise<void>;
  maximumRequestsPerMinute?: number;
}

const RATE_LIMIT_BUCKET_CAPACITY = 10_000;

const requireObject = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FederationError('invalid_request', `${name} must be an object`);
  return value as Record<string, unknown>;
};
const requireString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new FederationError('invalid_request', `${name} is required`);
  return value;
};
const allowOnly = (payload: Record<string, unknown>, fields: string[]): void => {
  const extra = Object.keys(payload).find((key) => !fields.includes(key));
  if (extra) throw new FederationError('invalid_request', `Unexpected payload field: ${extra}`);
};
const envelope = (body: unknown, operation: string): SignedFederationRequest<Record<string, unknown>> => {
  const request = requireObject(body, 'request') as unknown as SignedFederationRequest<Record<string, unknown>>;
  for (const field of ['requestId', 'idempotencyKey', 'sourceInstanceId', 'destinationInstanceId', 'keyId', 'issuedAt', 'expiresAt', 'nonce', 'operation', 'signature'] as const) requireString(request[field], field);
  if (request.version !== 1 || request.operation !== operation) throw new FederationError('operation_mismatch', `Expected ${operation}`);
  requireObject(request.payload, 'payload');
  return request;
};

const validateGrant = (payload: Record<string, unknown>, mode: 'create' | 'update' | 'revoke'): void => {
  allowOnly(payload, mode === 'create' ? ['id', 'actorUri', 'scopes', 'policyVersionAccepted', 'expiresAt'] : mode === 'update' ? ['grantId', 'scopes', 'expiresAt', 'policyVersionAccepted'] : ['grantId']);
  requireString(payload.grantId ?? payload.id, 'grantId');
  if (payload.scopes !== undefined && (!Array.isArray(payload.scopes) || payload.scopes.some((scope) => !FEDERATION_SCOPES.includes(scope)))) throw new FederationError('invalid_scope', 'Unsupported federation scope');
};
const validateProfile = (payload: Record<string, unknown>): void => {
  allowOnly(payload, ['grantId', 'actorUri', 'remoteCreatorId', 'snapshot']);
  requireString(payload.grantId, 'grantId'); requireString(payload.actorUri, 'actorUri'); requireString(payload.remoteCreatorId, 'remoteCreatorId'); requireObject(payload.snapshot, 'snapshot');
};
const canonicalActorRouteId = (actorUri: string): string => {
  let actor: URL;
  try { actor = new URL(actorUri); } catch { throw new FederationError('invalid_actor', 'Profile actor URI is invalid'); }
  if (actor.protocol !== 'https:' || actor.username || actor.password || actor.hash) throw new FederationError('invalid_actor', 'Profile actor URI must be a canonical HTTPS URL');
  return Buffer.from(actor.toString(), 'utf8').toString('base64url');
};
const actorFromRoute = (value: string): string => {
  let actorUri: string;
  try { actorUri = Buffer.from(value, 'base64url').toString('utf8'); } catch { throw new FederationError('invalid_actor', 'Profile actor route is invalid'); }
  if (!actorUri || canonicalActorRouteId(actorUri) !== value) throw new FederationError('invalid_actor', 'Profile actor route must use canonical base64url encoding');
  return actorUri;
};
const validatePublication = (payload: Record<string, unknown>, update = false): void => {
  allowOnly(payload, update ? ['grantId', 'publicationId', 'expectedRevision', 'sourceRevision', 'metadataSnapshot', 'disclosureSnapshot', 'assets'] : ['grantId', 'id', 'sourceWorkUri', 'sourceRevision', 'metadataSnapshot', 'disclosureSnapshot', 'assets']);
  requireString(payload.grantId, 'grantId');
  if (update) requireString(payload.publicationId, 'publicationId');
  else { requireString(payload.id, 'id'); requireString(payload.sourceWorkUri, 'sourceWorkUri'); }
};

export const createFederationRouter = (options: FederationRouterOptions): Router => {
  const router = express.Router();
  const windows = new Map<string, { startedAt: number; count: number }>();
  router.use(express.json({ limit: '256kb', type: ['application/json', 'application/ubeeq+json'] }));
  router.use((req, _res, next) => {
    if (!req.is(['application/json', 'application/ubeeq+json']) && !['GET', 'HEAD'].includes(req.method)) return next(new FederationError('unsupported_media_type', 'Federation requests must use JSON'));
    const declaredBytes = Number(req.headers['content-length'] ?? 0);
    if (declaredBytes > 256 * 1024 || (req.body && Buffer.byteLength(JSON.stringify(req.body))) > 256 * 1024) return next(new FederationError('payload_too_large', 'Federation request exceeds 256 KiB'));
    const current = Date.now(); const limit = options.maximumRequestsPerMinute ?? 120;
    const consume = (key: string): boolean => {
      const value = windows.get(key);
      const bucket = !value || current - value.startedAt >= 60_000 ? { startedAt: current, count: 0 } : value;
      bucket.count += 1; windows.set(key, bucket);
      return bucket.count <= limit;
    };
    // Claimed instance identity is untrusted until signature verification. A
    // network-origin bucket is therefore always consumed first.
    const networkKey = `network:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    if (!consume(networkKey)) return next(new FederationError('rate_limited', 'Federation request rate exceeded'));
    const source = typeof req.body?.sourceInstanceId === 'string' ? req.body.sourceInstanceId : undefined;
    if (source && !consume(`source:${source}`)) return next(new FederationError('rate_limited', 'Federation source rate exceeded'));
    if (windows.size > RATE_LIMIT_BUCKET_CAPACITY) {
      for (const [key, bucket] of windows) if (current - bucket.startedAt >= 60_000) windows.delete(key);
      while (windows.size > RATE_LIMIT_BUCKET_CAPACITY) windows.delete(windows.keys().next().value as string);
    }
    next();
  });

  router.get('/.well-known/ubeeq', (_req, res) => res.json({ protocolVersions: [1], instance: options.instance }));
  router.get('/v1/actors', async (req, res, next) => {
    try {
      const actorUri = requireString(req.query.actorUri, 'actorUri');
      const actor = await options.resolveActor(actorUri);
      if (!actor) return res.status(404).json({ code: 'actor_not_found', message: 'Actor was not found' });
      return res.json(actor);
    } catch (error) { return next(error); }
  });
  router.post('/v1/grants', (req, res) => { const value = envelope(req.body, 'grant.request'); validateGrant(value.payload, 'create'); res.status(202).json(options.service.requestGrant(value as never)); });
  router.put('/v1/grants/:grantId', (req, res) => { const value = envelope(req.body, 'grant.update'); validateGrant(value.payload, 'update'); if (value.payload.grantId !== req.params.grantId) throw new FederationError('identity_mismatch', 'Grant path and payload differ'); res.json(options.service.updateGrant(value as never)); });
  router.delete('/v1/grants/:grantId', (req, res) => { const value = envelope(req.body, 'grant.revoke'); validateGrant(value.payload, 'revoke'); if (value.payload.grantId !== req.params.grantId) throw new FederationError('identity_mismatch', 'Grant path and payload differ'); res.json(options.service.revokeGrant(value as never)); });
  router.post('/v1/grants/:grantId/status', (req, res) => { const value = envelope(req.body, 'grant.status'); allowOnly(value.payload, ['grantId']); requireString(value.payload.grantId, 'grantId'); if (value.payload.grantId !== req.params.grantId) throw new FederationError('identity_mismatch', 'Grant path and payload differ'); return res.json(options.service.grantStatus(value as never)); });
  router.put('/v1/profiles/:actorId', (req, res) => { const value = envelope(req.body, 'profile.publish'); validateProfile(value.payload); const actorUri = actorFromRoute(req.params.actorId); if (value.payload.actorUri !== actorUri) throw new FederationError('identity_mismatch', 'Profile actor path and payload differ'); res.json(options.service.publishProfile(value as never)); });
  router.post('/v1/publications', (req, res) => { const value = envelope(req.body, 'publication.create'); validatePublication(value.payload); res.status(202).json(options.service.createPublication(value as never)); });
  router.put('/v1/publications/:publicationId', (req, res) => { const value = envelope(req.body, 'publication.update'); validatePublication(value.payload, true); if (value.payload.publicationId !== req.params.publicationId) throw new FederationError('identity_mismatch', 'Publication path and payload differ'); res.json(options.service.updatePublication(value as never)); });
  router.delete('/v1/publications/:publicationId', (req, res) => { const value = envelope(req.body, 'publication.withdraw'); validatePublication(value.payload, true); if (value.payload.publicationId !== req.params.publicationId) throw new FederationError('identity_mismatch', 'Publication path and payload differ'); res.json(options.service.withdrawPublication(value as never)); });
  router.post('/v1/publications/:publicationId/status', (req, res) => { const value = envelope(req.body, 'publication.status'); allowOnly(value.payload, ['grantId', 'publicationId']); requireString(value.payload.grantId, 'grantId'); requireString(value.payload.publicationId, 'publicationId'); if (value.payload.publicationId !== req.params.publicationId) throw new FederationError('identity_mismatch', 'Publication path and payload differ'); return res.json(options.service.publicationStatus(value as never)); });
  router.get('/v1/creators', (req, res) => { const actorUri = requireString(req.query.actorUri, 'actorUri'); const page = options.product.federatedCreatorPage(actorUri); return page ? res.json(page) : res.status(404).json({ code: 'creator_not_found', message: 'Federated creator was not found' }); });
  router.post('/v1/creators/home-link-consent', (req, res) => {
    const actorUri = requireString(req.body?.actorUri, 'actorUri');
    options.product.recordHomeProfileConsent(actorUri, new URL(options.instance.origin).hostname);
    return res.status(204).end();
  });
  router.post('/v1/callbacks', async (req, res, next) => {
    try {
      if (!options.receiveCallback) throw new FederationError('callback_unavailable', 'This instance does not accept federation callbacks');
      const value = envelope(req.body, 'status.callback'); await options.receiveCallback(value); return res.status(202).json({ accepted: true });
    } catch (error) { return next(error); }
  });

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') return res.status(413).json({ code: 'payload_too_large', message: 'Federation request exceeds 256 KiB', retryable: false });
    if (error instanceof FederationError) {
      const status = error.code === 'rate_limited' ? 429 : error.code === 'unsupported_media_type' ? 415 : error.code === 'payload_too_large' ? 413 : ['invalid_signature', 'invalid_key', 'untrusted_instance'].includes(error.code) ? 401 : 400;
      if (status === 429) res.setHeader('Retry-After', '60');
      return res.status(status).json({ code: error.code, message: error.message, retryable: status === 429 });
    }
    return res.status(500).json({ code: 'federation_internal_error', message: 'Federation request failed', retryable: true });
  });
  return router;
};
