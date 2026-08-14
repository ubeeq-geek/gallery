export type ProductBrandId = 'eversally' | 'ubeeq';

export type ProductBrand = {
  id: ProductBrandId;
  productName: string;
  platformName: string;
  memberName: string;
  memberPlural: string;
  creatorName: string;
  creatorPlural: string;
  formalCreatorName: string;
  formalCreatorPlural: string;
  workspaceName: string;
  workspacePlural: string;
  workspaceFullName: string;
  studioName: string;
  siteUrl: string;
  creatorBaseUrl: string;
  rulesName: string;
  attribution?: string;
};

const brands: Record<ProductBrandId, ProductBrand> = {
  eversally: {
    id: 'eversally',
    productName: 'Eversally',
    platformName: 'Ubeeq',
    memberName: 'Ever',
    memberPlural: 'Evers',
    creatorName: 'Creator',
    creatorPlural: 'Creators',
    formalCreatorName: 'Ever Creator',
    formalCreatorPlural: 'Ever Creators',
    workspaceName: 'Space',
    workspacePlural: 'Spaces',
    workspaceFullName: 'Eversally Space',
    studioName: 'Eversally Studio',
    siteUrl: 'https://eversally.com',
    creatorBaseUrl: 'https://eversally.com/creators/',
    rulesName: 'Eversally Space Rules',
    attribution: 'Powered by Ubeeq'
  },
  ubeeq: {
    id: 'ubeeq',
    productName: 'Ubeeq',
    platformName: 'Ubeeq',
    memberName: 'Ubeeqer',
    memberPlural: 'Ubeeqers',
    creatorName: 'Creator',
    creatorPlural: 'Creators',
    formalCreatorName: 'Creator',
    formalCreatorPlural: 'Creators',
    workspaceName: 'Creator Area',
    workspacePlural: 'Creator Areas',
    workspaceFullName: 'Ubeeq Creator Area',
    studioName: 'Ubeeq Studio',
    siteUrl: 'https://ubeeq.site',
    creatorBaseUrl: 'https://ubeeq.site/creators/',
    rulesName: 'Ubeeq Creator Area Rules'
  }
};

const configuredBrand = String(import.meta.env.VITE_PRODUCT_BRAND || 'ubeeq').trim().toLowerCase();

export const brand: ProductBrand = brands[configuredBrand === 'eversally' ? 'eversally' : 'ubeeq'];

export const creatorBaseUrl = String(import.meta.env.VITE_CREATOR_BASE_URL || brand.creatorBaseUrl).replace(/\/?$/, '/');
