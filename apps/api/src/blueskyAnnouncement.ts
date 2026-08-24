import { createHmac } from 'crypto';
import type { AppConfig } from './config';

export class BlueskyAnnouncementError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterSeconds?: number) { super(message); }
}

export const blueskyAnnouncementConfigured = (config: AppConfig): boolean => Boolean(
  config.blueskyOAuthServiceUrl && config.blueskyOAuthInternalSecret
);

export const sendBlueskyAnnouncement = async (
  config: AppConfig,
  did: string,
  text: string,
  idempotencyKey: string,
  createdAt: string
): Promise<{ uri: string; cid?: string }> => {
  if (!blueskyAnnouncementConfigured(config)) throw new Error('Bluesky announcement publishing is not configured');
  const body = JSON.stringify({ did, text: text.slice(0, 300), idempotencyKey, createdAt });
  const signature = createHmac('sha256', config.blueskyOAuthInternalSecret!).update(body).digest('hex');
  const response = await fetch(`${config.blueskyOAuthServiceUrl!.replace(/\/$/, '')}/oauth/bluesky/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ubeeq-signature-256': `sha256=${signature}` },
    body
  });
  const payload = await response.json().catch(() => ({})) as { uri?: string; cid?: string; message?: string };
  if (!response.ok || !payload.uri) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new BlueskyAnnouncementError(response.status, payload.message || `Bluesky broker request failed (${response.status})`, Number.isFinite(retryAfter) ? retryAfter : undefined);
  }
  return { uri: payload.uri, cid: payload.cid };
};
