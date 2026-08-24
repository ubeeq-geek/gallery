import { assertAnnouncementPublicationImmutable, createAnnouncementPublication, renderAnnouncementPublication } from '../src/announcementPublication';

const content = { version: 1 as const, title: 'New work', text: 'A short description', url: 'https://example.test/work', creatorName: 'Creator', aiDisclosure: 'ai-generated' as const, capturedAt: '2026-08-24T12:00:00Z' };

describe('unified announcement publications', () => {
  it('renders Discord and Bluesky from the same immutable content snapshot', () => {
    const discord = createAnnouncementPublication({ provider: 'discord', connectionId: 'guild-1', targetId: 'channel-1', idempotencyKey: 'release-1:discord', content });
    const bluesky = createAnnouncementPublication({ provider: 'bluesky', connectionId: 'did:plc:test', targetId: 'did:plc:test', idempotencyKey: 'release-1:bluesky', content });
    expect(renderAnnouncementPublication(discord)).toMatchObject({ text: expect.stringContaining('New work'), embed: { title: 'New work' } });
    expect(renderAnnouncementPublication(bluesky)).toEqual({ text: expect.stringContaining('AI-generated') });
  });

  it('rejects edits to queued announcement content', () => {
    const publication = createAnnouncementPublication({ provider: 'discord', connectionId: 'guild-1', targetId: 'channel-1', idempotencyKey: 'release-1', content });
    expect(() => assertAnnouncementPublicationImmutable(publication, { ...publication, content: { ...content, title: 'Changed' } })).toThrow('immutable');
  });
});
