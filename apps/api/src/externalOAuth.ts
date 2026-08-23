import { createHash, createHmac, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import type { AppConfig } from './config';

interface OAuthStatePayload {
  userId: string;
  creatorIdentityId?: string;
  externalPlatformCredentialId: string;
  platform: 'deviantart' | 'youtube';
  returnPath: string;
  syncContentOnInitialImport?: boolean;
  nonce: string;
}

interface BlueskyOAuthStatePayload {
  userId: string;
  creatorIdentityId: string;
  platform: 'bluesky';
  returnPath: string;
  nonce: string;
}

interface DiscordOAuthStatePayload {
  userId: string;
  platform: 'discord';
  returnPath: string;
  nonce: string;
}

interface InstagramOAuthStatePayload {
  userId: string;
  creatorIdentityId: string;
  platform: 'instagram';
  returnPath: string;
  nonce: string;
}

const stateSecret = (config: AppConfig): string => config.externalTokenEncryptionKey || config.unlockJwtSecret;

const pkceVerifier = (config: AppConfig, nonce: string): string => (
  createHmac('sha256', stateSecret(config))
    .update(`external-oauth-pkce:${nonce}`)
    .digest('base64url')
);

export const externalOAuthPkce = (config: AppConfig, nonce: string) => {
  const codeVerifier = pkceVerifier(config, nonce);
  return {
    codeVerifier,
    codeChallenge: createHash('sha256').update(codeVerifier, 'utf8').digest('base64url')
  };
};

export const issueExternalOAuthState = (
  config: AppConfig,
  value: Omit<OAuthStatePayload, 'nonce'>
): { state: string; nonce: string } => {
  const nonce = randomUUID();
  return {
    state: jwt.sign({ ...value, nonce }, stateSecret(config), { expiresIn: '10m' }),
    nonce
  };
};

export const verifyExternalOAuthState = (config: AppConfig, value: string): OAuthStatePayload => {
  const payload = jwt.verify(value, stateSecret(config));
  if (!payload || typeof payload !== 'object') throw new Error('OAuth state is invalid');
  const state = payload as Partial<OAuthStatePayload>;
  if (
    typeof state.userId !== 'string'
    || typeof state.externalPlatformCredentialId !== 'string'
    || (state.platform !== 'deviantart' && state.platform !== 'youtube')
    || typeof state.returnPath !== 'string'
    || typeof state.nonce !== 'string'
  ) {
    throw new Error('OAuth state is invalid');
  }
  if (state.syncContentOnInitialImport !== undefined && typeof state.syncContentOnInitialImport !== 'boolean') {
    throw new Error('OAuth state is invalid');
  }
  return state as OAuthStatePayload;
};

/**
 * A Studio-issued state. The dedicated OAuth service returns it only after its
 * own PKCE state validation; the product API verifies it again before claiming
 * the signed connection proof. It never contains a Bluesky credential.
 */
export const issueBlueskyOAuthState = (
  config: AppConfig,
  value: Omit<BlueskyOAuthStatePayload, 'nonce'>
): { state: string; nonce: string } => {
  const nonce = randomUUID();
  return {
    state: jwt.sign({ ...value, nonce }, stateSecret(config), { expiresIn: '10m' }),
    nonce
  };
};

export const verifyBlueskyOAuthState = (config: AppConfig, value: string): BlueskyOAuthStatePayload => {
  const payload = jwt.verify(value, stateSecret(config));
  if (!payload || typeof payload !== 'object') throw new Error('OAuth state is invalid');
  const state = payload as Partial<BlueskyOAuthStatePayload>;
  if (
    typeof state.userId !== 'string'
    || typeof state.creatorIdentityId !== 'string'
    || state.platform !== 'bluesky'
    || typeof state.returnPath !== 'string'
    || typeof state.nonce !== 'string'
  ) throw new Error('OAuth state is invalid');
  return state as BlueskyOAuthStatePayload;
};

export const issueDiscordOAuthState = (
  config: AppConfig,
  value: Omit<DiscordOAuthStatePayload, 'nonce'>
): { state: string; nonce: string } => {
  const nonce = randomUUID();
  return { state: jwt.sign({ ...value, nonce }, stateSecret(config), { expiresIn: '10m' }), nonce };
};

export const verifyDiscordOAuthState = (config: AppConfig, value: string): DiscordOAuthStatePayload => {
  const payload = jwt.verify(value, stateSecret(config));
  if (!payload || typeof payload !== 'object') throw new Error('OAuth state is invalid');
  const state = payload as Partial<DiscordOAuthStatePayload>;
  if (typeof state.userId !== 'string' || state.platform !== 'discord' || typeof state.returnPath !== 'string' || typeof state.nonce !== 'string') {
    throw new Error('OAuth state is invalid');
  }
  return state as DiscordOAuthStatePayload;
};

export const issueInstagramOAuthState = (
  config: AppConfig,
  value: Omit<InstagramOAuthStatePayload, 'nonce'>
): { state: string; nonce: string } => {
  const nonce = randomUUID();
  return { state: jwt.sign({ ...value, nonce }, stateSecret(config), { expiresIn: '10m' }), nonce };
};

export const verifyInstagramOAuthState = (config: AppConfig, value: string): InstagramOAuthStatePayload => {
  const payload = jwt.verify(value, stateSecret(config));
  if (!payload || typeof payload !== 'object') throw new Error('OAuth state is invalid');
  const state = payload as Partial<InstagramOAuthStatePayload>;
  if (typeof state.userId !== 'string' || typeof state.creatorIdentityId !== 'string' || state.platform !== 'instagram' || typeof state.returnPath !== 'string' || typeof state.nonce !== 'string') {
    throw new Error('OAuth state is invalid');
  }
  return state as InstagramOAuthStatePayload;
};

export const resolveExternalOAuthReturnUrl = (config: AppConfig, returnPath: string, query: Record<string, string>): string => {
  const base = config.appOrigin || 'http://localhost:5173';
  const url = new URL(returnPath, base);
  if (url.origin !== new URL(base).origin) throw new Error('OAuth return URL is invalid');
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
};
