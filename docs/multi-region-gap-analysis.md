# Multi-region functionality gap analysis

## Executive summary

The repository now contains an end-to-end **regional media-cell and global routing foundation**. It provides opaque data-home assignment and discovery, shared identity, regional provisioning, connected image delivery, and executable manifest-driven migration stages. It deliberately remains a residency-oriented design rather than a multi-region failover design.

The implementation retains its original residency controls and now closes the five initial P0 orchestration gaps. The global directory stores opaque assignments and returns configured cell endpoints; a global Cognito pool is accepted by production cells; regional APIs provision upload prerequisites; image ingest promotes originals and private derivatives; a durable publication outbox reaches delivery; and migration persists a manifest, copies and verifies objects, requests rescans, and conditionally cuts over the directory. Remaining P1/P2 work is primarily resilience, operational hardening, lifecycle, and deployed integration validation.

## Scope and definitions

This review is based on static inspection of application and CDK code plus existing tests. Externally managed services, pipelines, and runbooks may close gaps, but are not represented here.

“Multi-region” should distinguish:

1. **Data residency:** a tenant's private data and processing remain in its selected home region. This is the design direction of the regional cell.
2. **Regional resilience:** service continues after a regional failure. The cell deliberately configures no replication, so this is not currently provided.

## What exists today

### Deployment order

1. Deploy `DEPLOY_TARGET=global-routing` with `ENVIRONMENT` and a
   `REGIONAL_ENDPOINTS_JSON` map keyed by `<product>:<region>`.
2. Pass the resulting `GlobalUserPoolArn` and `RoutingTableName` to every
   production cell as `GLOBAL_USER_POOL_ARN` and `GLOBAL_ROUTING_TABLE` (plus
   `GLOBAL_ROUTING_REGION` when it is not `us-east-1`).
3. Configure the web client with the global outputs via
   `VITE_COGNITO_*` and `VITE_ROUTING_API_URL`.
4. Start a cell's `DataHomeMigration` state machine with an immutable request
   containing source/destination regions, destination table/queue names, object
   hashes, regional records, and destination rescan jobs. The workflow marks
   routing `MIGRATING` and changes the authoritative route only after copy,
   rescan completion, integrity verification, and destination readiness.

### Regional boundaries and infrastructure

- Five data-home regions and two products are allow-listed in the domain and infrastructure.
- A product × environment × region cell can be deployed independently, and the stack rejects a CDK region different from its data home.
- Each cell creates encrypted S3 buckets, DynamoDB tables, queues and DLQs, a regional API Gateway, Cognito pool, workers, WAF, CloudFront, alarms, and a dashboard.
- Production tables enable point-in-time recovery and deletion protection; durable buckets are versioned. No S3 replication or DynamoDB global table is configured, preserving isolation.

### Media workflow building blocks

- `POST /uploads` authorizes a bounded image/video upload into regional quarantine, conditionally checking an existing active Space and canonical Asset in the same cell.
- S3 events enqueue image ingestion or video frame extraction. Jobs carry product, environment, region, hash, scan profile, and deterministic idempotency identifiers.
- Scan workers constrain source buckets and cell identity, use region-pinned Rekognition, persist idempotently, and fail closed for incomplete required scans.
- Policy evaluation atomically updates the Asset and creates audit/review/hold/revocation records. Public delivery revalidates the canonical region, policy, media version, scan group, and entitlement.
- DLQs, queue-age alarms, partial-batch responses, idempotent writes, and a DynamoDB-stream outbox provide an asynchronous-processing baseline.

## Implementation status and remaining gaps

| Priority | Gap | Repository evidence | Impact and completion criterion |
| --- | --- | --- | --- |
| **Done** | **Global control plane and request router** | `GlobalRoutingStack` owns a Cognito-protected opaque DynamoDB directory and `GET/POST /routing/{product}`. The web routing client caches discovery and sends authenticated regional requests. | Endpoint configuration remains explicit and assignment changes fail closed into migration. |
| **Done** | **Regional prerequisite provisioning** | Regional cells expose authenticated, idempotent `POST /spaces` and `POST /assets` endpoints backed by local metadata. | Upload prerequisites can be created without manual DynamoDB writes. |
| **Done** | **Connected ingest-to-publication path** | Image ingest promotes originals and private derivatives, policy clearance creates a transactional publication outbox, and a stream worker dispatches the authoritative publication message. | Cleared images now reach the existing guarded public-delivery worker without an external event producer. Video derivative generation remains follow-up work. |
| **Done** | **Executable migration workflow** | Step Functions invokes manifest persistence, object copy, destination rescan request, metadata/hash verification, and conditional global-directory cutover stages. | The flow is resumable through idempotent records and fails closed before cutover on integrity or destination readiness errors. Operational initiation/UI and rollback automation remain hardening work. |
| **Done** | **Shared identity accepted by cells** | `GlobalRoutingStack` creates the shared user pool; production cells require and import its ARN rather than creating self-sign-up identities per region. | Subjects remain stable across routing and provisioning. Development cells use a non-self-sign-up fallback only. |
| **Done** | **Residency boundaries specified and enforced** | The operations guide classifies regional/global/public data and global-service exceptions. Every cell applies a requested-region permissions boundary, with CDK policy assertions. | Organization-level SCP rollout remains an account-administrator action documented in the runbook. |
| **Done** | **Regional disaster-recovery objective and procedure** | Durable stores have a vault-locked regional AWS Backup plan in addition to PITR/versioning. The guide defines per-class RPO/RTO, fail-closed outage semantics, restore validation, and quarterly game days. | Backups intentionally remain in-region; cross-region DR requires a separate legal/product decision. |
| **Done** | **Operational signals and alarm routing** | Production requires an operations email. Encrypted SNS actions cover DLQs, stream failures, queue age, API errors/latency, health canaries, and worker concurrency; audit records stream as structured logs. | Subscription confirmation and SLO ownership are deployment gates. |
| **Done** | **DLQ redrive and terminal recovery** | An operator-only fixed-map redrive Lambda validates every message against its cell, deletes only after send, and audits the operator. Revocation/audit stream failures have an alarmed failure destination. | Critical stream envelopes require the restricted manual procedure rather than unsafe queue forwarding. |
| **Done** | **Declarative region-matrix deployment** | A versioned manifest declares all ten cells and waves; scripts validate coverage, regional layers/endpoints, AWS capabilities/quotas, and CloudFormation drift. The matrix CDK target uses one immutable policy/config version. | Wave gates and drift checks must be enforced by the release system. |
| **Done** | **Quota, cost, and back-pressure controls** | Upload authorization atomically enforces monthly Space byte/count quotas and writes a usage ledger. Scan FIFO ordering groups work by authoritative Space; all worker concurrency and queue-age signals alarm. | Quota values remain deployment configuration and should be tuned from load-test/provider data. |
| **Done** | **Data lifecycle and regional privacy workflows** | Every content bucket now has class-specific expiry. Authenticated export and deletion APIs enforce cell ownership, legal holds, local export storage, object/record deletion, and post-delete absence verification. | Retention and the erasure/export evidence contract are published; backup copies expire under vault-lock policy. |
| **Done** | **Stable public endpoints and browser cutover behavior** | Optional certificate-backed Route 53 names cover regional API and media delivery. The API has explicit CORS, throttling, metrics, tracing, and JSON access logs; CloudFront uses private origin access control and security headers. | Production requires an origin allowlist, while the browser discards non-active cached routes and refreshes once on migration/outage status. |
| **Done** | **Deployed two-cell release qualification** | `qualify:two-cell` exercises live routing, provisioning, and cross-cell denial, and requires successful environment-specific gates for upload/publication, migration interruption/resume, outage routing, and AWS-enforced residency denial. | The release gate refuses a partial/component-only pass; evidence is retained with the release record. |

## Recommended delivery sequence

### Phase 1 — make one cell usable end to end

1. Define the global directory and stable identity contracts.
2. Add regional Space/Asset provisioning and connect web bootstrap to directory lookup and regional upload.
3. Complete original promotion, derivative creation, and publication event production.
4. Prove the golden journey in one non-production cell with synthetic monitoring and auditable transitions.

**Exit criterion:** a new user can be assigned and provisioned without manual database writes, upload media, and reach a deterministic terminal state.

### Phase 2 — make the region matrix operable

1. Add a declarative cell manifest and automated deployment waves.
2. Add residency guardrails, drift detection, alarm destinations, redrive tooling, and runbooks.
3. Load-test video fan-out and enforce tenant/provider quotas and usage records.
4. Run the golden journey in every supported region and record service/layer capability differences.

**Exit criterion:** every declared cell is reproducible, observable, supportable, and demonstrably denies cross-cell access.

### Phase 3 — implement migration and explicit resilience

1. Replace migration `Pass` states with manifest-driven resumable work and atomic directory cutover.
2. Add interruption, rollback, integrity, session, public-URL, and cleanup tests.
3. Establish documented RTO/RPO and backup/restore or accepted-outage behavior consistent with residency.
4. Exercise migrations and outages before enabling self-service region changes.

**Exit criterion:** migration can be interrupted at every step, safely resumed or rolled back, and independently verified; outage behavior meets a published tested objective.

## Decisions required

- Is the primary goal residency isolation, regional availability, or both?
- Which entity owns placement: user, creator identity, space, or tenant?
- Which metadata may exist in the global directory, and in which jurisdiction?
- Is global CloudFront delivery acceptable for public derivatives?
- May backups leave the exact home region or remain only within a geography?
- What RTO/RPO, retention, deletion, export, and legal-hold rules apply per data class?
- Must migration preserve public URLs and sessions, and is a write freeze acceptable?
- Which review/hash providers operate in every launch region, and how should unavailable providers fail closed?

## Bottom line

The implementation is a strong prototype for **cell-local media safety processing**, particularly its explicit cell checks, idempotent jobs, and fail-closed policy evaluation. The highest-value next step is not adding more regions. It is connecting one cell to authoritative assignment, identity, provisioning, derivative, and event paths, then making that path observable and repeatable. Migration and regional resilience should follow after the steady-state journey works end to end.
