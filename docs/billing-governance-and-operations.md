# Billing governance and operations

## Storage and access boundaries

Financial data does not share an operational audit table:

- Each regional cell has an encrypted `billing-ledger` table for grants, balances, reservations, usage, refunds, expirations, and account-period rollups. It has no DynamoDB TTL, uses point-in-time recovery and deletion protection in production, and is retained with the stack.
- The commercial API has a dedicated `CommercialBillingTable`, separate from Content Core and support/safety data. Only the API execution role receives data access. It is included in the production AWS Backup plan.
- The regional `audit-usage` table remains an operational policy, publication, hold, and revocation journal. Publication receives read-only financial access; ingest, scan completion, and the rollup worker receive only the financial access required for their responsibilities.

The regional financial table exposes `account-period-index` (`GSI1PK = ACCOUNT#{accountId}#PERIOD#{YYYY-MM}`) ordered by record type and creation time. This supports statements, reconciliation, export, and bounded account-period investigations without table scans. The stream-driven rollup worker maintains product/Space aggregates and uses the DynamoDB stream event ID as an idempotency record.

## Retention and deletion

- Immutable financial ledger events, invoices, provider mappings, adjustments, and reconciliation outcomes must be retained for seven years after period close unless a longer legal hold applies. They must not receive TTL attributes.
- Production financial tables use point-in-time recovery, deletion protection, retained removal policy, daily backups retained for 35 days, and locked monthly backups retained for seven years.
- Operational audit records follow the product security/audit retention schedule and must not be used as the financial system of record.
- Account deletion removes product profile/content according to product policy but pseudonymizes the billing account subject rather than deleting invoice or ledger facts during the financial retention period. Provider customer deletion is scheduled only after legal/tax retention permits it.
- Customer exports include invoices and account-period usage statements, but never payment credentials, provider secrets, restricted safety evidence, or another account’s identifiers.

## Privacy and authorization

- Customer billing reads require account ownership. Prices are authenticated; statements and invoices are owner-scoped.
- Price changes, usage-rollup ingestion, period close, reconciliation, corrections, and operator queues require the administrator role.
- Billing-task execution additionally enforces requester/approver separation and records the provider operation ID and resulting amount.
- Payment methods remain with Stripe and are managed through the hosted portal; the application stores only provider customer/subscription/invoice identifiers.

## Monitoring and response

Regional dashboards show metered and reserved credits, estimated provider cost, available balance, negative non-overage balances, entitlement rejections, and aggregation failures. Alarms cover aggregation errors, negative balances, and sustained entitlement rejection.

The production commercial dashboard shows invoiced revenue, revenue leakage, provider-cost variance, open reconciliation issues, payment-provider failures, webhook failures, and webhook replays. Any financial-integrity alarm requires reconciliation before invoice close; failed or replayable inbox events remain durable until applied.
