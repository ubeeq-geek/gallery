# Regional media-processing billing contract

## Source of truth

Each product/region cell keeps financial processing records in its encrypted `audit-usage` table. Account-period balances use `BALANCE#{accountId}#{YYYY-MM}` keys. Grants, reservations, usage, refunds, and expirations are immutable records; the balance is the atomically maintained read model and can be checked against those records with `reconstructProcessingBalance`.

An Asset is not a balance source. Asset `processingBillingState` is only workflow evidence. Public delivery reloads the immutable usage entry and its account-period balance rather than trusting copied credit fields on the Asset.

## Price book

Price book `regional-processing-2026-08-25` is effective from 2026-08-25 UTC:

- one source image: 1 processing credit;
- video: 25 processing credits per started minute;
- unit and settlement currency: `PROCESSING_CREDIT` / `CREDIT`.

The reservation and final usage entry retain the price-book version, effective time, unit, currency, and human-readable calculation. A future price change must introduce a new version instead of changing historical records.

## Lifecycle and billable event

1. A typed, idempotent grant creates or increases an account-period balance.
2. After media bytes and metadata are authoritatively validated—but before Rekognition work is dispatched—the cell calculates the quote and atomically reserves credits. The reservation identity is stable for a media-version/scan-group retry. The conditional balance update prevents concurrent work from overspending unless the account explicitly permits overage.
3. Provider retries inside the same immutable scan group do not create another reservation or charge.
4. `SCAN_GROUP_POLICY_COMPLETED` is the sole billable event. When every required scan has a durable result and policy evaluation succeeds, policy state, the Asset billing marker, reservation consumption, account balance, and immutable usage entry are committed in one DynamoDB transaction.
5. A scan group that resolves to `SCAN_UNAVAILABLE` is non-billable and releases its reservation in the same policy transaction. Exhausted ingest work also releases a successfully created reservation before being marked unavailable.
6. Replaced versions, explicit rescans, approved imports, product transfers, and migrations are separate billable work only when they produce a new media-version/scan-group identity and successfully reserve credits. Replays of an existing identity are not charged twice.
7. Refunds are additive immutable adjustments linked to the original usage ID. Expiration is an immutable account-period adjustment and cannot consume reserved or already consumed credits. Expired reservations must be explicitly released; DynamoDB TTL is deliberately not used because deleting a reservation cannot repair its balance atomically.

## Operational requirements

- Provision grants before accepting processing for a new account-period. A missing balance fails reservation closed.
- Run an expiration/reconciliation job to release expired reservations and compare balance read models with immutable lifecycle records.
- Treat `ProcessingEntitlementExhausted` as a permanent, customer-actionable condition, not a transient provider error.
- Restrict grant, refund, expiration, and overage changes to a finance-authorized control plane. The repository methods are primitives and are not exposed through the creator upload API.
