import { brand } from '../brand';

export type StudioSection =
  | 'dashboard'
  | 'activity'
  | 'publishing'
  | 'settings'
  | 'files-media'
  | 'posts'
  | 'groupings'
  | 'collections'
  | 'works'
  | 'creators'
  | 'integrations'
  | 'challenges'
  | 'entries'
  | 'users'
  | 'moderation';

export const studioSectionDefs: Array<{ key: StudioSection; label: string; description: string }> = [
  { key: 'dashboard', label: 'Home', description: 'Your creator catalogue and publishing activity.' },
  { key: 'activity', label: 'Activity', description: 'Comments, favourites, and other activity from connected platforms.' },
  { key: 'works', label: 'Works', description: 'Find, organize, and prepare work from your local catalogue.' },
  { key: 'collections', label: 'Collections', description: `Organize work into ${brand.productName} collections, galleries, and series.` },
  { key: 'publishing', label: 'Publishing', description: 'Prepare work for external publishing and review its status.' },
  { key: 'integrations', label: 'Integrations', description: 'Connect and manage creator platforms such as DeviantArt.' },
  { key: 'settings', label: 'Settings', description: 'Manage creator defaults, access, and Studio preferences.' },
  { key: 'creators', label: `Manage ${brand.creatorPlural}`, description: `Create and maintain the ${brand.creatorName.toLowerCase()} identities in this account.` },
  { key: 'files-media', label: 'Files & Media', description: 'File-level and media-level resources.' },
  { key: 'posts', label: 'Posts', description: 'Canonical post CRUD with canonical media references.' },
  { key: 'groupings', label: 'Groupings', description: `${brand.creatorName}-owned public/private content groupings.` },
  { key: 'challenges', label: 'Challenges', description: 'Challenge lifecycle, prizes, and winners managed inside Studio.' },
  { key: 'entries', label: 'Entries', description: 'Entry approvals and contributor promotions into the configured contributor display flow.' },
  { key: 'users', label: brand.memberPlural, description: 'Role ladder, promotions, demotions, and member capability controls.' },
  { key: 'moderation', label: 'Moderation', description: 'Blocks, bans, flagged collections, and destructive safeguards.' }
];

export const readStudioSection = (search: string): StudioSection => {
  const params = new URLSearchParams(search);
  const candidate = params.get('section');
  if (!candidate) return 'dashboard';
  const found = studioSectionDefs.find((item) => item.key === candidate);
  return found?.key || 'dashboard';
};

export const studioPrimaryNavSections: StudioSection[] = [
  'dashboard',
  'activity',
  'works',
  'collections',
  'publishing',
  'integrations',
  'settings'
];

export const studioManagementNavSections: StudioSection[] = [
  'creators',
  'files-media',
  'posts',
  'groupings',
  'challenges',
  'entries',
  'users',
  'moderation'
];
