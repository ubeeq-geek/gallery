import { announcementIdempotencyKey, announcementPresetOptions, createAnnouncementPublication } from '../src/announcementPublication';

describe('announcement publications', () => {
  it('defines reusable presentation presets independently of canonical publication', () => {
    expect(announcementPresetOptions.map((item) => item.id)).toEqual(expect.arrayContaining([
      'single_work', 'gallery', 'collection', 'story_chapter', 'video', 'album', 'bulk_publish'
    ]));
  });

  it('creates an idempotent, provider-specific audience announcement', () => {
    const idempotencyKey = announcementIdempotencyKey('bluesky', 'creator', 'single_work', ['work-1']);
    const announcement = createAnnouncementPublication({ tenantId: 'tenant', creatorIdentityId: 'creator', provider: 'bluesky', preset: 'single_work', subject: { type: 'work', ids: ['work-1'] }, idempotencyKey, now: '2026-08-24T00:00:00.000Z' });
    expect(announcement).toMatchObject({ provider: 'bluesky', status: 'queued', idempotencyKey, subject: { type: 'work' } });
  });
});
