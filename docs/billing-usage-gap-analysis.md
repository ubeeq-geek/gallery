# Billing and usage gap analysis

Reviewed: 2026-08-25

## Executive summary

The repository contains useful **building blocks for media-processing metering and entitlement gating**, but not an end-to-end billing system. The implemented pieces calculate deterministic usage, define an idempotent ledger identity, block delivery when a caller-supplied credit balance is insufficient, and route billing adjustments to a human. They do not currently connect into a durable usage-to-invoice lifecycle.

The highest-risk gap is that the ledger calculation is not invoked by the production scan-completion path. Consequently, `remainingCreditUnits` and `requiredCreditUnits` are read from Asset metadata during publication, but this repository has no authoritative balance service that creates, reserves, decrements, replenishes, or reconciles those values. Billing enforcement can therefore only be as accurate as unspecified external writes to those fields.

## What exists today

| Capability | Current implementation | Assessment |
| --- | --- | --- |
| Usage calculation | `usageForMedia` counts images, video duration, sampled frames, moderation calls, face-age calls, estimated provider cost, and credit units. Images cost one credit; videos cost 25 credits per started minute. | Good domain-level starting point, with unit tests. |
| Idempotent ledger identity | `mediaProcessingLedgerRecord` hashes product, region, space, period, media version, and scan group. | Useful retry protection, but only a pure helper today. |
| Entitlement gate | Regional delivery denies publication/integration delivery when remaining credits are below required credits, unless overage is permitted. | Fail-closed at delivery, but late in the workflow and dependent on metadata maintained elsewhere. |
| Audit storage | Each regional cell provisions a DynamoDB `audit-usage` table. Upload, policy, publication, and revocation events are written there. | Operational audit trail exists; it is not a usage ledger or billing read model. |
| Human billing operations | Authenticated users can create billing tasks tied to support tickets; administrators record a human decision. | Appropriate safety control for manual changes, but not a payment or accounting workflow. |
| Tests | Unit tests cover the usage formula, stable ledger IDs, and exhausted-entitlement delivery behavior. | Covers pure contracts, not production persistence or lifecycle behavior. |

## Gaps, ordered by priority

### P0 — Enforcement and accounting integrity (implemented 2026-08-25)

1. **Production usage posting:** scan-group policy completion now atomically consumes its reservation and persists an immutable, idempotent usage entry.
2. **Authoritative balance lifecycle:** the regional billing repository implements grants, reservations, final consumption, release, refund, expiration, available-balance calculation, and event-based balance reconstruction.
3. **Race and overspend protection:** image/video ingest reserves against a conditional account-period balance before provider scan dispatch. Public delivery reloads the resulting usage and balance records instead of Asset-level credit copies.
4. **Explicit billable event:** `SCAN_GROUP_POLICY_COMPLETED` is billable; incomplete/unavailable work releases its reservation, while retries reuse the same media-version/scan-group identity. Detailed semantics are recorded in `regional-processing-billing.md`.
5. **Versioned pricing:** every quote, reservation, and usage record contains the effective price-book version, effective time, unit, currency, and calculation explanation.

### P1 — Commercial billing lifecycle (implemented 2026-08-25)

6. **Plans and subscriptions:** immutable prices, account ownership, trials, periods, scheduled plan changes/cancellation, and product entitlements are implemented.
7. **Payment provider:** the configured Stripe adapter supports customers, Checkout, Billing Portal, invoices, automatic tax/promotion configuration, signed raw-body webhooks, and durable event replay suppression.
8. **Invoice and reconciliation:** period close has a defined late-usage cutoff, itemized base/usage/tax/discount/credit lines, source usage IDs, draft corrections, provider invoice finalization, and durable reconciliation issues. Production processing usage now receives a versioned provider-cost estimate.
9. **Delinquency:** guarded transitions cover payment failure, grace, suspension, recovery, cancellation, and write-off, with provider webhooks using the same state machine.
10. **Billing tasks:** financial changes are typed and minor-unit/currency based; linked-ticket ownership, evidence, idempotency, decision reasons, provider operation IDs, and requester/approver separation are enforced.

### P1 — Customer and operator experience (implemented 2026-08-25)

11. **Billing and usage read model:** authenticated APIs expose accounts, active plan, period totals, available/reserved/pending credits, product/space rollups, invoices, prices, and authenticated CSV statements. Operator-authenticated ingestion maintains durable usage rollups.
12. **Customer billing UI:** `/billing` surfaces plan and status, credit progress and warnings, per-space usage, period selection, statements, invoices, hosted payment settings, upgrade/checkout actions, and an explicit exhausted-credit recovery message.
13. **Operator billing console:** `/billing/operator` combines typed support billing tasks and open reconciliation exceptions, with audited request-info, rejection, and execution recording. Admin APIs expose the same queues and rollup controls.
14. **Actionable failure semantics:** permanent processing-entitlement failures are acknowledged instead of retried through SQS, and an idempotent regional delivery-block record captures `retryable: false` plus the `ADD_PROCESSING_CREDITS_OR_ENABLE_OVERAGE` remediation. Transient failures remain retryable.

### P2 — Reporting, governance, and operations (implemented 2026-08-25)

15. **Billing access patterns and aggregation:** regional financial data now uses a separate billing ledger with an account-period GSI and stream-driven, event-idempotent product/Space rollups. Worker IAM grants distinguish financial reads/writes from operational audit access.
16. **Cost and revenue observability:** regional and commercial dashboards/alarms cover metered and reserved units, entitlement rejection, balance integrity, estimated provider cost, provider-cost variance, invoiced revenue, leakage, reconciliation issues, provider failures, webhook failures, and replay volume.
17. **Retention and governance:** regional and commercial financial tables are separate from audit/safety data, have no TTL, and use production PITR, deletion protection, retained removal, and backups. Seven-year ledger/invoice retention, pseudonymized deletion, scoped export, privacy, and role boundaries are documented in `billing-governance-and-operations.md`.
18. **Lifecycle and failure tests:** tests cover conditional concurrent reservation, atomic consumption/usage posting, event-idempotent aggregation, duplicate and reordered lifecycle input, balance reconstruction, period/late-arrival boundaries, refund/expiration transaction guards, webhook replay/failure recovery, cost variance, and reconciliation.

## Recommended target design

Keep safety/policy audit records separate from a dedicated billing domain:

1. **Account and entitlement service:** account/tenant owner, plan, subscription state, billing period, included units, overage policy, and effective-dated entitlement versions.
2. **Append-only usage ledger:** one immutable event per billable action, carrying account, product, region, creator/space, media version, scan group, quantity, unit, price-book version, source event, timestamps, and reversal linkage. Enforce uniqueness on the source/idempotency identity.
3. **Atomic reservation/consumption:** reserve estimated credits before costly processing, finalize actual usage on the defined billable event, and release or adjust the reservation on failure. Use one authoritative account-period balance, not copied Asset balances.
4. **Billing adapter:** isolate payment-provider checkout/customer/invoice/webhook operations behind a provider-neutral interface. Verify signed webhooks and store event IDs before applying state transitions.
5. **Read models and APIs:** expose plan, current and projected usage, available/reserved units, line-item detail, invoices, and remediation actions to customers; expose reconciliation and exception queues to authorized operators.
6. **Reconciliation and observability:** scheduled jobs compare scan/provider attempts, usage ledger entries, balances, and invoice lines. Alert on missing/duplicate usage, negative balances, stuck reservations, webhook lag/failures, and cost variance.

## Suggested delivery sequence

### Phase 1: make metering trustworthy

- Define billable-event and retry/failure/refund policy in an architecture decision record.
- Version the existing credit formula and add the version plus source identifiers to ledger entries.
- Post an immutable usage entry transactionally/idempotently when a scan group reaches its chosen billable state.
- Introduce an account-period balance with atomic reserve/finalize/release operations.
- Replace Asset-supplied balance fields in delivery checks with an authoritative entitlement read.
- Add concurrency, replay, incomplete-scan, rescan, and month-boundary tests.

### Phase 2: make usage visible

- Build account-period rollups and detail APIs.
- Add customer usage/balance views, thresholds, and exhaustion remediation.
- Add operator exception and reconciliation views plus usage/cost dashboards.

### Phase 3: make billing commercial

- Add plan/subscription state and payment-provider integration.
- Implement signed, idempotent webhooks, invoices, tax/discount handling, plan changes, cancellation, and dunning.
- Replace free-form financial mutations with typed adjustments/reversals and dual-control where required.
- Reconcile invoice lines to immutable ledger entries before period close.

## Minimum release criteria for paid usage

- Every costly provider operation has exactly one traceable usage outcome: charged, included, reversed, or explicitly non-billable.
- Duplicate and out-of-order events cannot double charge; concurrent requests cannot overspend a non-overage account.
- A balance can be reconstructed solely from grants, reservations, charges, releases, and reversals.
- Every charge records the effective entitlement and price-book versions.
- Customers can see current-period usage and understand an entitlement rejection.
- Operators can identify and replay failed usage/webhook events and reconcile provider activity to invoice lines.
- Automated tests cover the lifecycle above, including failures and period boundaries.

## Scope note

This is a repository-level implementation review. An external billing platform may exist outside this repository, but no contract, integration, or ownership boundary for one is represented here. If billing is intentionally external, the missing interface, event schema, source of truth, reconciliation responsibility, and failure behavior should still be documented and tested in this codebase.
