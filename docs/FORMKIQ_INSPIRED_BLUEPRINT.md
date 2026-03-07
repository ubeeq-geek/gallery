# FormKiQ-Inspired Blueprint for Gallery Platform

This blueprint keeps your core constraints:
- AWS-first
- DynamoDB for metadata/state
- S3 for media objects
- Cognito for identity/social login

It borrows proven patterns from FormKiQ-style serverless document systems:
- Event-driven processing
- Strong metadata indexing discipline
- Private object storage + signed access
- Clear service boundaries

## 1) Target Architecture

- **Web App** (`apps/web`): customer browsing, premium unlock, comments, favorites.
- **Admin App** (`apps/admin`): artist/gallery/media CRUD, moderation, user blocking.
- **API Service** (`apps/api`): authz, gallery logic, signed URLs, moderation APIs.
- **Ingestion Service** (new Lambda): validates uploads and writes canonical media metadata.
- **Workflow/Event Service** (new Lambda + EventBridge): reacts to media/comment/favorite events.
- **Optional Search Service** (future OpenSearch): discovery and filtering at scale.

## 2) DynamoDB Data Model (Single-Table Recommended)

Use one table (`GalleryCore`) for strong consistency of domain events and simpler evolution.

Primary keys:
- `PK`, `SK`

Suggested entity shapes:
- Artist
  - `PK=ARTIST#{artistId}`
  - `SK=PROFILE`
  - attrs: `slug`, `name`, `status`, `sortOrder`
- Gallery
  - `PK=GALLERY#{galleryId}`
  - `SK=PROFILE`
  - attrs: `artistId`, `artistSlug`, `slug`, `visibility`, `status`, `premiumPasswordHash`
- Media item (image/video)
  - `PK=GALLERY#{galleryId}`
  - `SK=MEDIA#{sortOrder}#{mediaId}`
  - attrs: `assetType`, `previewKey`, `premiumKey`, `previewPosterKey`, `premiumPosterKey`, `width`, `height`, `durationSeconds`
- Comment
  - `PK=TARGET#{targetType}#{targetId}`
  - `SK=COMMENT#{createdAt}#{commentId}`
  - attrs: `userId`, `displayName`, `body`, `hidden`
- Favorite (private per-user)
  - `PK=USER#{userId}`
  - `SK=FAV#{targetType}#{targetId}`
  - attrs: `createdAt`
- Favorite counter projection
  - `PK=TARGET#{targetType}#{targetId}`
  - `SK=STATS`
  - attrs: `favoriteCount`
- Blocked user
  - `PK=USER#{userId}`
  - `SK=BLOCK`
  - attrs: `reason`, `blockedAt`
- Unlock session (optional persisted)
  - `PK=GALLERY#{galleryId}`
  - `SK=UNLOCK#{sessionId}`
  - attrs: `userId?`, `expiresAt` (TTL)

GSIs:
- `GSI1PK`, `GSI1SK` for slug lookups:
  - Artist slug lookup: `GSI1PK=ARTIST_SLUG#{slug}`
  - Gallery slug lookup: `GSI1PK=GALLERY_SLUG#{slug}`
- `GSI2PK`, `GSI2SK` for artist-to-galleries listing:
  - `GSI2PK=ARTIST#{artistId}`
  - `GSI2SK=GALLERY#{status}#{sortOrder}`

## 3) S3 Object Strategy

Private bucket, no public ACLs.

Object key naming:
- Preview images: `artists/{artistSlug}/galleries/{gallerySlug}/preview/images/{mediaId}.{ext}`
- Premium images: `artists/{artistSlug}/galleries/{gallerySlug}/premium/images/{mediaId}.{ext}`
- Preview videos: `artists/{artistSlug}/galleries/{gallerySlug}/preview/videos/{mediaId}.{ext}`
- Premium videos: `artists/{artistSlug}/galleries/{gallerySlug}/premium/videos/{mediaId}.{ext}`
- Video posters: same path with `/posters/`

Rules:
- API only returns short-lived signed URLs.
- Separate prefixes for preview and premium to simplify IAM controls/auditing.
- Optional object tags: `assetType`, `galleryId`, `visibility`.

## 4) Event-Driven Workflows (FormKiQ-inspired)

Emit domain events from API writes to EventBridge:
- `gallery.media.created`
- `gallery.comment.created`
- `gallery.comment.hidden`
- `gallery.favorite.added`
- `gallery.favorite.removed`
- `gallery.user.blocked`

Consumers:
- **Counter projector**: updates favorite counts and comment counts.
- **Moderation notifier**: sends admin notifications for abuse signals.
- **Media validator**: verifies S3 object presence and metadata sanity.
- **Audit writer**: immutable security/audit stream.

## 5) Security and Auth Model

- Cognito (User Pool + social IdPs) for user identity.
- API role split:
  - `user` for comments/favorites.
  - `admin` group for moderation and content management.
- Premium access remains per-gallery password in MVP.
- Unlock token scoped to gallery and short TTL.
- Rate limiting:
  - Unlock attempts per IP/gallery.
  - Comment posting per user/IP.

## 6) Migration Path from Current Repo

Phase 1 (now):
- Keep current apps/APIs.
- Add event publishing and counter projection without API contract breakage.

Phase 2:
- Consolidate multi-table model into `GalleryCore` single-table.
- Replace ad hoc queries with key-conditioned patterns.

Phase 3:
- Add ingestion pipeline for media metadata normalization.
- Add optional OpenSearch projection for advanced discovery.

## 7) Immediate Implementation Backlog

1. Add `GalleryCore` table and GSIs in CDK next to current tables.
2. Add repository layer in API with single-table access patterns.
3. Add EventBridge bus and publish events on comment/favorite/media writes.
4. Add Lambda projector for favorite counters.
5. Add admin role enforcement via Cognito groups (not just authenticated).
6. Add seed tool for artists/galleries/image+video metadata and sample users.

