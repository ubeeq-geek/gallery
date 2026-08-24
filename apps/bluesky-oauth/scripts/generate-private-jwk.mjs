import { JoseKey } from '@atproto/oauth-client-node';
import { randomBytes } from 'node:crypto';

const key = await JoseKey.generate(['ES256'], `bluesky-oauth-${Date.now()}`);
if (!key.privateJwk) throw new Error('Could not generate a private ES256 JWK.');

process.stdout.write(`${JSON.stringify({
  blueskyOAuthPrivateJwk: JSON.stringify(key.privateJwk),
  blueskyOAuthInternalSecret: randomBytes(32).toString('base64url')
})}\n`);
