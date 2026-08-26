import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AtomicFileFederationRepository,
  FederationError,
  FederationService,
  InMemoryFederationRepository,
  ManagedFederationTrust,
  assertManagedFederationRoute,
  signFederationRequest,
  type DestinationProfileSnapshot,
  type FederatedAssetReference,
  type FederationInstanceMetadata,
  type FederationScope,
  type SignedFederationRequest
} from '../src/federation';

const clock = new Date('2026-08-25T12:00:00.000Z');
const homeKeys = generateKeyPairSync('ed25519');
const destinationKeys = generateKeyPairSync('ed25519');

const instance = (
  instanceId: string,
  brand: 'nightframe' | 'eversally',
  origin: string,
  publicKey: string
): FederationInstanceMetadata => ({
  instanceId,
  metadataRevision: 1,
  metadataUpdatedAt: '2026-08-25T00:00:00.000Z',
  brand,
  name: brand === 'nightframe' ? 'Nightframe' : 'Eversally',
  origin,
  actorBaseUrl: `${origin}/.well-known/ubeeq/creators`,
  policyVersion: '2026-08',
  status: 'trusted',
  keys: [{ keyId: `${instanceId}-2026-08`, algorithm: 'Ed25519', publicKeyPem: publicKey, validFrom: '2026-08-01T00:00:00.000Z' }]
});

const home = instance('nightframe-production', 'nightframe', 'https://nightfra.me', homeKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
const destination = instance('eversally-production', 'eversally', 'https://eversally.com', destinationKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString());
const actorUri = `${home.actorBaseUrl}/creator-01`;

const setup = () => {
  const repository = new InMemoryFederationRepository();
  const trust = new ManagedFederationTrust();
  trust.register(home);
  trust.register(destination);
  const service = new FederationService({
    instance: destination,
    repository,
    trust,
    now: () => clock,
    profilePolicy: {
      displayNameMax: 80,
      handleMax: 40,
      shortBioMax: 240,
      maximumLinks: 2,
      allowedLinkHosts: ['artist.example'],
      avatarMimeTypes: ['image/jpeg', 'image/png'],
      avatarMaximumBytes: 2_000_000
    },
    allowedRatings: ['general', 'suggestive']
  });
  return { repository, service, trust };
};

let sequence = 0;
const signed = <T>(operation: string, payload: T, overrides: Partial<{
  destinationInstanceId: string; idempotencyKey: string; nonce: string; now: Date; ttlSeconds: number;
}> = {}): SignedFederationRequest<T> => {
  sequence += 1;
  return signFederationRequest({
    sourceInstanceId: home.instanceId,
    destinationInstanceId: overrides.destinationInstanceId ?? destination.instanceId,
    keyId: home.keys[0].keyId,
    privateKey: homeKeys.privateKey,
    operation,
    payload,
    idempotencyKey: overrides.idempotencyKey ?? `request-${sequence}`,
    nonce: overrides.nonce ?? `nonce-${sequence}`,
    requestId: `id-${sequence}`,
    now: overrides.now ?? clock,
    ttlSeconds: overrides.ttlSeconds
  });
};

const grantRequest = (scopes: FederationScope[] = ['profile:publish', 'publication:create', 'publication:update', 'publication:withdraw', 'publication:status']) => signed('grant.request', {
  id: 'grant-01', actorUri, scopes, policyVersionAccepted: destination.policyVersion,
  expiresAt: '2026-09-25T12:00:00.000Z'
});

const activateGrant = (service: FederationService, scopes?: FederationScope[]) => {
  service.requestGrant(grantRequest(scopes));
  return service.decideGrant('grant-01', 'active');
};

const profile = (revision = 1): DestinationProfileSnapshot => ({
  displayName: 'Night Artist',
  handle: 'night-artist',
  shortBio: 'A destination-specific biography.',
  approvedLinks: [{ label: 'Portfolio', url: 'https://artist.example/portfolio' }],
  publicAttribution: { homeInstanceName: home.name, homeInstanceUrl: home.origin },
  revision
});

const bytes = Buffer.from('federated asset');
const asset: FederatedAssetReference = {
  assetUri: 'https://nightfra.me/.well-known/ubeeq/assets/asset-01',
  deliveryUrl: 'https://nightfra.me/federation/assets/asset-01?signature=valid',
  mimeType: 'image/jpeg',
  sizeBytes: bytes.byteLength,
  checksumSha256: createHash('sha256').update(bytes).digest('hex'),
  expiresAt: '2026-08-25T12:05:00.000Z'
};

const publicationRequest = () => signed('publication.create', {
  grantId: 'grant-01',
  id: 'publication-01',
  sourceWorkUri: 'https://nightfra.me/.well-known/ubeeq/works/work-01',
  sourceRevision: 1,
  metadataSnapshot: { title: 'A work', privateAccountEmail: undefined },
  disclosureSnapshot: { ai: 'none', rating: 'general' },
  assets: [asset]
});

describe('managed federation trust and grants', () => {
  test('persists grants and audit records across repository restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ubeeq-federation-'));
    const filename = join(directory, 'state.json');
    try {
      const first = new AtomicFileFederationRepository(filename);
      const trust = new ManagedFederationTrust();
      trust.register(home); trust.register(destination);
      const service = new FederationService({
        instance: destination, repository: first, trust, now: () => clock,
        profilePolicy: { displayNameMax: 80, handleMax: 40, shortBioMax: 240, maximumLinks: 2, avatarMimeTypes: ['image/jpeg'], avatarMaximumBytes: 2_000_000 }
      });
      service.requestGrant(grantRequest());

      const restored = new AtomicFileFederationRepository(filename);
      expect(restored.getGrant('grant-01')).toMatchObject({ actorUri, status: 'pending' });
      expect(restored.listAudit()).toHaveLength(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('accepts an authenticated grant and returns the cached result for an idempotent retry', () => {
    const { repository, service } = setup();
    const request = grantRequest();
    const first = service.requestGrant(request);
    const retry = service.requestGrant(signed('grant.request', request.payload, { idempotencyKey: request.idempotencyKey }));

    expect(first).toMatchObject({ status: 'pending', actorUri, homeInstanceId: home.instanceId, destinationInstanceId: destination.instanceId });
    expect(retry).toEqual(first);
    expect(repository.listAudit()).toHaveLength(1);
  });

  test('rejects wrong audiences, expired messages, tampering, and nonce replay', () => {
    const { service } = setup();
    expect(() => service.requestGrant(grantRequest().destinationInstanceId === 'never' ? grantRequest() : signed('grant.request', grantRequest().payload, { destinationInstanceId: 'wrong' }))).toThrow('audience');

    const expired = signed('grant.request', grantRequest().payload, { now: new Date('2026-08-25T11:50:00.000Z') });
    expect(() => service.requestGrant(expired)).toThrow('expired');

    const tampered = grantRequest();
    tampered.payload.actorUri = `${home.actorBaseUrl}/attacker`;
    expect(() => service.requestGrant(tampered)).toThrow('signature');

    const replay = grantRequest();
    service.requestGrant(replay);
    const sameNonce = signed('grant.request', replay.payload, { idempotencyKey: 'new-operation', nonce: replay.nonce });
    expect(() => service.requestGrant(sameNonce)).toThrow('nonce');
  });

  test('requires actor ownership, policy acceptance, supported scopes, and one grant per destination', () => {
    const { service } = setup();
    expect(() => service.requestGrant(signed('grant.request', { ...grantRequest().payload, actorUri: 'https://evil.example/creators/1' }))).toThrow('owned');
    expect(() => service.requestGrant(signed('grant.request', { ...grantRequest().payload, policyVersionAccepted: 'old' }))).toThrow('policy');
    expect(() => service.requestGrant(signed('grant.request', { ...grantRequest().payload, scopes: ['admin:all'] as unknown as FederationScope[] }))).toThrow('scope');
    service.requestGrant(grantRequest());
    expect(() => service.requestGrant(signed('grant.request', { ...grantRequest().payload, id: 'grant-02' }))).toThrow('already exists');
  });

  test('revocation is immediate and irreversible', () => {
    const { service } = setup();
    activateGrant(service);
    const revoked = service.revokeGrant(signed('grant.revoke', { grantId: 'grant-01' }));
    expect(revoked.status).toBe('revoked');
    expect(() => service.decideGrant('grant-01', 'active')).toThrow('cannot be reactivated');
    expect(() => service.publishProfile(signed('profile.publish', { grantId: 'grant-01', actorUri, remoteCreatorId: 'remote-01', snapshot: profile() }))).toThrow('does not allow');
  });

  test('updates grant scopes and expiry only through a signed home request', () => {
    const { service } = setup();
    activateGrant(service);
    const updated = service.updateGrant(signed('grant.update', {
      grantId: 'grant-01', scopes: ['profile:publish'], expiresAt: '2026-10-01T00:00:00.000Z', policyVersionAccepted: destination.policyVersion
    }));
    expect(updated).toMatchObject({ scopes: ['profile:publish'], expiresAt: '2026-10-01T00:00:00.000Z' });
    expect(service.grantStatus(signed('grant.status', { grantId: 'grant-01' }))).toEqual(updated);
  });
});

describe('destination projection and profile policy', () => {
  test('creates a projection rather than a creator account and enforces increasing revisions', () => {
    const { service } = setup();
    activateGrant(service);
    const projection = service.publishProfile(signed('profile.publish', { grantId: 'grant-01', actorUri, remoteCreatorId: 'remote-01', snapshot: profile() }));
    expect(projection).toMatchObject({ actorUri, remoteCreatorId: 'remote-01', profileRevision: 1, profileVisible: true });
    expect(projection).not.toHaveProperty('password');
    expect(() => service.publishProfile(signed('profile.publish', { grantId: 'grant-01', actorUri: `${actorUri}-substitute`, remoteCreatorId: 'remote-02', snapshot: profile(2) }))).toThrow('immutable grant actor');
    expect(() => service.publishProfile(signed('profile.publish', { grantId: 'grant-01', actorUri, remoteCreatorId: 'remote-01', snapshot: profile() }))).toThrow('monotonically');
  });

  test('validates links and attribution and supports local suppression without editing the snapshot', () => {
    const { service } = setup();
    activateGrant(service);
    expect(() => service.publishProfile(signed('profile.publish', {
      grantId: 'grant-01', actorUri, remoteCreatorId: 'remote-01', snapshot: { ...profile(), approvedLinks: [{ label: 'Unsafe', url: 'http://artist.example' }] }
    }))).toThrow('links');
    const projection = service.publishProfile(signed('profile.publish', { grantId: 'grant-01', actorUri, remoteCreatorId: 'remote-01', snapshot: profile() }));
    const suppressed = service.moderateProfile(actorUri, { visible: false, moderationState: 'limited', reason: 'destination policy' });
    expect(suppressed.profileVisible).toBe(false);
    expect(suppressed.destinationProfileSnapshot).toEqual(projection.destinationProfileSnapshot);
  });
});

describe('federated publication, assets, moderation, and audit', () => {
  test('creates, verifies, revises, publishes, withdraws, and retains distinct source/local state', () => {
    const { repository, service } = setup();
    activateGrant(service);
    const created = service.createPublication(publicationRequest());
    expect(created).toMatchObject({ sourceRevision: 1, localStatus: 'processing', sourceStatus: 'active' });
    expect(service.publicationStatus(signed('publication.status', { grantId: 'grant-01', publicationId: created.id }))).toMatchObject({ id: created.id });
    expect(() => service.verifyReplicatedAsset(asset, Buffer.from('tampered'), { malware: 'clean', safety: 'cleared' })).toThrow('checksum');
    expect(() => service.verifyReplicatedAsset(asset, bytes, { malware: 'detected', safety: 'cleared' })).toThrow('scanning');
    expect(() => service.verifyReplicatedAsset(asset, bytes, { malware: 'clean', safety: 'cleared' })).not.toThrow();

    expect(() => service.updatePublication(signed('publication.update', {
      grantId: 'grant-01', publicationId: created.id, expectedRevision: 0, sourceRevision: 2,
      metadataSnapshot: { title: 'Revised' }, disclosureSnapshot: { ai: 'ai-assisted', rating: 'general' }, assets: [asset]
    }))).toThrow('precondition');
    const revised = service.updatePublication(signed('publication.update', {
      grantId: 'grant-01', publicationId: created.id, expectedRevision: 1, sourceRevision: 2,
      metadataSnapshot: { title: 'Revised' }, disclosureSnapshot: { ai: 'ai-assisted', rating: 'general' }, assets: [asset]
    }));
    expect(revised).toMatchObject({ sourceRevision: 2, sourceStatus: 'updated', localStatus: 'processing' });
    expect(service.moderatePublication(created.id, 'published', 'approved').localStatus).toBe('published');
    const withdrawn = service.withdrawPublication(signed('publication.withdraw', { grantId: 'grant-01', publicationId: created.id }));
    expect(withdrawn).toMatchObject({ sourceStatus: 'withdrawn', localStatus: 'withdrawn' });
    const removed = service.moderatePublication(created.id, 'removed', 'destination removal');
    expect(removed).toMatchObject({ sourceStatus: 'withdrawn', localStatus: 'removed' });

    const audit = repository.listAudit();
    expect(audit.map((record) => record.event)).toEqual(expect.arrayContaining(['PUBLICATION_CREATED', 'PUBLICATION_UPDATED', 'PUBLICATION_WITHDRAWN', 'PUBLICATION_REMOVED']));
    expect(JSON.stringify(audit)).not.toContain('privateAccountEmail');
    expect(audit.find((record) => record.event === 'PUBLICATION_CREATED')?.detail).toHaveProperty('disclosureHash');
  });

  test('holds unavailable sources and legal evidence and isolates actor/instance moderation', () => {
    const { service } = setup();
    activateGrant(service);
    service.publishProfile(signed('profile.publish', { grantId: 'grant-01', actorUri, remoteCreatorId: 'remote-01', snapshot: profile() }));
    service.createPublication(publicationRequest());
    expect(service.sourceUnavailable('publication-01')).toMatchObject({ sourceStatus: 'unavailable', localStatus: 'held' });
    expect(service.setLegalHold('publication-01', true, 'court order')).toMatchObject({ legalHold: true, localStatus: 'held' });
    expect(service.moderateProfile(actorUri, { trustState: 'blocked', reason: 'destination abuse' }).trustState).toBe('blocked');
    service.safetyAlert(actorUri, 'urgent-security', 'restricted-case-01');
    service.blockSourceInstance(home.instanceId, 'operator decision');
    expect(() => service.requestGrant(signed('grant.request', { ...grantRequest().payload, id: 'grant-02' }))).toThrow('trusted');
  });

  test('retries transient delivery failures and dead-letters terminal failures', () => {
    const { service } = setup();
    const retry = service.recordDeliveryFailure(service.queueDelivery('deliver-01', 'publication.create').id, 'timeout', true, 2);
    expect(retry).toMatchObject({ status: 'retry_scheduled', attemptCount: 1 });
    const dead = service.recordDeliveryFailure(retry.id, 'timeout', true, 2);
    expect(dead).toMatchObject({ status: 'dead_letter', attemptCount: 2 });
  });

  test('enforces destination ratings and withdraws active publications when a grant is revoked', () => {
    const { repository, service } = setup();
    activateGrant(service);
    const payload = publicationRequest().payload;
    expect(() => service.createPublication(signed('publication.create', {
      ...payload, disclosureSnapshot: { ...payload.disclosureSnapshot, rating: 'mature' }
    }))).toThrow('rating');
    service.createPublication(publicationRequest());
    service.decideGrant('grant-01', 'revoked');
    expect(repository.getPublication('publication-01')?.localStatus).toBe('withdrawn');
  });

  test('requires publication status scope before disclosing destination state', () => {
    const { service } = setup();
    activateGrant(service, ['publication:create']);
    const created = service.createPublication(publicationRequest());
    expect(() => service.publicationStatus(signed('publication.status', { grantId: 'grant-01', publicationId: created.id }))).toThrow('does not allow publication:status');
  });
});

describe('Phase 1 routing boundary', () => {
  test('only permits Nightframe to Eversally', () => {
    expect(() => assertManagedFederationRoute('nightframe', 'eversally')).not.toThrow();
    expect(() => assertManagedFederationRoute('eversally', 'nightframe')).toThrow(FederationError);
    expect(() => assertManagedFederationRoute('ubeeq', 'eversally')).toThrow('only permits');
  });
});
