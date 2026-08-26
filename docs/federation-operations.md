# Managed federation operations and security

## Production telemetry

Federation services use CloudWatch Embedded Metric Format under the
`Ubeeq/Federation` namespace. The deployment dashboard covers authentication
failures, replay attempts, callback retries, reconciliation drift, asset
failures, and p95 processing latency. Authentication and persistent asset
failures notify the federation alarm topic in addition to the queue age and
dead-letter alarms.

Only the local instance, remote instance, and operation may be metric
dimensions. Actor URIs, creator identifiers, Work URIs, grant IDs, publication
IDs, callback IDs, and audit details must remain out of dimensions and metric
logs. This both limits CloudWatch cardinality and prevents creator data from
entering operational telemetry.

The metric observer rejects an invalid local instance identifier at startup
rather than emitting malformed or attacker-influenced EMF dimensions. Asset
replication and callback delivery emit latency on both successful and failed
attempts so p95 graphs include the slow failure paths that operators need to
investigate. This includes failures during preflight trust, origin, DNS, and
actor-namespace validation, before any remote request is made. Each attempt
emits one latency sample. Metric-writer failures are isolated from federation
operations and therefore cannot turn a successful transfer into a failure or
replace the protocol error returned for a rejected attempt.

## Service objectives

| Signal | Objective | Page when |
| --- | --- | --- |
| Publication withdrawal visibility | 99.9% hidden within 60 seconds | Any withdrawal remains public after 60 seconds. |
| Status callback delivery | 99% delivered within 5 minutes | Oldest queued callback exceeds 5 minutes or dead letters increase. |
| Reconciliation | No unresolved drift older than 15 minutes | Drift gauge is non-zero for 15 minutes. |
| Signature verification | Valid managed traffic succeeds at 99.99% | Failures exceed 1% for five minutes; separate invalid-key, expiry, audience, and signature alerts. |
| Asset processing | 99% of accepted assets finish within 15 minutes | Queue age exceeds 15 minutes or integrity/policy failures spike. |

Grant and publication status are private federation state. They are read only
through signed `grant.status` and `publication.status` envelopes, including the
same audience, lifetime, replay, idempotency, signing-home, and resource binding
checks used for mutations. Publication reads additionally require the active
`publication:status` grant scope. HTTP admission always consumes a network-origin
bucket before considering the still-unverified claimed source instance; deployed
edge throttling remains the distributed first layer of defense.

Distribution-profile authority is the immutable actor URI. The signed profile
payload includes that URI, and its HTTP path is the canonical base64url encoding
of the same HTTPS URL. The route actor, signed actor, and active grant actor must
match exactly; handles, remote creator IDs, and projection IDs are display or
destination identifiers and never authorize a profile update.

The product service exposes queue age, dead-letter count, reconciliation drift,
status callback, replay, and link-consent metrics. Grant, profile, publication,
moderation, link, and callback transitions are also immutable audit events.

Public creator projections fail closed on media URLs. Source-supplied
`thumbnailUrl` values and profile `deliveryUrl` values are not returned to
browsers because they can be arbitrary or expiring remote URLs. A public avatar
or thumbnail may be added only from a cleared destination replication record
and a destination-controlled delivery URL.

## Operator runbooks

### Failed delivery or callback

The callback worker treats every SQS body as untrusted. It rejects malformed
JSON, callback/job identifier mismatches, completed jobs, and target values that
are not exact HTTPS origins. Immediately before every outbound request, the
delivery service resolves the home instance again and requires the queued
origin to equal the current managed-trust origin, the destination identity to
equal the local instance, and the actor URI to remain inside the home instance's
verified actor namespace. Callback payload creation is conditional and each
delivery update compares the previously persisted attempt count, preventing a
stale worker from overwriting a newer retry or terminal result. The Lambda event
source must enable partial batch failure reporting: only parser or persistence
failures return to SQS, while HTTP failures are classified and re-enqueued by
the callback service with its bounded delay.

1. Confirm the source and destination are still trusted and the grant is active.
2. Inspect the last error without exposing the callback body or internal notes.
3. Reconcile the destination state before replaying any ambiguous create.
4. Replay only a dead-letter job. The original idempotency key remains attached.
5. Escalate if queue age breaches five minutes or failures affect multiple actors.
6. Treat 408, 425, 429, and 5xx responses as retryable; other 4xx responses are
   terminal until an operator corrects configuration or policy.
7. A replay creates a newly signed envelope and nonce while retaining the
   callback's semantic idempotency key.

### Reconciliation drift

The destination persists `appliedSourceRevision` separately from the latest
received `sourceRevision`. Receiving a revision moves the publication into
processing but does not advance the applied revision; only a destination
`published` moderation decision does. Reconciliation flags a published stale
revision, an unapplied source withdrawal, or source-unavailable content that is
still visible. Pending processing and intentional destination holds, rejections,
or removals are not classified as drift.

1. Compare source revision, applied destination revision, source status, and local status.
2. Do not overwrite a moderated or legally held destination publication.
3. Request a fresh signed status or revision from the home instance.
4. Apply the revision only after destination processing and moderation completes.
5. Preserve both snapshots and the resolution in the audit trail.

### Key or signature incident

1. Restrict the source instance when failures may be caused by clock or rollout
   error; block it immediately when compromise is suspected.
2. Reject unknown, revoked, not-yet-valid, expired, wrong-audience, and replayed
   requests. Never bypass verification to drain a queue.
3. Publish and register a replacement key with a bounded overlap window.
4. Re-sign undelivered operations with new nonces; never reuse captured requests.
5. Review the replay and signature counters and notify security if compromise is
   plausible.

### Creator or instance restriction

1. Suppress the home-profile link before investigation when off-service linking
   is implicated.
2. Limit or hide the destination projection without editing the home profile.
3. Hold or remove destination publications independently of source state.
4. Use legal hold before cleanup when evidence preservation is required.
5. Ordinary policy decisions stay local. Use restricted incident protocols for
   CSAM, NCII, lawful reports, or urgent security findings.

### Federated asset failure

1. Do not follow redirects or manually override source-origin and DNS checks;
   the delivery connection must use the exact addresses approved at preflight
   while retaining the verified hostname for TLS validation.
2. Compare the independently observed byte count and SHA-256 with the signed
   reference before requesting destination scans.
3. Keep failed objects in quarantine only when an active legal hold requires
   evidence retention; otherwise delete them immediately.
4. Never promote an asset until malware and destination safety scans clear and
   rendition processing succeeds.
5. If rendition generation succeeds but promotion fails, delete the quarantine
   object and every returned rendition key unless a legal hold requires all
   evidence to remain.
6. Reconcile promoted objects against publication state and delete destination
   copies and renditions after withdrawal according to the configured retention.

## Threat model and abuse cases

| Threat | Required control and acceptance check |
| --- | --- |
| Forged home or destination | Actor URI must match registered HTTPS instance metadata; Ed25519 signature, key validity, and exact audience are mandatory. |
| Captured request replay | Five-minute maximum lifetime, unique nonce persistence, and operation-scoped idempotency are checked before mutation. |
| Revision rollback/race | Profile revisions increase monotonically and publication updates require the current expected revision. |
| Destination account takeover | A remote projection contains no password, session, billing relationship, or canonical CRUD authority. |
| Profile laundering | Only the moderated distribution snapshot is rendered; the home profile is never fetched, mirrored, cached, previewed, or treated as approved. |
| Arbitrary redirect | The optional home link is exactly the verified actor URI and cannot be replaced by creator input. |
| Warning bypass | The public model marks the link warning-required; consent is recorded only while the link remains allowed. |
| Hidden or rejected Work exposure | Public queries select only locally published, source-active Works and allowlist public metadata/disclosure fields. |
| Asset substitution | HTTPS expiry, byte length, SHA-256, malware clearance, and safety clearance are all required. |
| Moderation propagation | Source and destination status remain separate; destination removal never changes the canonical Work. |
| Audit data leakage | Audit events use identifiers, state, reasons, and hashes rather than creator credentials, private account data, source metadata, or internal notes. |
| Queue amplification | Exponential retry is bounded; terminal work enters a dead letter and requires deliberate operator replay. |

## Audit access and retention

- Federation operators may read operational events only; moderators also see
  moderation events, safety investigators may read restricted safety events,
  and legal reviewers may read legal-hold records.
- Password, secret, token, credential, private-data, raw-payload, and internal
  note fields are rejected from audit details rather than redacted after write.
- Non-held records receive the configured retention TTL. Legal events omit TTL,
  and an attributed legal hold conditionally removes an existing expiration.
- Investigation exports verify each stored record hash before producing NDJSON;
  a mismatch stops export and triggers an integrity investigation.

## Operator authorization

- Federation operators can inspect state, replay reconciled dead letters, and
  read operational audits. Moderators can additionally restrict projections and
  moderate destination publications.
- Safety investigators can block a source instance. Legal reviewers can place
  or release publication holds and preserve audit records.
- Every destructive block, replay, or hold requires a non-empty reason and the
  exact resource-specific confirmation phrase shown by the operator client.

## Release acceptance procedure

Before managed federation is enabled, run the API federation contract suites and
the full API test suite, build both API and web TypeScript projects, and exercise
the following end-to-end cases in a managed staging pair:

1. Connect Nightframe to Eversally, accept the grant, and publish a moderated
   distribution profile.
2. Publish, revise, hold, reject, withdraw, and destination-remove separate
   Works; verify each per-destination state in the home dashboard.
3. Confirm the public creator page includes only accepted Works and allowlisted
   destination fields.
4. Opt in to the verified home link, confirm the warning copy and destination
   domain, continue, revoke consent, then suppress the link as an operator.
5. Tamper with signatures, audiences, timestamps, nonces, revisions, checksums,
   ratings, and source ownership and verify every request fails closed.
6. Block the actor and source instance, exercise source-unavailable and legal
   hold states, and verify canonical home records remain unchanged.
7. Force callback retries, dead-letter a callback, reconcile state, safely
   replay it, and confirm alerts and audit events.
8. Verify Eversally-to-Nightframe publication is rejected and no destination
   account, credentials, private home data, gallery, followers, favourites, or
   activity are created or copied.
