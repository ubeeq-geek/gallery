import { marshall } from '@aws-sdk/util-dynamodb';
import { createRegionalPublicationOutboxHandler } from '../src/regionalPublicationOutboxHandler';

it('durably dispatches an eligible derivative from the local asset', async () => {
  const send = jest.fn().mockResolvedValue(undefined); const complete = jest.fn().mockResolvedValue(undefined);
  const handler = createRegionalPublicationOutboxHandler({ loadAsset: jest.fn().mockResolvedValue({ currentScanGroupId: 'g', privateDerivativeObjectKey: 'assets/a/v/image', mediaContentHash: 'hash', mediaContentType: 'image/jpeg' }), send, complete });
  await handler({ Records: [{ eventName: 'INSERT', dynamodb: { NewImage: marshall({ PK: 'PUBLICATION#g', recordType: 'PUBLICATION_OUTBOX', state: 'PENDING', product: 'eversally', environment: 'test', dataHomeRegion: 'eu-central-1', assetId: 'a', mediaVersionId: 'v', scanGroupId: 'g' }) } }] } as any, {} as any, jest.fn());
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ privateDerivativeObjectKey: 'assets/a/v/image', contentHash: 'hash' })); expect(complete).toHaveBeenCalledWith('PUBLICATION#g');
});
