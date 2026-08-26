import { requireIntegrationAdmission } from '../src/integrationGuard';

describe('integration admission guard', () => {
  const store = (holds: unknown[] = []) => ({
    listActiveIntegrationReviewHolds: jest.fn(async () => holds)
  });

  it('rejects operations absent from the provider contract before invoking a provider', async () => {
    await expect(requireIntegrationAdmission(store() as any, {
      platform: 'youtube', operation: 'publish', targets: [{ type: 'creator', id: 'creator-1' }]
    })).rejects.toThrow('YouTube does not support publish.');
  });

  it('blocks admitted operations when any target has an active safety hold', async () => {
    await expect(requireIntegrationAdmission(store([{
      holdType: 'safety', reason: 'Needs review'
    }]) as any, {
      platform: 'ghost', operation: 'publish', targets: [{ type: 'work', id: 'work-1' }]
    })).rejects.toThrow('Needs review');
  });
});
