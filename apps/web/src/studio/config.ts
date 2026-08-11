export type StudioSection =
  | 'dashboard'
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
  { key: 'dashboard', label: 'Dashboard', description: 'Overview and action queues for Studio.' },
  { key: 'files-media', label: 'Files & Media', description: 'File-level and media-level resources.' },
  { key: 'posts', label: 'Posts', description: 'Canonical post CRUD with canonical media references.' },
  { key: 'groupings', label: 'Groupings', description: 'Creator-owned public/private content groupings.' },
  { key: 'collections', label: 'Collections', description: 'Creator-owned Ubeeq Galleries and their independent organization.' },
  { key: 'works', label: 'Works', description: 'Local creator catalogue with collection-specific filtering.' },
  { key: 'creators', label: 'Creators', description: 'Creator accounts and multi-creator ownership management.' },
  { key: 'integrations', label: 'Integrations', description: 'Connected creator platforms, local catalogues, and organization mapping.' },
  { key: 'challenges', label: 'Challenges', description: 'Challenge lifecycle, prizes, and winners managed inside Studio.' },
  { key: 'entries', label: 'Entries', description: 'Entry approvals and contributor promotions into the configured contributor display flow.' },
  { key: 'users', label: 'Users', description: 'Role ladder, promotions, demotions, and user capability controls.' },
  { key: 'moderation', label: 'Moderation', description: 'Blocks, bans, flagged collections, and destructive safeguards.' }
];

export const readStudioSection = (search: string): StudioSection => {
  const params = new URLSearchParams(search);
  const candidate = params.get('section');
  if (!candidate) return 'dashboard';
  const found = studioSectionDefs.find((item) => item.key === candidate);
  return found?.key || 'dashboard';
};

export const studioNavSections = studioSectionDefs.filter((section) => section.key !== 'dashboard');
