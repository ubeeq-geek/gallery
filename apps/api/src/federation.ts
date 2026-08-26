import { createHash, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const FEDERATION_SCOPES = [
  'profile:publish',
  'publication:create',
  'publication:update',
  'publication:withdraw',
  'publication:status',
  'activity:read'
] as const;

export type FederationScope = typeof FEDERATION_SCOPES[number];
export type FederationBrand = 'eversally' | 'nightframe' | 'ubeeq';
export type GrantStatus = 'pending' | 'active' | 'restricted' | 'revoked' | 'expired';
export type TrustState = 'pending' | 'trusted' | 'restricted' | 'blocked';
export type ModerationState = 'active' | 'limited' | 'suspended';
export type LocalPublicationStatus = 'pending' | 'processing' | 'published' | 'rejected' | 'held' | 'withdrawn' | 'removed';
export type SourcePublicationStatus = 'active' | 'updated' | 'withdrawn' | 'unavailable';
export type FederationEvent =
  | 'GRANT_REQUESTED'
  | 'GRANT_STATUS_CHANGED'
  | 'GRANT_REVOKED'
  | 'PROFILE_PUBLISHED'
  | 'PROFILE_MODERATED'
  | 'PUBLICATION_CREATED'
  | 'PUBLICATION_UPDATED'
  | 'PUBLICATION_WITHDRAWN'
  | 'PUBLICATION_MODERATED'
  | 'PUBLICATION_REMOVED'
  | 'CREATOR_BLOCKED'
  | 'INSTANCE_BLOCKED'
  | 'HOME_PROFILE_LINK_CHANGED'
  | 'HOME_PROFILE_LINK_CONSENT'
  | 'STATUS_CALLBACK_QUEUED'
  | 'DELIVERY_REPLAYED'
  | 'SOURCE_UNAVAILABLE'
  | 'LEGAL_HOLD'
  | 'SAFETY_ALERT';

export interface FederationKeyMetadata {
  keyId: string;
  algorithm: 'Ed25519';
  publicKeyPem: string;
  validFrom: string;
  validUntil?: string;
  revokedAt?: string;
}

export interface FederationInstanceMetadata {
  instanceId: string;
  metadataRevision: number;
  metadataUpdatedAt: string;
  brand: FederationBrand;
  name: string;
  origin: string;
  actorBaseUrl: string;
  policyVersion: string;
  keys: FederationKeyMetadata[];
  status: 'trusted' | 'restricted' | 'blocked';
}

export interface FederationGrant {
  id: string;
  actorUri: string;
  homeInstanceId: string;
  destinationInstanceId: string;
  scopes: FederationScope[];
  status: GrantStatus;
  policyVersionAccepted: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  restrictionReason?: string;
}

export interface FederatedAssetReference {
  assetUri: string;
  deliveryUrl: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  expiresAt: string;
}

export interface DestinationProfileSnapshot {
  displayName: string;
  handle: string;
  avatarAsset?: FederatedAssetReference;
  shortBio?: string;
  approvedLinks?: Array<{ label: string; url: string }>;
  publicAttribution: { homeInstanceName: string; homeInstanceUrl: string };
  revision: number;
}

export interface RemoteCreatorProjection {
  id: string;
  actorUri: string;
  homeInstanceId: string;
  remoteCreatorId: string;
  displayName: string;
  handle: string;
  avatarUrl?: string;
  destinationProfileSnapshot: DestinationProfileSnapshot;
  profileRevision: number;
  trustState: TrustState;
  moderationState: ModerationState;
  profileVisible: boolean;
  homeProfileLinkEnabled: boolean;
  homeProfileLinkSuppressedReason?: string;
  firstSeenAt: string;
  lastSyncedAt: string;
}

export interface FederatedPublication {
  id: string;
  grantId: string;
  sourceInstanceId: string;
  sourceActorUri: string;
  sourceWorkUri: string;
  sourceRevision: number;
  /** Latest source revision approved for destination presentation. */
  appliedSourceRevision?: number;
  metadataSnapshot: Readonly<Record<string, unknown>>;
  disclosureSnapshot: Readonly<Record<string, unknown>>;
  assets: FederatedAssetReference[];
  localStatus: LocalPublicationStatus;
  sourceStatus: SourcePublicationStatus;
  moderationState: string;
  legalHold: boolean;
  publishedAt?: string;
  lastSynchronizedAt: string;
}

export interface FederationAuditRecord {
  id: string;
  event: FederationEvent;
  actorUri?: string;
  instanceId: string;
  grantId?: string;
  publicationId?: string;
  profileRevision?: number;
  detail: Readonly<Record<string, string | number | boolean>>;
  occurredAt: string;
}

export interface SignedFederationRequest<T = unknown> {
  version: 1;
  requestId: string;
  idempotencyKey: string;
  sourceInstanceId: string;
  destinationInstanceId: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  operation: string;
  payload: T;
  signature: string;
}

export interface FederationDeliveryJob {
  id: string;
  idempotencyKey: string;
  operation: string;
  status: 'queued' | 'processing' | 'retry_scheduled' | 'delivered' | 'dead_letter';
  attemptCount: number;
  nextAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FederationRepository {
  getGrant(id: string): FederationGrant | undefined;
  findGrant(actorUri: string, destinationInstanceId: string): FederationGrant | undefined;
  listGrants(): FederationGrant[];
  saveGrant(grant: FederationGrant): void;
  getProjection(actorUri: string): RemoteCreatorProjection | undefined;
  saveProjection(projection: RemoteCreatorProjection): void;
  listProjections(): RemoteCreatorProjection[];
  getPublication(id: string): FederatedPublication | undefined;
  findPublication(sourceWorkUri: string): FederatedPublication | undefined;
  listPublications(): FederatedPublication[];
  savePublication(publication: FederatedPublication): void;
  appendAudit(record: FederationAuditRecord): void;
  listAudit(): FederationAuditRecord[];
  hasReplay(sourceInstanceId: string, nonce: string): boolean;
  recordReplay(sourceInstanceId: string, nonce: string, expiresAt: string): void;
  getIdempotentResult(key: string): unknown;
  saveIdempotentResult(key: string, result: unknown): void;
  saveDelivery(job: FederationDeliveryJob): void;
  getDelivery(id: string): FederationDeliveryJob | undefined;
  listDeliveries(): FederationDeliveryJob[];
}

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryFederationRepository implements FederationRepository {
  protected readonly grants = new Map<string, FederationGrant>();
  protected readonly projections = new Map<string, RemoteCreatorProjection>();
  protected readonly publications = new Map<string, FederatedPublication>();
  protected readonly audit: FederationAuditRecord[] = [];
  protected readonly replay = new Map<string, string>();
  protected readonly idempotency = new Map<string, unknown>();
  protected readonly deliveries = new Map<string, FederationDeliveryJob>();

  getGrant(id: string) { const value = this.grants.get(id); return value && clone(value); }
  findGrant(actorUri: string, destinationInstanceId: string) {
    const value = [...this.grants.values()].find((grant) => grant.actorUri === actorUri && grant.destinationInstanceId === destinationInstanceId);
    return value && clone(value);
  }
  listGrants() { return [...this.grants.values()].map(clone); }
  saveGrant(grant: FederationGrant) { this.grants.set(grant.id, clone(grant)); }
  getProjection(actorUri: string) { const value = this.projections.get(actorUri); return value && clone(value); }
  saveProjection(projection: RemoteCreatorProjection) { this.projections.set(projection.actorUri, clone(projection)); }
  listProjections() { return [...this.projections.values()].map(clone); }
  getPublication(id: string) { const value = this.publications.get(id); return value && clone(value); }
  findPublication(sourceWorkUri: string) {
    const value = [...this.publications.values()].find((publication) => publication.sourceWorkUri === sourceWorkUri);
    return value && clone(value);
  }
  listPublications() { return [...this.publications.values()].map(clone); }
  savePublication(publication: FederatedPublication) { this.publications.set(publication.id, clone(publication)); }
  appendAudit(record: FederationAuditRecord) { this.audit.push(clone(record)); }
  listAudit() { return clone(this.audit); }
  hasReplay(sourceInstanceId: string, nonce: string) {
    return this.replay.has(`${sourceInstanceId}:${nonce}`);
  }
  recordReplay(sourceInstanceId: string, nonce: string, expiresAt: string) { this.replay.set(`${sourceInstanceId}:${nonce}`, expiresAt); }
  getIdempotentResult(key: string) { const value = this.idempotency.get(key); return value === undefined ? undefined : clone(value); }
  saveIdempotentResult(key: string, result: unknown) { this.idempotency.set(key, clone(result)); }
  saveDelivery(job: FederationDeliveryJob) { this.deliveries.set(job.id, clone(job)); }
  getDelivery(id: string) { const value = this.deliveries.get(id); return value && clone(value); }
  listDeliveries() { return [...this.deliveries.values()].map(clone); }
}

interface FederationRepositoryState {
  grants: FederationGrant[];
  projections: RemoteCreatorProjection[];
  publications: FederatedPublication[];
  audit: FederationAuditRecord[];
  replay: Array<[string, string]>;
  idempotency: Array<[string, unknown]>;
  deliveries: FederationDeliveryJob[];
}

/** Atomic JSON persistence for single-process managed deployments and local recovery. */
export class AtomicFileFederationRepository extends InMemoryFederationRepository {
  constructor(private readonly filename: string) {
    super();
    if (existsSync(filename)) this.restore(JSON.parse(readFileSync(filename, 'utf8')) as FederationRepositoryState);
  }

  override saveGrant(grant: FederationGrant): void { super.saveGrant(grant); this.persist(); }
  override saveProjection(projection: RemoteCreatorProjection): void { super.saveProjection(projection); this.persist(); }
  override savePublication(publication: FederatedPublication): void { super.savePublication(publication); this.persist(); }
  override appendAudit(record: FederationAuditRecord): void { super.appendAudit(record); this.persist(); }
  override recordReplay(sourceInstanceId: string, nonce: string, expiresAt: string): void { super.recordReplay(sourceInstanceId, nonce, expiresAt); this.persist(); }
  override saveIdempotentResult(key: string, result: unknown): void { super.saveIdempotentResult(key, result); this.persist(); }
  override saveDelivery(job: FederationDeliveryJob): void { super.saveDelivery(job); this.persist(); }

  private restore(state: FederationRepositoryState): void {
    for (const value of state.grants ?? []) this.grants.set(value.id, clone(value));
    for (const value of state.projections ?? []) this.projections.set(value.actorUri, clone(value));
    for (const value of state.publications ?? []) this.publications.set(value.id, clone(value));
    this.audit.push(...clone(state.audit ?? []));
    for (const [key, value] of state.replay ?? []) this.replay.set(key, value);
    for (const [key, value] of state.idempotency ?? []) this.idempotency.set(key, clone(value));
    for (const value of state.deliveries ?? []) this.deliveries.set(value.id, clone(value));
  }

  private persist(): void {
    const state: FederationRepositoryState = {
      grants: [...this.grants.values()], projections: [...this.projections.values()], publications: [...this.publications.values()],
      audit: this.audit, replay: [...this.replay.entries()], idempotency: [...this.idempotency.entries()], deliveries: [...this.deliveries.values()]
    };
    mkdirSync(dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.filename);
  }
}

export class FederationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
};

const canonicalRequest = (request: Omit<SignedFederationRequest, 'signature'>): Buffer => Buffer.from(canonicalJson(request));

export const signFederationRequest = <T>(input: {
  sourceInstanceId: string;
  destinationInstanceId: string;
  keyId: string;
  privateKey: KeyObject | string;
  operation: string;
  payload: T;
  idempotencyKey: string;
  now?: Date;
  ttlSeconds?: number;
  requestId?: string;
  nonce?: string;
}): SignedFederationRequest<T> => {
  const now = input.now ?? new Date();
  const unsigned: Omit<SignedFederationRequest<T>, 'signature'> = {
    version: 1,
    requestId: input.requestId ?? randomUUID(),
    idempotencyKey: input.idempotencyKey,
    sourceInstanceId: input.sourceInstanceId,
    destinationInstanceId: input.destinationInstanceId,
    keyId: input.keyId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlSeconds ?? 300) * 1000).toISOString(),
    nonce: input.nonce ?? randomUUID(),
    operation: input.operation,
    payload: input.payload
  };
  return { ...unsigned, signature: sign(null, canonicalRequest(unsigned), input.privateKey).toString('base64url') };
};

export class ManagedFederationTrust {
  private readonly instances = new Map<string, FederationInstanceMetadata>();
  constructor(private readonly observe: (signal: string) => void = () => undefined) {}

  register(metadata: FederationInstanceMetadata): void {
    const origin = new URL(metadata.origin);
    const actorBase = new URL(metadata.actorBaseUrl);
    if (origin.protocol !== 'https:' || actorBase.protocol !== 'https:' || actorBase.origin !== origin.origin) {
      throw new FederationError('invalid_instance_metadata', 'Instance and actor URLs must use the same HTTPS origin');
    }
    if (!Number.isInteger(metadata.metadataRevision) || metadata.metadataRevision < 1 || !Number.isFinite(Date.parse(metadata.metadataUpdatedAt))) {
      throw new FederationError('invalid_instance_metadata', 'Instance metadata requires a positive revision and update timestamp');
    }
    if (!metadata.keys.length || new Set(metadata.keys.map((key) => key.keyId)).size !== metadata.keys.length) {
      throw new FederationError('invalid_instance_metadata', 'Instance metadata requires unique signing keys');
    }
    for (const key of metadata.keys) {
      if (key.algorithm !== 'Ed25519' || !key.keyId || !Number.isFinite(Date.parse(key.validFrom)) || (key.validUntil && Date.parse(key.validUntil) <= Date.parse(key.validFrom))) {
        throw new FederationError('invalid_instance_metadata', 'Instance signing-key metadata is invalid');
      }
      createPublicKey(key.publicKeyPem);
    }
    const previous = this.instances.get(metadata.instanceId);
    if (previous) {
      if (metadata.metadataRevision <= previous.metadataRevision) throw new FederationError('metadata_rollback', 'Instance metadata revision must increase');
      if (previous.origin !== metadata.origin || previous.actorBaseUrl !== metadata.actorBaseUrl || previous.brand !== metadata.brand) {
        throw new FederationError('instance_identity_changed', 'Immutable instance identity metadata cannot change during key rotation');
      }
      const now = Date.parse(metadata.metadataUpdatedAt);
      const hasUsableKey = metadata.keys.some((key) => !key.revokedAt && Date.parse(key.validFrom) <= now && (!key.validUntil || Date.parse(key.validUntil) > now));
      if (metadata.status !== 'blocked' && !hasUsableKey) throw new FederationError('invalid_key_rotation', 'A non-blocked instance must retain a usable signing key');
    }
    this.instances.set(metadata.instanceId, clone(metadata));
  }

  list(): FederationInstanceMetadata[] { return [...this.instances.values()].map(clone); }

  resolve(instanceId: string): FederationInstanceMetadata | undefined {
    const value = this.instances.get(instanceId);
    return value && clone(value);
  }

  block(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new FederationError('unknown_instance', 'Instance is not registered');
    this.instances.set(instanceId, { ...instance, status: 'blocked' });
  }

  verify<T>(request: SignedFederationRequest<T>, audience: string, repository: FederationRepository, now = new Date()): void {
    if (request.version !== 1 || request.destinationInstanceId !== audience) {
      this.observe('federation.verify.invalid_audience');
      throw new FederationError('invalid_audience', 'Federation request audience does not match this instance');
    }
    const source = this.instances.get(request.sourceInstanceId);
    if (!source || source.status === 'blocked') { this.observe('federation.verify.untrusted_instance'); throw new FederationError('untrusted_instance', 'Source instance is not trusted'); }
    const key = source.keys.find((candidate) => candidate.keyId === request.keyId);
    if (!key || key.revokedAt || Date.parse(key.validFrom) > now.getTime() || (key.validUntil && Date.parse(key.validUntil) <= now.getTime())) {
      this.observe('federation.verify.invalid_key');
      throw new FederationError('invalid_key', 'Signing key is unknown, revoked, or outside its validity period');
    }
    const issuedAt = Date.parse(request.issuedAt);
    const expiresAt = Date.parse(request.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now.getTime() + 30_000 || expiresAt <= now.getTime() || expiresAt - issuedAt > 300_000) {
      this.observe('federation.verify.expired_request');
      throw new FederationError('expired_request', 'Federation request is expired or has an invalid lifetime');
    }
    const { signature, ...unsigned } = request;
    if (!verify(null, canonicalRequest(unsigned), createPublicKey(key.publicKeyPem), Buffer.from(signature, 'base64url'))) {
      this.observe('federation.verify.invalid_signature');
      throw new FederationError('invalid_signature', 'Federation request signature is invalid');
    }
    if (repository.hasReplay(request.sourceInstanceId, request.nonce)) { this.observe('federation.verify.replay'); throw new FederationError('replay_detected', 'Federation request nonce was already used'); }
    repository.recordReplay(request.sourceInstanceId, request.nonce, request.expiresAt);
  }
}

export interface DestinationProfilePolicy {
  displayNameMax: number;
  handleMax: number;
  shortBioMax: number;
  maximumLinks: number;
  allowedLinkHosts?: string[];
  avatarMimeTypes: string[];
  avatarMaximumBytes: number;
}

export interface FederationServiceOptions {
  instance: FederationInstanceMetadata;
  repository: FederationRepository;
  trust: ManagedFederationTrust;
  profilePolicy: DestinationProfilePolicy;
  allowedRatings?: string[];
  observe?: (signal: string) => void;
  now?: () => Date;
}

const actorBelongsTo = (actorUri: string, instance: FederationInstanceMetadata): boolean => {
  try {
    const actor = new URL(actorUri);
    const base = new URL(instance.actorBaseUrl);
    return actor.protocol === 'https:' && actor.origin === base.origin && actor.pathname.startsWith(base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`);
  } catch { return false; }
};

const resourceBelongsTo = (resourceUri: string, instance: FederationInstanceMetadata): boolean => {
  try {
    const resource = new URL(resourceUri);
    return resource.protocol === 'https:' && resource.origin === new URL(instance.origin).origin;
  } catch { return false; }
};

const immutableSnapshot = (value: Record<string, unknown>): Readonly<Record<string, unknown>> => Object.freeze(clone(value));
const checksum = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

export class FederationService {
  private readonly now: () => Date;
  constructor(private readonly options: FederationServiceOptions) { this.now = options.now ?? (() => new Date()); }

  private audit(event: FederationEvent, values: Omit<FederationAuditRecord, 'id' | 'event' | 'instanceId' | 'occurredAt' | 'detail'> & { detail?: FederationAuditRecord['detail'] }): void {
    this.options.repository.appendAudit({
      id: randomUUID(), event, instanceId: this.options.instance.instanceId, occurredAt: this.now().toISOString(),
      ...values, detail: Object.freeze({ ...(values.detail ?? {}) })
    });
  }

  private authenticated<T, R>(request: SignedFederationRequest<T>, scope: FederationScope | undefined, operation: (payload: T) => R): R {
    const cacheKey = `${request.sourceInstanceId}:${request.operation}:${request.idempotencyKey}`;
    this.options.trust.verify(request, this.options.instance.instanceId, this.options.repository, this.now());
    const cached = this.options.repository.getIdempotentResult(cacheKey) as R | undefined;
    if (cached !== undefined) return cached;
    if (scope) {
      const payload = request.payload as { grantId?: string };
      const grant = payload.grantId ? this.requireActiveGrant(payload.grantId, scope) : undefined;
      if (grant && grant.homeInstanceId !== request.sourceInstanceId) throw new FederationError('wrong_home_instance', 'Grant does not belong to the signing home instance');
    }
    const result = operation(request.payload);
    this.options.repository.saveIdempotentResult(cacheKey, result);
    return clone(result);
  }

  private requireActiveGrant(id: string, scope: FederationScope): FederationGrant {
    const grant = this.options.repository.getGrant(id);
    if (!grant) throw new FederationError('grant_not_found', 'Federation grant was not found');
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= this.now().getTime()) {
      const expired = { ...grant, status: 'expired' as const, updatedAt: this.now().toISOString() };
      this.options.repository.saveGrant(expired);
      throw new FederationError('grant_expired', 'Federation grant has expired');
    }
    if (!['active', 'restricted'].includes(grant.status) || !grant.scopes.includes(scope)) {
      throw new FederationError('grant_forbidden', `Grant does not allow ${scope}`);
    }
    return grant;
  }

  requestGrant(request: SignedFederationRequest<{
    id: string; actorUri: string; scopes: FederationScope[]; policyVersionAccepted: string; expiresAt?: string;
  }>): FederationGrant {
    return this.authenticated(request, undefined, (payload) => {
      const home = this.options.trust.resolve(request.sourceInstanceId);
      if (!home || !actorBelongsTo(payload.actorUri, home)) throw new FederationError('invalid_actor', 'Actor URI is not owned by the signing home instance');
      assertManagedFederationRoute(home.brand, this.options.instance.brand);
      if (payload.policyVersionAccepted !== this.options.instance.policyVersion) throw new FederationError('policy_mismatch', 'Destination policy version was not accepted');
      if (payload.scopes.length === 0 || payload.scopes.some((scope) => !FEDERATION_SCOPES.includes(scope))) throw new FederationError('invalid_scope', 'Grant contains an unsupported scope');
      if (this.options.repository.findGrant(payload.actorUri, this.options.instance.instanceId)) throw new FederationError('grant_exists', 'A grant already exists for this actor and destination');
      const now = this.now().toISOString();
      const grant: FederationGrant = {
        id: payload.id, actorUri: payload.actorUri, homeInstanceId: request.sourceInstanceId,
        destinationInstanceId: this.options.instance.instanceId, scopes: [...new Set(payload.scopes)], status: 'pending',
        policyVersionAccepted: payload.policyVersionAccepted, createdAt: now, updatedAt: now, expiresAt: payload.expiresAt
      };
      this.options.repository.saveGrant(grant);
      this.audit('GRANT_REQUESTED', { actorUri: grant.actorUri, grantId: grant.id, detail: { scopeCount: grant.scopes.length } });
      return grant;
    });
  }

  decideGrant(id: string, status: 'active' | 'restricted' | 'revoked', restrictionReason?: string): FederationGrant {
    const grant = this.options.repository.getGrant(id);
    if (!grant) throw new FederationError('grant_not_found', 'Federation grant was not found');
    if (grant.status === 'revoked') throw new FederationError('grant_revoked', 'Revoked grants cannot be reactivated');
    const updated = { ...grant, status, restrictionReason, updatedAt: this.now().toISOString() };
    this.options.repository.saveGrant(updated);
    if (status === 'revoked') {
      for (const publication of this.options.repository.listPublications().filter((item) => item.grantId === id && !['withdrawn', 'removed'].includes(item.localStatus))) {
        this.options.repository.savePublication({ ...publication, localStatus: 'withdrawn', lastSynchronizedAt: this.now().toISOString() });
      }
    }
    this.audit(status === 'revoked' ? 'GRANT_REVOKED' : 'GRANT_STATUS_CHANGED', { actorUri: grant.actorUri, grantId: id, detail: { status } });
    return updated;
  }

  revokeGrant(request: SignedFederationRequest<{ grantId: string }>): FederationGrant {
    return this.authenticated(request, undefined, ({ grantId }) => {
      const grant = this.options.repository.getGrant(grantId);
      if (!grant || grant.homeInstanceId !== request.sourceInstanceId) throw new FederationError('grant_not_found', 'Federation grant was not found');
      return this.decideGrant(grantId, 'revoked');
    });
  }

  updateGrant(request: SignedFederationRequest<{ grantId: string; scopes: FederationScope[]; expiresAt?: string; policyVersionAccepted: string }>): FederationGrant {
    return this.authenticated(request, undefined, (payload) => {
      const grant = this.options.repository.getGrant(payload.grantId);
      if (!grant || grant.homeInstanceId !== request.sourceInstanceId) throw new FederationError('grant_not_found', 'Federation grant was not found');
      if (grant.status === 'revoked') throw new FederationError('grant_revoked', 'Revoked grants cannot be updated');
      if (payload.policyVersionAccepted !== this.options.instance.policyVersion) throw new FederationError('policy_mismatch', 'Destination policy version was not accepted');
      if (payload.scopes.length === 0 || payload.scopes.some((scope) => !FEDERATION_SCOPES.includes(scope))) throw new FederationError('invalid_scope', 'Grant contains an unsupported scope');
      const updated = { ...grant, scopes: [...new Set(payload.scopes)], expiresAt: payload.expiresAt, policyVersionAccepted: payload.policyVersionAccepted, updatedAt: this.now().toISOString() };
      this.options.repository.saveGrant(updated);
      this.audit('GRANT_STATUS_CHANGED', { actorUri: grant.actorUri, grantId: grant.id, detail: { status: grant.status, scopeCount: updated.scopes.length } });
      return updated;
    });
  }

  grantStatus(request: SignedFederationRequest<{ grantId: string }>): FederationGrant {
    return this.authenticated(request, undefined, ({ grantId }) => {
      const grant = this.options.repository.getGrant(grantId);
      if (!grant || grant.homeInstanceId !== request.sourceInstanceId) throw new FederationError('grant_not_found', 'Federation grant was not found');
      return grant;
    });
  }

  publicationStatus(request: SignedFederationRequest<{ grantId: string; publicationId: string }>): FederatedPublication {
    return this.authenticated(request, 'publication:status', ({ grantId, publicationId }) => {
      const publication = this.options.repository.getPublication(publicationId);
      if (!publication || publication.grantId !== grantId || publication.sourceInstanceId !== request.sourceInstanceId) throw new FederationError('publication_not_found', 'Federated publication was not found');
      return publication;
    });
  }

  publishProfile(request: SignedFederationRequest<{ grantId: string; actorUri: string; remoteCreatorId: string; snapshot: DestinationProfileSnapshot }>): RemoteCreatorProjection {
    return this.authenticated(request, 'profile:publish', ({ grantId, actorUri, remoteCreatorId, snapshot }) => {
      const grant = this.requireActiveGrant(grantId, 'profile:publish');
      if (actorUri !== grant.actorUri) throw new FederationError('actor_mismatch', 'Profile actor does not match the immutable grant actor');
      this.validateProfile(snapshot, grant);
      const existing = this.options.repository.getProjection(grant.actorUri);
      if (existing && snapshot.revision <= existing.profileRevision) throw new FederationError('stale_revision', 'Profile revision must increase monotonically');
      const now = this.now().toISOString();
      const projection: RemoteCreatorProjection = {
        id: existing?.id ?? randomUUID(), actorUri: grant.actorUri, homeInstanceId: grant.homeInstanceId, remoteCreatorId,
        displayName: snapshot.displayName, handle: snapshot.handle, avatarUrl: snapshot.avatarAsset?.deliveryUrl,
        destinationProfileSnapshot: clone(snapshot), profileRevision: snapshot.revision,
        trustState: existing?.trustState ?? 'trusted', moderationState: existing?.moderationState ?? 'active',
        profileVisible: existing?.profileVisible ?? true, homeProfileLinkEnabled: existing?.homeProfileLinkEnabled ?? false,
        homeProfileLinkSuppressedReason: existing?.homeProfileLinkSuppressedReason,
        firstSeenAt: existing?.firstSeenAt ?? now, lastSyncedAt: now
      };
      this.options.repository.saveProjection(projection);
      this.audit('PROFILE_PUBLISHED', { actorUri: grant.actorUri, grantId, profileRevision: snapshot.revision, detail: { snapshotHash: checksum(snapshot) } });
      return projection;
    });
  }

  private validateProfile(snapshot: DestinationProfileSnapshot, grant: FederationGrant): void {
    const policy = this.options.profilePolicy;
    if (!snapshot.displayName.trim() || snapshot.displayName.length > policy.displayNameMax || !snapshot.handle.trim() || snapshot.handle.length > policy.handleMax || (snapshot.shortBio?.length ?? 0) > policy.shortBioMax) {
      throw new FederationError('invalid_profile', 'Distribution profile exceeds destination field limits');
    }
    if (snapshot.revision < 1 || !Number.isInteger(snapshot.revision)) throw new FederationError('invalid_revision', 'Profile revision must be a positive integer');
    if ((snapshot.approvedLinks?.length ?? 0) > policy.maximumLinks) throw new FederationError('invalid_profile', 'Distribution profile has too many links');
    for (const link of snapshot.approvedLinks ?? []) {
      const url = new URL(link.url);
      if (url.protocol !== 'https:' || (policy.allowedLinkHosts && !policy.allowedLinkHosts.includes(url.hostname))) throw new FederationError('invalid_profile_link', 'Profile links must satisfy destination policy');
    }
    if (snapshot.avatarAsset && (!policy.avatarMimeTypes.includes(snapshot.avatarAsset.mimeType) || snapshot.avatarAsset.sizeBytes > policy.avatarMaximumBytes)) {
      throw new FederationError('invalid_avatar', 'Avatar does not satisfy destination policy');
    }
    const home = this.options.trust.resolve(grant.homeInstanceId);
    if (!home || snapshot.publicAttribution.homeInstanceName !== home.name || snapshot.publicAttribution.homeInstanceUrl !== home.origin) {
      throw new FederationError('invalid_attribution', 'Public attribution must match verified instance metadata');
    }
  }

  moderateProfile(actorUri: string, input: { trustState?: TrustState; moderationState?: ModerationState; visible?: boolean; reason: string }): RemoteCreatorProjection {
    const projection = this.options.repository.getProjection(actorUri);
    if (!projection) throw new FederationError('projection_not_found', 'Remote creator projection was not found');
    const updated = { ...projection, trustState: input.trustState ?? projection.trustState, moderationState: input.moderationState ?? projection.moderationState, profileVisible: input.visible ?? projection.profileVisible, lastSyncedAt: this.now().toISOString() };
    this.options.repository.saveProjection(updated);
    this.audit(updated.trustState === 'blocked' ? 'CREATOR_BLOCKED' : 'PROFILE_MODERATED', { actorUri, profileRevision: updated.profileRevision, detail: { reason: input.reason, visible: updated.profileVisible } });
    return updated;
  }

  createPublication(request: SignedFederationRequest<{
    grantId: string; id: string; sourceWorkUri: string; sourceRevision: number; metadataSnapshot: Record<string, unknown>;
    disclosureSnapshot: Record<string, unknown>; assets: FederatedAssetReference[];
  }>): FederatedPublication {
    return this.authenticated(request, 'publication:create', (payload) => {
      const grant = this.requireActiveGrant(payload.grantId, 'publication:create');
      if (!resourceBelongsTo(payload.sourceWorkUri, this.options.trust.resolve(grant.homeInstanceId)!)) throw new FederationError('invalid_work_uri', 'Source Work URI is not owned by the home instance');
      if (this.options.repository.findPublication(payload.sourceWorkUri)) throw new FederationError('publication_exists', 'Source Work is already published to this destination');
      if (!Number.isInteger(payload.sourceRevision) || payload.sourceRevision < 1) throw new FederationError('invalid_revision', 'Source revision must be a positive integer');
      this.validateDisclosure(payload.disclosureSnapshot);
      payload.assets.forEach((asset) => this.validateAsset(asset));
      this.validateDisclosure(payload.disclosureSnapshot);
      const now = this.now().toISOString();
      const publication: FederatedPublication = {
        id: payload.id, grantId: payload.grantId, sourceInstanceId: grant.homeInstanceId, sourceActorUri: grant.actorUri,
        sourceWorkUri: payload.sourceWorkUri, sourceRevision: payload.sourceRevision,
        metadataSnapshot: immutableSnapshot(payload.metadataSnapshot), disclosureSnapshot: immutableSnapshot(payload.disclosureSnapshot),
        assets: clone(payload.assets), localStatus: 'processing', sourceStatus: 'active', moderationState: 'pending', legalHold: false,
        lastSynchronizedAt: now
      };
      this.options.repository.savePublication(publication);
      this.audit('PUBLICATION_CREATED', { actorUri: grant.actorUri, grantId: grant.id, publicationId: publication.id, detail: { sourceRevision: publication.sourceRevision, metadataHash: checksum(publication.metadataSnapshot), disclosureHash: checksum(publication.disclosureSnapshot) } });
      return publication;
    });
  }

  updatePublication(request: SignedFederationRequest<{
    grantId: string; publicationId: string; expectedRevision: number; sourceRevision: number;
    metadataSnapshot: Record<string, unknown>; disclosureSnapshot: Record<string, unknown>; assets: FederatedAssetReference[];
  }>): FederatedPublication {
    return this.authenticated(request, 'publication:update', (payload) => {
      const grant = this.requireActiveGrant(payload.grantId, 'publication:update');
      const publication = this.options.repository.getPublication(payload.publicationId);
      if (!publication || publication.sourceActorUri !== grant.actorUri) throw new FederationError('publication_not_found', 'Federated publication was not found');
      if (publication.sourceRevision !== payload.expectedRevision || payload.sourceRevision <= publication.sourceRevision) throw new FederationError('revision_conflict', 'Publication revision precondition failed');
      payload.assets.forEach((asset) => this.validateAsset(asset));
      const updated: FederatedPublication = {
        ...publication, sourceRevision: payload.sourceRevision, metadataSnapshot: immutableSnapshot(payload.metadataSnapshot),
        disclosureSnapshot: immutableSnapshot(payload.disclosureSnapshot), assets: clone(payload.assets), sourceStatus: 'updated',
        localStatus: 'processing', moderationState: 'pending_revision', lastSynchronizedAt: this.now().toISOString()
      };
      this.options.repository.savePublication(updated);
      this.audit('PUBLICATION_UPDATED', { actorUri: grant.actorUri, grantId: grant.id, publicationId: updated.id, detail: { sourceRevision: updated.sourceRevision, metadataHash: checksum(updated.metadataSnapshot), disclosureHash: checksum(updated.disclosureSnapshot) } });
      return updated;
    });
  }

  withdrawPublication(request: SignedFederationRequest<{ grantId: string; publicationId: string }>): FederatedPublication {
    return this.authenticated(request, 'publication:withdraw', ({ grantId, publicationId }) => {
      const grant = this.requireActiveGrant(grantId, 'publication:withdraw');
      const publication = this.options.repository.getPublication(publicationId);
      if (!publication || publication.sourceActorUri !== grant.actorUri) throw new FederationError('publication_not_found', 'Federated publication was not found');
      const updated = { ...publication, sourceStatus: 'withdrawn' as const, localStatus: 'withdrawn' as const, lastSynchronizedAt: this.now().toISOString() };
      this.options.repository.savePublication(updated);
      this.audit('PUBLICATION_WITHDRAWN', { actorUri: grant.actorUri, grantId, publicationId, detail: { legalHold: updated.legalHold } });
      return updated;
    });
  }

  moderatePublication(publicationId: string, status: 'published' | 'rejected' | 'held' | 'removed', reason: string): FederatedPublication {
    const publication = this.options.repository.getPublication(publicationId);
    if (!publication) throw new FederationError('publication_not_found', 'Federated publication was not found');
    const updated = { ...publication, localStatus: status, moderationState: reason, appliedSourceRevision: status === 'published' ? publication.sourceRevision : publication.appliedSourceRevision, publishedAt: status === 'published' ? (publication.publishedAt ?? this.now().toISOString()) : publication.publishedAt, lastSynchronizedAt: this.now().toISOString() };
    this.options.repository.savePublication(updated);
    this.audit(status === 'removed' ? 'PUBLICATION_REMOVED' : 'PUBLICATION_MODERATED', { actorUri: publication.sourceActorUri, grantId: publication.grantId, publicationId, detail: { status, reason } });
    return updated;
  }

  sourceUnavailable(publicationId: string): FederatedPublication {
    const publication = this.options.repository.getPublication(publicationId);
    if (!publication) throw new FederationError('publication_not_found', 'Federated publication was not found');
    const updated = { ...publication, sourceStatus: 'unavailable' as const, localStatus: 'held' as const, lastSynchronizedAt: this.now().toISOString() };
    this.options.repository.savePublication(updated);
    this.audit('SOURCE_UNAVAILABLE', { actorUri: publication.sourceActorUri, grantId: publication.grantId, publicationId, detail: {} });
    return updated;
  }

  setLegalHold(publicationId: string, active: boolean, reason: string): FederatedPublication {
    const publication = this.options.repository.getPublication(publicationId);
    if (!publication) throw new FederationError('publication_not_found', 'Federated publication was not found');
    const updated = { ...publication, legalHold: active, localStatus: active ? 'held' as const : publication.localStatus, lastSynchronizedAt: this.now().toISOString() };
    this.options.repository.savePublication(updated);
    this.audit('LEGAL_HOLD', { actorUri: publication.sourceActorUri, grantId: publication.grantId, publicationId, detail: { active, reason } });
    return updated;
  }

  safetyAlert(actorUri: string, category: string, reference: string): void {
    this.audit('SAFETY_ALERT', { actorUri, detail: { category, reference } });
  }

  blockSourceInstance(instanceId: string, reason: string): void {
    this.options.trust.block(instanceId);
    this.audit('INSTANCE_BLOCKED', { detail: { sourceInstanceId: instanceId, reason } });
  }

  private validateAsset(asset: FederatedAssetReference): void {
    const url = new URL(asset.deliveryUrl);
    if (url.protocol !== 'https:' || Date.parse(asset.expiresAt) <= this.now().getTime() || !/^[a-f0-9]{64}$/i.test(asset.checksumSha256) || asset.sizeBytes <= 0) {
      throw new FederationError('invalid_asset', 'Federated asset reference is invalid, expired, or lacks a SHA-256 checksum');
    }
  }

  private validateDisclosure(disclosure: Record<string, unknown>): void {
    const rating = disclosure.rating;
    if (this.options.allowedRatings && (typeof rating !== 'string' || !this.options.allowedRatings.includes(rating))) {
      throw new FederationError('rating_forbidden', 'Publication rating is not allowed by destination policy');
    }
  }

  verifyReplicatedAsset(asset: FederatedAssetReference, bytes: Buffer, scan: { malware: 'clean' | 'detected'; safety: 'cleared' | 'held' }): void {
    if (bytes.byteLength !== asset.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== asset.checksumSha256) { this.options.observe?.('federation.asset.integrity_failed'); throw new FederationError('asset_integrity_failed', 'Replicated asset failed size or checksum verification'); }
    if (scan.malware !== 'clean' || scan.safety !== 'cleared') { this.options.observe?.('federation.asset.policy_blocked'); throw new FederationError('asset_policy_blocked', 'Replicated asset did not pass destination scanning'); }
  }

  queueDelivery(idempotencyKey: string, operation: string): FederationDeliveryJob {
    const now = this.now().toISOString();
    const job = { id: randomUUID(), idempotencyKey, operation, status: 'queued' as const, attemptCount: 0, createdAt: now, updatedAt: now };
    this.options.repository.saveDelivery(job);
    return job;
  }

  recordDeliveryFailure(id: string, error: string, retryable: boolean, maximumAttempts = 5): FederationDeliveryJob {
    const job = this.options.repository.getDelivery(id);
    if (!job) throw new FederationError('delivery_not_found', 'Federation delivery job was not found');
    const attemptCount = job.attemptCount + 1;
    const retry = retryable && attemptCount < maximumAttempts;
    const updated: FederationDeliveryJob = {
      ...job, attemptCount, status: retry ? 'retry_scheduled' : 'dead_letter', lastError: error,
      nextAttemptAt: retry ? new Date(this.now().getTime() + Math.min(3600, 2 ** attemptCount) * 1000).toISOString() : undefined,
      updatedAt: this.now().toISOString()
    };
    this.options.repository.saveDelivery(updated);
    return updated;
  }
}

export const assertManagedFederationRoute = (home: FederationBrand, destination: FederationBrand): void => {
  if (home !== 'nightframe' || destination !== 'eversally') {
    throw new FederationError('route_forbidden', 'Phase 1 federation only permits Nightframe home creators to publish to Eversally');
  }
};
