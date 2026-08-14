import type { AppConfig } from './config';

export type ApiBrand = {
  id: 'eversally' | 'ubeeq';
  productName: string;
  workspaceName: string;
  workspaceFullName: string;
  memberName: string;
  creatorName: string;
  siteUrl: string;
  creatorBaseUrl: string;
};

const eversallyBrand: ApiBrand = {
  id: 'eversally',
  productName: 'Eversally',
  workspaceName: 'Space',
  workspaceFullName: 'Eversally Space',
  memberName: 'Ever',
  creatorName: 'Ever Creator',
  siteUrl: 'https://eversally.com',
  creatorBaseUrl: 'https://eversally.com/creators/'
};

const ubeeqBrand: ApiBrand = {
  id: 'ubeeq',
  productName: 'Ubeeq',
  workspaceName: 'Creator Area',
  workspaceFullName: 'Ubeeq Creator Area',
  memberName: 'Ubeeqer',
  creatorName: 'Creator',
  siteUrl: 'https://ubeeq.site',
  creatorBaseUrl: 'https://ubeeq.site/creators/'
};

export const brandForConfig = (config: Pick<AppConfig, 'productBrand'>): ApiBrand => (
  config.productBrand === 'eversally' ? eversallyBrand : ubeeqBrand
);
