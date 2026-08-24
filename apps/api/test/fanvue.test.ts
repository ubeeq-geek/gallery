import { createHmac } from 'node:crypto';
import { FanvueClient, FanvueWebhookVerifier, createFanvuePkce, evaluateFanvueEligibility } from '../src/fanvue';
import { minimizeFanvueWebhook } from '../src/fanvueRepository';

describe('Fanvue integration security and policy foundation', () => {
  test('eligibility gate reports every blocking reason and requires creator-owned mode when policy requires it', () => {
    expect(evaluateFanvueEligibility({
      ownershipAttested: false,
      everyParticipantAdultAttested: false,
      consentAttested: false,
      aiGenerated: true,
      aiDisclosureConfirmed: false,
      realPersonLikenessCleared: false,
      activeSafetyHold: true,
      platformPolicy: 'CREATOR_OWNED_REQUIRED',
      connectionMode: 'STUDIO_MANAGED',
      mediaSupported: false
    })).toEqual({ eligible: false, reasons: [
      'RIGHTS_EVIDENCE_REQUIRED', 'ADULT_ATTESTATION_REQUIRED', 'CONSENT_ATTESTATION_REQUIRED',
      'AI_DISCLOSURE_REQUIRED', 'LIKENESS_CLEARANCE_REQUIRED', 'ACTIVE_SAFETY_HOLD',
      'UNSUPPORTED_MEDIA', 'CREATOR_OWNED_CONNECTION_REQUIRED'
    ] });
  });

  test('allows a completely attested eligible work', () => {
    expect(evaluateFanvueEligibility({
      rightsManifestReference: 'manifest:sha256:abc', ownershipAttested: true,
      everyParticipantAdultAttested: true, consentAttested: true, aiGenerated: false,
      aiDisclosureConfirmed: false, realPersonLikenessCleared: true, activeSafetyHold: false,
      platformPolicy: 'ELIGIBLE', connectionMode: 'STUDIO_MANAGED', mediaSupported: true
    })).toEqual({ eligible: true, reasons: [] });
  });

  test('creates S256 PKCE material', () => {
    const pkce = createFanvuePkce();
    expect(pkce.verifier.length).toBeGreaterThan(42);
    expect(pkce.challenge).toMatch(/^[\w-]+$/);
    expect(pkce.verifier).not.toBe(pkce.challenge);
  });

  test('verifies signatures and safely deduplicates webhook deliveries', () => {
    const body = Buffer.from('{"eventId":"evt-1"}');
    const timestamp = '1770000000';
    const signature = createHmac('sha256', 'secret').update(`${timestamp}.`).update(body).digest('hex');
    const verifier = new FanvueWebhookVerifier('secret');
    verifier.verify(body, `sha256=${signature}`, timestamp, 1770000000 * 1000);
    expect(verifier.accept('evt-1')).toBe(true);
    expect(verifier.accept('evt-1')).toBe(false);
    expect(() => verifier.verify(body, signature, timestamp, 1770001000 * 1000)).toThrow('WEBHOOK_REPLAY_WINDOW');
  });

  test('uses API version and caller-owned idempotency key for post mutations', async () => {
    const fetcher = jest.fn(async (_url: string, init?: RequestInit) => ({
      ok: true, status: 200, headers: new Headers(), json: async () => ({ uuid: 'post-1', state: 'published' })
    }));
    const client = new FanvueClient('token', '2026-08-01', fetcher);
    await client.mutatePost({ text: 'hello' }, 'attempt-1');
    expect(fetcher).toHaveBeenCalledWith('https://api.fanvue.com/posts', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({
        authorization: 'Bearer token', 'fanvue-api-version': '2026-08-01', 'idempotency-key': 'attempt-1'
      })
    }));
  });

  test('does not retry policy or permission rejection', async () => {
    const fetcher = jest.fn(async () => ({
      ok: false, status: 403, headers: new Headers(), json: async () => ({ message: 'restricted' })
    }));
    const client = new FanvueClient('token', 'v1', fetcher);
    await expect(client.mutatePost({}, 'attempt-1')).rejects.toMatchObject({
      code: 'POLICY_OR_PERMISSION_REJECTION', retryable: false
    });
  });

  test('minimizes persisted webhook payloads and excludes personal data', () => {
    const event = minimizeFanvueWebhook({
      eventId: 'evt-1', eventType: 'creator.post.updated', occurredAt: '2026-08-23T00:00:00Z',
      connectionId: 'connection-1',
      payload: { postUuid: 'post-1', subscriberEmail: 'never-store@example.com', message: 'private' }
    });
    expect(event.subjectIds).toEqual({ postUuid: 'post-1' });
    expect(JSON.stringify(event)).not.toContain('never-store');
    expect(JSON.stringify(event)).not.toContain('private');
  });
});
