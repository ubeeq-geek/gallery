import { createHmac } from 'crypto';
import { sendBlueskyAnnouncement } from '../src/blueskyAnnouncement';
import type { AppConfig } from '../src/config';

describe('Bluesky announcement broker client', () => {
  it('signs an idempotent broker request without exposing OAuth credentials', async () => {
    const request = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ uri: 'at://did:plc:test/app.bsky.feed.post/rkey', cid: 'cid-1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const config = { blueskyOAuthServiceUrl: 'https://oauth.example.test', blueskyOAuthInternalSecret: 'internal-secret' } as AppConfig;
    await expect(sendBlueskyAnnouncement(config, 'did:plc:test', 'Announcement', 'attempt-1', '2026-08-24T12:00:00.000Z')).resolves.toEqual({ uri: 'at://did:plc:test/app.bsky.feed.post/rkey', cid: 'cid-1' });
    const [, init] = request.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const body = String(init.body);
    expect(init.headers).toMatchObject({ 'x-ubeeq-signature-256': `sha256=${createHmac('sha256', 'internal-secret').update(body).digest('hex')}` });
    expect(JSON.parse(body)).toMatchObject({ idempotencyKey: 'attempt-1', createdAt: '2026-08-24T12:00:00.000Z' });
    expect(body).not.toContain('internal-secret');
    request.mockRestore();
  });
});
