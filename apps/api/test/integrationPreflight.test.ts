import { preflightIntegrationPublication } from '../src/integrationPreflight';

describe('integration publication preflight', () => {
  it('warns when a parent-level carousel disclosure cannot precisely represent mixed assets', () => {
    const result = preflightIntegrationPublication({
      platform: 'instagram',
      mediaTypes: ['carousel'],
      aiDisclosures: ['none', 'ai-generated'],
      itemCount: 2,
      mimeTypes: ['image/jpeg']
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'mixed_ai_carousel', severity: 'warning' })
    ]));
  });

  it('blocks a publication that exceeds documented provider limits', () => {
    const result = preflightIntegrationPublication({
      platform: 'instagram',
      mediaTypes: ['carousel'],
      itemCount: 11,
      caption: 'x'.repeat(2201),
      mimeTypes: ['application/pdf'],
      bytes: 101 * 1024 * 1024
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'maximum_items_exceeded', 'caption_too_long', 'unsupported_mime_type', 'asset_too_large'
    ]));
  });

  it('honours wildcard MIME support and blocks unsupported publishing operations', () => {
    expect(preflightIntegrationPublication({
      platform: 'wordpress', mediaTypes: ['image'], mimeTypes: ['image/webp']
    }).issues.some((issue) => issue.code === 'unsupported_mime_type')).toBe(false);

    const result = preflightIntegrationPublication({ platform: 'youtube', mediaTypes: ['video'] });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'unsupported_operation', 'unsupported_media'
    ]));
  });
});
