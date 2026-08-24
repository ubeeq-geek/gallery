# Integration standardization

This branch establishes a common model before provider-specific drafts are
merged. Providers declare their capabilities in `integrationStandard.ts`; a
missing capability is deliberately unavailable rather than represented by an
unsupported method on a broad provider interface.

## Existing integrations

DeviantArt and YouTube use the shared capability and hold checks both when
work is queued and immediately before a provider call. Bluesky uses the same
connection admission check while keeping OAuth tokens in its isolated broker.
Discord is registered as a native destination integration; its delivery worker
checks Creator, destination, and Work holds before it sends a message and uses
the shared delivery retry classification.

The capability registry also covers Ghost, SmugMug, and Vimeo, which previously
had provider implementations but no shared declaration. Bluesky and Discord
both publish immutable `AnnouncementPublication` snapshots: Discord renders an
embed, while Bluesky sends the same portable content through the isolated DPoP
OAuth broker. The broker uses an HMAC-authenticated internal request and a
deterministic AT Protocol record key so retries cannot create duplicate posts.
Bluesky is an explicit announcement target; existing Discord-only requests do
not begin posting to a connected Bluesky account implicitly.

## AI provenance and Instagram disclosure

Canonical Works now distinguish an explicit `none` declaration from unknown
provenance on an imported record. Each confirmed publication attempt appends a
fingerprinted disclosure snapshot containing the Work revision, AI provenance,
content rating, heavy-topic declarations, and selected Asset checksums. Both
in-memory and DynamoDB persistence reject edits or removal of prior snapshots;
the DynamoDB write also conditionally compares prior history to prevent a
concurrent append from being overwritten.

Meta's June 2026 Instagram changelog semantics are implemented as follows:

- `is_ai_generated=true` is sent while creating the top-level media container.
- For a carousel, the flag is sent only on the carousel parent. Supplying it to
  a child container fails locally before any provider call.
- `is_ai_generated` is requested on top-level media imports. `true` becomes a
  provider-backed `ai-generated` provenance assertion; false or absent remains
  provenance `unknown`, because lack of a provider label is not proof of no AI.
- The default pinned Graph API version is v26.0. Existing connections keep the
  version stored when they were authorized until an explicit migration.

## Shared sync and recovery

`integrationSyncRecovery.ts` extracts the reusable checkpoint/page and failure
recovery rules from the DeviantArt worker. Incomplete page walks require a
continuation cursor and never advance the successful-sync watermark. Ambiguous
writes require reconciliation against a persisted provider identifier before
retry; authentication, policy, rate-limit, and terminal failures have distinct
portable dispositions.

## Execution order

1. Integrate the support/safety hold and scan model behind `IntegrationPolicyGate`.
   Both job creation and the sync worker check durable holds before provider
   contact, including the connected account, owning Creator, asset,
   publication, and external-content targets.
2. The shared reconciliation module now provides normalized snapshots,
   field-level diffs, status classification, and confirmation-gated resolution.
   Normalized baseline and remote snapshots now persist on canonical
   Publications, and a confirmation-gated publication resolver now advances
   the shared baseline. It supports accepting remote metadata, retaining
   local metadata, or creating a detached local copy.
3. A shared delivery envelope now supplies idempotency, retry classification,
   exponential jitter, and terminal policy-block behavior. Extract one queue
   and dead-letter workflow from the existing external sync, Vimeo, and Tumblr drafts.
4. The common migration module now validates public approved HTTPS sources,
   verifies SHA-256 checksums, and requires a verified quarantine item before
   canonical attachment. Route Flickr and SmugMug source acquisition through it.
5. Add provider adapters only after they declare capabilities and policy
   requirements. Patreon remains an entitlement adapter, not a content-sync
   adapter. New provider drafts should adopt the delivery and migration
   modules rather than duplicating queue or source-validation behavior.

## Safety targets

The standard explicitly recognizes `external_account`,
`integration_connection`, `publication`, and `external_content`, in addition
to canonical Works, Assets, and Creators. This permits a hold to stop an
in-flight integration without hiding unrelated canonical content.
