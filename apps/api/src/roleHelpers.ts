import type { PlatformRole, UserCapabilities } from './domain';

export const capabilitiesForRole = (role: PlatformRole): UserCapabilities => ({
  canBrowse: true,
  canComment: true,
  canVote: true,
  canSubmitToContexts: role === 'contributor' || role === 'creator' || role === 'admin',
  canPublishPosts: role === 'creator' || role === 'admin',
  canManageGroups: role === 'creator' || role === 'admin',
  canModerate: role === 'admin',
  canAwardPrizes: role === 'admin'
});

export const normalizePlatformRoleValue = (input: unknown): PlatformRole => {
  if (input === 'admin' || input === 'creator' || input === 'contributor') return input;
  return 'user';
};
