import { encryptExternalCredential } from '../src/externalCredentials';
import { MemoryVimeoRepository, type VimeoConnection, type VimeoPublication } from '../src/vimeoIntegration';
import { VimeoProvider } from '../src/vimeoProvider';
import { VimeoApiError } from '../src/vimeoProvider';
import { VimeoUploadWorker } from '../src/vimeoWorker';

describe('VimeoUploadWorker', () => {
  test('resumes a tus upload from the provider offset without creating another video', async () => {
    const encryptionKey = 'test-encryption-key';
    const repository = new MemoryVimeoRepository();
    const connection: VimeoConnection = {
      id: 'connection', ownerId: 'creator', mode: 'EVERSALLY_MANAGED',
      credentialRef: encryptExternalCredential(JSON.stringify({ accessToken: 'token', scopes: ['upload'] }), encryptionKey),
      capabilities: ['video_publish'], state: 'CONNECTED', createdAt: 'now', updatedAt: 'now'
    };
    const publication: VimeoPublication = {
      id: 'publication', ownerId: 'creator', connectionId: connection.id, workId: 'work', sourceAssetId: 'asset',
      sourceHash: 'hash', intentVersion: '1', idempotencyKey: 'key', state: 'UPLOADING', privacy: 'nobody',
      embedDomains: [], downloadsAllowed: false, remoteVideoId: '42', remoteUrl: '/videos/42',
      uploadAuthorization: encryptExternalCredential('https://upload.test/42', encryptionKey), createdAt: 'now', updatedAt: 'now'
    };
    await repository.saveConnection(connection);
    await repository.savePublication(publication);

    const provider = new VimeoProvider();
    provider.createUpload = jest.fn();
    provider.uploadOffset = jest.fn(async () => 4);
    provider.uploadChunk = jest.fn(async (_url, offset, body) => offset + body.length);
    provider.configureVideo = jest.fn(async () => undefined);
    const audit = { record: jest.fn(async () => undefined) };
    const worker = new VimeoUploadWorker(repository, provider, encryptionKey, audit, 3);
    const bytes = Buffer.from('0123456789');

    const result = await worker.run({
      publicationId: publication.id,
      source: { sizeBytes: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) },
      title: 'Test video',
      correlationId: 'correlation'
    });

    expect(provider.createUpload).not.toHaveBeenCalled();
    expect(provider.uploadChunk).toHaveBeenNthCalledWith(1, 'https://upload.test/42', 4, Buffer.from('456'));
    expect(result.state).toBe('PROCESSING');
    expect(result.uploadAuthorization).toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ result: 'success', correlationId: 'correlation' }));
  });

  test('marks confirmed provider rejection as non-retryable', async () => {
    const encryptionKey = 'test-encryption-key';
    const repository = new MemoryVimeoRepository();
    await repository.saveConnection({ id: 'connection', ownerId: 'creator', mode: 'EVERSALLY_MANAGED', credentialRef: encryptExternalCredential(JSON.stringify({ accessToken: 'token' }), encryptionKey), capabilities: ['video_publish'], state: 'CONNECTED', createdAt: 'now', updatedAt: 'now' });
    await repository.savePublication({ id: 'publication', ownerId: 'creator', connectionId: 'connection', workId: 'work', sourceAssetId: 'asset', sourceHash: 'hash', intentVersion: '1', idempotencyKey: 'key', state: 'QUEUED', privacy: 'nobody', embedDomains: [], downloadsAllowed: false, createdAt: 'now', updatedAt: 'now' });
    const provider = new VimeoProvider();
    provider.createUpload = jest.fn(async () => { throw new VimeoApiError('policy denied', 403, false); });
    const worker = new VimeoUploadWorker(repository, provider, encryptionKey, { record: async () => undefined });
    const result = await worker.run({ publicationId: 'publication', source: { sizeBytes: 1, read: async () => Buffer.from('x') }, title: 'Denied', correlationId: 'correlation' });
    expect(result).toMatchObject({ state: 'FAILED', lastError: 'VIMEO_403', lastFailureRetryable: false });
  });

  test('re-enters a failed upload only when its last failure is retryable', async () => {
    const encryptionKey = 'test-encryption-key';
    const repository = new MemoryVimeoRepository();
    await repository.saveConnection({ id: 'connection', ownerId: 'creator', mode: 'EVERSALLY_MANAGED', credentialRef: encryptExternalCredential(JSON.stringify({ accessToken: 'token' }), encryptionKey), capabilities: ['video_publish'], state: 'CONNECTED', createdAt: 'now', updatedAt: 'now' });
    await repository.savePublication({ id: 'publication', ownerId: 'creator', connectionId: 'connection', workId: 'work', sourceAssetId: 'asset', sourceHash: 'hash', intentVersion: '1', idempotencyKey: 'key', state: 'FAILED', lastFailureRetryable: true, privacy: 'nobody', embedDomains: [], downloadsAllowed: false, createdAt: 'now', updatedAt: 'now' });
    const provider = new VimeoProvider();
    provider.createUpload = jest.fn(async () => ({ videoId: '42', videoUri: '/videos/42', uploadUrl: 'https://upload.test/42' }));
    provider.uploadOffset = jest.fn(async () => 0);
    provider.uploadChunk = jest.fn(async (_url, offset, body) => offset + body.length);
    provider.configureVideo = jest.fn(async () => undefined);
    const worker = new VimeoUploadWorker(repository, provider, encryptionKey, { record: async () => undefined });
    const result = await worker.run({ publicationId: 'publication', source: { sizeBytes: 1, read: async () => Buffer.from('x') }, title: 'Retry', correlationId: 'correlation' });
    expect(provider.createUpload).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ state: 'PROCESSING', lastFailureRetryable: undefined });
  });
});
