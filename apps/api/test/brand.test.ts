import { brandForConfig } from '../src/brand';

describe('product branding', () => {
  it('describes the Eversally hosted edition', () => {
    expect(brandForConfig({ productBrand: 'eversally' })).toEqual(expect.objectContaining({
      productName: 'Eversally',
      memberName: 'Ever',
      creatorName: 'Ever Creator',
      workspaceFullName: 'Eversally Space',
      siteUrl: 'https://eversally.com',
      creatorBaseUrl: 'https://eversally.com/creators/'
    }));
  });

  it('describes the Ubeeq open-source edition', () => {
    expect(brandForConfig({ productBrand: 'ubeeq' })).toEqual(expect.objectContaining({
      productName: 'Ubeeq',
      memberName: 'Ubeeqer',
      workspaceFullName: 'Ubeeq Creator Area',
      siteUrl: 'https://ubeeq.site',
      creatorBaseUrl: 'https://ubeeq.site/creators/'
    }));
  });
});
