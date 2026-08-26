# Commercial billing lifecycle

## Catalog and entitlements

Commercial prices are immutable versioned records scoped to Eversally or Nightframe. They define currency, monthly/yearly interval, base amount, included processing credits, optional overage price, and tax behavior. Billing accounts have one owner and a provider customer mapping. Subscriptions retain the selected price version, period, optional trial, scheduled next-period plan, scheduled cancellation, and product-specific entitlement.

## Payment provider

The configured Stripe adapter creates customers, hosted subscription Checkout sessions, Billing Portal sessions, invoice items, and invoices. Checkout enables automatic tax and promotion codes; payment methods and customer invoice history are managed in the hosted portal. Every mutation that can be replayed carries an idempotency key.

Stripe webhooks are accepted only on the raw request body after timestamp tolerance and HMAC-SHA256 verification of the `Stripe-Signature` header. Provider event IDs are conditionally persisted in DynamoDB before state changes, so a replay is acknowledged without applying it twice. Provider secrets are server-only `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` configuration.

## Invoicing and reconciliation

Period close selects usage from period start through an explicit late-usage cutoff (24 hours by default), applies included credits, constructs subscription and overage lines, and records taxes, discounts, and account credits separately. Usage lines retain their immutable source usage IDs. Draft corrections are idempotent by source ID.

Finalization creates provider invoice items and an invoice using the internal invoice ID as its idempotency key. Reconciliation compares invoice source IDs with usage and emits durable issues for missing usage and missing provider-cost estimates. Regional processing usage now estimates provider cost from the versioned per-analysis-call cost assumption rather than silently defaulting production entries to zero.

## Delinquency

Allowed subscription transitions explicitly model trial, active service, past due, a seven-day grace period, suspension, recovery, cancellation, and write-off. Payment-failure, payment-recovery, and provider-cancellation webhooks drive the same guarded transition function used by operators. Suspended, canceled, and written-off subscriptions do not grant product entitlement.

## Financial support controls

Billing support work uses enumerated change and reason types, integer minor-unit amounts, an ISO currency, expected prior state, notes, evidence references, and an idempotency key. The linked billing ticket must exist and belong to the requester. Execution requires a different human approver, a written decision reason, and a provider operation ID; all outcomes retain before/after audit context.

## Customer and operator experience

The account-period read model aggregates credits granted, consumed, reserved, pending, and available by product and Space. Authenticated customers can query the current plan and status, invoice history, rollups for a selected month, and download a CSV statement. The `/billing` application screen adds progress warnings, an exhausted-credit remediation, hosted checkout/upgrade actions, and Stripe Billing Portal access.

Finance operators receive a combined queue of typed billing tasks and reconciliation exceptions at `/billing/operator`. The console supports requesting evidence, rejection, and recording an executed provider operation with the resulting balance. Permanent regional delivery failures caused by exhausted entitlement are stored as non-retryable blocks with explicit customer remediation instead of repeatedly consuming SQS delivery attempts.
