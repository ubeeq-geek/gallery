# Studio Platform (MVP)

AWS-first creator platform with:
- Multi-creator and multi-grouping support.
- Free preview media and premium media behind per-grouping passwords.
- Image and video support in both preview and premium flows.
- Public read comments, authenticated write comments.
- Favorites with private user saves plus public like counts.
- Integrated Studio workspace for creator/grouping/media management and moderation.

## Tech Stack

- `apps/web`: Customer React app (Vite).
- `apps/api`: Express API (Lambda-compatible via `serverless-http`).
- `infra`: AWS CDK stack (API Gateway, Lambda, DynamoDB, S3, Cognito).
- Includes migration-safe `GroupingCore` single-table support (`GROUPING_CORE_TABLE`, `USE_GROUPING_CORE_TABLE`).

## Studio Workspace

- The web app now includes an authenticated Studio surface as the long-term home for upload and management workflows.
- Studio handles creator, grouping, media, moderation, and operations workflows in one place.

## Requirements

- Node `>=20`
- npm `>=9` recommended.
- Default AWS region for this project is `ca-central-1`.

## Quick Start

```bash
npm install
npm --workspace @gallery/api run dev
npm --workspace @gallery/web run dev
```

API local defaults to `http://localhost:4000`.

## Build and Test

```bash
npm --workspace @gallery/api run test
npm --workspace @gallery/shared run build
npm --workspace @gallery/api run build
npm --workspace @gallery/infra run build
npm --workspace @gallery/web run build
```

## Key API Endpoints

- `GET /creators`
- `GET /creators/:slug/groupings`
- `GET /groupings/:slug`
- `POST /groupings/:slug/unlock`
- `GET /groupings/:slug/premium-images` (`x-unlock-token` required)
- `GET/POST /groupings/:slug/comments`
- `GET/POST /images/:imageId/comments`
- `POST/DELETE /favorites`
- `GET /me/favorites`
- Admin:
  - `POST /admin/creators`
  - `POST /admin/groupings`
  - `POST /admin/images` (use `assetType: image|video`)
  - `PATCH /admin/comments/:commentId`
  - `DELETE /admin/comments/:commentId`
  - `POST/DELETE /admin/users/:userId/block`

## Deployment Notes

1. Build API before CDK deploy:
```bash
npm --workspace @gallery/api run build
```
2. Deploy infra:
```bash
npm --workspace @gallery/infra run deploy
```
3. If your API points at a pre-existing `CONTENT_CORE_TABLE` (legacy/shared table), ensure `GSI1` and `GSI2` exist:
```bash
# Preview only
npm --workspace @gallery/api run ensure:core-indexes -- --dry-run --content-core-table <ContentCoreTableName> --region ca-central-1

# Create any missing GSI1/GSI2 definitions
npm --workspace @gallery/api run ensure:core-indexes -- --content-core-table <ContentCoreTableName> --region ca-central-1
```
4. Configure web env var `VITE_API_BASE_URL` to deployed API URL.
5. Configure Cognito social identity providers in AWS console/CDK extensions.

## GroupingCore Migration

After deploying infra, backfill `GroupingCore` from legacy tables:

```bash
# Preview counts only
npm --workspace @gallery/api run migrate:core -- --dry-run

# Execute migration
npm --workspace @gallery/api run migrate:core
```

Optional flags:
- `--region <aws-region>` (or `--region=<aws-region>`)
- `--profile <aws-profile>` (or `--profile=<aws-profile>`)
- `--creators-table <name>`
- `--groupings-table <name>`
- `--images-table <name>`
- `--grouping-core-table <name>`

Examples:

```bash
npm --workspace @gallery/api run migrate:core -- --dry-run --region ca-central-1 --profile dev
npm --workspace @gallery/api run migrate:core -- --region ca-central-1 --profile dev
```

If your CDK tables are auto-named, pass explicit table names with the flags above.

Then set:
- `USE_GROUPING_CORE_TABLE=true`
- `GROUPING_CORE_TABLE=<deployed GroupingCore table name>`

Verify parity before disabling fallback:

```bash
npm --workspace @gallery/api run verify:core
```

With flags:

```bash
npm --workspace @gallery/api run verify:core -- --region ca-central-1 --profile dev
```

## Seed Fresh Stack

For a brand-new deployment (no legacy tables to migrate), seed `GroupingCore` directly:

```bash
# Preview only
npm --workspace @gallery/api run seed:core -- --dry-run --region ca-central-1 --profile cdk-ca --grouping-core-table <GroupingCoreTableName>

# Write sample creator/grouping/image+video metadata (auto-discovers tables + media bucket)
npm --workspace @gallery/api run seed:core -- --region ca-central-1 --profile cdk-ca --premium-password <your-password>

# Reset all grouping metadata + creator/branding objects only
npm --workspace @gallery/api run reset:core -- --region ca-central-1 --profile cdk-ca

# Reset all grouping metadata + creator/branding objects first, then seed (single command option)
npm --workspace @gallery/api run seed:core -- --reset --region ca-central-1 --profile cdk-ca --premium-password <your-password>
```

When `--scenario-file` is omitted, `seed:core` automatically uses `seed-scenarios/default/seed.json`.

`seed:core` now reads from an in-repo default scenario bundle:
- `seed-scenarios/default/seed.json`
- `seed-scenarios/default/media/` (child folder symlink to repo `media/`)

Seeded S3 objects use flat UUID keys: `creator_uuid/object_uuid` (no grouping/title path encoding).

### Scenario File Seeding (Stack-Specific)

`seed:core` supports loading creators/groupings/site settings from a JSON file.  
Use `--scenario-file` and keep the media folder as a child folder under the same scenario folder.

```text
/outside-source-control/my-scenario/
  seed.json
  media/
    anne-0001.jpg
    anne-0002.jpg
    samuel-0001.mp4
    scenario-a-logo.svg
```

```bash
# Dry-run a scenario bundle
npm --workspace @gallery/api run seed:core -- \
  --dry-run \
  --region ca-central-1 \
  --profile cdk-ca \
  --scenario-file /outside-source-control/my-scenario/seed.json

# Execute against the stack named in seed.json siteSettings.stackName
npm --workspace @gallery/api run seed:core -- \
  --region ca-central-1 \
  --profile cdk-ca \
  --scenario-file /outside-source-control/my-scenario/seed.json
```

The scenario file can set:
- `siteSettings.stackName` (used to read `GroupingCoreTableName`, `SiteSettingsTableName`, `MediaBucketName` from CloudFormation outputs)
- `siteSettings.siteName`, `siteSettings.theme`, `siteSettings.logoKey`, `siteSettings.logoFile`
- `creators[]` with nested `groupings[]` definitions (`free|preview|premium`) and optional per-premium-grouping password

Reference example: `docs/seed-scenarios/example/seed.json`

Default in-repo scenario: `seed-scenarios/default/seed.json`

Optional flags:

```bash
--site-name "Ubeeq"
--theme ubeeq|sand|forest|slate
--logo-key branding/ubeeq-logo.svg
--logo-file /absolute/path/to/logo.svg
--skip-logo-upload
--media-dir /absolute/path/to/media
--media-bucket your-media-bucket-name
--scenario-file /absolute/path/to/scenario/seed.json
--stack-name StudioStackName
--skip-media-upload
--skip-renditions
--reset
```

## Store Integration (MVP)

- Use external store as checkout source.
- Fulfill access manually by sharing per-grouping premium password.
- API/DB model is ready for future webhook-based entitlement automation.
