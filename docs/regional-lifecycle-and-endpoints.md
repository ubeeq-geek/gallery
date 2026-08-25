# Regional lifecycle, privacy, and endpoint contract

## Retention and holds

All durations are maximum operational retention and are enforced with cell-local S3 lifecycle rules: quarantine 30 days, originals and restricted safety evidence 7 years, private and public derivatives 1 year, exports 7 days, and temporary scan frames 7 days. Non-current durable versions expire after 30 days. Product policy may shorten these values. Production evidence storage also uses S3 Object Lock governance retention, so lifecycle and application deletion cannot remove protected evidence early. A litigation or regulatory hold is represented on the regional Space or Asset, blocks the deletion workflow, and requires held bytes to be preserved in that evidence store; authorized operators must record the basis and release of a hold in the regional audit store. AWS Backup recovery points remain subject to the separately documented vault-lock schedule and are deleted by expiry rather than edited in place.

Authenticated `POST /privacy/export` produces a cell-local JSON export with a 15-minute download URL. `POST /privacy/delete` verifies ownership and cell identity, rejects legal holds, removes every object referenced by the Space's authoritative records, deletes those records, performs S3 absence checks, and persists a verified erasure receipt. Exports expire after seven days. Operators investigate any `privacy_workflow_failed` response before retrying the idempotent request.

## Stable endpoints

Production cells use `api.{region}.{product}.example` and `media.{region}.{product}.example`-style names supplied by deployment configuration. API certificates are region-local; CloudFront certificates must be in `us-east-1`. Route 53 aliases, TLS 1.2, WAF, JSON access logs, X-Ray tracing, API metrics, a 100 request/second steady-state throttle with 200 burst, and an explicit browser-origin allowlist are configured per cell. The media origin is private and reachable only through CloudFront origin access control.

Public asset URLs are immutable (`https://media.<cell>/<space>/<asset>/<media-version>/<rendition>`). Publication cutover writes a new version before routing changes; revocation invalidates the exact prior version. Browser clients never construct a cell hostname: they use the routing directory and refresh it once on 409, 421, or 503 so migration and health failover cannot leave a stale session route.

## Deployed two-cell qualification

Before each production wave, deploy two ephemeral cells and run `scripts/qualify-two-cell.mjs` with their endpoint and test-token environment variables. The four `QUALIFY_*_COMMAND` variables connect the release environment's upload fixture, Step Functions fault injector, Route 53/outage simulator, and wrong-region AWS probe. Every hook must exit nonzero on a failed assertion. The qualification covers assignment, provisioning, upload, scan/review/publication, cross-cell denial, interrupted migration resume, routing refresh during outage, and an AWS-enforced wrong-region request. Evidence (CloudFormation events, request IDs, audit receipts, and cleanup confirmation) is retained with the release record. The script refuses to report success without explicit endpoints, tokens, and all four executable gates; component tests are not a substitute for this gate.
