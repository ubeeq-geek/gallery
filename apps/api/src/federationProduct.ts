import { randomUUID } from 'node:crypto';
import {
  FederationError,
  type FederatedPublication,
  type FederationAuditRecord,
  type FederationDeliveryJob,
  type FederationGrant,
  type FederationInstanceMetadata,
  type FederationRepository,
  type ManagedFederationTrust,
  type RemoteCreatorProjection
} from './federation';

export interface FederatedCreatorPage {
  actorUri: string;
  displayName: string;
  handle: string;
  avatarUrl?: string;
  shortBio?: string;
  approvedLinks: Array<{ label: string; url: string }>;
  attribution: { label: string; homeInstanceName: string };
  homeProfileLink?: { href: string; homeInstanceName: string; warningRequired: true };
  publications: Array<{
    id: string;
    metadata: Readonly<Record<string, unknown>>;
    disclosure: Readonly<Record<string, unknown>>;
    rating?: string;
    labels: string[];
    publishedAt?: string;
  }>;
}

export interface FederationDashboard {
  destinations: Array<{
    instanceId: string;
    name: string;
    policyVersion: string;
    status: FederationGrant['status'] | 'not_connected';
    scopes: FederationGrant['scopes'];
    expiresAt?: string;
    profileRevision?: number;
  }>;
  works: Array<{
    sourceWorkUri: string;
    destinations: Array<{
      instanceId: string;
      publicationId: string;
      status: FederatedPublication['localStatus'];
      sourceStatus: FederatedPublication['sourceStatus'];
      revision: number;
      updatedAt: string;
    }>;
  }>;
}

export interface FederationMetricSnapshot {
  counters: Record<string, number>;
  gauges: { retryQueueAgeSeconds: number; deadLetterCount: number; reconciliationDriftCount: number };
  objectives: {
    callbackDeliverySeconds: number;
    withdrawalVisibilitySeconds: number;
    reconciliationMaximumAgeSeconds: number;
  };
}

export interface FederationStatusCallback {
  callbackId: string;
  destinationInstanceId: string;
  homeInstanceId: string;
  actorUri: string;
  publicationId?: string;
  event: 'grant.status' | 'publication.status' | 'profile.status' | 'safety.status';
  status: string;
  occurredAt: string;
}

export type FederationReconciliationEntry = {
  publicationId: string;
  sourceRevision: number;
  appliedSourceRevision?: number;
  status: string;
  drifted: boolean;
  driftReason?: 'revision_mismatch' | 'withdrawal_not_applied' | 'source_unavailable_visible';
};

export const reconcileFederatedPublication = (publication: FederatedPublication): FederationReconciliationEntry => {
  let driftReason: FederationReconciliationEntry['driftReason'];
  if (publication.sourceStatus === 'withdrawn' && publication.localStatus !== 'withdrawn' && publication.localStatus !== 'removed') driftReason = 'withdrawal_not_applied';
  else if (publication.sourceStatus === 'unavailable' && !['held', 'withdrawn', 'removed'].includes(publication.localStatus)) driftReason = 'source_unavailable_visible';
  else if (publication.localStatus === 'published' && publication.appliedSourceRevision !== publication.sourceRevision) driftReason = 'revision_mismatch';
  return {
    publicationId: publication.id,
    sourceRevision: publication.sourceRevision,
    appliedSourceRevision: publication.appliedSourceRevision,
    status: `${publication.sourceStatus}:${publication.localStatus}`,
    drifted: Boolean(driftReason),
    driftReason
  };
};

const clone = <T>(value: T): T => structuredClone(value);
const publicFields = (source: Readonly<Record<string, unknown>>, allowed: string[]): Readonly<Record<string, unknown>> => Object.freeze(
  Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, clone(source[key])]))
);

/** Product-facing queries and operator actions layered over the federation authority service. */
export class FederationProductService {
  private readonly counters = new Map<string, number>();
  private readonly callbacks = new Map<string, FederationStatusCallback>();

  constructor(
    private readonly repository: FederationRepository,
    private readonly trust: ManagedFederationTrust,
    private readonly destination: FederationInstanceMetadata,
    private readonly now: () => Date = () => new Date()
  ) {}

  dashboard(actorUri: string, supportedDestinations: FederationInstanceMetadata[]): FederationDashboard {
    const grants = this.repository.listGrants().filter((grant) => grant.actorUri === actorUri);
    const projection = this.repository.getProjection(actorUri);
    const publications = this.repository.listPublications().filter((publication) => publication.sourceActorUri === actorUri);
    return {
      destinations: supportedDestinations.map((instance) => {
        const grant = grants.find((candidate) => candidate.destinationInstanceId === instance.instanceId);
        return {
          instanceId: instance.instanceId,
          name: instance.name,
          policyVersion: instance.policyVersion,
          status: grant?.status ?? 'not_connected',
          scopes: grant?.scopes ?? [],
          expiresAt: grant?.expiresAt,
          profileRevision: grant ? projection?.profileRevision : undefined
        };
      }),
      works: publications.map((publication) => ({
        sourceWorkUri: publication.sourceWorkUri,
        destinations: [{
          instanceId: this.destination.instanceId,
          publicationId: publication.id,
          status: publication.localStatus,
          sourceStatus: publication.sourceStatus,
          revision: publication.sourceRevision,
          updatedAt: publication.lastSynchronizedAt
        }]
      }))
    };
  }

  federatedCreatorPage(actorUri: string): FederatedCreatorPage | undefined {
    const projection = this.repository.getProjection(actorUri);
    if (!projection || !projection.profileVisible || projection.trustState === 'blocked' || projection.moderationState === 'suspended') return undefined;
    const snapshot = projection.destinationProfileSnapshot;
    const home = this.trust.resolve(projection.homeInstanceId);
    if (!home) return undefined;
    const publications = this.repository.listPublications()
      .filter((publication) => publication.sourceActorUri === actorUri && publication.localStatus === 'published' && publication.sourceStatus !== 'withdrawn' && publication.sourceStatus !== 'unavailable')
      .map((publication) => ({
        id: publication.id,
        // Remote presentation URLs are never projected. Public media must be
        // served from a destination-owned replication record, not source
        // metadata or an expiring signed delivery URL.
        metadata: publicFields(publication.metadataSnapshot, ['title', 'summary', 'destinationLabels']),
        disclosure: publicFields(publication.disclosureSnapshot, ['rating', 'ai', 'aiProvenance', 'heavyTopics']),
        rating: typeof publication.disclosureSnapshot.rating === 'string' ? publication.disclosureSnapshot.rating : undefined,
        labels: Array.isArray(publication.metadataSnapshot.destinationLabels)
          ? publication.metadataSnapshot.destinationLabels.filter((label): label is string => typeof label === 'string')
          : [],
        publishedAt: publication.publishedAt
      }));
    const homeLinkAllowed = projection.homeProfileLinkEnabled
      && !projection.homeProfileLinkSuppressedReason
      && projection.trustState === 'trusted'
      && projection.moderationState === 'active'
      && home.status === 'trusted';
    return {
      actorUri,
      displayName: snapshot.displayName,
      handle: snapshot.handle,
      shortBio: snapshot.shortBio,
      approvedLinks: clone(snapshot.approvedLinks ?? []),
      attribution: { label: `Managed on ${home.name}`, homeInstanceName: home.name },
      homeProfileLink: homeLinkAllowed ? { href: actorUri, homeInstanceName: home.name, warningRequired: true } : undefined,
      publications
    };
  }

  setHomeProfileLink(actorUri: string, input: { enabled?: boolean; suppressedReason?: string }): RemoteCreatorProjection {
    const projection = this.repository.getProjection(actorUri);
    if (!projection) throw new FederationError('projection_not_found', 'Remote creator projection was not found');
    const updated = {
      ...projection,
      homeProfileLinkEnabled: input.enabled ?? projection.homeProfileLinkEnabled,
      homeProfileLinkSuppressedReason: input.suppressedReason,
      lastSyncedAt: this.now().toISOString()
    };
    this.repository.saveProjection(updated);
    this.audit('HOME_PROFILE_LINK_CHANGED', actorUri, { enabled: updated.homeProfileLinkEnabled, suppressed: Boolean(updated.homeProfileLinkSuppressedReason) });
    this.increment('home_profile_link_changes');
    return updated;
  }

  recordHomeProfileConsent(actorUri: string, destinationDomain: string): void {
    const page = this.federatedCreatorPage(actorUri);
    if (!page?.homeProfileLink) throw new FederationError('home_link_unavailable', 'The verified home-profile link is unavailable');
    if (new URL(this.destination.origin).hostname !== destinationDomain) throw new FederationError('invalid_destination_domain', 'Consent destination does not match this service');
    this.audit('HOME_PROFILE_LINK_CONSENT', actorUri, { destinationDomain, homeDomain: new URL(page.homeProfileLink.href).hostname });
    this.increment('home_profile_link_consents');
  }

  queueStatusCallback(callback: Omit<FederationStatusCallback, 'callbackId' | 'occurredAt'>): FederationDeliveryJob {
    const value = { ...callback, callbackId: randomUUID(), occurredAt: this.now().toISOString() };
    this.callbacks.set(value.callbackId, clone(value));
    const now = this.now().toISOString();
    const job: FederationDeliveryJob = {
      id: value.callbackId,
      idempotencyKey: `callback:${value.callbackId}`,
      operation: value.event,
      status: 'queued',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    };
    this.repository.saveDelivery(job);
    this.audit('STATUS_CALLBACK_QUEUED', callback.actorUri, { callbackId: value.callbackId, event: value.event });
    this.increment('status_callbacks_queued');
    return job;
  }

  replayDelivery(deliveryId: string): FederationDeliveryJob {
    const existing = this.repository.getDelivery(deliveryId);
    if (!existing || existing.status !== 'dead_letter') throw new FederationError('delivery_not_replayable', 'Only dead-letter deliveries may be replayed');
    const updated = { ...existing, status: 'queued' as const, nextAttemptAt: undefined, lastError: undefined, updatedAt: this.now().toISOString() };
    this.repository.saveDelivery(updated);
    this.audit('DELIVERY_REPLAYED', undefined, { deliveryId });
    this.increment('delivery_replays');
    return updated;
  }

  operatorSnapshot(): {
    projections: RemoteCreatorProjection[];
    failedDeliveries: FederationDeliveryJob[];
    reconciliation: FederationReconciliationEntry[];
  } {
    const publications = this.repository.listPublications();
    return {
      projections: this.repository.listProjections(),
      failedDeliveries: this.repository.listDeliveries().filter((job) => job.status === 'dead_letter'),
      reconciliation: publications.map(reconcileFederatedPublication)
    };
  }

  metrics(): FederationMetricSnapshot {
    const now = this.now().getTime();
    const deliveries = this.repository.listDeliveries();
    const retryQueueAgeSeconds = deliveries
      .filter((job) => ['queued', 'retry_scheduled'].includes(job.status))
      .reduce((age, job) => Math.max(age, Math.max(0, now - Date.parse(job.createdAt)) / 1000), 0);
    const reconciliationDriftCount = this.operatorSnapshot().reconciliation.filter((entry) => entry.drifted).length;
    const counters = Object.fromEntries(this.counters);
    for (const record of this.repository.listAudit()) {
      const name = `transition_${record.event.toLowerCase()}`;
      counters[name] = (counters[name] ?? 0) + 1;
    }
    counters.delivery_retries = deliveries.reduce((total, job) => total + job.attemptCount, 0);
    return {
      counters,
      gauges: { retryQueueAgeSeconds, deadLetterCount: deliveries.filter((job) => job.status === 'dead_letter').length, reconciliationDriftCount },
      objectives: { callbackDeliverySeconds: 300, withdrawalVisibilitySeconds: 60, reconciliationMaximumAgeSeconds: 900 }
    };
  }

  private increment(name: string): void { this.counters.set(name, (this.counters.get(name) ?? 0) + 1); }
  private audit(event: FederationAuditRecord['event'], actorUri: string | undefined, detail: FederationAuditRecord['detail']): void {
    this.repository.appendAudit({ id: randomUUID(), event, actorUri, instanceId: this.destination.instanceId, detail: Object.freeze({ ...detail }), occurredAt: this.now().toISOString() });
  }
}
