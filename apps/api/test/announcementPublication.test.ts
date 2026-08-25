import { assertAnnouncementPublicationImmutable, createAnnouncementPublication, renderAnnouncementPublication } from '../src/announcementPublication';

const content = { version: 1 as const, title: 'New work', text: 'A short description', url: 'https://example.test/work', creatorName: 'Creator', aiDisclosure: 'ai-generated' as const, capturedAt: '2026-08-24T12:00:00Z' };

describe('unified announcement publications', () => {
  it('renders Discord and Bluesky from the same immutable content snapshot', () => {
    const discord = createAnnouncementPublication({ provider: 'discord', connectionId: 'guild-1', targetId: 'channel-1', idempotencyKey: 'release-1:discord', content });
    const bluesky = createAnnouncementPublication({ provider: 'bluesky', connectionId: 'did:plc:test', targetId: 'did:plc:test', idempotencyKey: 'release-1:bluesky', content });
    expect(renderAnnouncementPublication(discord)).toMatchObject({ text: expect.stringContaining('New work'), embed: { title: 'New work' } });
    const renderedBluesky = renderAnnouncementPublication(bluesky);
    expect(renderedBluesky.text).toContain('AI-generated');
    expect(renderedBluesky.blueskyPost).toMatchObject({
      text: expect.stringContaining('https://example.test/work'),
      facets: [{
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.test/work' }]
      }],
      embed: {
        $type: 'app.bsky.embed.external',
        external: { uri: 'https://example.test/work', title: 'New work' }
      }
    });
  });

  it('keeps Bluesky posts inside the 300-character record limit', () => {
    const bluesky = createAnnouncementPublication({
      provider: 'bluesky',
      connectionId: 'did:plc:test',
      targetId: 'did:plc:test',
      idempotencyKey: 'release-long:bluesky',
      content: { ...content, text: 'Long announcement. '.repeat(80) }
    });
    const rendered = renderAnnouncementPublication(bluesky).blueskyPost;
    expect(Array.from(rendered?.text || '')).toHaveLength(300);
  });

  it('rejects edits to queued announcement content', () => {
    const publication = createAnnouncementPublication({ provider: 'discord', connectionId: 'guild-1', targetId: 'channel-1', idempotencyKey: 'release-1', content });
    expect(() => assertAnnouncementPublicationImmutable(publication, { ...publication, content: { ...content, title: 'Changed' } })).toThrow('immutable');
  });
});
