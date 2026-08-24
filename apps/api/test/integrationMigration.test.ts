import {
  attachVerifiedMigrationSource,
  validateMigrationSourceUrl,
  verifyMigrationSource
} from '../src/integrationMigration';

describe('integration migration standard', () => {
  const source = {
    sourceId: 'source-1', platform: 'flickr', externalContentId: 'remote-1', sourceUrl: 'https://images.example.test/original.jpg',
    status: 'discovered' as const, discoveredAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z'
  };

  it('allows only approved public HTTPS source hosts', () => {
    expect(validateMigrationSourceUrl(source.sourceUrl, { approvedHosts: ['example.test'] }).hostname).toBe('images.example.test');
    expect(() => validateMigrationSourceUrl('http://images.example.test/file.jpg', { approvedHosts: ['example.test'] })).toThrow('HTTPS');
    expect(() => validateMigrationSourceUrl('https://127.0.0.1/private', { approvedHosts: ['example.test'] })).toThrow('not allowed');
    expect(() => validateMigrationSourceUrl('https://untrusted.test/file.jpg', { approvedHosts: ['example.test'] })).toThrow('not approved');
  });

  it('requires a verified quarantine source before canonical attachment', () => {
    const verified = verifyMigrationSource(source, Buffer.from('source-bytes'), 'quarantine/source-1', '2026-08-23T01:00:00.000Z');
    expect(verified.status).toBe('verified');
    expect(attachVerifiedMigrationSource(verified, '2026-08-23T02:00:00.000Z')).toMatchObject({ status: 'attached' });
    expect(verifyMigrationSource({ ...source, expectedChecksumSha256: '0'.repeat(64) }, Buffer.from('source-bytes'), 'quarantine/source-1').status).toBe('rejected');
  });
});
