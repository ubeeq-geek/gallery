import { createRegionalPublicDeliveryHandler } from '../src/regionalPublicDeliveryHandler';

const message = {
  product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2', assetId: 'asset',
  mediaVersionId: 'version', scanGroupId: 'group', contentHash: 'a'.repeat(64), contentType: 'image/webp', privateDerivativeObjectKey: 'asset/preview.webp'
} as const;
const event = (body: unknown, id = 'message') => ({ Records: [{ messageId: id, body: typeof body === 'string' ? body : JSON.stringify(body) }] }) as any;

describe('regional public delivery handler', () => {
  const dependencies = () => ({
    cell: { product: 'eversally' as const, environment: 'production', dataHomeRegion: 'us-east-2' as const },
    privateDerivativesBucket: 'private', publicDerivativesBucket: 'public',
    loadAuthoritativeState: jest.fn().mockResolvedValue({ canonicalRegion: 'us-east-2', policyDecision: { state: 'CLEARED_FOR_POLICY_REVIEW', policyVersion: 'v1', reasonCode: 'AUTOMATED_NO_RELEVANT_RESULT', automatedCompletionOnly: true }, remainingCreditUnits: 10, requiredCreditUnits: 1 }),
    publish: jest.fn().mockResolvedValue(undefined)
  });

  it('reloads authorization and publishes using only configured cell buckets', async () => {
    const deps = dependencies();
    await expect(createRegionalPublicDeliveryHandler(deps)(event(message))).resolves.toEqual({ batchItemFailures: [] });
    expect(deps.loadAuthoritativeState).toHaveBeenCalledWith(message);
    expect(deps.publish).toHaveBeenCalledWith(expect.objectContaining({ sourceBucket: 'private', publicDerivativesBucket: 'public', delivery: expect.objectContaining({ canonicalRegion: 'us-east-2' }) }));
  });

  it('rejects cross-cell commands before reading authoritative state', async () => {
    const deps = dependencies();
    await expect(createRegionalPublicDeliveryHandler(deps)(event({ ...message, product: 'nightframe' }))).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'message' }] });
    expect(deps.loadAuthoritativeState).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('fails only the affected SQS record when policy or persistence denies publication', async () => {
    const deps = dependencies();
    deps.publish.mockRejectedValueOnce(new Error('Asset held'));
    await expect(createRegionalPublicDeliveryHandler(deps)(event(message, 'failed'))).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'failed' }] });
  });

  it('rejects incomplete messages without accessing storage', async () => {
    const deps = dependencies();
    await expect(createRegionalPublicDeliveryHandler(deps)(event({ product: 'eversally' }))).resolves.toEqual({ batchItemFailures: [{ itemIdentifier: 'message' }] });
    expect(deps.loadAuthoritativeState).not.toHaveBeenCalled();
  });
});
