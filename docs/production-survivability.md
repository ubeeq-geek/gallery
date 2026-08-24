# Production survivability

These controls are intentionally enabled only when `DEPLOYMENT_STAGE=production` (or `prod`). Development and local stacks remain disposable.

## Production deployment requirements

Production synthesis fails unless both variables are set:

```bash
export DEPLOYMENT_STAGE=production
export WEB_APP_URL=https://eversally.com
export APP_SECRETS_NAME=eversally/production/application
```

`WEB_APP_URL` is the only browser origin placed in API Gateway, S3, CloudFront media, Cognito callback, and Cognito logout configuration. Do not include a trailing slash.

Create the Secrets Manager secret outside the application stack so deleting or replacing a stack cannot delete the key material. Store one JSON object with these fields:

```json
{
  "externalTokenEncryptionKey": "a stable high-entropy value",
  "unlockJwtSecret": "a separate stable high-entropy value",
  "googleClientSecret": "optional; required when GOOGLE_CLIENT_ID is set",
  "applePrivateKey": "optional; required when Apple sign-in variables are set",
  "tumblrClientSecret": "optional; required when TUMBLR_CLIENT_ID is set",
  "cloudFrontPrivateKey": "optional; required when premium signed media is configured"
}
```

The DeviantArt and creator-owned Tumblr client secrets and OAuth tokens supplied by Creators remain encrypted in DynamoDB. `externalTokenEncryptionKey` is the managed root key for that encryption. Rotating it requires re-encrypting existing credential records; replacing it without migration makes those records unreadable. The managed Tumblr application secret is read from `tumblrClientSecret` in this production secret rather than from the deployment shell.

Production does not read `GOOGLE_CLIENT_SECRET`, `APPLE_PRIVATE_KEY`, `CLOUDFRONT_PRIVATE_KEY`, `EXTERNAL_TOKEN_ENCRYPTION_KEY`, or `UNLOCK_JWT_SECRET` from the deployment shell. Non-production may continue to use those environment values.

## Retention contract

| Data | Production protection | Retention |
| --- | --- | --- |
| DynamoDB tables | Deletion protection, retained CloudFormation resources, native point-in-time recovery | PITR rolling window managed by DynamoDB (up to 35 days) |
| DynamoDB and media bucket | AWS Backup vault and plan | Daily recovery points for 35 days and monthly recovery points for one year |
| S3 media | Retained bucket, versioning, SSL-only access | Current objects retained; non-current versions retained for 90 days by default |
| Incomplete S3 uploads | Lifecycle cleanup | Aborted after 7 days |
| Lambda and API access logs | JSON logs, X-Ray tracing, retained log groups | 90 days |
| Sync and poster dead-letter queues | Failed-message retention | 14 days |

Override the S3 non-current-version period with `MEDIA_NONCURRENT_VERSION_RETENTION_DAYS`. Reducing it reduces the recovery window and should be treated as a production policy change.

The AWS Backup vault enforces recovery-point retention between 35 and 366 days. It is retained if the application stack is deleted.

## Monitoring

Production creates:

- queue depth, age, and application-level job-failure alarms for external synchronization;
- dead-letter alarms for external synchronization and video posters;
- error alarms for every Lambda function;
- an API Gateway 5xx-rate alarm (5% over five minutes, after at least 20 requests);
- a CloudWatch operations dashboard; and
- an SNS operations topic.

Set `ALARM_NOTIFICATION_EMAIL` to subscribe an operator during deployment. AWS sends a confirmation message; alarms will not reach that address until the subscription is confirmed. The topic ARN is also a stack output and can be connected to another incident-management destination.

## Restore drill

Run this before launch and at least quarterly. Never restore over a live table or bucket.

1. Pick a recovery point at least 24 hours old from the production backup vault.
2. Restore `ContentCoreTable` to a new temporary table name such as `restore-drill-content-core-YYYYMMDD`.
3. Restore the media recovery point to a new temporary S3 bucket.
4. Record the restore job IDs, start/end times, selected recovery-point ARNs, and any warnings.
5. Compare source and restored DynamoDB item counts. Sample at least ten Creators/Works and verify their related Assets, Collections, and Publications can be read.
6. Compare S3 object counts and total bytes. Download a sample of original and thumbnail objects and verify stored SHA-256 checksums where a checksum is present in the manifest.
7. Start a non-production API against the restored table and bucket. Open a private Work as an authorized user and a public Work anonymously.
8. Download a Creator JSON export and confirm it contains the sampled Work, Asset, Collection, and Publication records without OAuth tokens or application secrets.
9. Record pass/fail, recovery-point objective achieved, actual restore time, and follow-up work.
10. After the drill is signed off, delete only the explicitly named temporary restore resources and record that cleanup.

The initial drill requires deployed production recovery points and operator approval, so it cannot be completed by synthesis alone.

## Portable Creator export

Authenticated Creator members can download `GET /studio/creators/:creatorId/export`. Studio exposes the same action under **Settings → Portable data export**.

The versioned JSON manifest includes canonical Creator, Work, Asset attachment, Collection membership, Publication, discovery, and non-secret integration-account records. It deliberately excludes stored OAuth tokens and application credentials. Binary originals remain protected in S3; a later archive export can package them using the manifest's storage references and checksums.
