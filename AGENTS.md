# Repository status

- This is the legacy Gallery codebase. It is not the source of truth for new Ubeeq, Eversally, Nightframe, Brightpush, commercial, or infrastructure work.
- Route reusable brand-neutral mechanisms to `ubeeq`, shared hosted capabilities to `ubeeq-commercial`, product behavior to the matching product repository, and deployment configuration to the matching infrastructure repository.
- Do not add new product features here unless the user explicitly identifies a migration or legacy-maintenance reason.
- Do not promote or deploy Gallery artifacts as substitutes for current product artifacts.

# Allowed maintenance

- Prefer narrowly scoped security fixes, migration support, data-export compatibility, and regressions required to retire or safely operate legacy installations.
- Preserve existing data and API compatibility unless a documented migration changes it.
- Keep region/cell, authorization, billing, storage, moderation, and publication behavior auditable. Do not silently change historical records or infer that remote/provider effects did not occur.
- Tests must not call live providers, publish content, charge payments, use personal credentials, or mutate production resources.

# Validation

- Use Node 22 as specified by `.nvmrc` and install with `npm ci`.
- Run focused tests while iterating, then `npm run build`, `npm test`, and `npm run lint`.
- Run regional drift or two-cell qualification commands when a legacy regional boundary changes.
- State the migration/retirement reason for the change and any validation that remains unavailable.

# Agent workflow

- Before substantial work, confirm that Gallery is truly the intended repository rather than one of its successors.
- Work on a branch and open a pull request describing the legacy need, compatibility impact, migration or rollback plan, and validation.
- Leave pull requests open for review. Do not merge, deploy, start paid resources, or run production migrations unless the user explicitly asks.
- Never commit credentials, local state, media, production data, certificates, or generated deployment output.
