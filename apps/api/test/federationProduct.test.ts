import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  FederationService,
  InMemoryFederationRepository,
  ManagedFederationTrust,
  signFederationRequest,
  type DestinationProfileSnapshot,
  type FederationInstanceMetadata
} from '../src/federation';
import { FederationProductService, reconcileFederatedPublication } from '../src/federationProduct';

const now = new Date('2026-08-25T12:00:00.000Z');
const keys = generateKeyPairSync('ed25519');
const home: FederationInstanceMetadata = {
  metadataRevision: 1, metadataUpdatedAt: '2026-08-25T00:00:00.000Z',
  instanceId: 'nightframe', brand: 'nightframe', name: 'Nightframe', origin: 'https://nightfra.me',
  actorBaseUrl: 'https://nightfra.me/.well-known/ubeeq/creators', policyVersion: '1', status: 'trusted',
  keys: [{ keyId: 'home-key', algorithm: 'Ed25519', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), validFrom: '2026-01-01T00:00:00.000Z' }]
};
const destination: FederationInstanceMetadata = {
  metadataRevision: 1, metadataUpdatedAt: '2026-08-25T00:00:00.000Z',
  instanceId: 'eversally', brand: 'eversally', name: 'Eversally', origin: 'https://eversally.com',
  actorBaseUrl: 'https://eversally.com/.well-known/ubeeq/creators', policyVersion: '1', status: 'trusted',
  keys: [{ keyId: 'destination-key', algorithm: 'Ed25519', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), validFrom: '2026-01-01T00:00:00.000Z' }]
};
const actorUri = `${home.actorBaseUrl}/artist`;
let requestNumber = 0;

const setup = () => {
  const repository = new InMemoryFederationRepository();
  const trust = new ManagedFederationTrust();
  trust.register(home); trust.register(destination);
  const federation = new FederationService({
    repository, trust, instance: destination, now: () => now, allowedRatings: ['general'],
    profilePolicy: { displayNameMax: 80, handleMax: 40, shortBioMax: 200, maximumLinks: 1, avatarMimeTypes: ['image/jpeg'], avatarMaximumBytes: 1000 }
  });
  const product = new FederationProductService(repository, trust, destination, () => now);
  const signed = <T>(operation: string, payload: T) => {
    requestNumber += 1;
    return signFederationRequest({
      sourceInstanceId: home.instanceId, destinationInstanceId: destination.instanceId, keyId: 'home-key', privateKey: keys.privateKey,
      operation, payload, idempotencyKey: `key-${requestNumber}`, nonce: `nonce-${requestNumber}`, requestId: `request-${requestNumber}`, now
    });
  };
  federation.requestGrant(signed('grant.request', {
    id: 'grant', actorUri, scopes: ['profile:publish', 'publication:create', 'publication:update', 'publication:withdraw'] as const,
    policyVersionAccepted: '1'
  }));
  federation.decideGrant('grant', 'active');
  const snapshot: DestinationProfileSnapshot = {
    displayName: 'Destination Artist', handle: 'destination-artist', shortBio: 'Safe destination biography',
    avatarAsset: { assetUri: 'https://nightfra.me/assets/avatar', deliveryUrl: 'https://nightfra.me/assets/avatar?secret=signed', mimeType: 'image/jpeg', sizeBytes: 100, checksumSha256: 'a'.repeat(64), expiresAt: '2026-08-25T12:05:00.000Z' },
    approvedLinks: [{ label: 'Portfolio', url: 'https://portfolio.example' }],
    publicAttribution: { homeInstanceName: 'Nightframe', homeInstanceUrl: 'https://nightfra.me' }, revision: 1
  };
  federation.publishProfile(signed('profile.publish', { grantId: 'grant', actorUri, remoteCreatorId: 'artist', snapshot }));
  const assetBytes = Buffer.from('asset');
  const asset = {
    assetUri: 'https://nightfra.me/assets/1', deliveryUrl: 'https://nightfra.me/assets/1?signed=yes', mimeType: 'image/jpeg',
    sizeBytes: assetBytes.length, checksumSha256: createHash('sha256').update(assetBytes).digest('hex'), expiresAt: '2026-08-25T12:05:00.000Z'
  };
  const publish = (id: string, work: string, title: string) => federation.createPublication(signed('publication.create', {
    grantId: 'grant', id, sourceWorkUri: `https://nightfra.me/works/${work}`, sourceRevision: 1,
    metadataSnapshot: { title, thumbnailUrl: 'https://nightfra.me/assets/thumbnail?secret=signed', destinationLabels: ['Eversally reviewed'], homeBiography: 'must not be projected' },
    disclosureSnapshot: { rating: 'general', ai: 'none' }, assets: [asset]
  }));
  return { repository, federation, product, signed, publish };
};

describe('Phase 1 federation product completion', () => {
  test('dashboard exposes every destination-local publication status distinctly', () => {
    const { federation, product, publish } = setup();
    publish('published', 'one', 'One'); federation.moderatePublication('published', 'published', 'accepted');
    publish('held', 'two', 'Two'); federation.moderatePublication('held', 'held', 'review');
    publish('rejected', 'three', 'Three'); federation.moderatePublication('rejected', 'rejected', 'policy');
    publish('withdrawn', 'four', 'Four');
    const { signed } = setup(); // use a fresh signer only to obtain a uniquely signed shape
    federation.withdrawPublication(signed('publication.withdraw', { grantId: 'grant', publicationId: 'withdrawn' }));
    publish('removed', 'five', 'Five'); federation.moderatePublication('removed', 'removed', 'destination removal');

    const dashboard = product.dashboard(actorUri, [destination]);
    expect(dashboard.destinations[0]).toMatchObject({ status: 'active', profileRevision: 1 });
    expect(dashboard.works.map((work) => work.destinations[0].status)).toEqual(expect.arrayContaining(['published', 'held', 'rejected', 'withdrawn', 'removed']));
  });

  test('public page contains only the moderated distribution profile and accepted works', () => {
    const { federation, product, publish } = setup();
    publish('accepted', 'accepted', 'Accepted'); federation.moderatePublication('accepted', 'published', 'accepted');
    publish('pending', 'pending', 'Pending and secret');
    const page = product.federatedCreatorPage(actorUri)!;

    expect(page).toMatchObject({ displayName: 'Destination Artist', shortBio: 'Safe destination biography', attribution: { label: 'Managed on Nightframe' } });
    expect(page.publications).toHaveLength(1);
    expect(page.publications[0]).toMatchObject({ id: 'accepted', rating: 'general', labels: ['Eversally reviewed'] });
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('Pending and secret');
    expect(serialized).not.toContain('homeBiography');
    expect(serialized).not.toContain('followers');
    expect(serialized).not.toContain('favourites');
    expect(serialized).not.toContain('secret=signed');
    expect(page.avatarUrl).toBeUndefined();
    expect(page.publications[0].metadata).not.toHaveProperty('thumbnailUrl');
  });

  test('home link is actor-derived, opt-in, warning-gated, suppressible, and consent-audited', () => {
    const { repository, product } = setup();
    expect(product.federatedCreatorPage(actorUri)?.homeProfileLink).toBeUndefined();
    product.setHomeProfileLink(actorUri, { enabled: true });
    expect(product.federatedCreatorPage(actorUri)?.homeProfileLink).toEqual({ href: actorUri, homeInstanceName: 'Nightframe', warningRequired: true });
    product.recordHomeProfileConsent(actorUri, 'eversally.com');
    expect(repository.listAudit().some((record) => record.event === 'HOME_PROFILE_LINK_CONSENT')).toBe(true);
    product.setHomeProfileLink(actorUri, { suppressedReason: 'source restriction' });
    expect(product.federatedCreatorPage(actorUri)?.homeProfileLink).toBeUndefined();
    expect(() => product.recordHomeProfileConsent(actorUri, 'eversally.com')).toThrow('unavailable');
  });

  test('operator callbacks, dead-letter replay, reconciliation, and service metrics are observable', () => {
    const { federation, product, publish } = setup();
    publish('drift', 'drift', 'Drift'); federation.moderatePublication('drift', 'held', 'revision review');
    const callback = product.queueStatusCallback({
      destinationInstanceId: destination.instanceId, homeInstanceId: home.instanceId, actorUri,
      publicationId: 'drift', event: 'publication.status', status: 'held'
    });
    federation.recordDeliveryFailure(callback.id, 'timeout', false);
    expect(product.operatorSnapshot().failedDeliveries).toHaveLength(1);
    expect(product.replayDelivery(callback.id).status).toBe('queued');
    expect(product.metrics()).toMatchObject({
      counters: { status_callbacks_queued: 1, delivery_replays: 1 },
      objectives: { callbackDeliverySeconds: 300, withdrawalVisibilitySeconds: 60, reconciliationMaximumAgeSeconds: 900 }
    });
  });

  test('reconciliation compares the source revision with the revision actually approved at the destination', () => {
    const { repository, federation, signed, publish } = setup();
    const created = publish('revisioned', 'revisioned', 'Revision one');
    expect(reconcileFederatedPublication(created)).toMatchObject({ appliedSourceRevision: undefined, drifted: false });
    const approved = federation.moderatePublication('revisioned', 'published', 'accepted');
    expect(reconcileFederatedPublication(approved)).toMatchObject({ sourceRevision: 1, appliedSourceRevision: 1, drifted: false });

    const updated = federation.updatePublication(signed('publication.update', {
      grantId: 'grant', publicationId: 'revisioned', expectedRevision: 1, sourceRevision: 2,
      metadataSnapshot: { title: 'Revision two' }, disclosureSnapshot: { rating: 'general' }, assets: approved.assets
    }));
    expect(reconcileFederatedPublication(updated)).toMatchObject({ sourceRevision: 2, appliedSourceRevision: 1, status: 'updated:processing', drifted: false });

    repository.savePublication({ ...updated, localStatus: 'published' });
    expect(reconcileFederatedPublication(repository.getPublication('revisioned')!)).toMatchObject({ drifted: true, driftReason: 'revision_mismatch' });
    const reapproved = federation.moderatePublication('revisioned', 'published', 'revision accepted');
    expect(reconcileFederatedPublication(reapproved)).toMatchObject({ appliedSourceRevision: 2, drifted: false });
  });

  test('reconciliation distinguishes missing withdrawal and source-unavailable handling from policy holds', () => {
    const { repository, publish } = setup();
    const publication = publish('status-drift', 'status-drift', 'Status drift');
    expect(reconcileFederatedPublication({ ...publication, sourceStatus: 'withdrawn', localStatus: 'published' })).toMatchObject({ drifted: true, driftReason: 'withdrawal_not_applied' });
    expect(reconcileFederatedPublication({ ...publication, sourceStatus: 'unavailable', localStatus: 'published' })).toMatchObject({ drifted: true, driftReason: 'source_unavailable_visible' });
    repository.savePublication({ ...publication, sourceStatus: 'unavailable', localStatus: 'held' });
    expect(reconcileFederatedPublication(repository.getPublication('status-drift')!)).toMatchObject({ drifted: false });
  });

  test('moderation suppression removes the creator page without changing canonical source state', () => {
    const { federation, product, publish } = setup();
    publish('accepted', 'accepted', 'Accepted'); federation.moderatePublication('accepted', 'published', 'accepted');
    federation.moderateProfile(actorUri, { visible: false, moderationState: 'limited', reason: 'destination-only action' });
    expect(product.federatedCreatorPage(actorUri)).toBeUndefined();
  });
});
