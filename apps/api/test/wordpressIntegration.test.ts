import { detectWordPressCapabilities, diffWordPressSnapshots, evaluateWordPressEligibility, renderWordPressContent, signWordPressWebhookEvent, wordPressPostSnapshot } from '../src/wordpressIntegration';
import { InMemoryStore } from '../src/inMemoryStore';

describe('WordPress allowlisted renderer', () => {
  it('escapes canonical text and renders supported semantic blocks', () => {
    expect(renderWordPressContent([
      { blockId: '1', type: 'heading', level: 3, text: 'Safe & sound' },
      { blockId: '2', type: 'paragraph', text: '<script>alert(1)</script>' },
      { blockId: '3', type: 'link', url: 'https://example.com/story', label: 'Read "this"' }
    ])).toBe([
      '<h3>Safe &amp; sound</h3>',
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
      '<p><a href="https://example.com/story" rel="noopener noreferrer">Read &quot;this&quot;</a></p>'
    ].join('\n'));
  });

  it.each(['html_fragment'] as const)('rejects unsafe %s blocks', (type) => {
    expect(() => renderWordPressContent([{ blockId: 'unsafe', type, html: '<script>bad()</script>' }]))
      .toThrow(`Unsupported WordPress block: ${type}`);
  });

  it('rejects non-allowlisted link protocols', () => {
    expect(() => renderWordPressContent([{ blockId: '1', type: 'link', url: 'javascript:alert(1)' }]))
      .toThrow('Only HTTPS and email links are supported');
  });

  it('renders only explicitly approved HTTPS providers as core embeds', () => {
    const block = { blockId: 'embed-1', type: 'embed' as const, url: 'https://video.example/watch/1' };
    expect(renderWordPressContent([block], { approvedEmbedHosts: ['video.example'], format: 'blocks' }))
      .toContain('<!-- wp:embed -->');
    expect(() => renderWordPressContent([block], { approvedEmbedHosts: ['elsewhere.example'] }))
      .toThrow('Untrusted WordPress embed provider');
  });

  it('uses a plain safe link for approved embeds in classic mode', () => {
    const html = renderWordPressContent([{ blockId: 'embed-1', type: 'embed', url: 'https://video.example/watch/1', title: 'Watch' }], { approvedEmbedHosts: ['video.example'], format: 'classic' });
    expect(html).toBe('<p><a href="https://video.example/watch/1" rel="noopener noreferrer">Watch</a></p>');
    expect(html).not.toContain('<iframe');
  });
});

describe('WordPress reconciliation snapshots', () => {
  it('normalizes editable REST fields and ignores volatile response metadata', () => {
    const first = wordPressPostSnapshot({ id: 10, modified_gmt: '2026-01-01', title: { raw: 'Title' }, content: { raw: '<p>Body</p>' }, excerpt: { rendered: 'Intro' }, slug: 'title', status: 'draft', date_gmt: '2026-02-01', categories: [2], tags: [3], featured_media: 9 });
    const second = wordPressPostSnapshot({ id: 10, modified_gmt: '2026-08-23', title: { raw: 'Title' }, content: { raw: '<p>Body</p>' }, excerpt: { rendered: 'Intro' }, slug: 'title', status: 'draft', date_gmt: '2026-02-01', categories: [2], tags: [3], featured_media: 9 });
    expect(diffWordPressSnapshots(first, second)).toEqual([]);
  });

  it('returns field-level local and remote values', () => {
    const local = wordPressPostSnapshot({ title: { raw: 'Local' }, content: { raw: 'Same' }, status: 'draft', categories: [], tags: [] });
    const remote = wordPressPostSnapshot({ title: { raw: 'Remote' }, content: { raw: 'Same' }, status: 'publish', categories: [], tags: [] });
    expect(diffWordPressSnapshots(local, remote)).toEqual([
      { field: 'title', local: 'Local', remote: 'Remote' },
      { field: 'status', local: 'draft', remote: 'publish' }
    ]);
  });
});

describe('WordPress capability detection', () => {
  it('understands the standard REST index endpoint representation', () => {
    const profile = detectWordPressCapabilities({ capabilities: {
      edit_posts: true,
      edit_pages: true,
      upload_files: true,
      publish_posts: true,
      manage_categories: false
    } }, {
      '/wp/v2/posts': { endpoints: [{ methods: ['GET'] }, { methods: ['POST'] }] },
      '/wp/v2/pages': { endpoints: [{ methods: ['GET', 'POST'] }] },
      '/wp/v2/media': { endpoints: [{ methods: ['POST'] }] },
      '/wp/v2/categories': { endpoints: [{ methods: ['POST'] }] },
      '/wp/v2/tags': { endpoints: [{ methods: ['POST'] }] }
    });

    expect(profile).toMatchObject({
      postsRead: true,
      postsWrite: true,
      pagesRead: true,
      pagesWrite: true,
      mediaUpload: true,
      categoriesWrite: false,
      tagsWrite: false,
      schedule: true
    });
  });

  it('does not infer write access from a route without WordPress permission', () => {
    const profile = detectWordPressCapabilities({ capabilities: {} }, {
      '/wp/v2/posts': { methods: ['GET', 'POST'] }
    });
    expect(profile.postsRead).toBe(true);
    expect(profile.postsWrite).toBe(false);
  });
});

describe('WordPress integration persistence', () => {
  it('stores tenant state independently and returns defensive copies', async () => {
    const store = new InMemoryStore();
    const state = { connections: [], publications: [], externalReferences: [], mediaMappings: [], audits: [{ auditId: 'a1', actorId: 'u1', action: 'TEST', connectionId: 'c1', result: 'SUCCESS' as const, correlationId: 'r1', at: '2026-08-23T00:00:00.000Z' }] };
    await store.putWordPressIntegrationState('tenant-a', state);
    const loaded = await store.getWordPressIntegrationState('tenant-a');
    loaded.audits[0].action = 'MUTATED';
    expect((await store.getWordPressIntegrationState('tenant-a')).audits[0].action).toBe('TEST');
    expect((await store.getWordPressIntegrationState('tenant-b')).audits).toEqual([]);
  });
});

describe('WordPress webhook signatures', () => {
  it('binds signatures to the connection and complete event identity', () => {
    const signature = signWordPressWebhookEvent('master', 'connection-1', '2026-08-23T00:00:00.000Z', 'event-1', 'posts', 42, 'updated');
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(signWordPressWebhookEvent('master', 'connection-2', '2026-08-23T00:00:00.000Z', 'event-1', 'posts', 42, 'updated')).not.toBe(signature);
    expect(signWordPressWebhookEvent('master', 'connection-1', '2026-08-23T00:00:00.000Z', 'event-1', 'posts', 42, 'deleted')).not.toBe(signature);
  });
});

describe('WordPress connection eligibility', () => {
  it('requires creator-owned credentials by default and never infers managed status', () => {
    expect(evaluateWordPressEligibility(new URL('https://site.example'))).toEqual({ eligibility: 'CREATOR_OWNED_REQUIRED', reason: 'A creator-owned connector credential is required' });
  });

  it('applies explicit managed, blocked, and safety cohorts in priority order', () => {
    const url = new URL('https://site.example');
    expect(evaluateWordPressEligibility(url, { managedSiteHosts: ['site.example'] }).eligibility).toBe('ALLOWED_MANAGED');
    expect(evaluateWordPressEligibility(url, { managedSiteHosts: ['site.example'], blockedSiteHosts: ['site.example'] }).eligibility).toBe('PLATFORM_INELIGIBLE');
    expect(evaluateWordPressEligibility(url, { blockedSiteHosts: ['site.example'], safetyHoldSiteHosts: ['site.example'] }).eligibility).toBe('SAFETY_HOLD');
  });
});
