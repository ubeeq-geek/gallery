# Regional residency, recovery, and operations

## Residency boundary and data classification

| Data class | Examples | Authoritative location | Permitted movement | Controls |
| --- | --- | --- | --- | --- |
| Restricted private content | quarantine bytes, originals, private derivatives, scan frames, safety evidence | Selected product × home-region cell | Never copied outside the home region except an explicitly authorized migration to its destination | Regional KMS/S3, blocked public access, cell assertions, regional permissions boundary, manifest/hash migration |
| Regional operational metadata | Spaces, Assets, upload authorizations, scan jobs/results, policy decisions, usage/quota records, review cases | Selected home-region cell | Same rule as restricted content | Regional DynamoDB/KMS, conditional cell checks, PITR and AWS Backup |
| Regional audit data | upload/policy/redrive audit records and structured audit logs | Selected home-region cell | No cross-region aggregation of payload-bearing logs | Regional DynamoDB stream, dedicated CloudWatch log group, one-year production retention |
| Global routing metadata | opaque routing ID, product, home region, migration status | Global control-plane region (`us-east-1` by default) | Globally available to authenticated routing clients | No email, handle, content metadata, or raw identity subject is stored; key is a one-way digest |
| Global identity data | Cognito subject, email and authentication attributes | Cognito user-pool region | Processed according to Cognito's service terms | Shared user pool keeps a stable subject; regional cells receive tokens, not copied profiles |
| Public derivatives | policy-cleared public media | Home-region S3 origin; globally cached by CloudFront | Global edge delivery is intentional | Separate bucket and publication gate; revocation invalidates the global distribution |
| Infrastructure telemetry | resource metrics, alarms, stack metadata | Regional CloudWatch plus global AWS control planes | AWS-managed control-plane processing | Payloads and creator identifiers must not be metric dimensions |

CloudFront, IAM, Route 53, AWS Organizations, Support, and the global routing/identity control plane are explicit exceptions to an exact-region claim. Product copy must therefore promise **regional storage and processing for private media**, not that every control-plane byte remains in one AWS region.

The regular-workload IAM permissions boundary denies non-exempt API calls whose `aws:RequestedRegion` is not the cell region. The migration worker has a separate boundary limited to the approved launch regions and configured global-routing region because authorized copy and directory cutover are inherently cross-region. Organization administrators should apply equivalent role-aware SCPs to the workload OUs; the CDK boundaries are defense in depth and cannot constrain the AWS account root or organization management account.

## Recovery objectives and failure semantics

This is a residency-first system, not active-active regional failover. A home-region outage makes that cell unavailable; routing must fail closed and must not redirect private work to another region.

| Data class / service | RPO | RTO | Recovery source |
| --- | --- | --- | --- |
| DynamoDB regional metadata/audit | 24 hours maximum; target minutes with PITR | 8 hours | PITR or daily/monthly regional AWS Backup recovery points |
| Durable S3 content | 24 hours maximum; target zero for versioned-object rollback | 24 hours | Object versions or regional AWS Backup vault |
| Temporary scan frames | No recovery objective | Regenerated within 24 hours after durable content is restored | Re-extraction from restored original |
| SQS in-flight work | Up to 14 days retained in DLQ; individual in-flight messages may be replayed | 4 hours after cell restoration | Cell-validating redrive Lambda and scan idempotency |
| Global routing directory | 24 hours maximum; target minutes with PITR | 4 hours | Global table PITR and infrastructure redeployment |
| Regional API/compute | No durable state | 2 hours after regional service availability | CDK matrix redeployment from the immutable configuration version |

Backups remain in the exact home region. The production vault is KMS-encrypted and vault-locked for 35–370 days; the plan takes daily 35-day and monthly one-year recovery points. This protects against logical loss but **does not survive destruction of the AWS region**. Cross-region copies must not be added until product/legal owners approve a destination geography and update this matrix.

### Restore procedure

1. Declare the cell unavailable, page the alarm topic owner, freeze directory assignment/migration for that cell, and record the incident ID.
2. Prefer DynamoDB PITR for a narrow logical-loss timestamp; otherwise select the latest completed regional vault recovery point meeting the incident's clean-time requirement.
3. Restore to new resource names. Never overwrite the damaged tables/buckets during investigation.
4. Validate product/environment/region tags, record counts, object version counts, representative SHA-256 metadata, and KMS access in an isolated operator role.
5. Deploy the same `ConfigurationVersion` from the manifest, point a temporary validation stack at restored resources, and run the cell health and upload→scan→publication golden journey.
6. Approve cutover with two operators, update stack parameters/imports, then reopen routing. Do not change a tenant's home region as a recovery shortcut.
7. Retain damaged resources under incident hold, document achieved RPO/RTO, and perform deletion only after security/legal approval.

Run a restore game day quarterly in every deployment wave and record restore duration, recovery-point age, hash validation, and golden-journey result.

## Monitoring and incident ownership

Every cell creates an encrypted SNS alarm topic. Production synthesis requires `OPERATIONS_ALARM_EMAIL`; confirm the SNS email subscription after deployment. Alarms cover all DLQs/critical stream failures, all queue ages, API 5xx/p95 latency, scheduled health-canary failures, and scan/image/video/publication concurrency. The audit stream writes structured JSON to the dedicated cell audit log.

Initial SLOs:

- Regional routing/API availability: 99.9% monthly, excluding declared AWS regional outages.
- API p95 latency: under 2 seconds.
- Accepted image to terminal policy state: 99% within 10 minutes.
- Public-eligible to published: 99% within 10 minutes.
- Safety revocation stream: no unhandled record; critical stream failure alarm pages immediately.

Alarm response: acknowledge within 15 minutes, identify the exact product/environment/region from the alarm name, stop migrations during ambiguous state, and never replay into another cell.

## DLQ redrive runbook

The `DlqRedriveFunctionName` stack output identifies the operator-only replay Lambda. It has fixed source/destination queue mappings and cannot accept arbitrary URLs. Each message is parsed and rejected unless product, environment, and data-home region match the Lambda's cell. Successful replay is deleted from the DLQ only after send and creates an immutable `DLQ_REDRIVE_AUDIT` record with the operator identity.

1. Inspect and classify messages without copying restricted bodies into tickets or chat.
2. Fix the root cause and deploy it to the same configuration wave.
3. Invoke with `{"queue":"scan|image|video|publication","maximumMessages":10,"requestedBy":"<operator/incident>"}`. Start with one message.
4. Confirm the audit record and terminal workflow state before increasing the batch (hard maximum 100).
5. Cross-cell or malformed messages are evidence: do not alter and replay them. Escalate to security.
6. Critical stream failures, including revocation, use a separate alarmed failure queue. Re-drive the original DynamoDB stream record only after verifying the outbox remains pending; do not send stream envelopes to work queues.

## Deployment waves, preflight, and drift

`infra/config/regional-cells.json` is the authoritative product/region matrix and immutable configuration version. Deploy global routing first, validate all endpoint/layer maps, then promote waves sequentially. Each wave must pass synthesis, deployed health, golden journey, alarm delivery, and rollback verification before the next wave.

Commands:

- `npm run validate:regional-cells` — schema, uniqueness, full product/region coverage, and wave validation.
- `node scripts/validate-regional-cells.mjs --production-preflight` — required shared resources, HTTPS endpoints, and region-local FFmpeg ARN validation.
- `node scripts/validate-regional-cells.mjs --aws-preflight` — AWS CLI checks for regional Lambda concurrency quota and Rekognition access.
- `DEPLOY_TARGET=regional-matrix npm --workspace @gallery/infra run synth` — synthesize every declared cell from one policy/config version.
- `npm run check:regional-drift` — require every production cell stack to report `IN_SYNC`.

Drift is release-blocking. Roll back a failed wave; never patch an individual cell manually.

## Quotas and back pressure

Upload authorization atomically reserves bytes and increments upload count in a monthly Space quota record before issuing an S3 URL. Production defaults may be overridden per cell with `MONTHLY_MEDIA_BYTES_LIMIT` and `MONTHLY_UPLOAD_LIMIT`; exceeding either fails the authorization transaction. The same transaction appends a regional `MEDIA_PROCESSING_LEDGER` record.

Scan work uses a FIFO queue grouped by authoritative Space ID, preventing one Space from monopolizing ordering while preserving bounded worker concurrency. Queue-age, DLQ, and concurrency alarms expose provider or Lambda saturation. Before raising concurrency, run AWS preflight and confirm Rekognition and account quotas in every region in the deployment wave.
