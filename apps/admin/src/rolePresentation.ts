import { adminBrand } from './brand';

export type PlatformRole = 'user' | 'contributor' | 'creator' | 'admin';

const configuredContributorLabel = import.meta.env.VITE_CONTRIBUTOR_LABEL?.trim();

const ROLE_DISPLAY_LABELS: Partial<Record<PlatformRole, string>> = {
  contributor: configuredContributorLabel || adminBrand.memberName
};

export const roleDisplayLabel = (role: PlatformRole): string =>
  ROLE_DISPLAY_LABELS[role] || role[0].toUpperCase() + role.slice(1);
