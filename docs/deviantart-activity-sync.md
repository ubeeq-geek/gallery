# DeviantArt activity synchronization

Ubeeq treats DeviantArt as one adapter behind integration-neutral activity, comment, favourite, engagement, and checkpoint records. The Studio API and Work Activity UI read only the normalized records; DeviantArt response payloads are retained for diagnostics and future adapter migrations.

## Synchronization model

- A scheduled `activity_sync` polls DeviantArt feedback every two minutes by default. DeviantArt does not expose webhooks.
- Feedback checkpoints are maintained separately for comments, replies, and other activity. Recent remote IDs make polling idempotent and allow a page containing only known events to stop pagination early.
- Each activity poll queues `engagement_sync`. Engagement metadata is loaded in batches of 10 deviations, the maximum accepted by DeviantArt's metadata endpoint.
- A changed comment count causes the work's complete comment thread to be reconciled. A changed favourite count causes the complete `whofaved` result to be reconciled.
- Full account imports also queue activity and engagement jobs, so a manual/full sync includes catalogue metadata and current activity.
- Full account imports reconcile gallery folders and continuous folder mappings. Remote membership is attributed to its mapping, so it can be refreshed without removing manually assigned Ubeeq collection works.
- Publications absent from a complete catalogue scan are checked individually and retained with `missing`, `deleted`, or `restricted` lifecycle state. Remote metadata fingerprints distinguish remote edits, pending outbound updates, and conflicts.
- Engagement has a mutable current record for fast reads and immutable snapshots written only when a metric changes.
- Favourite removal and missing comments are soft state changes (`active: false` or `remoteDeletedAt`), rather than destructive deletes.

The OAuth application must grant the `message` scope in addition to the existing user, browse, gallery, collection, Sta.sh, publish, and comment-post scopes. Accounts authorized before this scope was added may need to reconnect before feedback can be read.

## Content replacement

DeviantArt does not document a stable source checksum or deviation-level HTTP last-modified value. Ubeeq therefore uses two checks:

1. A remote descriptor fingerprint covers the stable source URL path, filename, type, size, and dimensions while excluding expiring signed URL query parameters.
2. When a content check is required, Ubeeq downloads the source and computes SHA-256 over its bytes. Identical bytes retain the existing object. Changed bytes are written to a checksum-addressed immutable version key.

Hosted works are checked when first copied, when the descriptor changes, or at least once every 24 hours while source-file synchronization remains enabled. Provider `ETag` and `Last-Modified` download headers are stored when present, but SHA-256 is authoritative.

## Configuration

`EXTERNAL_ACTIVITY_SCAN_INTERVAL_SECONDS` controls the feedback poll interval and defaults to `120`. `EXTERNAL_ACCOUNT_SCAN_INTERVAL_SECONDS` controls catalogue reconciliation and defaults to `21600`. Production invokes the scheduler every minute; adaptive provider rate-limit responses use the existing retry queue and backoff behavior.

The integration-neutral endpoints are:

- `GET /studio/integrations/activity?creatorId=...&type=...&status=...&accountId=...&cursor=...&limit=...` for a filtered, paginated creator feed.
- `POST /studio/integrations/activity/sync` to refresh every connected account assigned to a creator.
- `PATCH /studio/integrations/activity/accounts/:externalAccountId/:remoteActivityId` for local read/unread state.
- `PATCH /studio/integrations/activity/bulk` for bulk local read/unread triage.
- `POST /studio/integrations/activity/accounts/:externalAccountId/:remoteActivityId/dismiss` to dismiss a backed DeviantArt message while retaining its Ubeeq history.
- `GET /studio/integrations/activity/works/:assetId` for a complete per-work aggregate.
- `POST /studio/integrations/activity/works/:assetId/sync` to queue feedback and engagement refreshes.

DeviantArt's public API supports posting comment replies but does not expose comment hide/delete operations or deletion of a published deviation. Ubeeq therefore retains removed comments as history, provides retryable replies, links moderation back to the deviation, and reports unsupported lifecycle operations instead of presenting a destructive action that cannot be verified.
