import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { assertPublicationCell, dynamoRegionalPublicDeliveryRepository, s3RegionalPublicDerivativeStore } from '../src/regionalPublicDeliveryAws';
import type { RegionalPublicDerivativePublication } from '../src/regionalPublicDelivery';

const publication: RegionalPublicDerivativePublication = {
  id: 'publication-1', recordType: 'PUBLIC_DERIVATIVE_PUBLICATION', product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2',
  assetId: 'asset', mediaVersionId: 'version', scanGroupId: 'group', sourceBucket: 'private', sourceObjectKey: 'a folder/file.webp',
  destinationBucket: 'public', destinationObjectKey: 'assets/asset/version/hash.webp', contentHash: 'a'.repeat(64), contentType: 'image/webp',
  state: 'PUBLISHING', createdAt: '2026-08-25T00:00:00.000Z'
};

describe('AWS regional public delivery adapters', () => {
  it('copies with replaced safe metadata, short cache lifetime, and encoded source', async () => {
    const send = jest.fn().mockResolvedValue({});
    const store = s3RegionalPublicDerivativeStore({ send } as any);
    await store.copy({ sourceBucket: 'private', sourceObjectKey: 'a folder/file.webp', destinationBucket: 'public', destinationObjectKey: 'assets/file.webp', contentType: 'image/webp', contentHash: 'a'.repeat(64) });
    expect(send.mock.calls[0][0]).toBeInstanceOf(CopyObjectCommand);
    expect(send.mock.calls[0][0].input).toMatchObject({ CopySource: 'private/a%20folder/file.webp', MetadataDirective: 'REPLACE', CacheControl: expect.stringContaining('max-age=300') });
    expect(send.mock.calls[0][0].input.ServerSideEncryption).toBeUndefined();
    await store.remove({ bucket: 'public', objectKey: 'assets/file.webp' });
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it('conditionally begins and atomically completes publication with its Asset and audit', async () => {
    const send = jest.fn().mockResolvedValue({});
    const repository = dynamoRegionalPublicDeliveryRepository({ client: { send } as any, metadataTableName: 'metadata', auditTableName: 'audit' });
    await repository.begin(publication);
    const begin = send.mock.calls[0][0] as TransactWriteCommand;
    expect(begin).toBeInstanceOf(TransactWriteCommand);
    expect(begin.input.TransactItems).toHaveLength(2);
    expect(begin.input.TransactItems?.[0].ConditionCheck?.ConditionExpression).toContain('currentScanGroupId');
    await repository.complete({ ...publication, state: 'PUBLISHED', publishedAt: publication.createdAt });
    const complete = send.mock.calls[1][0] as TransactWriteCommand;
    expect(complete.input.TransactItems).toHaveLength(3);
    expect(complete.input.TransactItems?.[1].Update?.UpdateExpression).toContain('publicDeliveryState');
  });

  it('records failed publication attempts conditionally', async () => {
    const send = jest.fn().mockResolvedValue({});
    const repository = dynamoRegionalPublicDeliveryRepository({ client: { send } as any, metadataTableName: 'metadata', auditTableName: 'audit' });
    await repository.fail(publication, 'CopyFailed');
    expect(send.mock.calls[0][0]).toBeInstanceOf(UpdateCommand);
    expect(send.mock.calls[0][0].input.ConditionExpression).toBe('#state = :publishing');
  });

  it('rejects publications belonging to another product, environment, or region', () => {
    expect(() => assertPublicationCell(publication, { product: 'nightframe', environment: 'production', dataHomeRegion: 'us-east-2' })).toThrow('Cross-cell');
    expect(() => assertPublicationCell(publication, { product: 'eversally', environment: 'production', dataHomeRegion: 'eu-central-1' })).toThrow('Cross-cell');
  });
});
