import { evaluateInstagramEligibility, type InstagramPreflightInput, type InstagramPublication } from './instagramIntegration';
import { InstagramProvider, InstagramProviderError, type InstagramContainerRequest } from './instagramProvider';

export interface InstagramPublicationRepository {
  getById(publicationId: string): Promise<InstagramPublication | undefined>;
  getByIdempotencyKey(key: string): Promise<InstagramPublication | undefined>;
  save(publication: InstagramPublication): Promise<void>;
}

/** Coordinates the controlled-pilot create/status/publish sequence without owning credentials or media URLs. */
export class InstagramPublicationService {
  constructor(private readonly repository: InstagramPublicationRepository, private readonly provider: InstagramProvider) {}

  async confirmPreflight(publication: InstagramPublication, input: InstagramPreflightInput): Promise<InstagramPublication> {
    const existing = await this.repository.getByIdempotencyKey(publication.idempotencyKey);
    if (existing && existing.publicationId !== publication.publicationId) return existing;
    const decision = evaluateInstagramEligibility(input);
    if (decision.result !== 'ALLOWED_MANAGED') throw new Error(`${decision.reasonCode}: ${decision.explanation}`);
    const confirmed = { ...publication, status: 'CONFIRMED' as const };
    await this.repository.save(confirmed);
    return confirmed;
  }

  async createContainer(publicationId: string, accessToken: string, accountId: string, request: InstagramContainerRequest): Promise<InstagramPublication> {
    const publication = await this.required(publicationId);
    if (publication.remoteMediaId || publication.status === 'PUBLISHED') return publication;
    if (publication.containerIds.length) return publication;
    if (publication.status !== 'CONFIRMED') throw new Error('Final creator confirmation is required before container creation');
    const containerId = await this.provider.createContainer(accessToken, accountId, request);
    const processing = { ...publication, containerIds: [containerId], status: 'CONTAINER_PROCESSING' as const };
    await this.repository.save(processing);
    return processing;
  }

  async reconcileAndPublish(publicationId: string, accessToken: string, accountId: string): Promise<InstagramPublication> {
    const publication = await this.required(publicationId);
    if (publication.status === 'PUBLISHED' || publication.remoteMediaId) return publication;
    const containerId = publication.containerIds.at(-1);
    if (!containerId) throw new Error('No Instagram container exists');
    const status = await this.provider.getContainerStatus(accessToken, containerId);
    if (status === 'IN_PROGRESS') return publication;
    if (status !== 'FINISHED') {
      const next = { ...publication, status: (status === 'ERROR' || status === 'EXPIRED' ? 'FAILED' : 'UNKNOWN') as InstagramPublication['status'] };
      await this.repository.save(next);
      return next;
    }
    try {
      const remoteMediaId = await this.provider.publishContainer(accessToken, accountId, containerId);
      const published = { ...publication, remoteMediaId, status: 'PUBLISHED' as const, publishedAt: new Date().toISOString() };
      await this.repository.save(published);
      return published;
    } catch (error) {
      if (!(error instanceof InstagramProviderError) || error.code !== 'UNKNOWN') throw error;
      const unknown = { ...publication, status: 'UNKNOWN' as const };
      await this.repository.save(unknown);
      return unknown;
    }
  }

  private async required(id: string): Promise<InstagramPublication> {
    const publication = await this.repository.getById(id);
    if (!publication) throw new Error('Instagram publication not found');
    return publication;
  }
}
