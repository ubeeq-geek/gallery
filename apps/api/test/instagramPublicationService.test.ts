import type { InstagramPublication } from '../src/instagramIntegration';
import { InstagramPublicationService, type InstagramPublicationRepository } from '../src/instagramPublicationService';
import { InstagramProvider } from '../src/instagramProvider';

const publication: InstagramPublication = { publicationId: 'pub-1', workId: 'work-1', connectionId: 'connection-1', placement: 'IMAGE', derivativeIds: ['preview-1'], captionSnapshot: 'Preview', providerVersion: 'v24.0', idempotencyKey: 'key-1', status: 'CONFIRMED', containerIds: [] };
const repository = (initial = publication) => {
  let current = initial;
  return { getById: async () => current, getByIdempotencyKey: async () => undefined, save: async (next: InstagramPublication) => { current = next; }, value: () => current } satisfies InstagramPublicationRepository & { value(): InstagramPublication };
};
const provider = (responses: unknown[]) => new InstagramProvider({ appId: 'a', appSecret: 's', redirectUri: 'https://example.test', apiVersion: 'v24.0', graphBaseUrl: 'https://graph.test', approvedCapabilities: {} }, (async () => new Response(JSON.stringify(responses.shift()), { status: 200 })) as typeof fetch);

describe('Instagram publication service', () => {
  it('does not create a second container when a retry sees the persisted first id', async () => {
    const repo = repository(); const service = new InstagramPublicationService(repo, provider([{ id: 'container-1' }]));
    await service.createContainer('pub-1', 'token', 'account', { placement: 'IMAGE', mediaUrl: 'https://delivery.test/token' });
    await service.createContainer('pub-1', 'token', 'account', { placement: 'IMAGE', mediaUrl: 'https://delivery.test/token' });
    expect(repo.value().containerIds).toEqual(['container-1']);
  });
  it('publishes a ready container once and makes subsequent retries no-ops', async () => {
    const repo = repository({ ...publication, status: 'CONTAINER_PROCESSING', containerIds: ['container-1'] });
    const service = new InstagramPublicationService(repo, provider([{ status_code: 'FINISHED' }, { id: 'media-1' }]));
    expect((await service.reconcileAndPublish('pub-1', 'token', 'account')).remoteMediaId).toBe('media-1');
    expect((await service.reconcileAndPublish('pub-1', 'token', 'account')).remoteMediaId).toBe('media-1');
  });
  it('holds unknown container states for reconciliation instead of republishing', async () => {
    const repo = repository({ ...publication, status: 'CONTAINER_PROCESSING', containerIds: ['container-1'] });
    const service = new InstagramPublicationService(repo, provider([{ status_code: 'MYSTERY' }]));
    expect((await service.reconcileAndPublish('pub-1', 'token', 'account')).status).toBe('UNKNOWN');
  });
});
