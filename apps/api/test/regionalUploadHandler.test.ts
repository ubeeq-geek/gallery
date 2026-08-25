import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createRegionalUploadHandler, dynamoRegionalUploadRepository } from '../src/regionalUploadHandler';

const event = (body: unknown, sub = 'creator') => ({ httpMethod: 'POST', body: JSON.stringify(body), requestContext: { authorizer: { claims: { sub } } } }) as any;
const body = { spaceId: 'space', assetId: 'asset', mediaVersionId: 'version', mediaType: 'image', contentType: 'image/jpeg', contentLength: 1024 };

describe('regional upload HTTP handler', () => {
  it('uses the authenticated subject and returns only the regional upload contract', async () => {
    const authorize = jest.fn().mockResolvedValue({ authorization: { ...body, creatorId: 'creator', dataHomeRegion: 'us-east-2', quarantineObjectKey: 'images/asset/version/source', expiresAt: 'soon' }, uploadUrl: 'https://upload.example' });
    const response = await createRegionalUploadHandler({ authorize })(event(body));
    expect(authorize).toHaveBeenCalledWith({ ...body, creatorId: 'creator' });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({ uploadUrl: 'https://upload.example', dataHomeRegion: 'us-east-2', requiredHeaders: { 'content-type': 'image/jpeg', 'content-length': '1024' } });
    expect(response.headers).toMatchObject({ 'cache-control': 'no-store' });
  });

  it('fails closed without an authenticated creator', async () => {
    const authorize = jest.fn();
    const response = await createRegionalUploadHandler({ authorize })(event(body, ''));
    expect(response.statusCode).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('does not expose repository errors', async () => {
    const response = await createRegionalUploadHandler({ authorize: jest.fn().mockRejectedValue(new Error('database unavailable')) })(event(body));
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('{"error":"internal_error"}');
  });

  it('atomically checks the Space and Asset before storing authorization and audit', async () => {
    const send = jest.fn().mockResolvedValue({});
    const repository = dynamoRegionalUploadRepository({ client: { send } as any, metadataTableName: 'metadata', auditTableName: 'audit' });
    await repository.authorize({ id: 'upload-version', recordType: 'REGIONAL_UPLOAD_AUTHORIZATION', product: 'eversally', environment: 'production', dataHomeRegion: 'us-east-2', creatorId: 'creator', spaceId: 'space', assetId: 'asset', mediaVersionId: 'version', mediaType: 'image', contentType: 'image/jpeg', contentLength: 1024, quarantineBucket: 'quarantine', quarantineObjectKey: 'images/asset/version/source', state: 'AUTHORIZED', createdAt: '2026-08-25T00:00:00Z', expiresAt: '2026-08-25T00:15:00Z', expiresAtEpochSeconds: 1787616900 });
    const command = send.mock.calls[0][0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems).toHaveLength(4);
    expect(command.input.TransactItems?.[0].ConditionCheck?.ConditionExpression).toContain('dataHomeMigrationState = :none');
    expect(command.input.TransactItems?.[1].ConditionCheck?.ConditionExpression).toContain('canonicalRegion = :region');
    expect(command.input.TransactItems?.[2].Put?.ConditionExpression).toBe('attribute_not_exists(PK)');
  });
});
