import { requiredScopesForIntegrationOperation } from '../src/integrationScopes';

describe('integration operation scopes', () => {
  it('declares the provider permission required for implemented YouTube reads', () => {
    expect(requiredScopesForIntegrationOperation('youtube', 'import')).toEqual([
      'https://www.googleapis.com/auth/youtube.readonly'
    ]);
    expect(requiredScopesForIntegrationOperation('youtube', 'publish')).toEqual([]);
  });
});
