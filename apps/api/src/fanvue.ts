import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type FanvueConnectionMode = 'STUDIO_MANAGED' | 'CREATOR_OWNED';
export type FanvueConnectionState =
  | 'PENDING_OAUTH' | 'CONNECTED' | 'REAUTH_REQUIRED' | 'INSUFFICIENT_SCOPE'
  | 'FANVUE_RESTRICTED' | 'DISCONNECTED' | 'ERROR';
export type FanvuePublicationState =
  | 'DRAFT' | 'UPLOADING' | 'PROCESSING' | 'SCHEDULED' | 'PUBLISHED'
  | 'REMOTE_CHANGED' | 'FLAGGED' | 'FAILED' | 'REMOVED' | 'DISCONNECTED';

export interface FanvueConnection {
  connectionId: string;
  ownerId: string;
  ownerType: 'creator' | 'studio';
  mode: FanvueConnectionMode;
  fanvueUserUuid?: string;
  encryptedCredentialReference?: string;
  scopes: string[];
  capabilities: Array<'read_posts' | 'publish_posts' | 'manage_mapped_posts' | 'account_health'>;
  state: FanvueConnectionState;
  apiVersion: string;
  verificationStatus: 'unknown' | 'verified' | 'restricted';
  verificationAttestedAt?: string;
  lastSyncAt?: string;
  lastWebhookEventAt?: string;
  accountHealth?: {
    status: 'healthy' | 'attention' | 'restricted' | 'unknown';
    moderationFlagCount?: number;
    postingRestricted?: boolean;
    summaryCode?: string;
    checkedAt: string;
  };
  webhookSubscriptions: string[];
  policyVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface FanvueRightsEligibilityInput {
  rightsManifestReference?: string;
  ownershipAttested: boolean;
  everyParticipantAdultAttested: boolean;
  consentAttested: boolean;
  aiGenerated: boolean;
  aiDisclosureConfirmed: boolean;
  realPersonLikenessCleared: boolean;
  activeSafetyHold: boolean;
  platformPolicy: 'ELIGIBLE' | 'CREATOR_OWNED_REQUIRED' | 'PLATFORM_INELIGIBLE';
  connectionMode: FanvueConnectionMode;
  mediaSupported: boolean;
}

export interface FanvueEligibilityResult {
  eligible: boolean;
  reasons: string[];
}

export interface FanvueRightsEligibility {
  eligibilityId: string;
  ownerId: string;
  workId: string;
  assetIds: string[];
  rightsManifestReference: string;
  ownershipAttested: boolean;
  everyParticipantAdultAttested: boolean;
  consentAttested: boolean;
  realPersonLikenessCleared: boolean;
  aiDisclosureConfirmed: boolean;
  platformPolicy: 'ELIGIBLE' | 'CREATOR_OWNED_REQUIRED' | 'PLATFORM_INELIGIBLE';
  reviewerId: string;
  reviewedAt: string;
  expiresAt?: string;
  revokedAt?: string;
  updatedAt: string;
}

/** This gate relies only on creator/reviewer attestations; automated media tags never assert age or consent. */
export const evaluateFanvueEligibility = (input: FanvueRightsEligibilityInput): FanvueEligibilityResult => {
  const reasons: string[] = [];
  if (!input.rightsManifestReference || !input.ownershipAttested) reasons.push('RIGHTS_EVIDENCE_REQUIRED');
  if (!input.everyParticipantAdultAttested) reasons.push('ADULT_ATTESTATION_REQUIRED');
  if (!input.consentAttested) reasons.push('CONSENT_ATTESTATION_REQUIRED');
  if (input.aiGenerated && !input.aiDisclosureConfirmed) reasons.push('AI_DISCLOSURE_REQUIRED');
  if (!input.realPersonLikenessCleared) reasons.push('LIKENESS_CLEARANCE_REQUIRED');
  if (input.activeSafetyHold) reasons.push('ACTIVE_SAFETY_HOLD');
  if (!input.mediaSupported) reasons.push('UNSUPPORTED_MEDIA');
  if (input.platformPolicy === 'PLATFORM_INELIGIBLE') reasons.push('PLATFORM_INELIGIBLE');
  if (input.platformPolicy === 'CREATOR_OWNED_REQUIRED' && input.connectionMode !== 'CREATOR_OWNED') {
    reasons.push('CREATOR_OWNED_CONNECTION_REQUIRED');
  }
  return { eligible: reasons.length === 0, reasons };
};

export interface FanvuePublication {
  publicationId: string;
  connectionId: string;
  workId: string;
  remotePostUuid?: string;
  remoteUrl?: string;
  state: FanvuePublicationState;
  captionSnapshot: string;
  captionHash: string;
  previewHash: string;
  workRevision: number;
  eligibilityId: string;
  scheduleAt?: string;
  access: { type: 'free' | 'subscriber' | 'paid'; priceMinor?: number; currency?: string };
  collectionUuid?: string;
  media: Array<{ assetId: string; derivativeId: string; checksum: string; remoteMediaUuid?: string; state: string }>;
  idempotencyKeys: string[];
  activeIdempotencyKey?: string;
  activeMutation?: 'publish' | 'unpublish' | 'delete';
  createdAt: string;
  updatedAt: string;
  unpublishedAt?: string;
  deletedAt?: string;
  lastRemoteEventAt?: string;
}

export interface FanvueAuditEvent {
  auditEventId: string;
  actorId: string;
  action: string;
  connectionId: string;
  publicationId?: string;
  beforeHash?: string;
  afterHash?: string;
  result: 'SUCCESS' | 'FAILURE';
  errorCode?: string;
  correlationId: string;
  createdAt: string;
}

export interface FanvueExternalReferenceWork {
  externalReferenceId: string;
  connectionId: string;
  ownerId: string;
  sourcePlatform: 'fanvue';
  remotePostUuid: string;
  canonicalUrl?: string;
  title?: string;
  caption?: string;
  publicationState?: string;
  accessSummary?: string;
  publishedAt?: string;
  scheduledAt?: string;
  collectionUuid?: string;
  /** Remote identifiers and preview-safe metadata only; never media bytes or signed URLs. */
  remoteMedia: Array<{ mediaUuid: string; mediaType?: string; processingState?: string; previewUrl?: string }>;
  remoteVersion?: string;
  metadataHash: string;
  mappedWorkId?: string;
  match?: 'creator-confirmed';
  syncStatus: 'IN_SYNC' | 'REMOTE_CHANGED' | 'REMOTE_REMOVED';
  importedAt: string;
  updatedAt: string;
}

export const hashFanvueSnapshot = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const createFanvuePkce = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

export interface FanvueWebhookEnvelope {
  eventId: string;
  eventType: string;
  occurredAt: string;
  connectionId: string;
  payload: Record<string, unknown>;
}

export class FanvueWebhookVerifier {
  private readonly seen = new Map<string, number>();

  constructor(private readonly secret: string, private readonly toleranceMs = 5 * 60_000) {}

  verify(rawBody: Buffer, signatureHeader: string | undefined, timestampHeader: string | undefined, now = Date.now()): void {
    if (!signatureHeader || !timestampHeader) throw new Error('WEBHOOK_SIGNATURE_REQUIRED');
    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp) || Math.abs(now - timestamp * 1000) > this.toleranceMs) throw new Error('WEBHOOK_REPLAY_WINDOW');
    const suppliedHex = signatureHeader.replace(/^sha256=/i, '');
    if (!/^[a-f\d]{64}$/i.test(suppliedHex)) throw new Error('WEBHOOK_SIGNATURE_INVALID');
    const expected = createHmac('sha256', this.secret).update(`${timestampHeader}.`).update(rawBody).digest();
    const supplied = Buffer.from(suppliedHex, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('WEBHOOK_SIGNATURE_INVALID');
  }

  accept(eventId: string, now = Date.now()): boolean {
    for (const [id, expiry] of this.seen) if (expiry <= now) this.seen.delete(id);
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, now + this.toleranceMs * 2);
    return true;
  }
}

export interface FanvueHttpResponse<T> { ok: boolean; status: number; headers: Headers; json(): Promise<T> }
export type FanvueFetch = (url: string, init?: RequestInit) => Promise<FanvueHttpResponse<unknown>>;

export class FanvueClient {
  constructor(
    private readonly accessToken: string,
    private readonly apiVersion: string,
    private readonly fetcher: FanvueFetch = fetch as FanvueFetch,
    private readonly baseUrl = 'https://api.fanvue.com'
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, idempotencyKey?: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'fanvue-api-version': this.apiVersion,
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        ...(init.headers || {})
      }
    });
    const body = response.status === 204 ? {} : await response.json() as { message?: string };
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw Object.assign(new Error(body.message || `Fanvue request failed (${response.status})`), {
        code: response.status === 401 ? 'REAUTH_REQUIRED' : response.status === 403 ? 'POLICY_OR_PERMISSION_REJECTION' : 'FANVUE_API_ERROR',
        retryable,
        retryAfter: response.headers.get('retry-after')
      });
    }
    return body as T;
  }

  async createMultipartUpload(input: { filename: string; contentType: string; byteSize: number; checksum: string }) {
    return this.request<{ uploadId: string; mediaUuid: string; partSize?: number; parts: Array<{ partNumber: number; url: string }> }>(
      '/media/multipart', { method: 'POST', body: JSON.stringify(input) }, randomUUID()
    );
  }

  async uploadPart(url: string, body: Buffer): Promise<string> {
    const response = await this.fetcher(url, { method: 'PUT', body: body as unknown as BodyInit, headers: { 'content-length': String(body.byteLength) } });
    if (!response.ok) throw Object.assign(new Error(`Fanvue multipart transfer failed (${response.status})`), { code: 'UPLOAD_FAILED', retryable: response.status >= 500 });
    return response.headers.get('etag') || '';
  }

  async completeMultipartUpload(uploadId: string, parts: Array<{ partNumber: number; etag: string }>) {
    return this.request<{ mediaUuid: string; state: string }>(
      `/media/multipart/${encodeURIComponent(uploadId)}/complete`, { method: 'POST', body: JSON.stringify({ parts }) }, randomUUID()
    );
  }

  async getMedia(mediaUuid: string) {
    return this.request<{ mediaUuid: string; state: 'processing' | 'finalized' | 'failed'; moderation?: string }>(`/media/${encodeURIComponent(mediaUuid)}`);
  }

  async listPosts(cursor?: string) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request<{
      items: Array<{
        uuid: string; url?: string; title?: string; text?: string; state?: string;
        access?: { type?: string }; publishedAt?: string; scheduledAt?: string; collectionUuid?: string;
        updatedAt?: string; media?: Array<{ uuid: string; type?: string; state?: string; previewUrl?: string }>;
      }>;
      nextCursor?: string;
    }>(`/posts${query}`);
  }

  async getAccountHealth() {
    return this.request<{ status?: string; moderationFlagCount?: number; postingRestricted?: boolean; summaryCode?: string }>('/creator/account-health');
  }

  async mutatePost(input: Record<string, unknown>, idempotencyKey: string, remotePostUuid?: string) {
    const path = remotePostUuid ? `/posts/${encodeURIComponent(remotePostUuid)}` : '/posts';
    return this.request<{ uuid: string; url?: string; state: string }>(path, {
      method: remotePostUuid ? 'PATCH' : 'POST', body: JSON.stringify(input)
    }, idempotencyKey);
  }

  async unpublishPost(remotePostUuid: string, idempotencyKey: string) {
    return this.request<{ uuid?: string; state?: string }>(`/posts/${encodeURIComponent(remotePostUuid)}/unpublish`, {
      method: 'POST', body: JSON.stringify({})
    }, idempotencyKey);
  }

  async deletePost(remotePostUuid: string, idempotencyKey: string) {
    return this.request<Record<string, never>>(`/posts/${encodeURIComponent(remotePostUuid)}`, { method: 'DELETE' }, idempotencyKey);
  }
}

export const newFanvuePublication = (input: Omit<FanvuePublication, 'publicationId' | 'state' | 'captionHash' | 'previewHash' | 'idempotencyKeys' | 'createdAt' | 'updatedAt'> & { preview: unknown }): FanvuePublication => {
  const now = new Date().toISOString();
  const { preview, ...publication } = input;
  return {
    ...publication,
    publicationId: randomUUID(),
    state: 'DRAFT',
    captionHash: hashFanvueSnapshot(input.captionSnapshot),
    previewHash: hashFanvueSnapshot(preview),
    idempotencyKeys: [],
    createdAt: now,
    updatedAt: now
  };
};
