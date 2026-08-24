# SmugMug migration integration

## Implementation order

1. **Inventory and reference import (implemented).** OAuth 1.0a requests read-only access. The
   gateway walks the authenticated root node, folder children, albums, and paginated image lists with
   opaque resumable cursors. The review manifest is created before any import is confirmed.
2. **Selected/full source migration (implemented for images).** DynamoDB persists checkpoints and
   encrypted credential references. Provider checksums, MIME, byte length, authenticated download
   capability, fail-closed image parsing, SHA-256 deduplication, and private hosted storage are checked
   before a canonical source Asset becomes ready. Unsupported or unsafe payloads remain quarantined.
3. **Selected outbound publishing and metadata sync (implemented).** A creator must explicitly submit Work IDs and an
   inventoried SmugMug gallery to the dedicated publish endpoint. Connect, inventory, import, resume,
   and inventory/reconciliation paths never invoke upload or remote mutation. Only ready, hosted,
   creator-owned canonical images are eligible; later metadata updates require a second explicit selection.

The API exposes the migration workflow at `/api/integrations/smugmug/*`. The application composes
`SmugMugIntegrationService` with two server-side adapters:

- `SmugMugGateway` owns OAuth credentials, migration reads, and isolated explicit publish/update calls. Credential references
  passed to the service must point to encrypted secret storage; raw access tokens are never part of
  a connection, Work, Asset, response export, or audit payload.
- `SmugMugMigrationSink` stages reference metadata in the canonical content model and moves validated
  bytes through private quarantine. Its `quarantine` operation must perform a fail-closed content scan
  and only report `scanPassed` after that scan succeeds. Deployments may inject
  a stronger malware scanner through the same interface.

Outbound publication is isolated behind `POST /api/integrations/smugmug/connections/{id}/publish`; metadata
updates are isolated behind `POST /api/integrations/smugmug/connections/{id}/metadata-sync`. Publishing
records each successful remote image as a canonical SmugMug Publication. Disconnect clears the
credential reference but deliberately retains inventory, provenance, migration items, and canonical content.

## v1 policy decisions

- Folder records remain hierarchy nodes. Galleries and albums remain distinct external collection
  kinds until the creator confirms their Ubeeq Collection mapping.
- EXIF is inventoried when the provider permits it, but the canonical sink applies the creator's EXIF
  privacy policy before storing or exporting it. Location metadata is not implicitly made public.
- Source migration requests the highest authenticated representation. An unavailable original is
  recorded as `EXTERNAL_REFERENCE_ONLY`; it is never reported as a backup.
- Password/client galleries are excluded in v1 (`passwordProtectedGalleries: false`). Passwords,
  visitor identities, client links, proofing data, and commerce data must not be requested or stored.
- Provider permission and policy failures are terminal. Transfer failures are bounded to three
  attempts and resume with a deterministic SHA-256 idempotency key.

The concrete OAuth 1.0a gateway requests `Access=Full` with `Permissions=Read`; this permits catalogue
inventory without granting write access. Inventory promotes `originalDownloads` only after an authenticated
image advertises a permitted original route; each unavailable image still becomes a reference. The in-memory
repository is limited to local development and tests. The production factory uses the content-core DynamoDB
table for durable checkpoints and AES-GCM-encrypted credential records.
