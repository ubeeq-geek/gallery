type WorksWorkspaceRouteOptions = {
  workId?: string;
  tab?: string;
  create?: boolean;
};

export const worksWorkspacePath = (
  currentSearch: string,
  options: WorksWorkspaceRouteOptions = {}
): string => {
  const params = new URLSearchParams(currentSearch);
  params.set('section', 'works');
  params.delete('workId');
  params.delete('tab');
  params.delete('create');

  if (options.workId) params.set('workId', options.workId);
  if (options.tab) params.set('tab', options.tab);
  if (options.create) params.set('create', '1');

  return `/studio/workspace?${params.toString()}`;
};
