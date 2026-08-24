import { randomUUID } from 'crypto';
import type { AnnouncementPresetId, AnnouncementPublication, CommunityProvider } from './domain';

export const announcementPresetOptions: Array<{ id: AnnouncementPresetId; label: string; subjectTypes: string[] }> = [
  { id: 'single_work', label: 'Single work', subjectTypes: ['work'] },
  { id: 'gallery', label: 'Gallery', subjectTypes: ['gallery'] },
  { id: 'collection', label: 'Collection', subjectTypes: ['collection'] },
  { id: 'story_chapter', label: 'Story or chapter', subjectTypes: ['story_chapter'] },
  { id: 'video', label: 'Video', subjectTypes: ['video'] },
  { id: 'album', label: 'Album', subjectTypes: ['album'] },
  { id: 'bulk_publish', label: 'Bulk publish', subjectTypes: ['bulk_publish'] },
  { id: 'recommended', label: 'Recommended', subjectTypes: ['all'] },
  { id: 'image_showcase', label: 'Image showcase', subjectTypes: ['work', 'gallery'] },
  { id: 'writing_release', label: 'Writing release', subjectTypes: ['story_chapter'] },
  { id: 'video_premiere', label: 'Video premiere', subjectTypes: ['video'] },
  { id: 'audio_release', label: 'Audio release', subjectTypes: ['album'] },
  { id: 'compact_link', label: 'Compact link', subjectTypes: ['all'] },
  { id: 'text_only', label: 'Text only', subjectTypes: ['all'] },
  { id: 'collection_digest', label: 'Collection digest', subjectTypes: ['gallery', 'collection'] },
  { id: 'series_digest', label: 'Series digest', subjectTypes: ['story_chapter', 'album'] }
];

const presetIds = new Set(announcementPresetOptions.map((preset) => preset.id));
export const isAnnouncementPreset = (value: unknown): value is AnnouncementPresetId => typeof value === 'string' && presetIds.has(value as AnnouncementPresetId);

export const createAnnouncementPublication = (input: Omit<AnnouncementPublication, 'announcementPublicationId' | 'status' | 'attemptCount' | 'createdAt' | 'updatedAt'> & { status?: AnnouncementPublication['status']; now?: string }): AnnouncementPublication => {
  const now = input.now || new Date().toISOString();
  return { ...input, announcementPublicationId: randomUUID(), status: input.status || 'queued', attemptCount: 0, createdAt: now, updatedAt: now };
};

/** Both Discord and Bluesky announcement adapters use this shape, never Publication. */
export const announcementIdempotencyKey = (provider: CommunityProvider, creatorIdentityId: string, preset: AnnouncementPresetId, subjectIds: string[]): string =>
  `announcement:${provider}:${creatorIdentityId}:${preset}:${[...subjectIds].sort().join(':')}`;
