# Ubeeq federation implementation backlog

This backlog translates the draft Ubeeq Federation Specification into an
implementation sequence. Priority reflects dependency and launch risk rather
than estimated effort:

- **P0 — launch blocker:** required for a safe Phase 1 managed-federation
  release.
- **P1 — launch completion:** required before Phase 1 is generally available,
  but can follow the underlying P0 contracts in development.
- **P2 — trusted expansion:** required for Phase 2 third-party federation.
- **P3 — self-host expansion:** required for Phase 3 open federation.

Comment replies, shared login, automatic destination accounts, full profile or
activity mirroring, and federation-based migration are explicitly out of scope.

## P0 — Phase 1 foundations and safety

**Implementation status:** completed by the managed federation domain service
and its contract suite. The implementation includes repository-backed domain
records, Ed25519 request authentication, replay and idempotency controls, grant
and profile policy enforcement, publication and asset lifecycles, destination
moderation, audit records, delivery recovery, and the one-way Phase 1 routing
guard. Production adapters can implement the repository contract without
changing these authority and lifecycle rules.

**HTTP contract slice:** the API now provides an injectable, versioned
federation router with discovery, actor resolution, grant/profile/publication
operations, public projection reads, schema and operation checks, JSON body
limits, per-source admission limits, and stable protocol errors. Production
enablement still requires the configured trust registry, signing-key loader,
Dynamo-backed async service adapter, queues, and asset pipeline.

**Managed trust slice:** instance metadata now carries a monotonic revision and
update timestamp. Trust updates validate Ed25519 key metadata, reject metadata
rollback and immutable identity changes, require a usable key for non-blocked
instances, and can be conditionally persisted and hydrated from DynamoDB.

**Asset-transfer slice:** Phase 1 uses destination-controlled approved
replication. Delivery and asset URLs must remain on the verified source origin;
DNS results, redirects, expiry, signed size, streaming byte limits, and SHA-256
are checked before destination scanning, rendition processing, and promotion.
Failed quarantine objects and any renditions created before promotion are
deleted unless a legal hold requires retention.
The production transport pins the preflight-approved DNS addresses into the TLS
connection to prevent DNS rebinding, and the S3 adapter streams into the
dedicated encrypted prefix before copy-and-delete promotion.

**Status-callback slice:** destination status events can now be durably queued,
signed with the active instance key, delivered to the fixed verified home
callback route, retried with bounded exponential delay, or dead-lettered on
terminal/exhausted responses. The receiver authenticates signature, audience,
replay nonce, and callback instance identities before applying an event.
Callback queue payloads are stored separately from delivery state, parsed as
untrusted input by the worker, restricted to a verified HTTPS origin, and
re-resolved against managed trust immediately before delivery. Queued origins,
local destination identity, and actor namespaces must still match current trust
metadata. Delivery state advances with attempt-count conditional writes. Batch processing reports only
malformed or unexpectedly failed messages to SQS; deliveries that schedule
their own bounded retry are removed from the current batch.

**Infrastructure slice:** federation is an explicit deployment feature flag.
Enabled stacks require an operator-managed signing-key secret and provision
encrypted request/callback queues with dead letters, a private versioned asset
bucket with quarantine lifecycle cleanup, least-privilege API grants, queue-age
and dead-letter alarms, an SNS alarm topic, and a federation dashboard.

**Audit/privacy slice:** Dynamo mutations now create separately keyed,
conditionally immutable audit envelopes with privacy-field rejection,
classification-based reader roles, SHA-256 integrity verification, bounded TTL
retention, NDJSON investigation export, and reviewer-attributed legal holds that
remove expiration.

**Operator API slice:** an authenticated, role-tiered admin router now exposes
projection suppression, actor/source-instance restrictions, publication
moderation and legal holds, reconciled dead-letter replay, audit investigation
and export, and attributed audit holds. Sensitive block, replay, and hold actions
require a reason and exact typed confirmation.

**Operator console slice:** the administrator application now presents remote
projection state, destination publication decisions, dead-letter delivery
replay, and revision-aware reconciliation results. Suppression and replay use
explicit reason/confirmation forms, refresh their server snapshot after each
action, and keep destination controls visibly separate from canonical home
authority.

**Public creator-page slice:** Eversally now mounts a stable base64url actor
route that loads only the server-approved federation projection. The external
home-link dialog traps focus, supports Escape, prevents background scrolling,
awaits durable consent recording before navigation, restores focus on Stay, and
shows a retryable error instead of losing consent during page unload.
Source-supplied avatar delivery URLs and metadata thumbnail URLs are excluded
from that projection; public media must come from cleared, destination-owned
replication records.

**Home dashboard slice:** Studio now exposes federation in its primary creator
navigation and loads an ownership-authorized, title-enriched dashboard. Creator
controls cover destination consent, distribution-profile updates, publication,
withdrawal, republication, and grant revocation through a dedicated authenticated
HTTP contract; instance-to-instance signing remains behind the injected home
coordinator rather than being delegated to the browser. Destination connection
uses a policy-versioned consent dialog and explicit scope selection rather than
accepting an arbitrary instance or a hard-coded policy version from browser
prompts; the API also rejects duplicate scopes, stale expiries, and profile
fields outside the Phase 1 bounds.

**Production telemetry slice:** federation observers now emit CloudWatch
Embedded Metric Format records for verification failures, replay attempts,
callback delivery states, asset outcomes, reconciliation drift, lifecycle
transitions, and processing latency. Dimensions are restricted to bounded
instance and operation identifiers; creator, actor, Work, grant, and
publication identifiers are never emitted as metric dimensions.
The observer also validates the deployment-owned local instance dimension and
the asset and callback services now measure both successful and failed attempt
latency, including preflight validation failures, rather than exposing dashboard
metrics that no production path emits. Telemetry failures are isolated from
delivery outcomes.

**Revision reconciliation slice:** publications now retain the source revision
actually approved for destination presentation separately from the latest
received source revision. Operator reconciliation identifies stale published
revisions, unapplied withdrawals, and visible source-unavailable content without
misclassifying in-flight processing or intentional destination policy decisions.

**Private status and admission slice:** grant and publication status reads now
require signed, replay-resistant, idempotent envelopes bound to the requested
resource and signing home. Publication reads enforce `publication:status`.
Admission throttling consumes a network-origin bucket before using an unverified
claimed source identity and returns an explicit retry interval.

**Profile authority binding slice:** profile publication requests now carry the
immutable actor URI in the signed payload and address its canonical base64url
HTTPS encoding in the route. Both the router and domain service reject actor
substitution, so handles and destination projection identifiers cannot become
profile authority keys.

| ID | Task | Deliverable / completion condition | Depends on |
| --- | --- | --- | --- |
| FED-001 | Define the federation domain model and persistence | Persist immutable instance-qualified actor URIs, grants, remote creator projections, destination profile snapshots, federated publications, per-destination statuses, revisions, timestamps, and audit references. Enforce one home authority and prevent projections from becoming local creator accounts. | — |
| FED-002 | Establish managed bilateral trust | Publish instance identifiers and key metadata for Eversally and Nightframe; authenticate audience-bound, short-lived signed requests; reject expired or replayed requests; support safe key rotation. | FED-001 |
| FED-003 | Implement idempotent federation transport | Add request envelopes, idempotency keys, revision preconditions, delivery retries, dead-letter handling, and reconciliation primitives for every cross-instance state change. | FED-001, FED-002 |
| FED-004 | Implement grant lifecycle and scopes | Add home-side request/update/revoke controls and destination-side accept/restrict/reject/status handling for the six initial scopes. Enforce expiry and make revocation stop new operations immediately. | FED-001–FED-003 |
| FED-005 | Enforce routing and authorization boundaries | Permit Nightframe-to-Eversally publication, block Eversally-to-Nightframe federation, prevent destination login/account provisioning, and ensure destination operations can never mutate canonical home Works or profiles. | FED-004 |
| FED-006 | Implement destination distribution profiles | Let creators manage a destination-specific snapshot at home; validate field allowlists, lengths, links, images, and monotonically increasing revisions at the destination; support destination moderation and suppression without changing the home profile. | FED-001–FED-004 |
| FED-007 | Build federated publication lifecycle | Support signed create, revision, withdrawal, and status flows; capture immutable metadata and disclosure snapshots per revision; keep source and local statuses separate; preserve destination-only moderation authority. | FED-001–FED-005 |
| FED-008 | Integrate asset transfer and processing | Choose and implement the Phase 1 approved-replication or signed-delivery mode, including checksum verification, malware/content scanning, storage, processing, access control, and cleanup/retention behavior. | FED-002, FED-003, FED-007 |
| FED-009 | Add moderation, policy, and emergency controls | Independently moderate every profile snapshot and publication; enforce actor and instance blocks, legal holds, safety alerts, age/rating rules, and source-unavailable behavior. Ensure ordinary moderation does not propagate to unrelated instances. | FED-004, FED-006–FED-008 |
| FED-010 | Create the audit and privacy baseline | Audit grants, consent changes, revisions, publication transitions, moderation actions, and link consent while excluding credentials, private account data, unpublished Works, and internal moderation notes from federation payloads. Define retention and legal-hold rules. | FED-001, FED-003, FED-009 |

## P1 — Phase 1 product completion

**Implementation status:** completed by the product projection service,
creator-facing React views, callback/operator controls, observability snapshot,
acceptance contract tests, and the managed-federation security and operations
runbook. Deployment wiring must supply the managed instance registry and the
chosen repository adapter.

| ID | Task | Deliverable / completion condition | Depends on |
| --- | --- | --- | --- |
| FED-011 | Build the home federation dashboard | Allow destination selection, grant consent, distribution-profile editing, publication selection, withdrawal, and revocation. Show distinct pending, published, held, rejected, withdrawn, and removed status for each Work and destination. | FED-004, FED-006, FED-007 |
| FED-012 | Build the Eversally federated creator page | Render only the moderated destination profile, Eversally-accepted Works, and Eversally-local labels/ratings/disclosures; clearly attribute remote management; never expose home galleries, followers, favourites, activity, home bio, or unaccepted Works. | FED-006, FED-007, FED-009 |
| FED-013 | Implement verified home-profile links | Derive the URL solely from the verified actor URI; add creator opt-in/revocation and creator/instance suppression; disable it under applicable restrictions; never fetch, preview, embed, scrape, or cache the target page. | FED-002, FED-004, FED-009, FED-012 |
| FED-014 | Add the external-link warning interstitial | Identify the home instance and destination domain, explain possible mature/off-service content without implying approval, and provide Continue and Stay actions. Log consent/click-through without fetching home content. | FED-010, FED-013 |
| FED-015 | Implement status callbacks and operator tooling | Deliver destination moderation/status changes to the home, expose failed deliveries and reconciliation state, and provide safe replay, projection suppression, actor blocking, and instance blocking controls. | FED-003, FED-007, FED-009 |
| FED-016 | Add observability and service objectives | Instrument signature failures, replays, queue age, retries, reconciliation drift, grant and publication transitions, moderation latency, and asset failures; add alerts and operational runbooks. | FED-002, FED-003, FED-007–FED-010 |
| FED-017 | Complete Phase 1 security and acceptance testing | Add contract, authorization, replay, idempotency, revision-race, moderation, withdrawal/removal, privacy, routing, failure-recovery, and end-to-end tests covering every specification acceptance criterion. Run threat-model and abuse-case reviews before release. | FED-001–FED-016 |

## P2 — Phase 2 trusted external instances

| ID | Task | Deliverable / completion condition | Depends on |
| --- | --- | --- | --- |
| FED-018 | Standardize discovery and actor/key resolution | Publish versioned well-known instance metadata and immutable actor resolution contracts usable without the managed trust registry. | FED-017 |
| FED-019 | Implement capability and policy negotiation | Negotiate protocol versions, asset modes, content types and limits, ratings, moderation requirements, profile-link policy, and activity/comment support; fail closed on incompatible required capabilities. | FED-018 |
| FED-020 | Add trusted-instance governance | Create approval, suspension, reactivation, policy-version acceptance, trust-state, and key-rotation workflows for third-party operators. | FED-018, FED-019 |
| FED-021 | Harden multi-instance operations | Add per-instance rate and concurrency limits, health scoring, isolation, reconciliation dashboards, callback compatibility tests, and incident playbooks. | FED-019, FED-020 |
| FED-022 | Pilot optional activity retrieval | Implement scoped, privacy-minimized `activity:read` only for approved local activity and only after ownership, retention, pagination, and moderation behavior are defined. | FED-019–FED-021 |

## P3 — Phase 3 broader self-host federation

| ID | Task | Deliverable / completion condition | Depends on |
| --- | --- | --- | --- |
| FED-023 | Add open enrollment and proof of instance control | Let self-hosters register through verifiable domain and key control while preventing identifier takeover and unsafe metadata changes. | FED-018–FED-021 |
| FED-024 | Ship federation governance and abuse tooling | Support deny/allow lists, trust tiers, reports, appeals, coordinated safety incidents, legal escalation, and transparent instance-level enforcement. | FED-020, FED-023 |
| FED-025 | Prove resilience at open-federation scale | Validate key rotation, replay defense, rate limiting, reconciliation, queue isolation, large-asset handling, disaster recovery, and source disappearance through load and chaos tests. | FED-021, FED-023, FED-024 |
| FED-026 | Publish the self-host interoperability package | Provide a versioned protocol, conformance suite, reference fixtures, operator documentation, upgrade policy, and compatibility/certification process. | FED-019, FED-023–FED-025 |

## Recommended execution order

1. **Model and secure the protocol:** FED-001 through FED-005.
2. **Deliver safe content flows:** FED-006 through FED-010.
3. **Add creator and destination experiences:** FED-011 through FED-014.
4. **Operationalize and validate managed federation:** FED-015 through FED-017.
5. **Expand only after Phase 1 evidence:** FED-018 through FED-022, followed
   by FED-023 through FED-026.

Work can proceed in parallel only after its listed dependencies are met. In
particular, page and dashboard work may use contract fixtures while transport is
being built, but production enablement remains blocked on moderation, audit,
privacy, failure recovery, and the complete acceptance test suite.

## Phase 1 release gates

- There is exactly one home authority and no destination creator account or
  session.
- All federation state changes are signed, audience-bound, replay-resistant,
  idempotent, revisioned, and auditable.
- Destination pages expose only moderated distribution-profile fields and
  destination-accepted publications.
- Profile links are actor-derived, opt-in, warning-gated, no-preview,
  revocable, and suppressible at creator and source-instance levels.
- Source withdrawal and destination removal remain distinct in storage, API
  responses, operator views, and creator-facing status.
- Eversally-to-Nightframe publishing is denied, and federation cannot be used
  as an account-linking or migration shortcut.
- Failure recovery, key rotation, moderation holds, legal holds, safety events,
  privacy boundaries, and source unavailability have been exercised in tests
  and documented runbooks.

## Deferred decisions requiring product or architecture sign-off

These decisions do not change the ordering above, but they must be resolved
before the affected task can complete:

1. Configure Phase 1 maximum asset limits and retention periods per destination;
   approved replication and legal-hold-aware deletion are implemented (FED-008).
2. Define grant expiry defaults, renewal UX, and behavior for existing
   publications after revocation (FED-004 and FED-007).
3. Define Eversally distribution-profile limits, permitted link schemes/domains,
   image requirements, and profile moderation states (FED-006).
4. Define handling and retention for comments, reactions, ratings, and other
   destination-owned activity when a publication is withdrawn or removed
   (FED-007, FED-009, and FED-010).
5. Define the exact safety-alert payload, access controls, retention, and
   incident protocol for CSAM, NCII, lawful reporting, and urgent security
   events (FED-009 and FED-010).
6. Define status callback authentication, delivery targets, and which internal
   moderation details may be disclosed to a home instance (FED-015).
7. Establish measurable availability, synchronization-latency, withdrawal, and
   moderation-response objectives (FED-016).
