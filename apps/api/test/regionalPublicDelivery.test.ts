import { publishRegionalPublicDerivative } from '../src/regionalPublicDelivery';

const input = {
  product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2',
  assetId: 'asset_1', mediaVersionId: 'version_1', scanGroupId: 'group_1',
  contentHash: 'a'.repeat(64), contentType: 'image/webp',
  sourceBucket: 'private-derivatives', sourceObjectKey: 'asset_1/preview.webp',
  expectedPrivateDerivativesBucket: 'private-derivatives', publicDerivativesBucket: 'public-derivatives', expectedPublicDerivativesBucket: 'public-derivatives',
  delivery: { canonicalRegion: 'us-east-2', policyDecision: { state: 'CLEARED_FOR_POLICY_REVIEW', policyVersion: 'v1', reasonCode: 'AUTOMATED_NO_RELEVANT_RESULT', automatedCompletionOnly: true }, remainingCreditUnits: 10, requiredCreditUnits: 1 }
} as const;

const dependencies = () => ({
  repository: { begin: jest.fn(), complete: jest.fn(), fail: jest.fn() },
  store: { copy: jest.fn(), remove: jest.fn() }
});

describe('regional public derivative publication', () => {
  it('promotes only an eligible private derivative to a deterministic public key', async () => {
    const { repository, store } = dependencies();
    const publication = await publishRegionalPublicDerivative(input, repository, store, '2026-08-25T00:00:00.000Z');
    expect(publication).toMatchObject({ state: 'PUBLISHED', destinationObjectKey: `assets/asset_1/version_1/${'a'.repeat(64)}.webp` });
    expect(repository.begin).toHaveBeenCalledWith(expect.objectContaining({ state: 'PUBLISHING' }));
    expect(store.copy).toHaveBeenCalledWith(expect.objectContaining({ sourceBucket: 'private-derivatives', destinationBucket: 'public-derivatives' }));
    expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({ state: 'PUBLISHED' }));
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('rejects quarantine or cross-cell source buckets before creating a record', async () => {
    const { repository, store } = dependencies();
    await expect(publishRegionalPublicDerivative({ ...input, sourceBucket: 'quarantine' }, repository, store)).rejects.toThrow('private derivatives bucket');
    expect(repository.begin).not.toHaveBeenCalled();
    expect(store.copy).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary public destination bucket', async () => {
    const { repository, store } = dependencies();
    await expect(publishRegionalPublicDerivative({ ...input, publicDerivativesBucket: 'another-cell-public' }, repository, store)).rejects.toThrow('destination must be this cell');
    expect(repository.begin).not.toHaveBeenCalled();
    expect(store.copy).not.toHaveBeenCalled();
  });

  it('fails closed when scan or policy delivery is not eligible', async () => {
    const { repository, store } = dependencies();
    await expect(publishRegionalPublicDerivative({ ...input, delivery: { ...input.delivery, policyDecision: undefined } }, repository, store)).rejects.toMatchObject({ reason: 'REQUIRED_SCAN_INCOMPLETE' });
    expect(repository.begin).not.toHaveBeenCalled();
  });

  it('removes a copied object if publication persistence fails', async () => {
    const { repository, store } = dependencies();
    repository.complete.mockRejectedValueOnce(Object.assign(new Error('transaction failed'), { name: 'TransactionCanceledException' }));
    await expect(publishRegionalPublicDerivative(input, repository, store)).rejects.toThrow('transaction failed');
    expect(store.remove).toHaveBeenCalledWith({ bucket: 'public-derivatives', objectKey: `assets/asset_1/version_1/${'a'.repeat(64)}.webp` });
    expect(repository.fail).toHaveBeenCalledWith(expect.objectContaining({ state: 'PUBLISHING' }), 'TransactionCanceledException');
  });

  it('rejects unsafe identifiers and unsupported derivative formats', async () => {
    const { repository, store } = dependencies();
    await expect(publishRegionalPublicDerivative({ ...input, assetId: '../asset' }, repository, store)).rejects.toThrow('not safe');
    await expect(publishRegionalPublicDerivative({ ...input, contentType: 'text/html' }, repository, store)).rejects.toThrow('not supported');
  });
});
