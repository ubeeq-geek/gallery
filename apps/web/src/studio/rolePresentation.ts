export type PlatformRole = 'user' | 'contributor' | 'creator' | 'admin';

const configuredContributorLabel = import.meta.env.VITE_CONTRIBUTOR_LABEL?.trim();

export const ROLE_DISPLAY_LABELS: Partial<Record<PlatformRole, string>> = {
  contributor: configuredContributorLabel || 'Beeker'
};

export const roleDisplayLabel = (role: PlatformRole): string =>
  ROLE_DISPLAY_LABELS[role] || role[0].toUpperCase() + role.slice(1);
