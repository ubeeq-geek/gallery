# Ubeeq extraction inventory

This repository remains the transitional source while Ubeeq and the private hosted-product repositories are verified. Do not delete it until every item below has a tested replacement.

Run `node scripts/inventory-hosted-coupling.mjs` to produce the current file/reference count by migration category. The initial inventory finds 113 files with hosted-product references; treat the report as a migration baseline, not a public-repository allowlist.

## First extraction: integration mechanism

The generic capability vocabulary, remote-operation gate, and executable conformance runner are now represented by `@ubeeq/integrations` in the public Ubeeq repository.

The neutral moderation evidence, review-case, hold, and auditable decision lifecycle are now represented by `@ubeeq/moderation`. Product-specific thresholding, notices, enforcement, and escalation policy remain private.

The provider-neutral admission decision over active review holds is now represented by `@ubeeq/moderation`, including a typed blocked result for queue and API callers. Product policy continues to decide which holds exist, which operations select which targets, how a hold is remediated, and what a creator is told.

The neutral asset-processing request and idempotent usage measurement interfaces are now represented by `@ubeeq/processing`. Plan catalogues, credit reservations, prices, quotas, overage treatment, and billing approvals remain private.

The neutral object-storage and delivery adapter interfaces are now represented by `@ubeeq/storage`. Retention schedules, access eligibility, domains, signed-delivery policy, and revocation decisions remain private.

The neutral Work, Asset, WorkAsset, origin, and content-availability contracts are now represented by `@ubeeq/core`. The legacy canonical domain remains transitional while its content-rating, AI-disclosure, discovery, publication, provider destination, and product-policy fields are separately moved behind the appropriate public or private contracts.

The neutral Creator, collection, publication, publication-intent, and reconciliation contracts are now also represented by `@ubeeq/core`. Legacy concrete provider destinations, raw provider data, disclosure snapshots, and discovery/remediation policy remain transitional rather than becoming Ubeeq defaults.

The portable structured content-block and media-reference contracts are now represented by `@ubeeq/core`, including structural validation only. Legacy viewer-specific visibility filtering, HTML sanitization, and provider renderers remain outside the public core and must move with the owning product or connector.

The provider-neutral remote-publication state transitions and idempotent retry scheduling are now represented by `@ubeeq/integrations`. Concrete connector calls, external-account persistence, provider response normalization, credentials, and raw payload handling remain private adapter responsibilities.

The provider-neutral reconciliation normalization, snapshot diffing, status classification, and confirmation-gated resolution are now represented by `@ubeeq/integrations`. Adapters remain responsible for selecting user-meaningful fields, creating any adapter-owned fingerprint, stripping their remote identifiers, and scheduling actual remote writes.

The distinct Eversally provider-billing and Nightframe manual-settlement plan catalogues now live in private product modules. The Gallery billing ledger remains transitional until its neutral entitlement/usage mechanism is extracted separately; payment credentials, processor setup, finance procedures, and price terms must not move into public Ubeeq.

The neutral append-only usage and credit-reservation ledger is now represented by `@ubeeq/billing`, including idempotency, expiry, reservation, commit/release, and balance semantics. Product plan selection, entitlement activation, payment providers, finance workflows, and commercial terms remain private.

The neutral authenticated-subject and role/scope authorization contracts are now represented by `@ubeeq/auth`. Identity-provider verification, group mapping, role hierarchy, product eligibility, and transport-specific unauthorized/forbidden responses remain application responsibilities.

Eversally's current group mapping, role hierarchy, and creator/community capability decisions are now represented by the private `@eversally/policy` module and exercised by the product-composition shell. Gallery's corresponding application code remains transitional until the hosted deployment consumes that module end-to-end.

Nightframe now has its own private `@nightframe/policy` eligibility boundary. It is intentionally fail-closed until a Nightframe deployment supplies a product-specific evaluator, preserving the requirement that Nightframe not inherit Eversally's eligibility or moderation rules.

Nightframe now also has an independent private API composition at `nightframe-platform/apps/api`. It exposes only product health and the fail-closed Nightframe admission boundary, and is tested without importing or copying Eversally application code. It is the minimal base for future Nightframe-owned product features rather than a competing implementation of the Eversally API.

Private `nightframe-infrastructure` now pins only the Nightframe API, web composition, and landing revision through a CI-validated provenance manifest. Its account, data, encryption, logs, and production approval gates are separate from Eversally; further product capabilities must be added through Nightframe-owned deployment changes rather than copied infrastructure.

The Eversally provider catalogue—provider ids, labels, rollout state, product surfaces, and enabled operations—is now declared and validated in the private `eversally-platform` repository. The legacy runtime registry remains temporarily until that private catalogue is consumed by the Eversally deployment.

The private `@eversally/integrations` module now consumes that catalogue and the Eversally web-composition shell exposes it at runtime. Provider adapters, OAuth custody, and media/policy presentation details remain in the legacy runtime until their private implementations and product tests are migrated.

The private `@eversally/brand` module now owns the hosted product's terminology, navigation, URLs, and theme tokens. The legacy API, web, and admin brand selectors remain transitional until the Eversally application composes that module at runtime.

The private Eversally web-composition shell now consumes `@eversally/brand` at runtime. It is intentionally limited to health and brand endpoints until public Ubeeq packages are released and the legacy product's domain features can migrate through declared dependencies.

The private `@nightframe/brand` module and Nightframe web-composition shell now own the established product name and visual tokens. They intentionally do not infer eligibility, moderation, billing, or integration policy from Eversally; those implementations begin only when Nightframe-specific requirements are available.

The complete Eversally and Nightframe branded landing applications have been copied byte-for-byte into their respective private product repositories and are covered by product-local integrity checks. Keep the legacy landing directories until the private deployments have been manually verified; product landing changes should now be made in the private repositories.

The substantive Eversally creator/public web and administration applications now also live in private `eversally-platform` under `apps/product-web` and `apps/admin`. Their private copies remove the Ubeeq product selector and Gallery-specific local TLS paths; both production builds are verified. Keep Gallery's applications until the private deployment is connected to its independently deployed API and manually verified end-to-end.

The substantive Eversally API and its test suite now live in private `eversally-platform/apps/api`. Its private local runner defaults to the Eversally tenant and no longer relies on Gallery's hostname or certificate paths; the API compiles and its focused configuration/brand tests pass. Keep the Gallery API until this private API is deployed into Eversally's separate infrastructure and the complete suite plus end-to-end product flow are verified there.

The migrated private Eversally API now passes its complete suite (94 suites / 464 tests) in `eversally-platform`; its deployment provenance is pinned only after that verification. This verifies the source migration, not the separate AWS deployment or manual end-to-end rollout.

Private `eversally-infrastructure` now pins the migrated Eversally API, creator web, and admin source revision in a CI-validated deployment manifest. Production promotion requires a private CI build, artifact provenance, and manual approval; it cannot bundle source from Gallery. AWS account credentials, artifact publishing, and the actual production rollout remain private operational work.

Both private product repositories now declare their full current Ubeeq package set and verify, in CI, that every declared package exists in the pinned public checkout with a compatible major version. This is an explicit source-compatibility gate; installing those packages by semantic version remains gated on the first public registry release.

The complete neutral Ubeeq landing application has likewise been copied byte-for-byte into the public Ubeeq repository and is covered by its public test suite and boundary check. Keep the Gallery copy only for manual verification; neutral landing changes should now be made in Ubeeq.

Public Ubeeq now includes the `@ubeeq/self-host` package and a neutral reference instance configuration. It validates instance identity, secure public origins, storage requirements, and extension identifiers without selecting any hosted-product policy, domain, or credential. Package verification passes; a real operator installation remains an independent deployment verification gate.

Public Ubeeq packages now have a manually dispatched, provenance-capable publish workflow and registry-safe dependency metadata. The remaining release gate is operational: configure the protected npm publishing credential (or trusted publishing), publish the first package set, and then replace the private compatibility checkout with installed semver dependencies.

The following remain here temporarily because they are product decisions or provider implementations:

- `apps/api/src/integrationStandard.ts`: transitional runtime copy of the Eversally provider catalogue; remove only after the private product composition consumes its declared catalogue.
- `apps/api/src/brand.ts`, `apps/web/src/brand.ts`, and `apps/admin/src/brand.ts`: transitional Eversally brand copies; remove only after the private Eversally application consumes `@eversally/brand`.
- `apps/api/src/integrationCapabilities.ts`: media limits, rights/consent requirements, rollout messaging, and UI presentation.
- OAuth credential storage, connector implementations, secrets, and provider-specific operations.
- Product visibility, eligibility, the rules that create and resolve safety holds, and admission policies.

## Required migration gates

1. Replace duplicated capability and conformance types in this repository with the released Ubeeq package.
2. Move provider enablement and credential custody decisions into each private product extension.
3. Run provider-backed conformance tests in private product CI.
4. Verify a neutral Ubeeq reference application starts with no hosted-product modules.
5. Only then remove the transitional implementation from this repository.

## Safety rule

No production data, credentials, product policy, prices, or reviewer instructions may be copied into the public Ubeeq repository during extraction.
