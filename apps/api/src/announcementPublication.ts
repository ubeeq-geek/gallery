import { createHash } from 'crypto';
import type { AiDisclosure } from './domain';

export type AnnouncementProvider = 'discord' | 'bluesky';
export type AnnouncementPublicationStatus = 'queued' | 'sending' | 'sent' | 'retry_scheduled' | 'failed' | 'cancelled';

export interface AnnouncementContentSnapshot {
  version: 1;
  title: string;
  text?: string;
  url?: string;
  creatorName?: string;
  imageUrl?: string;
  aiDisclosure?: AiDisclosure;
  capturedAt: string;
}

/**
 * A Discord message and a Bluesky post are two renderings of this same
 * announcement publication. The content snapshot and idempotency key are
 * immutable after the publication is queued.
 */
export interface AnnouncementPublication {
  announcementPublicationId: string;
  provider: AnnouncementProvider;
  connectionId: string;
  targetId: string;
  workId?: string;
  idempotencyKey: string;
  content: AnnouncementContentSnapshot;
  status: AnnouncementPublicationStatus;
  remoteId?: string;
  remoteUri?: string;
}

const stableFingerprint = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort()))
  .digest('hex');

export const createAnnouncementPublication = (input: Omit<AnnouncementPublication, 'announcementPublicationId' | 'status'>): AnnouncementPublication => {
  if (!input.idempotencyKey.trim()) throw new Error('An announcement publication requires an idempotency key.');
  return {
    ...input,
    announcementPublicationId: stableFingerprint([input.provider, input.connectionId, input.targetId, input.idempotencyKey]),
    status: 'queued'
  };
};

export const assertAnnouncementPublicationImmutable = (previous: AnnouncementPublication, next: AnnouncementPublication): void => {
  if (previous.announcementPublicationId !== next.announcementPublicationId
    || previous.idempotencyKey !== next.idempotencyKey
    || JSON.stringify(previous.content) !== JSON.stringify(next.content)) {
    throw new Error('Queued announcement publication content is immutable.');
  }
};

const aiLabel = (value?: AiDisclosure): string => value === 'ai-generated'
  ? 'AI-generated'
  : value === 'ai-assisted'
    ? 'AI-assisted'
    : '';

export const renderAnnouncementPublication = (publication: AnnouncementPublication): {
  text: string;
  embed?: { title: string; description?: string; url?: string; imageUrl?: string };
} => {
  const { content } = publication;
  const disclosure = aiLabel(content.aiDisclosure);
  const suffix = [content.url, disclosure].filter(Boolean).join('\n');
  if (publication.provider === 'bluesky') {
    const lead = `${content.creatorName ? `${content.creatorName}: ` : ''}${content.title}`;
    return { text: [lead, content.text, suffix].filter(Boolean).join('\n\n').slice(0, 300) };
  }
  return {
    text: [`New from ${content.creatorName || 'a creator'}: **${content.title}**`, suffix].filter(Boolean).join('\n'),
    embed: { title: content.title, description: [content.text, disclosure].filter(Boolean).join('\n\n') || undefined, url: content.url, imageUrl: content.imageUrl }
  };
};
