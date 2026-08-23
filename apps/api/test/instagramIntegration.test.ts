import { evaluateInstagramEligibility, instagramIdempotencyKey, instagramPublishingLimitAvailable, issueInstagramDeliveryCapability, validateInstagramMedia, verifyInstagramDeliveryCapability, verifyInstagramWebhookSignature, type InstagramConnection } from '../src/instagramIntegration';
import { INSTAGRAM_PILOT_MEDIA_CONSTRAINTS } from '../src/instagramConfiguration';
import { createHmac } from 'crypto';

const connection: InstagramConnection = {
  connectionId: 'ig-1', ownerUserId: 'user-1', creatorId: 'creator-1', mode: 'EversallyManagedApp',
  remoteProfessionalAccountId: '1789', accountType: 'CREATOR', encryptedCredentialReference: 'secret:ig-1',
  scopes: ['instagram_basic', 'instagram_content_publish'], apiVersion: 'v24.0', policyProfileVersion: '2026-08-23.1', state: 'CONNECTED',
  capabilities: { accountRead: true, mediaRead: true, imagePublish: true, carouselPublish: true, reelPublish: false, storyPublish: false, mediaUpdate: false, mediaDeleteOrArchive: false, insightsRead: false, commentsRead: false, commentsReply: false }
};
const input = { connection, placement: 'IMAGE' as const, media: [{ derivativeId: 'preview-1', contentType: 'image/jpeg', byteSize: 10, width: 1080, height: 1080 }], caption: 'Preview', contentRating: 'general' as const, rightsAttested: true, creatorAttested: true };

describe('Instagram integration guardrails', () => {
  it('allows an explicitly approved public-safe preview', () => expect(evaluateInstagramEligibility(input).result).toBe('ALLOWED_MANAGED'));
  it('denies Nightframe and mature works independently of provider capability', () => {
    expect(evaluateInstagramEligibility({ ...input, nightframeAdult: true }).reasonCode).toBe('PUBLIC_SAFE_PROFILE_DENIED');
    expect(evaluateInstagramEligibility({ ...input, contentRating: 'mature' }).result).toBe('DESTINATION_POLICY_DENIED');
  });
  it('rejects unsupported placements before creating a container', () => expect(evaluateInstagramEligibility({ ...input, placement: 'REEL' }).reasonCode).toBe('PLACEMENT_UNSUPPORTED'));
  it('generates stable intent-version idempotency keys', () => {
    expect(instagramIdempotencyKey('work', 'account', 'IMAGE', 1, 'secret')).toBe(instagramIdempotencyKey('work', 'account', 'IMAGE', 1, 'secret'));
    expect(instagramIdempotencyKey('work', 'account', 'IMAGE', 2, 'secret')).not.toBe(instagramIdempotencyKey('work', 'account', 'IMAGE', 1, 'secret'));
  });
  it('verifies webhook signatures over the untouched body', () => {
    const body = Buffer.from('{"object":"instagram"}');
    const signature = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    expect(verifyInstagramWebhookSignature(body, signature, 'app-secret')).toBe(true);
    expect(verifyInstagramWebhookSignature(Buffer.from('changed'), signature, 'app-secret')).toBe(false);
  });
  it('binds temporary media delivery to one publication and a short expiry', () => {
    const capability = issueInstagramDeliveryCapability('derivative-1', 'publication-1', 0, 'delivery-secret', 60, 1_000);
    expect(capability.pathToken).not.toContain('derivative-1');
    expect(verifyInstagramDeliveryCapability(capability.pathToken, 'publication-1', 0, 'delivery-secret', 1_001)).toBe(true);
    expect(verifyInstagramDeliveryCapability(capability.pathToken, 'publication-1', 1, 'delivery-secret', 1_001)).toBe(false);
    expect(verifyInstagramDeliveryCapability(capability.pathToken, 'publication-2', 0, 'delivery-secret', 1_001)).toBe(false);
    expect(verifyInstagramDeliveryCapability(capability.pathToken, 'publication-1', 0, 'delivery-secret', 61_000)).toBe(false);
  });
  it('returns field-level validation before any provider container is created', () => {
    const issues = validateInstagramMedia({ ...input, placement: 'CAROUSEL', caption: 'x'.repeat(2201), media: [{ ...input.media[0], contentType: 'image/png', width: 100, height: 1000 }] }, INSTAGRAM_PILOT_MEDIA_CONSTRAINTS);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'media', code: 'CAROUSEL_COUNT_INVALID' }),
      expect.objectContaining({ field: 'caption', code: 'CAPTION_TOO_LONG' }),
      expect.objectContaining({ field: 'media.0', code: 'MEDIA_TYPE_UNSUPPORTED' }),
      expect.objectContaining({ field: 'media.0', code: 'ASPECT_RATIO_UNSUPPORTED' })
    ]));
  });
  it('derives availability from the documented provider response rather than a local quota', () => {
    expect(instagramPublishingLimitAvailable({ data: [{ quota_usage: 24, config: { quota_total: 25 } }] })).toBe(true);
    expect(instagramPublishingLimitAvailable({ data: [{ quota_usage: 25, config: { quota_total: 25 } }] })).toBe(false);
    expect(instagramPublishingLimitAvailable({})).toBeUndefined();
  });
  it('validates gated video placements against adapter duration and type constraints', () => {
    const reel = validateInstagramMedia({ ...input, placement: 'REEL', media: [{ ...input.media[0], contentType: 'video/mp4', durationSeconds: 901 }] }, INSTAGRAM_PILOT_MEDIA_CONSTRAINTS);
    expect(reel).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DURATION_UNSUPPORTED' })]));
    const validStory = validateInstagramMedia({ ...input, placement: 'STORY', media: [{ ...input.media[0], contentType: 'video/mp4', durationSeconds: 60 }] }, INSTAGRAM_PILOT_MEDIA_CONSTRAINTS);
    expect(validStory).toEqual([]);
  });
});
