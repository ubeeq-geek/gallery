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
