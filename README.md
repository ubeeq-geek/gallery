# Gallery Platform (MVP)

AWS-first gallery platform with:
- Multi-artist and multi-gallery support.
- Free preview media and premium media behind per-gallery passwords.
- Image and video support in both preview and premium flows.
- Public read comments, authenticated write comments.
- Favorites with private user saves plus public like counts.
- Admin panel for artist/gallery/media management and moderation.

## Tech Stack

- `apps/web`: Customer React app (Vite).
- `apps/admin`: Admin React app (Vite).
- `apps/api`: Express API (Lambda-compatible via `serverless-http`).
- `infra`: AWS CDK stack (API Gateway, Lambda, DynamoDB, S3, Cognito).
- Includes migration-safe `GalleryCore` single-table support (`GALLERY_CORE_TABLE`, `USE_GALLERY_CORE_TABLE`).

## Requirements

- Node `>=18` (Node 16 will fail Vite builds and is unsupported for this stack).
- npm `>=9` recommended.
- Default AWS region for this project is `ca-central-1`.

## Quick Start

```bash
npm install
npm --workspace @gallery/api run dev
npm --workspace @gallery/web run dev
npm --workspace @gallery/admin run dev
```

API local defaults to `http://localhost:4000`.

## Build and Test

```bash
npm --workspace @gallery/api run test
npm --workspace @gallery/shared run build
npm --workspace @gallery/api run build
npm --workspace @gallery/infra run build
npm --workspace @gallery/web run build
npm --workspace @gallery/admin run build
```

## Key API Endpoints

- `GET /artists`
- `GET /artists/:slug/galleries`
- `GET /galleries/:slug`
- `POST /galleries/:slug/unlock`
- `GET /galleries/:slug/premium-images` (`x-unlock-token` required)
- `GET/POST /galleries/:slug/comments`
- `GET/POST /images/:imageId/comments`
- `POST/DELETE /favorites`
- `GET /me/favorites`
- Admin:
  - `POST /admin/artists`
  - `POST /admin/galleries`
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
3. Configure web/admin env var `VITE_API_BASE_URL` to deployed API URL.
4. Configure Cognito social identity providers in AWS console/CDK extensions.

## GalleryCore Migration

After deploying infra, backfill `GalleryCore` from legacy tables:

```bash
# Preview counts only
npm --workspace @gallery/api run migrate:core -- --dry-run

# Execute migration
npm --workspace @gallery/api run migrate:core
```

Optional flags:
- `--region <aws-region>` (or `--region=<aws-region>`)
- `--profile <aws-profile>` (or `--profile=<aws-profile>`)
- `--artists-table <name>`
- `--galleries-table <name>`
- `--images-table <name>`
- `--gallery-core-table <name>`

Examples:

```bash
npm --workspace @gallery/api run migrate:core -- --dry-run --region ca-central-1 --profile dev
npm --workspace @gallery/api run migrate:core -- --region ca-central-1 --profile dev
```

If your CDK tables are auto-named, pass explicit table names with the flags above.

Then set:
- `USE_GALLERY_CORE_TABLE=true`
- `GALLERY_CORE_TABLE=<deployed GalleryCore table name>`

Verify parity before disabling fallback:

```bash
npm --workspace @gallery/api run verify:core
```

With flags:

```bash
npm --workspace @gallery/api run verify:core -- --region ca-central-1 --profile dev
```

## Seed Fresh Stack

For a brand-new deployment (no legacy tables to migrate), seed `GalleryCore` directly:

```bash
# Preview only
npm --workspace @gallery/api run seed:core -- --dry-run --region ca-central-1 --profile cdk-ca --gallery-core-table <GalleryCoreTableName>

# Write sample artist/galleries/image+video metadata
npm --workspace @gallery/api run seed:core -- --region ca-central-1 --profile cdk-ca --gallery-core-table <GalleryCoreTableName> --premium-password <your-password>
```

## Store Integration (MVP)

- Use external store as checkout source.
- Fulfill access manually by sharing per-gallery premium password.
- API/DB model is ready for future webhook-based entitlement automation.