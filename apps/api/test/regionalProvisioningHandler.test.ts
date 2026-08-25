import { createRegionalProvisioningHandler } from '../src/regionalProvisioningHandler';

const event = (resource: string, body: unknown): any => ({ httpMethod: 'POST', resource, body: JSON.stringify(body), requestContext: { authorizer: { claims: { sub: 'creator' } } } });
describe('regional provisioning', () => {
  const cell = { product: 'eversally' as const, environment: 'test', dataHomeRegion: 'eu-central-1' as const };
  it('creates upload prerequisites in the owning cell', async () => {
    const put = jest.fn().mockResolvedValue(undefined); const handler = createRegionalProvisioningHandler(cell, { put });
    await expect(handler(event('/spaces', { spaceId: 'space' }))).resolves.toMatchObject({ statusCode: 201 });
    await expect(handler(event('/assets', { spaceId: 'space', assetId: 'asset' }))).resolves.toMatchObject({ statusCode: 201 });
    expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ PK: 'ASSET#asset', canonicalRegion: 'eu-central-1', creatorId: 'creator' }));
  });
});
