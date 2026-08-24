# Fanvue integration implementation

The v1 connector foundation is intentionally separate from the generic external-platform connector. Fanvue connections, publications, minimized webhook envelopes, and audit events use explicit Fanvue entities. OAuth credentials are referenced only by a connection and are never returned in client models or stored on a Work.

## Security and policy contract

- OAuth clients must use authorization code with S256 PKCE plus independently validated state and nonce. Tokens are exchanged server-side and encrypted with a per-connection data-encryption key before repository storage.
- The eligibility gate is fail-closed. Rights evidence, ownership, adult status, consent, likeness clearance, AI disclosure, safety holds, media support, platform policy, and connector-mode policy are evaluated before starting any upload.
- Each post mutation receives a stable idempotency key owned by the publication attempt. Callers must reuse it after ambiguous or transient failures. Permission and moderation rejections are never retried.
- Multipart sessions upload only approved derivatives to Fanvue-provided part URLs. A post cannot be created until every mapped medium reports `finalized`.
- Webhook handlers verify the signature over the unparsed body, enforce the timestamp window, schema-check before enqueueing, and use the Fanvue event ID as a conditional-write deduplication key. Stored envelopes contain only operational subject IDs and expire via DynamoDB TTL.
- Disconnect revokes remotely when supported, removes subscriptions, physically deletes the credential entity, marks the connection disconnected, and retains only minimum post mappings and audit history. Canonical Works and Assets are not changed.

## Required deployment configuration

Keep these values in the application secret rather than source control or browser configuration:

| Value | Purpose |
| --- | --- |
| Fanvue client ID and client secret | Studio-managed OAuth application |
| Fanvue OAuth callback URL | Exact HTTPS redirect registered in Builder |
| Fanvue webhook signing secret | Signature verification |
| Fanvue API version | Explicit version pinned for the release |
| Token key-encryption key | Wraps each connection's data-encryption key |

Creator-owned credentials are collected only in the server-side setup flow and encrypted immediately. KYC files, tax/bank information, releases, fan identities, DMs, subscriber lists, and payment rows are never accepted by this connector.

## Delivery boundary

`fanvue.ts` supplies the policy model, S256 PKCE generation, API-versioned/idempotent post and multipart calls, and constant-time webhook verification. `fanvueRepository.ts` supplies explicit DynamoDB persistence with atomic event deduplication and minimized retention.

The first implementation slice exposes connection start, server-side OAuth callback, connection status, capability selection, disconnect, and webhook receipt at the specification's Fanvue-scoped routes. The OAuth callback binds the short-lived signed state to the pending owner/connection, exchanges the code on the server, fetches the authenticated Fanvue account, encrypts tokens before storage, and reports insufficient scopes. Capability selection separately refuses publishing when the account is not verified or the necessary scope was not granted. Creator-owned application credentials remain fail-closed until the dedicated credential-vault flow is available.

Connection alone never triggers import, upload, publication, remote update, or deletion. Subsequent slices must preserve explicit preview and confirmation and use the eligibility gate before opening a multipart session.

The second implementation slice adds an explicit `POST /api/integrations/fanvue/connections/{id}/sync` action. It requires the separately enabled `read_posts` capability, decrypts credentials only inside the integration service, follows cursor pagination, and stores each remote post as `FanvueExternalReferenceWork`. Imports contain post fields plus remote media UUID/type/state only: no media bytes and no signed preview URL are retained. Existing references whose metadata hash changes become `REMOTE_CHANGED`; references absent after a complete reconciliation become `REMOTE_REMOVED`. Neither state overwrites a canonical Work or triggers a remote mutation.

The third slice adds private rights-attestation and eligibility endpoints at `/api/works/{workId}/fanvue/eligibility`. Attestations persist only manifest references and explicit decisions—not releases or identity evidence—and are tied to the exact current Asset IDs, reviewer, review time, and optional expiry. Eligibility also derives media readiness from canonical hosted Assets and reads safety holds from service-controlled Asset metadata. It fails closed for missing, expired, or revoked attestations, unsupported/unready media, AI disclosure gaps, and connector-mode policy. Only an administrator/operations reviewer may approve `ELIGIBLE` for a shared managed connection; creator managers may conservatively select `CREATOR_OWNED_REQUIRED` or `PLATFORM_INELIGIBLE`.

The fourth slice adds draft creation at `POST /api/works/{workId}/fanvue/publications`. It re-runs eligibility at request time, requires a verified connection with the explicit `publish_posts` capability, verifies that every selected Asset is attached to the Work, and validates caption, access/pricing, collection, and future schedule fields. The response contains the exact remote preview and `confirmationRequired: true`; the stored draft binds its eligibility decision, Work revision, selected derivative checksums, caption hash, and full preview hash. Draft creation performs no Fanvue API call or upload. A later publish action must re-check all bindings before opening multipart sessions.

The fifth slice adds the separately confirmed `POST /api/fanvue/publications/{id}/publish` mutation. The caller must return the exact stored preview hash, and the service rechecks owner access, connection state/capability, Work revision, rights-decision ID, safety eligibility, and every Asset checksum. Approved Asset bytes are loaded server-side, checksum-verified, split according to Fanvue's multipart plan, transferred directly to presigned part URLs, completed, and polled to finalization before post creation. The post idempotency key is durably stored before the mutation and reused after an ambiguous failure; finalized media mappings are also reused. Moderation responses become `FLAGGED` and are never retried automatically. No storage credential, OAuth token, or presigned URL is returned or persisted.

The sixth slice adds explicit update-draft creation at `PATCH /api/fanvue/publications/{id}`. Published or scheduled posts are never changed by a local Work edit: an authorized creator must choose new caption/access/pricing/schedule/collection values, inspect the regenerated preview and field-change summary, then confirm its new preview hash through the publish action. The update rebinds the current Work revision and rights decision, clears any prior active mutation attempt, preserves finalized media mappings, and generates a new durable idempotency key for the remote `PATCH`. Failed ambiguous attempts retain that active key for safe retry.

The seventh slice adds distinct confirmed remote-removal actions: `POST /api/fanvue/publications/{id}/unpublish` and `DELETE /api/fanvue/publications/{id}`. Both require the separately selected `manage_mapped_posts` capability and an exact remote-post UUID confirmation; neither is invoked by a normal local edit or Work deletion. Each action stores its action-scoped idempotency key before the remote mutation, safely reuses it after ambiguity, records success/failure audit events, and retains the remote mapping as `REMOVED` history. Unpublish and delete remain separate facts and timestamps, and a later delete can explicitly follow an unpublish.

The eighth slice turns verified operational webhooks into minimized connector state updates. Only the allowlisted creator account, post, and media lifecycle classes are accepted; message, subscriber, and payment payloads are rejected. The signed event must identify the local connection and its exact Fanvue account UUID. Conditional event storage deduplicates retries before processing, persisted payloads retain only approved subject IDs, and per-account/per-publication event timestamps make older out-of-order deliveries `IGNORED`. Accepted events update account restriction/verification, mapped post lifecycle, media finalization, moderation flags, and `REMOTE_CHANGED` state without modifying the canonical Work or automatically retrying flagged content.

The ninth slice exposes private, owner-authorized connector panel reads for connection and publication queues plus an explicit account-health refresh. Health access requires the separately selected `account_health` capability; the service fetches it with server-held credentials and stores only a normalized status, aggregate moderation count, posting restriction, short summary code, and check time. It never returns credentials or requests fan identities, subscriber lists, earnings, payment rows, DMs, or raw moderation payloads. A restricted health result immediately moves the connection to `FANVUE_RESTRICTED`, blocking new publication attempts.

The tenth slice adds the private Studio connector panel. Fanvue is an independently selectable integration and its mainstream, media-free panel shows connection and verification states, granted scopes, last sync, explicit capability controls, minimized account health, and the mapped publication queue. OAuth, metadata reconciliation, health refresh, and disconnect are user-invoked actions; disconnect explicitly confirms that local Works and Assets remain intact. The panel distinguishes Eversally hosting, Fanvue publication, subscriber availability, and synchronization rather than implying that any one state changes the others.
