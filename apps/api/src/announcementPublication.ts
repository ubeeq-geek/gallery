import { createHash } from 'crypto';
import type { AiDisclosure, AnnouncementPresetId } from './domain';

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
  preset?: AnnouncementPresetId;
  capturedAt: string;
}

export interface BlueskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: 'app.bsky.richtext.facet#link'; uri: string }>;
}

export interface BlueskyPost {
  text: string;
  facets?: BlueskyFacet[];
  embed?: {
    $type: 'app.bsky.embed.external';
    external: { uri: string; title: string; description?: string };
  };
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

const trimCharacters = (value: string, maximum: number): string => Array.from(value).slice(0, maximum).join('');

const publicUrl = (value?: string): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

export const renderBlueskyPost = (content: AnnouncementContentSnapshot): BlueskyPost => {
  const lead = `${content.creatorName ? `${content.creatorName}: ` : ''}${content.title}`;
  const disclosure = aiLabel(content.aiDisclosure);
  const prose = [lead, content.text?.trim(), disclosure ? `[${disclosure}]` : undefined].filter(Boolean).join('\n\n');
  // A URL longer than Bluesky's entire text limit cannot be represented as a
  // valid facet. Keep the announcement useful rather than emit an invalid
  // record that the broker must reject.
  const requestedUrl = publicUrl(content.url);
  const url = requestedUrl && Array.from(requestedUrl).length <= 300 ? requestedUrl : undefined;
  const urlCharacters = url ? Array.from(url).length : 0;
  const separator = prose && url ? '\n\n' : '';
  const prefix = trimCharacters(prose, Math.max(0, 300 - urlCharacters - Array.from(separator).length));
  const text = `${prefix}${prefix && url ? separator : ''}${url || ''}` || trimCharacters(lead, 300);
  const urlStart = url ? Array.from(prefix).length + Array.from(prefix && url ? separator : '').length : -1;
  const facets = url
    ? [{
      index: {
        byteStart: Buffer.byteLength(Array.from(text).slice(0, urlStart).join(''), 'utf8'),
        byteEnd: Buffer.byteLength(Array.from(text).slice(0, urlStart + urlCharacters).join(''), 'utf8')
      },
      features: [{ $type: 'app.bsky.richtext.facet#link' as const, uri: url }]
    }]
    : undefined;
  const description = trimCharacters([content.text?.trim(), disclosure ? `[${disclosure}]` : undefined].filter(Boolean).join('\n\n'), 300);
  const embed = url && content.preset !== 'text_only'
    ? { $type: 'app.bsky.embed.external' as const, external: { uri: url, title: trimCharacters(content.title, 300), description: description || undefined } }
    : undefined;
  return { text: trimCharacters(text, 300), ...(facets ? { facets } : {}), ...(embed ? { embed } : {}) };
};

export const renderAnnouncementPublication = (publication: AnnouncementPublication): {
  text: string;
  embed?: { title: string; description?: string; url?: string; imageUrl?: string };
  blueskyPost?: BlueskyPost;
} => {
  const { content } = publication;
  const disclosure = aiLabel(content.aiDisclosure);
  const suffix = [content.url, disclosure].filter(Boolean).join('\n');
  if (publication.provider === 'bluesky') {
    const blueskyPost = renderBlueskyPost(content);
    return { text: blueskyPost.text, blueskyPost };
  }
  return {
    text: [`New from ${content.creatorName || 'a creator'}: **${content.title}**`, suffix].filter(Boolean).join('\n'),
    embed: { title: content.title, description: [content.text, disclosure].filter(Boolean).join('\n\n') || undefined, url: content.url, imageUrl: content.imageUrl }
  };
};
