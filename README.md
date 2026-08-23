# Ubeeq / Eversally Studio Platform

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

## Product editions

The same Ubeeq platform ships in two branded editions:

| Edition | Public domain | Member | Creator | Creator workspace |
| --- | --- | --- | --- | --- |
| **Eversally** (commercial hosted service) | `eversally.com` | Ever / Evers | Ever Creator / Ever Creators | Eversally Space |
| **Ubeeq** (open-source distribution) | `ubeeq.site` | Ubeeqer / Ubeeqers | Creator / Creators | Ubeeq Creator Area |

Branding is selected at build and launch time; persisted field names and API routes retain their existing Ubeeq/Space identifiers for backward compatibility. See [Product branding](docs/product-branding.md) for the complete contract.

## Studio workspace

- Every signed-in Eversally member is an **Ever**; the equivalent Ubeeq member is a **Ubeeqer**. Members can browse, save work, and follow creators without setting up a public identity.
- Every member can create a free **Eversally Space** or **Ubeeq Creator Area** from Studio. It is a creator identity with its own URL, catalogue, integrations, and members.
- **Ever Creator** is the Eversally creator term. Invitation-only support or approval is a separate tier and is never a prerequisite for creating a free workspace.

## Requirements

- Node `>=20`
- npm `>=9` recommended.
- Default AWS region for this project is `ca-central-1`.

## Quick Start

```bash
npm install
npm run dev:eversally
```

This runs the Eversally web app at `https://fanadmin.top:5174` and its API at `https://fanadmin.top:4000`. The API supplies the HTTPS, local-media, OAuth callback, and local-auth defaults documented below.

Run the Ubeeq OSS pair at `https://fanadmin.top:5175` and `https://fanadmin.top:4001` with `npm run dev:ubeeq`. Run both complete pairs side by side with `npm run dev:all`.

## Local API environment

The API reads environment variables from the shell that starts it; it does **not** load `apps/api/.env` automatically. `npm run dev:api` provides suitable local defaults for the variables below. Override an individual value by exporting it before the command.

| Variable | Local default | Purpose |
| --- | --- | --- |
| `PRODUCT_BRAND` | `eversally` in `dev:eversally`; `ubeeq` in `dev:ubeeq` | Selects API messages, verification emails, and other server-rendered product terminology. |
| `TENANT_ID` | `eversally` in `dev:eversally`; `ubeeq` in `dev:ubeeq` | Namespaces canonical Creator content so both editions can safely use the same storage contract. Set this explicitly for every deployment. |
| `HOST` / `PORT` | `127.0.0.1` / `4000` for Eversally; `4001` for Ubeeq | API listener. |
| `DEV_HTTPS` | `true` | Enables the `certs/fanadmin.top*.pem` development certificate. |
| `LOCAL_AUTH_USER_ID` | `local-user` | Enables the local authenticated creator identity. Never set in deployment. |
| `LOCAL_MEDIA_DIRECTORY` | `/tmp/eversally-media` for Eversally; `/tmp/ubeeq-media` for Ubeeq | Isolated storage for imported and uploaded local work copies. |
| `APP_ORIGIN` | `https://fanadmin.top:5174` for Eversally; `https://fanadmin.top:5175` for Ubeeq | Trusted return origin for external OAuth callbacks. Match the paired web server. |
| `EXTERNAL_OAUTH_REDIRECT_URI` | Port `4000` for Eversally; `4001` for Ubeeq | Register the matching `/integrations/deviantart/callback` URL in each local DeviantArt application. |
| `EXTERNAL_TOKEN_ENCRYPTION_KEY` | A generated value for the process | Encrypts stored external client secrets and OAuth tokens. Set a stable value yourself when you need it to survive an API restart. |
| `EXTERNAL_CONTENT_MAX_BYTES` | `52428800` | Maximum downloaded external source-file size (50 MiB). |
| `DEVIANTART_MIN_REQUEST_INTERVAL_MS` | `2000` | Minimum spacing between DeviantArt API requests. The conservative default caps a single worker at roughly 30 calls per minute before response time. |
| `DEVIANTART_PUBLISHED_DESCRIPTION_UPDATE` | `true` | Enables supported published-description updates through retained Sta.sh IDs. |
| `FLICKR_API_KEY` / `FLICKR_API_SECRET` | unset | Flickr OAuth 1.0a application credentials for creator-authorized catalogue migration. The secret remains server-side. |
| `FLICKR_OAUTH_CALLBACK_URL` | unset | Registered callback for `/api/integrations/flickr/oauth/callback`. Flickr connections request read access only. |
| `FLICKR_MIN_REQUEST_INTERVAL_MS` | `1000` | Minimum per-process spacing between Flickr API calls. Provider throttling also honors `Retry-After` with bounded retries. |
| `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` | unset / read from `apps/web/.env.local` when present | Local-header auth remains available without a pool ID. For real local account testing, set `VITE_COGNITO_USER_POOL_ID` and `VITE_COGNITO_CLIENT_ID`; the paired launcher copies both values to the API so each Cognito user receives their own local profile. |
| `BLUESKY_OAUTH_CLIENT_METADATA_URL` / `BLUESKY_OAUTH_CALLBACK_URL` | unset | Public HTTPS URLs for the AT Protocol OAuth client metadata and API callback. These cannot use a plain local host. |
| `BLUESKY_OAUTH_JWKS_JSON` | unset | Public JWKS JSON advertised to Bluesky. Never include private JWK fields here. |
| `BLUESKY_OAUTH_PRIVATE_JWK` | unset | Confidential ES256 signing JWK. Load from managed secret storage in production; never commit it. |
| `BLUESKY_OAUTH_SERVICE_URL` / `BLUESKY_OAUTH_SERVICE_JWKS_URL` | unset | The dedicated OAuth broker and its public JWKS. Studio uses these to issue and verify Creator-scoped Bluesky connection proofs without receiving a refresh token. |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | unset | Discord application OAuth credentials for native community delivery. Keep the client secret out of source control. |
| `DISCORD_BOT_TOKEN` | unset | Bot token used only by the API/worker to enumerate permitted channels and send announcements. Never expose it to the web client. |
| `DISCORD_SECRETS_NAME` | unset | Optional Secrets Manager JSON secret for the Discord client secret and bot token. Use this for every shared AWS environment, including development. |
| `DISCORD_OAUTH_REDIRECT_URI` | `https://fanadmin.top:4000/integrations/discord/callback` | Register this exact URL in the Discord application’s OAuth2 Redirects list. The Ubeeq local API should use port `4001`. |
| `DISCORD_API_BASE_URL` | `https://discord.com/api/v10` | Optional API base override for controlled testing. |
| `YOUTUBE_OAUTH_CLIENT_ID` | unset | Google OAuth web-client ID for the optional YouTube import/embed integration. |
| `YOUTUBE_OAUTH_CLIENT_SECRET` | unset | Google OAuth web-client secret. Keep it in `YOUTUBE_SECRETS_NAME` for shared AWS deployments. |
| `YOUTUBE_OAUTH_REDIRECT_URI` | `https://fanadmin.top:4000/integrations/youtube/callback` | Register this exact redirect URI in Google Cloud. The Ubeeq local API uses port `4001`. |
| `YOUTUBE_SECRETS_NAME` | unset | Optional Secrets Manager JSON secret containing `youtubeOAuthClientSecret`; recommended for every deployed environment. |
| `YOUTUBE_MIN_REQUEST_INTERVAL_MS` | `1000` | Minimum interval between YouTube Data API requests for one worker. |

For a stable local encryption key, run this once and export the result before starting the API:

```bash
export EXTERNAL_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 48)"
npm run dev:api
```

Each local API has its own in-memory database. Restarting or hot-reloading it clears that edition's local creator workspaces, DeviantArt credentials, connected accounts, and imports; files in the edition-specific media directory are not automatically deleted.

Canonical uploads are stored below `works/<tenant>/<creator>/<asset>/` in the configured media directory or S3 bucket. Work lifecycle, Space visibility, discovery participation, and destination synchronization are intentionally separate records. The accepted contract is documented in [ADR 0001](docs/adr/0001-canonical-content-publication-model.md).

## YouTube video import (read-only v1)

YouTube is an optional import-and-embed integration. Ubeeq/Eversally remains the canonical Work manager; this first release does **not** upload, edit, delete, or download original YouTube videos.

1. In Google Cloud, enable **YouTube Data API v3** and create an OAuth 2.0 **Web application** client.
2. Register the exact callback URL for the environment:
   - Eversally local: `https://fanadmin.top:4000/integrations/youtube/callback`
   - Ubeeq local: `https://fanadmin.top:4001/integrations/youtube/callback`
   - Deployed: `https://<your-api-host>/integrations/youtube/callback`
3. Set `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`, and `YOUTUBE_OAUTH_REDIRECT_URI`. In AWS, put the secret in a Secrets Manager JSON value named by `YOUTUBE_SECRETS_NAME`:

   ```json
   { "youtubeOAuthClientSecret": "your-google-oauth-client-secret" }
   ```

The connection requests only `https://www.googleapis.com/auth/youtube.readonly`, uses Authorization Code + PKCE and incremental consent, and retains a refresh token only in encrypted server-side storage. Imports use the channel uploads playlist plus batched Videos lookups rather than the expensive Search endpoint. The worker spaces requests by `YOUTUBE_MIN_REQUEST_INTERVAL_MS` (one second by default) and backs off on Google quota/rate-limit responses. Google controls the actual project quota; a new standard project commonly starts with 10,000 units per day, so operators should monitor quota use in Google Cloud before enabling large backfills.

## Build and Test

```bash
npm --workspace @gallery/api run test
npm --workspace @gallery/shared run build
npm --workspace @gallery/api run build
npm --workspace @gallery/infra run build
npm --workspace @gallery/web run build
# Verify the OSS-branded web build too.
npm --workspace @gallery/web run build:oss
```

## Key API Endpoints

Canonical Studio and Space routes:

- `GET/POST /studio/works`
- `GET/PATCH /studio/works/:workId`
- `PUT /studio/works/:workId/image`
- `PUT /studio/works/:workId/publications/eversally`
- `PUT /studio/works/:workId/discovery`
- `GET/POST /studio/collections`
- `PATCH/DELETE /studio/collections/:collectionId`
- `PUT /studio/collections/:collectionId/works`
- `GET /creators/:slug/works`
- `GET /creators/:slug/works/:workSlug`
- `GET /creators/:slug/collections`
- `GET /creators/:slug/collections/:collectionSlug`

Legacy discovery routes remain while the public discovery presentation is moved onto this canonical contract:

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

### Deployment matrix

| Goal | Deployment target | What it creates | What it does not create |
| --- | --- | --- | --- |
| Local product development | `npm run dev:ubeeq` | Ubeeq API and Vite web app on local ports | AWS resources, durable data, public domains |
| Public Ubeeq launch page + Bluesky OAuth | `DEPLOY_TARGET=public` | Static `UbeeqLanding` and minimal `UbeeqBlueskyOAuth` stacks | Product API, Cognito, creator data, media, queues, workers |
| Full self-hosted Ubeeq product | default `full` target | API, DynamoDB, media/CDN, Cognito, queues, worker Lambdas, monitoring/backup profile in production | A public web hostname unless explicitly enabled below |

All CDK stacks in this repository are deployed in `ca-central-1`. Use Node 22 and bootstrap the account/region once before the first deployment:

```bash
source ~/.nvm/nvm.sh
nvm use 22

CDK_DEFAULT_ACCOUNT=<aws-account-id> \
CDK_DEFAULT_REGION=ca-central-1 \
AWS_REGION=ca-central-1 \
AWS_DEFAULT_REGION=ca-central-1 \
npm --workspace @gallery/infra run cdk -- bootstrap aws://<aws-account-id>/ca-central-1
```

### Full Ubeeq deployment

The default CDK target is the complete product stack. It does not use the Eversally managed-hosting policy layer; set `PRODUCT_BRAND=ubeeq` and give the deployment its own `TENANT_ID`.

1. Build API before CDK deploy:
```bash
npm --workspace @gallery/api run build
```
2. Create an application secret in Secrets Manager using the [production secret schema](docs/production-survivability.md#production-deployment-requirements). The secret must contain stable `externalTokenEncryptionKey` and `unlockJwtSecret` values; do not pass either value through the shell in production.
3. Deploy infrastructure:
```bash
export DEPLOYMENT_STAGE=production
export DEPLOY_TARGET=full
export PRODUCT_BRAND=ubeeq
export TENANT_ID=ubeeq
export APP_SECRETS_NAME=ubeeq/production/application
export WEB_APP_URL=https://<your-ubeeq-web-host>
export APP_ORIGIN="$WEB_APP_URL"
export EXTERNAL_OAUTH_REDIRECT_URI=https://<your-ubeeq-api-host>/integrations/deviantart/callback

CDK_DEFAULT_REGION=ca-central-1 AWS_REGION=ca-central-1 AWS_DEFAULT_REGION=ca-central-1 \
npm --workspace @gallery/infra run deploy
```
4. Build the web client against the API stack output. Host `apps/web/dist` on your preferred static HTTPS host when you are not using the optional CDK custom-domain path:
```bash
export VITE_PRODUCT_BRAND=ubeeq
export VITE_API_BASE_URL=https://<your-ubeeq-api-host>
npm --workspace @gallery/web run build
```
5. To let the full stack own a root and `api.` domain, build the web client first, then set `ENABLE_FULL_PRODUCT_DOMAINS=true` along with `ROOT_DOMAIN`, `API_DOMAIN`, `HOSTED_ZONE_ID`, `WEB_CERTIFICATE_ARN` (issued in `us-east-1`), and `API_CERTIFICATE_ARN` (issued in the stack region). This is a domain cutover: do not enable it while the separate `UbeeqLanding` or `UbeeqBlueskyOAuth` stacks still own the same Route 53 records/custom API domain.
6. If your API points at a pre-existing `CONTENT_CORE_TABLE` (legacy/shared table), ensure `GSI1` and `GSI2` exist:
```bash
# Preview only
npm --workspace @gallery/api run ensure:core-indexes -- --dry-run --content-core-table <ContentCoreTableName> --region ca-central-1

# Create any missing GSI1/GSI2 definitions
npm --workspace @gallery/api run ensure:core-indexes -- --content-core-table <ContentCoreTableName> --region ca-central-1
```
7. Follow the Cognito setup below before enabling social sign-in in a deployed environment.

Set `DEPLOYMENT_STAGE=production` to enable the production survivability profile. Production requires `WEB_APP_URL` and `APP_SECRETS_NAME`; it enables retained/deletion-protected data stores, DynamoDB point-in-time recovery, S3 versioning, scheduled AWS Backup recovery points, restricted CORS, structured logs, tracing, alarms, and an operations dashboard. Development stacks remain disposable. See [Production survivability](docs/production-survivability.md) for the secret schema, retention contract, deployment requirements, and restore drill.

### Production custom domains

Route 53 hosted zones and ACM certificates are created/validated outside CDK. There are two deliberately separate deployment targets:

- `full` (the default) deploys the complete Ubeeq/Eversally product stack.
- `public` deploys only a static landing page and a small Bluesky OAuth service. It creates no product API, Cognito user pool, media bucket, content tables, or background workers.

The full stack does not claim the public root/API domains unless `ENABLE_FULL_PRODUCT_DOMAINS=true` is deliberately set. This avoids a CloudFormation ownership collision while the launch stacks are live; moving the full product onto these domains is an explicit future cutover.

The public target needs a Secrets Manager secret whose JSON contains a single `blueskyOAuthPrivateJwk` field holding a P-256 / ES256 private JWK. This is the confidential OAuth client signing key; never commit it or put it in a shell history. The service derives and publishes a public JWKS automatically.

Generate the secret payload locally, save it directly into Secrets Manager, and securely discard the temporary file afterward:

```bash
node apps/bluesky-oauth/scripts/generate-private-jwk.mjs > /tmp/eversally-bluesky-oauth-secret.json
aws secretsmanager create-secret \
  --name eversally/production/bluesky-oauth \
  --secret-string file:///tmp/eversally-bluesky-oauth-secret.json \
  --region ca-central-1
```

Use a distinct secret/key for Ubeeq. Do not rotate or delete a key while active Bluesky sessions exist; create a planned key/session migration instead.

Use the `ca-central-1` API certificate for API Gateway and the `us-east-1` website certificate for CloudFront. The Eversally public launch deployment is:

```bash
export DEPLOY_TARGET=public
export ROOT_DOMAIN=eversally.com
export API_DOMAIN=api.eversally.com
export HOSTED_ZONE_ID=Z0933147166BL9EKW6HNC
export API_CERTIFICATE_ARN=arn:aws:acm:ca-central-1:024505387948:certificate/a112c104-4d43-4604-aed8-ecaecfd43f61
export WEB_CERTIFICATE_ARN=arn:aws:acm:us-east-1:024505387948:certificate/25ddb503-6b4a-49ad-8a71-475307fa819a
export PRODUCT_BRAND=eversally
export BLUESKY_OAUTH_SECRET_NAME=eversally/production/bluesky-oauth
npm --workspace @gallery/infra run deploy -- --all
```

For Ubeeq, substitute `ubeeq.site`, `api.ubeeq.site`, hosted zone `Z0932683HY1YB6JSU1XI`, web certificate `arn:aws:acm:us-east-1:024505387948:certificate/e8c28fd0-cf73-49cb-8305-912999b08833`, API certificate `arn:aws:acm:ca-central-1:024505387948:certificate/1b562c5a-4e1e-41b6-aa41-aa40f868a2ee`, `PRODUCT_BRAND=ubeeq`, and a separate `BLUESKY_OAUTH_SECRET_NAME`. The target deploys two stacks: `<Brand>Landing` and `<Brand>BlueskyOAuth`.

The OAuth service exposes `https://api.<domain>/oauth/bluesky/client-metadata.json`, `/oauth/bluesky/jwks.json`, `/oauth/bluesky/authorize?handle=<handle>`, and `/oauth/bluesky/callback`. It uses OAuth authorization-code flow with PKCE, PAR, DPoP, private-key client authentication, state storage with a one-hour TTL, and AWS-managed storage for refreshable sessions.

### Bluesky Studio handoff

The Studio integration uses a deliberately narrow handoff: Studio issues a signed, ten-minute Creator-scoped state; the OAuth service returns that state only after its own PKCE validation, together with a short-lived ES256 connection proof. Studio verifies the proof against the OAuth service's public JWKS before attaching the Bluesky DID to the selected Creator. Refresh tokens and the DPoP key remain solely in the OAuth service.

Configure the full product API with the broker's public endpoints:

```bash
export BLUESKY_OAUTH_SERVICE_URL=https://oauth.api.eversally.com
export BLUESKY_OAUTH_SERVICE_JWKS_URL=https://oauth.api.eversally.com/oauth/bluesky/jwks.json
```

Use a dedicated OAuth subdomain such as `oauth.api.eversally.com` before the full Studio API takes over `api.eversally.com`. The initial landing deployment used `api.eversally.com` as a temporary OAuth host; leaving it there would conflict with the future full-product API custom domain. Moving it now changes the OAuth client ID, so the test account should simply reconnect once after the move. The existing `*.api.eversally.com` certificate covers this subdomain.

### Local landing-page preview

Run either static site alone, with no product API or web app required:

```bash
npm run dev:landing:eversally # http://127.0.0.1:5180
npm run dev:landing:ubeeq     # http://127.0.0.1:5181
```

Or preview both together with `npm run dev:landing`.

### Buttondown redirects

Set these on each Buttondown newsletter (or through its newsletter API):

| Newsletter | `subscription_redirect_url` | `subscription_confirmation_redirect_url` |
| --- | --- | --- |
| Eversally | `https://eversally.com/thanks/` | `https://eversally.com/confirmed/` |
| Ubeeq | `https://ubeeq.site/thanks/` | `https://ubeeq.site/confirmed/` |

The landing deployment includes these branded pages. Buttondown redirects to the first URL immediately after form submission and to the second after email confirmation.

### Portable Ubeeq Creator export

Every Creator member can download a portable manifest from **Studio → Settings → Portable data export**, or through the authenticated endpoint:

```text
GET /studio/creators/:creatorId/export
```

The response is a downloaded JSON document with this stable top-level contract:

```json
{
  "schema": "https://ubeeq.site/schemas/creator-export/v1",
  "schemaVersion": 1,
  "generatedAt": "2026-08-14T00:00:00.000Z",
  "source": { "product": "Ubeeq", "tenantId": "ubeeq" },
  "creator": {},
  "works": [],
  "collections": [],
  "integrationAccounts": []
}
```

It includes:

- Creator identity, profile, branding, and Space configuration stored in the canonical record.
- Canonical Works with lifecycle, visibility, metadata, revisions/timestamps, origin, and discovery participation.
- Asset attachments, original-file storage references, MIME metadata, byte sizes, and checksums where available.
- Collection records plus ordered Work memberships.
- Destination-specific Publications and publication intent, including external IDs, URLs, status, synchronization metadata, and destination metadata overrides.
- Non-secret external account identity and health metadata.

It deliberately excludes OAuth access/refresh tokens, creator-owned application client secrets, encrypted credential payloads, passwords, and other authentication material. It is a metadata manifest, not a ZIP archive: originals remain in the configured object store and are referenced by storage key/checksum. Preserve the manifest together with those originals for migration; an archive/original-file export is a future addition.

For a restore or migration, first provision a compatible Ubeeq deployment, copy the referenced originals into its object store, then import the manifest through the forthcoming import workflow. Today, the export is intentionally read-only and is suitable for ownership records, backup verification, and external migration tooling.

## Account Email and Social Sign-In

The CDK stack has branded Cognito verification-email content, optional SES delivery, and conditional Google/Apple providers. It deliberately does not create third-party developer accounts or insert credentials into source control.

Set the following before `cdk deploy`:

```bash
# Required to expose Cognito managed login and social federation.
export COGNITO_DOMAIN_PREFIX=your-unique-ubeeq-auth-prefix
export WEB_APP_URL=https://app.example.com

# Optional but required for a branded From address and reliable production delivery.
export SES_FROM_ADDRESS=hello@example.com

# Optional. Where Creator integration requests are delivered. When omitted,
# Eversally sends to hello@eversally.com and Ubeeq sends to hello@ubeeq.site.
export INTEGRATION_REQUEST_TO_ADDRESS=hello@example.com

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

For local use, the redirect URI must match the active edition: `https://fanadmin.top:5174/auth/callback` for Eversally or `https://fanadmin.top:5175/auth/callback` for Ubeeq. The social sign-in flow uses OAuth authorization code + PKCE and completes the code exchange in the browser.

### Branded account emails

The stack has separate Eversally and Ubeeq themes, subjects, and copy for account-confirmation emails. Set `PRODUCT_BRAND=eversally` or `PRODUCT_BRAND=ubeeq` before deployment.

To brand **all** code emails — confirmation/resend, password reset, and authentication/MFA — configure `SES_FROM_ADDRESS` with a verified SES identity. The stack then attaches a Cognito Custom Message Lambda and uses the same product-specific visual system for every code email. Without SES, Cognito's managed sender still uses the branded confirmation template, but reset and authentication-code messages remain Cognito-managed; this avoids enabling a custom-message trigger that Cognito cannot deliver through its managed sender.

Cognito requires the `{####}` token in code templates. See [Cognito email settings](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html) and [message template requirements](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-message-customizations.html).

### Integration-request inbox

The Creator setup flow includes an authenticated **Request an integration** form. The API sends each request using `SES_FROM_ADDRESS`, with the requesting member as the reply-to address. Its destination defaults by edition:

- **Eversally:** `hello@eversally.com`
- **Ubeeq:** `hello@ubeeq.site`

SES can send email, but it does not create a receiving mailbox. Before using either default, provision the corresponding `hello@` mailbox or alias with your email host (or override `INTEGRATION_REQUEST_TO_ADDRESS`), verify the sender/domain in SES, and—while SES is in the sandbox—verify the recipient as well. CDK grants the API permission to send only when `SES_FROM_ADDRESS` is configured.

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

The Studio **Integrations** section connects one or more DeviantArt accounts to a creator identity. Each creator identity supplies its own DeviantArt OAuth application in Studio; the platform does not use a shared DeviantArt client application. Imports run asynchronously through the `ExternalSyncQueue`; the local API uses an in-process worker and production uses SQS plus Lambda.

Set these deployment-time API variables before deploying CDK:

```bash
export EXTERNAL_OAUTH_REDIRECT_URI=https://<api-host>/integrations/deviantart/callback
export EXTERNAL_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 48)"
export APP_ORIGIN=https://<web-host>
```

Creators register `EXTERNAL_OAUTH_REDIRECT_URI` as the callback URL in their own DeviantArt application, then enter that application’s client ID and secret under Studio Integrations. `EXTERNAL_TOKEN_ENCRYPTION_KEY` encrypts both creator application secrets and OAuth tokens at rest. Keep it in managed secret storage in the deployment environment and rotate it through a planned credential migration; changing it without migration prevents existing encrypted credentials from being decrypted. `EXTERNAL_SCHEDULED_SCANS_ENABLED` controls autonomous catalogue and activity polling, defaults to `false` outside production, and can be set to `false` in any environment to control provider costs; manual syncs and retries of jobs already queued remain available. `EXTERNAL_ACCOUNT_SCAN_INTERVAL_SECONDS` defaults to `21600` (six hours) for catalogues; `EXTERNAL_ACTIVITY_SCAN_INTERVAL_SECONDS` defaults to `120` (two minutes) for feedback activity. `DEVIANTART_MIN_REQUEST_INTERVAL_MS` defaults to `2000`, serializing calls at a conservative maximum of roughly 30 requests per minute; production also uses one external-sync Lambda execution at a time and retains Retry-After/backoff handling as a safety net. DeviantArt does not expose webhooks, so bounded polling and proactive pacing provide near-real-time updates without intentionally running into adaptive rate limits.

New platform-to-DeviantArt publications retain the Sta.sh `itemid` returned by `stash/submit` before calling `stash/publish`. Published-description updates are enabled by default after local validation; set `DEVIANTART_PUBLISHED_DESCRIPTION_UPDATE=false` to disable them. The worker submits `itemid` plus `artist_comments` to `stash/submit` without a file, then reads the published deviation back and only marks the job synchronized when the description matches. Existing imported publications and older publications without a retained Sta.sh item ID remain read-only for published descriptions.

Outbound DeviantArt destinations default to **Published**, but can instead target a **Draft in Sta.sh** per work or in bulk from Works. Draft synchronization stops after `stash/submit`; changing that destination to Published later reuses the retained Sta.sh `itemid` and continues with `stash/publish`.

Full account synchronization also reconciles DeviantArt gallery hierarchy and membership for continuous mappings, detects missing/deleted/restricted publications, and records metadata conflicts between queued platform changes and newer remote edits. The Activity inbox supports server-side filters, pagination, bulk read state, and remote DeviantArt message dismissal while retaining local history. See [`docs/deviantart-activity-sync.md`](docs/deviantart-activity-sync.md) for the reconciliation and moderation boundaries.

For local OAuth testing, the paired launch command supplies the required local API environment and queues sync work in-process. Register the exact edition callback URL with DeviantArt.

```bash
export EXTERNAL_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 48)" # optional: stable across restarts
npm run dev:eversally
```

Sign in through the existing local web flow, then open `/studio/workspace?section=integrations`. `LOCAL_AUTH_USER_ID` is accepted only when the API has no Cognito verifier configured; do not set it in a deployed environment.

## Discord Community Delivery

Discord is a **community-delivery** integration, not a second content host. It can announce a Work after it first becomes public in an Eversally Space; it never creates a separate canonical Work or treats a Discord message as a publication.

### Discord application setup

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Add the exact redirect URI: `https://<api-host>/integrations/discord/callback` (locally, `https://fanadmin.top:4000/integrations/discord/callback` for Eversally or port `4001` for Ubeeq).
3. Enable the OAuth scopes `identify`, `guilds`, `bot`, and `applications.commands`. The install URL asks only for **View Channels**, **Send Messages**, and **Embed Links** permissions.
4. Configure the API with `DISCORD_CLIENT_ID` and `DISCORD_OAUTH_REDIRECT_URI`. Keep `discordClientSecret` and `discordBotToken` in Secrets Manager: set `DISCORD_SECRETS_NAME` for a shared development deployment, or use the existing `APP_SECRETS_NAME` JSON in production. Client ID and redirect URI remain ordinary deployment environment values.

In Studio → Integrations, connect Discord once, then select a text or announcement channel for each Creator that should receive messages. A connected server belongs to the user account and can be reused by that user’s Creator identities. The API never exposes bot tokens or OAuth access tokens to the browser.

Each destination has an editable compact template using `{title}`, `{url}`, and `{creator}`, and offers a safe test message. When a Work first becomes **public** in its Space, delivery is queued with an idempotency key. The worker retries transient failures (including Discord’s `retry_after` rate limits) up to six times; a missing channel or lost permissions pauses the destination as **Needs attention** instead of repeatedly posting. Discord messages suppress all automatic mentions (`@everyone`, roles, and users).

This initial integration intentionally does not read message history, manage members, send DMs, use the Gateway, or implement moderation/archive mirroring. Slash commands and Challenge-specific messages are future additions.

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

## First administrator bootstrap

The API can provision the first administrator when it starts. Set
`ADMIN_EMAIL` and `ADMIN_PASSWORD` in the local API environment or deployment
environment. The hosted Eversally default email is `admin@eversally.com`; the
Ubeeq default is `admin@ubeeq.site`. The password must satisfy the Cognito user
pool policy.

The bootstrap is idempotent: a missing user is created, marked as having a
verified email, and added to the `Admins` group. Existing users are never
assigned a new password. In production, put `adminPassword` in the JSON secret
referenced by `APP_SECRETS_NAME` rather than putting the password in a shell
history or committed environment file. The CDK API role includes only the
Cognito admin actions required for this bootstrap.

When running locally without Cognito, providing both values makes the local
simulated identity an administrator so the full admin UI can be exercised. The
local password is not persisted or used for authentication in that mode. If
the values are omitted, local development keeps its normal non-admin identity.
