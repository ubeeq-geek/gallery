import { issueInstagramOAuthState, verifyInstagramOAuthState } from '../src/externalOAuth';
import type { AppConfig } from '../src/config';

const config = { externalTokenEncryptionKey: 'state-secret', unlockJwtSecret: 'fallback' } as AppConfig;

describe('Instagram OAuth state', () => {
  it('binds the callback to the user and selected Creator', () => {
    const issued = issueInstagramOAuthState(config, { userId: 'user-1', creatorIdentityId: 'creator-1', platform: 'instagram', returnPath: '/studio/workspace?section=integrations' });
    expect(verifyInstagramOAuthState(config, issued.state)).toMatchObject({ userId: 'user-1', creatorIdentityId: 'creator-1', platform: 'instagram' });
  });
  it('rejects state signed by another deployment', () => {
    const issued = issueInstagramOAuthState(config, { userId: 'user-1', creatorIdentityId: 'creator-1', platform: 'instagram', returnPath: '/studio' });
    expect(() => verifyInstagramOAuthState({ ...config, externalTokenEncryptionKey: 'different' }, issued.state)).toThrow();
  });
});
