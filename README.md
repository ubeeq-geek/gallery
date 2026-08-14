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

- Every signed-in member is a **Ubeeqer**. They can browse, save work, and follow creators without setting up a public identity.
- Every Ubeeqer can create a free **Ubeeq Space** from Studio. A Space is a creator identity with its own URL, catalogue, integrations, and members.
- **Approved Creator** is an invitation-only support tier on a Space. It is never a prerequisite for creating or using a free Space.

## Requirements

- Node `>=20`
- npm `>=9` recommended.
- Default AWS region for this project is `ca-central-1`.

## Quick Start

```bash
npm install
npm run dev:api
npm --workspace @gallery/web run dev
```

`npm run dev:api` starts the local API at `https://fanadmin.top:4000`; it supplies the HTTPS, local-media, OAuth callback, and local-auth defaults documented below. The web app must use `VITE_API_BASE_URL=https://fanadmin.top:4000`.

## Local API environment

The API reads environment variables from the shell that starts it; it does **not** load `apps/api/.env` automatically. `npm run dev:api` provides suitable local defaults for the variables below. Override an individual value by exporting it before the command.

| Variable | Local default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `4000` | API listener. |
| `DEV_HTTPS` | `true` | Enables the `certs/fanadmin.top*.pem` development certificate. |
| `LOCAL_AUTH_USER_ID` | `local-user` | Enables the local authenticated creator identity. Never set in deployment. |
| `LOCAL_MEDIA_DIRECTORY` | `/tmp/ubeeq-media` | Where imported and uploaded work copies are stored locally. |
| `APP_ORIGIN` | `https://fanadmin.top:5174` | Trusted return origin for external OAuth callbacks. Match the local web server. |
| `EXTERNAL_OAUTH_REDIRECT_URI` | `https://fanadmin.top:4000/integrations/deviantart/callback` | Register this exact URL in the local DeviantArt application. |
| `EXTERNAL_TOKEN_ENCRYPTION_KEY` | A generated value for the process | Encrypts stored external client secrets and OAuth tokens. Set a stable value yourself when you need it to survive an API restart. |
| `EXTERNAL_CONTENT_MAX_BYTES` | `52428800` | Maximum downloaded external source-file size (50 MiB). |
| `DEVIANTART_PUBLISHED_DESCRIPTION_UPDATE` | `true` | Enables supported published-description updates through retained Sta.sh IDs. |
| `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` | unset | Leave unset for local-header auth. Set both only when testing Cognito token verification locally. |

For a stable local encryption key, run this once and export the result before starting the API:

```bash
export EXTERNAL_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 48)"
npm run dev:api
```

The local development server uses an in-memory database. Restarting or hot-reloading it clears local Spaces, DeviantArt credentials, connected accounts, and imports; the local media files under `/tmp/ubeeq-media` are not automatically deleted.

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
5. Follow the Cognito setup below before enabling social sign-in in a deployed environment.

## Account Email and Social Sign-In

The CDK stack has branded Cognito verification-email content, optional SES delivery, and conditional Google/Apple providers. It deliberately does not create third-party developer accounts or insert credentials into source control.

Set the following before `cdk deploy`:

```bash
# Required to expose Cognito managed login and social federation.
export COGNITO_DOMAIN_PREFIX=your-unique-ubeeq-auth-prefix
export WEB_APP_URL=https://app.example.com

# Optional but required for a branded From address and reliable production delivery.
export SES_FROM_ADDRESS=hello@example.com

# Set both to enable Google.
export GOOGLE_CLIENT_ID=...
export GOOGLE_CLIENT_SECRET=...

# Set all four to enable Sign in with Apple.
export APPLE_SERVICE_ID=com.example.ubeeq.web
export APPLE_TEAM_ID=...
export APPLE_KEY_ID=...
export APPLE_PRIVATE_KEY="$(cat AuthKey_XXXXXXXXXX.p8)"
```

After deployment, configure the web application:

```bash
VITE_COGNITO_DOMAIN=<UserPoolDomain CloudFormation output>
VITE_COGNITO_CLIENT_ID=<UserPoolClientId CloudFormation output>
VITE_COGNITO_REDIRECT_URI=https://app.example.com/auth/callback
```

For local use, the redirect URI must be `http://localhost:5173/auth/callback` or `http://localhost:5174/auth/callback`. The social sign-in flow uses OAuth authorization code + PKCE and completes the code exchange in the browser.

### Branded verification email

The stack supplies the Ubeeq subject and HTML code template. Configure `SES_FROM_ADDRESS` with a verified SES identity to send from Ubeeq rather than Cognito's default sender. Cognito requires the `{####}` token in a code template. See [Cognito email settings](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html) and [message template requirements](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-message-customizations.html).

### Google setup

1. In Google Cloud Console, create or select the project for Ubeeq and configure the OAuth consent screen.
2. Create an OAuth 2.0 **Web application** client.
3. Add `https://<UserPoolDomain>/oauth2/idpresponse` as an authorized redirect URI. This is Cognito's provider callback, not the Ubeeq web-app callback.
4. Put the Google client ID and client secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then deploy the stack.
5. Configure the Ubeeq web variables above and test from `/auth/signin`.

Google's OAuth client and redirect guidance is available in the [Google OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect). Cognito then performs the provider exchange and returns Ubeeq user-pool tokens through the configured `/auth/callback` URL.

### Apple setup

1. Enroll in the Apple Developer Program and enable Sign in with Apple on a primary App ID.
2. Register a Services ID for the Ubeeq web application and associate it with that primary App ID.
3. Add the Cognito domain and `https://<UserPoolDomain>/oauth2/idpresponse` as the Apple website domain and return URL.
4. Create a Sign in with Apple private key, download its `.p8` once, and record the team ID, key ID, and Services ID.
5. Set `APPLE_SERVICE_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY`, then deploy the stack.

Apple requires the Services ID, verified website configuration, and private key for web sign-in. Follow [Apple's web configuration guide](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web) and [private-key guide](https://developer.apple.com/help/account/capabilities/create-a-sign-in-with-apple-private-key/). Treat the Apple private key and all social client secrets as deployment secrets; do not commit them.

## DeviantArt Integration

The Studio **Integrations** section connects one or more DeviantArt accounts to a creator identity. Each creator identity supplies its own DeviantArt OAuth application in Studio; Ubeeq does not use a shared DeviantArt client application. Imports run asynchronously through the `ExternalSyncQueue`; the local API uses an in-process worker and production uses SQS plus Lambda.

Set these deployment-time API variables before deploying CDK:

```bash
export EXTERNAL_OAUTH_REDIRECT_URI=https://<api-host>/integrations/deviantart/callback
export EXTERNAL_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 48)"
export APP_ORIGIN=https://<web-host>
```

Creators register `EXTERNAL_OAUTH_REDIRECT_URI` as the callback URL in their own DeviantArt application, then enter that application’s client ID and secret under Studio Integrations. `EXTERNAL_TOKEN_ENCRYPTION_KEY` encrypts both creator application secrets and OAuth tokens at rest. Keep it in managed secret storage in the deployment environment and rotate it through a planned credential migration; changing it without migration prevents existing encrypted credentials from being decrypted. `EXTERNAL_ACCOUNT_SCAN_INTERVAL_SECONDS` defaults to `21600` (six hours) for catalogues; `EXTERNAL_ACTIVITY_SCAN_INTERVAL_SECONDS` defaults to `120` (two minutes) for feedback activity. DeviantArt does not expose webhooks, so this bounded polling interval provides near-real-time updates while respecting adaptive rate limits.

New Ubeeq-to-DeviantArt publications retain the Sta.sh `itemid` returned by `stash/submit` before calling `stash/publish`. Published-description updates are enabled by default after local validation; set `DEVIANTART_PUBLISHED_DESCRIPTION_UPDATE=false` to disable them. The worker submits `itemid` plus `artist_comments` to `stash/submit` without a file, then reads the published deviation back and only marks the job synchronized when the description matches. Existing imported publications and older Ubeeq publications without a retained Sta.sh item ID remain read-only for published descriptions.

Outbound DeviantArt destinations default to **Published**, but can instead target a **Draft in Sta.sh** per work or in bulk from Works. Draft synchronization stops after `stash/submit`; changing that destination to Published later reuses the retained Sta.sh `itemid` and continues with `stash/publish`.

Full account synchronization also reconciles DeviantArt gallery hierarchy and membership for continuous mappings, detects missing/deleted/restricted publications, and records metadata conflicts between queued Ubeeq changes and newer remote edits. The Activity inbox supports server-side filters, pagination, bulk read state, and remote DeviantArt message dismissal while retaining Ubeeq history. See [`docs/deviantart-activity-sync.md`](docs/deviantart-activity-sync.md) for the reconciliation and moderation boundaries.

For local OAuth testing, `npm run dev:api` supplies the required local API environment and queues sync work in-process. Register the exact local callback URL with DeviantArt, then point the web app at the local API.

```bash
export EXTERNAL_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 48)" # optional: stable across restarts
npm run dev:api

VITE_API_BASE_URL=https://fanadmin.top:4000 npm --workspace @gallery/web run dev
```

Sign in through the existing local web flow, then open `/studio/workspace?section=integrations`. `LOCAL_AUTH_USER_ID` is accepted only when the API has no Cognito verifier configured; do not set it in a deployed environment.

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
