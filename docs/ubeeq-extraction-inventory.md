# Ubeeq extraction inventory

This repository remains the transitional source while Ubeeq and the private hosted-product repositories are verified. Do not delete it until every item below has a tested replacement.

## First extraction: integration mechanism

The generic capability vocabulary, remote-operation gate, and executable conformance runner are now represented by `@ubeeq/integrations` in the public Ubeeq repository.

The following remain here temporarily because they are product decisions or provider implementations:

- `apps/api/src/integrationStandard.ts`: provider identifiers, labels, rollout availability, and Studio surfaces.
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

