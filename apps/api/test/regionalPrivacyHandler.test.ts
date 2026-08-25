import { createRegionalPrivacyHandler } from '../src/regionalPrivacyHandler';

const event = (resource: string) => ({ httpMethod: 'POST', resource, body: JSON.stringify({ spaceId: 'space-1' }), requestContext: { authorizer: { claims: { sub: 'owner-1' } } } } as any);
const cell = { product: 'eversally' as const, environment: 'test', dataHomeRegion: 'us-east-2' as const };

test('exports only records owned by the caller from the regional cell', async () => {
  const put = jest.fn(); const writeExport = jest.fn().mockResolvedValue('signed-url');
  const handler = createRegionalPrivacyHandler(cell, { get: async () => ({ PK: 'SPACE#space-1', creatorId: 'owner-1', product: 'eversally', environment: 'test', dataHomeRegion: 'us-east-2' }), listForSpace: async () => [{ PK: 'ASSET#a', spaceId: 'space-1' }], put, delete: jest.fn() }, { writeExport, delete: jest.fn(), exists: jest.fn() }, {});
  const result = await handler(event('/privacy/export'));
  expect(result.statusCode).toBe(202); expect(writeExport).toHaveBeenCalled(); expect(put).toHaveBeenCalledWith(expect.objectContaining({ recordType: 'PRIVACY_EXPORT' }));
});

test('legal holds block erasure before any object is deleted', async () => {
  const remove = jest.fn();
  const handler = createRegionalPrivacyHandler(cell, { get: async () => ({ PK: 'SPACE#space-1', creatorId: 'owner-1', product: 'eversally', environment: 'test', dataHomeRegion: 'us-east-2', legalHold: true }), listForSpace: async () => [], put: jest.fn(), delete: jest.fn() }, { writeExport: jest.fn(), delete: remove, exists: jest.fn() }, {});
  expect((await handler(event('/privacy/delete'))).statusCode).toBe(409); expect(remove).not.toHaveBeenCalled();
});

test('deletion removes regional objects and verifies erasure', async () => {
  const put = jest.fn(); const removeRecord = jest.fn(); const removeObjects = jest.fn();
  const handler = createRegionalPrivacyHandler(cell, { get: async () => ({ PK: 'SPACE#space-1', creatorId: 'owner-1', product: 'eversally', environment: 'test', dataHomeRegion: 'us-east-2' }), listForSpace: async () => [{ PK: 'ASSET#a', creatorId: 'owner-1', spaceId: 'space-1', originalKey: 'original/a' }], put, delete: removeRecord }, { writeExport: jest.fn(), delete: removeObjects, exists: async () => false }, { originals: 'originals' });
  const result = await handler(event('/privacy/delete'));
  expect(result.statusCode).toBe(202); expect(removeObjects).toHaveBeenCalledWith('originals', ['original/a']); expect(removeRecord).toHaveBeenCalledWith('ASSET#a'); expect(put).toHaveBeenCalledWith(expect.objectContaining({ status: 'DELETED' }));
});
