import { randomUUID, type KeyObject } from 'node:crypto';
import { FederationError, signFederationRequest, type FederationDeliveryJob, type FederationInstanceMetadata, type FederationRepository, type ManagedFederationTrust, type SignedFederationRequest } from './federation';

export interface FederationCallbackPayload {
  callbackId: string;
  actorUri: string;
  homeInstanceId: string;
  destinationInstanceId: string;
  publicationId?: string;
  event: 'grant.status' | 'publication.status' | 'profile.status' | 'safety.status';
  status: string;
  occurredAt: string;
  detail?: Record<string, string | number | boolean>;
}
export interface FederationCallbackQueueMessage { job: FederationDeliveryJob; callback: FederationCallbackPayload; targetOrigin: string; }
export interface FederationCallbackQueue { enqueue(message: FederationCallbackQueueMessage, delaySeconds?: number): Promise<void>; }
export interface FederationCallbackPersistence {
  create(message: FederationCallbackQueueMessage): Promise<void>;
  update(job: FederationDeliveryJob): Promise<void>;
}
export interface FederationCallbackHttpResponse { status: number; }

export class FederationCallbackService {
  constructor(private readonly options: {
    localInstance: FederationInstanceMetadata; activeKeyId: string; privateKey: KeyObject | string;
    trust: ManagedFederationTrust;
    queue: FederationCallbackQueue; persistence: FederationCallbackPersistence;
    fetch?: (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<FederationCallbackHttpResponse>;
    now?: () => Date; maximumAttempts?: number; baseDelaySeconds?: number; timeoutMs?: number;
    observe?: (event: string, detail: Record<string, string | number | boolean>) => void;
  }) {}

  private observe(event: string, detail: Record<string, string | number | boolean>): void {
    try { this.options.observe?.(event, detail); } catch { /* Telemetry must never change callback delivery outcomes. */ }
  }

  async queue(payload: Omit<FederationCallbackPayload, 'callbackId' | 'occurredAt' | 'destinationInstanceId'>, target: FederationInstanceMetadata): Promise<FederationDeliveryJob> {
    const trustedTarget = this.options.trust.resolve(payload.homeInstanceId);
    if (!trustedTarget || target.instanceId !== payload.homeInstanceId || target.status === 'blocked' || trustedTarget.status === 'blocked' || trustedTarget.origin !== target.origin) throw new FederationError('callback_target_forbidden', 'Callback target is not an active trusted home instance');
    const now = this.options.now?.() ?? new Date();
    const callback: FederationCallbackPayload = { ...payload, callbackId: randomUUID(), occurredAt: now.toISOString(), destinationInstanceId: this.options.localInstance.instanceId };
    const job: FederationDeliveryJob = { id: callback.callbackId, idempotencyKey: `federation-callback:${callback.callbackId}`, operation: 'status.callback', status: 'queued', attemptCount: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    const message = { job, callback, targetOrigin: target.origin };
    await this.options.persistence.create(message); await this.options.queue.enqueue(message);
    this.observe('federation.callback.queued', { event: callback.event, targetInstanceId: target.instanceId });
    return job;
  }

  async deliver(message: FederationCallbackQueueMessage): Promise<FederationDeliveryJob> {
    const now = this.options.now?.() ?? new Date();
    const startedAt = now.getTime();
    try {
      return await this.deliverAttempt(message, now);
    } finally {
      this.observe('federation.callback.latency', { targetInstanceId: message.callback.homeInstanceId, event: message.callback.event, durationMs: Math.max(0, (this.options.now?.() ?? new Date()).getTime() - startedAt) });
    }
  }

  private async deliverAttempt(message: FederationCallbackQueueMessage, now: Date): Promise<FederationDeliveryJob> {
    const trustedTarget = this.options.trust.resolve(message.callback.homeInstanceId);
    if (!trustedTarget || trustedTarget.status === 'blocked' || trustedTarget.origin !== message.targetOrigin) throw new FederationError('callback_target_forbidden', 'Callback target does not match the managed trust registry');
    if (message.callback.destinationInstanceId !== this.options.localInstance.instanceId) throw new FederationError('callback_target_forbidden', 'Callback destination identity does not match this instance');
    const actor = new URL(message.callback.actorUri);
    const actorBase = new URL(trustedTarget.actorBaseUrl);
    if (actor.origin !== actorBase.origin || !actor.pathname.startsWith(`${actorBase.pathname.replace(/\/$/, '')}/`)) throw new FederationError('callback_target_forbidden', 'Callback actor is outside the trusted home actor namespace');
    const target = new URL('/federation/v1/callbacks', message.targetOrigin);
    if (target.protocol !== 'https:' || target.origin !== new URL(message.targetOrigin).origin) throw new FederationError('callback_target_forbidden', 'Callback target must be an HTTPS instance origin');
    const request = signFederationRequest({
      sourceInstanceId: this.options.localInstance.instanceId, destinationInstanceId: message.callback.homeInstanceId,
      keyId: this.options.activeKeyId, privateKey: this.options.privateKey, operation: 'status.callback', payload: message.callback,
      idempotencyKey: message.job.idempotencyKey, now
    });
    const fetcher = this.options.fetch ?? (async (url, init) => fetch(url, init));
    let status = 503;
    try { status = (await fetcher(target.toString(), { method: 'POST', headers: { 'Content-Type': 'application/ubeeq+json', Accept: 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000) })).status; } catch { status = 503; }
    const attemptCount = message.job.attemptCount + 1;
    const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
    const retry = retryable && attemptCount < (this.options.maximumAttempts ?? 5);
    const delay = Math.min(900, (this.options.baseDelaySeconds ?? 30) * (2 ** Math.max(0, attemptCount - 1)));
    const job: FederationDeliveryJob = {
      ...message.job, attemptCount, status: status >= 200 && status < 300 ? 'delivered' : retry ? 'retry_scheduled' : 'dead_letter',
      nextAttemptAt: retry ? new Date(now.getTime() + delay * 1000).toISOString() : undefined,
      lastError: status >= 200 && status < 300 ? undefined : `HTTP ${status}`, updatedAt: now.toISOString()
    };
    await this.options.persistence.update(job);
    if (retry) await this.options.queue.enqueue({ ...message, job }, delay);
    this.observe(`federation.callback.${job.status}`, { status, attemptCount, targetInstanceId: message.callback.homeInstanceId });
    return job;
  }
}

export const parseFederationCallbackRequest = (request: SignedFederationRequest<unknown>): FederationCallbackPayload => {
  if (request.operation !== 'status.callback' || !request.payload || typeof request.payload !== 'object') throw new FederationError('invalid_callback', 'Expected a status callback payload');
  const payload = request.payload as FederationCallbackPayload;
  if (!payload.callbackId || !payload.actorUri || !payload.homeInstanceId || !payload.destinationInstanceId || !payload.event || !payload.status || !payload.occurredAt) throw new FederationError('invalid_callback', 'Status callback is missing required fields');
  if (payload.homeInstanceId !== request.destinationInstanceId || payload.destinationInstanceId !== request.sourceInstanceId) throw new FederationError('invalid_callback', 'Callback instance identities do not match the signed envelope');
  return structuredClone(payload);
};

export class FederationCallbackReceiver {
  constructor(private readonly options: { instanceId: string; trust: ManagedFederationTrust; repository: FederationRepository; apply(payload: FederationCallbackPayload): Promise<void>; now?: () => Date }) {}
  async receive(request: SignedFederationRequest<Record<string, unknown>>): Promise<void> {
    this.options.trust.verify(request, this.options.instanceId, this.options.repository, this.options.now?.() ?? new Date());
    await this.options.apply(parseFederationCallbackRequest(request));
  }
}
