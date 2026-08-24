import { decryptExternalCredential, encryptExternalCredential } from './externalCredentials';
import type { VimeoConnection, VimeoPublication, VimeoRepository } from './vimeoIntegration';
import { VimeoApiError, VimeoProvider, type VimeoTokens } from './vimeoProvider';

export interface VimeoSource {
  sizeBytes: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export interface VimeoAuditSink {
  record(event: { actor: 'worker'; action: string; result: 'success' | 'failure'; publicationId: string; correlationId: string; detail?: Record<string, unknown> }): Promise<void>;
}

const tokensFor = (connection: VimeoConnection, encryptionKey: string | undefined): VimeoTokens => {
  if (!connection.credentialRef) throw new Error('Vimeo connection has no credentials');
  return JSON.parse(decryptExternalCredential(connection.credentialRef, encryptionKey)) as VimeoTokens;
};

const failedState = (publication: VimeoPublication, error: unknown): VimeoPublication => ({
  ...publication,
  state: 'FAILED',
  // Never persist provider payloads, authorization data, upload URLs, or source URLs.
  lastError: error instanceof VimeoApiError ? `VIMEO_${error.status}` : 'VIMEO_UPLOAD_FAILED',
  // Unknown transport/storage failures are safe to retry because the worker
  // always asks tus for the authoritative offset before sending more bytes.
  lastFailureRetryable: error instanceof VimeoApiError ? error.retryable : true,
  updatedAt: new Date().toISOString()
});

export class VimeoUploadWorker {
  constructor(
    private readonly repository: VimeoRepository,
    private readonly provider: VimeoProvider,
    private readonly encryptionKey: string | undefined,
    private readonly audit: VimeoAuditSink,
    private readonly chunkBytes = 8 * 1024 * 1024
  ) {}

  async run(input: { publicationId: string; source: VimeoSource; title: string; description?: string; correlationId: string }): Promise<VimeoPublication> {
    const publication = await this.repository.publication(input.publicationId);
    if (!publication) throw new Error('Vimeo publication not found');
    if (!['QUEUED', 'UPLOADING'].includes(publication.state) && !(publication.state === 'FAILED' && publication.lastFailureRetryable)) return publication;
    const connection = await this.repository.connection(publication.connectionId);
    if (!connection || connection.state !== 'CONNECTED' || !connection.capabilities.includes('video_publish')) {
      throw new Error('Vimeo connection cannot publish');
    }
    if (input.source.sizeBytes <= 0) throw new Error('Vimeo source is empty');

    try {
      const token = tokensFor(connection, this.encryptionKey).accessToken;
      let uploadUrl: string;
      if (publication.uploadAuthorization) {
        uploadUrl = decryptExternalCredential(publication.uploadAuthorization, this.encryptionKey);
      } else if (!publication.remoteVideoId || !publication.remoteUrl) {
        const ticket = await this.provider.createUpload(token, { sizeBytes: input.source.sizeBytes, title: input.title, description: input.description });
        publication.remoteVideoId = ticket.videoId;
        publication.remoteUrl = ticket.videoUri;
        uploadUrl = ticket.uploadUrl;
        publication.uploadAuthorization = encryptExternalCredential(ticket.uploadUrl, this.encryptionKey);
      } else {
        throw new VimeoApiError('Upload authorization expired; reconcile before retry', 409, false);
      }
      if (!publication.remoteUrl) throw new VimeoApiError('Upload has no remote video mapping', 409, false);
      publication.state = 'UPLOADING';
      publication.updatedAt = new Date().toISOString();
      await this.repository.savePublication(publication);

      let offset = await this.provider.uploadOffset(uploadUrl);
      while (offset < input.source.sizeBytes) {
        const length = Math.min(this.chunkBytes, input.source.sizeBytes - offset);
        const chunk = await input.source.read(offset, length);
        if (chunk.length !== length) throw new VimeoApiError('Canonical source ended before its declared size', 422, false);
        offset = await this.provider.uploadChunk(uploadUrl, offset, chunk);
        publication.uploadOffset = offset;
        publication.updatedAt = new Date().toISOString();
        await this.repository.savePublication(publication);
      }
      await this.provider.configureVideo(token, publication.remoteUrl, {
        title: input.title,
        description: input.description,
        privacy: publication.privacy,
        embedDomains: publication.embedDomains,
        downloadsAllowed: publication.downloadsAllowed
      });
      publication.state = 'PROCESSING';
      publication.uploadAuthorization = undefined;
      publication.uploadOffset = undefined;
      publication.lastError = undefined;
      publication.lastFailureRetryable = undefined;
      publication.updatedAt = new Date().toISOString();
      await this.repository.savePublication(publication);
      await this.audit.record({ actor: 'worker', action: 'vimeo.upload', result: 'success', publicationId: publication.id, correlationId: input.correlationId });
      return publication;
    } catch (error) {
      const failed = failedState(publication, error);
      await this.repository.savePublication(failed);
      await this.audit.record({ actor: 'worker', action: 'vimeo.upload', result: 'failure', publicationId: publication.id, correlationId: input.correlationId, detail: { code: failed.lastError } });
      return failed;
    }
  }

  async reconcile(publicationId: string): Promise<VimeoPublication> {
    const publication = await this.repository.publication(publicationId);
    if (!publication) throw new Error('Vimeo publication not found');
    const connection = await this.repository.connection(publication.connectionId);
    if (!connection || !publication.remoteUrl) return publication;
    try {
      const remote = await this.provider.video(tokensFor(connection, this.encryptionKey).accessToken, publication.remoteUrl);
      const transcode = (remote.transcode as { status?: string } | undefined)?.status;
      publication.state = transcode === 'complete' ? 'PUBLISHED' : transcode === 'error' ? 'FAILED' : 'PROCESSING';
      publication.updatedAt = new Date().toISOString();
    } catch (error) {
      if (error instanceof VimeoApiError && error.status === 404) publication.state = 'MISSING';
      else throw error;
    }
    await this.repository.savePublication(publication);
    return publication;
  }
}
