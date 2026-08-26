# Ubeeq extraction inventory

This repository remains the transitional source while Ubeeq and the private hosted-product repositories are verified. Do not delete it until every item below has a tested replacement.

Run `node scripts/inventory-hosted-coupling.mjs` to produce the current file/reference count by migration category. The initial inventory finds 113 files with hosted-product references; treat the report as a migration baseline, not a public-repository allowlist.

## First extraction: integration mechanism

The generic capability vocabulary, remote-operation gate, and executable conformance runner are now represented by `@ubeeq/integrations` in the public Ubeeq repository.

The neutral moderation evidence, review-case, hold, and auditable decision lifecycle are now represented by `@ubeeq/moderation`. Product-specific thresholding, notices, enforcement, and escalation policy remain private.

The neutral asset-processing request and idempotent usage measurement interfaces are now represented by `@ubeeq/processing`. Plan catalogues, credit reservations, prices, quotas, overage treatment, and billing approvals remain private.

The neutral object-storage and delivery adapter interfaces are now represented by `@ubeeq/storage`. Retention schedules, access eligibility, domains, signed-delivery policy, and revocation decisions remain private.

The Eversally provider catalogue—provider ids, labels, rollout state, product surfaces, and enabled operations—is now declared and validated in the private `eversally-platform` repository. The legacy runtime registry remains temporarily until that private catalogue is consumed by the Eversally deployment.

The private `@eversally/integrations` module now consumes that catalogue and the Eversally web-composition shell exposes it at runtime. Provider adapters, OAuth custody, and media/policy presentation details remain in the legacy runtime until their private implementations and product tests are migrated.

The private `@eversally/brand` module now owns the hosted product's terminology, navigation, URLs, and theme tokens. The legacy API, web, and admin brand selectors remain transitional until the Eversally application composes that module at runtime.

The private Eversally web-composition shell now consumes `@eversally/brand` at runtime. It is intentionally limited to health and brand endpoints until public Ubeeq packages are released and the legacy product's domain features can migrate through declared dependencies.

The private `@nightframe/brand` module and Nightframe web-composition shell now own the established product name and visual tokens. They intentionally do not infer eligibility, moderation, billing, or integration policy from Eversally; those implementations begin only when Nightframe-specific requirements are available.

The complete Eversally and Nightframe branded landing applications have been copied byte-for-byte into their respective private product repositories and are covered by product-local integrity checks. Keep the legacy landing directories until the private deployments have been manually verified; product landing changes should now be made in the private repositories.

The complete neutral Ubeeq landing application has likewise been copied byte-for-byte into the public Ubeeq repository and is covered by its public test suite and boundary check. Keep the Gallery copy only for manual verification; neutral landing changes should now be made in Ubeeq.

Public Ubeeq packages now have a manually dispatched, provenance-capable publish workflow and registry-safe dependency metadata. The remaining release gate is operational: configure the protected npm publishing credential (or trusted publishing), publish the first package set, and then replace the private compatibility checkout with installed semver dependencies.

The following remain here temporarily because they are product decisions or provider implementations:

- `apps/api/src/integrationStandard.ts`: transitional runtime copy of the Eversally provider catalogue; remove only after the private product composition consumes its declared catalogue.
- `apps/api/src/brand.ts`, `apps/web/src/brand.ts`, and `apps/admin/src/brand.ts`: transitional Eversally brand copies; remove only after the private Eversally application consumes `@eversally/brand`.
- `apps/api/src/integrationCapabilities.ts`: media limits, rights/consent requirements, rollout messaging, and UI presentation.
- OAuth credential storage, connector implementations, secrets, and provider-specific operations.
- Product visibility, eligibility, safety holds, and admission policies.

## Required migration gates

1. Replace duplicated capability and conformance types in this repository with the released Ubeeq package.
2. Move provider enablement and credential custody decisions into each private product extension.
3. Run provider-backed conformance tests in private product CI.
4. Verify a neutral Ubeeq reference application starts with no hosted-product modules.
5. Only then remove the transitional implementation from this repository.

## Safety rule

No production data, credentials, product policy, prices, or reviewer instructions may be copied into the public Ubeeq repository during extraction.
