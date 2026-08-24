import type { AppConfig } from './config';
import { TumblrApiClient, TumblrApiError, evaluateTumblrEligibility, type TumblrContentDeclarations, type TumblrNpfPost, type TumblrPolicyRule } from './tumblrIntegration';
import { decryptTumblrCreatorApplication, decryptTumblrOAuthGrant, encryptTumblrOAuthGrant, type TumblrOAuthGrant, type TumblrRepository } from './tumblrRepository';
import type { TumblrPublishQueue } from './tumblrPublishQueue';

const managedCredentials = (config: AppConfig) => {
  if (!config.tumblrClientId || !config.tumblrClientSecret || !config.tumblrOAuthRedirectUri) throw new Error('Managed Tumblr OAuth is not configured.');
  return { clientId: config.tumblrClientId, clientSecret: config.tumblrClientSecret, redirectUri: config.tumblrOAuthRedirectUri };
};

const rules = (config: AppConfig): TumblrPolicyRule[] => {
  const value = config.tumblrPolicyRulesJson ? JSON.parse(config.tumblrPolicyRulesJson) : [];
  if (!Array.isArray(value)) throw new Error('Tumblr policy configuration is invalid.');
  return value as TumblrPolicyRule[];
};

const remoteResult = (payload: Record<string, unknown>) => {
  const id = typeof payload.id_string === 'string' ? payload.id_string : typeof payload.id === 'string' || typeof payload.id === 'number' ? String(payload.id) : '';
  if (!id) throw new Error('Tumblr did not return a post ID.');
  const url = typeof payload.post_url === 'string' ? payload.post_url : typeof payload.url === 'string' ? payload.url : undefined;
  return { id, url };
};

const usableGrant = async (repository: TumblrRepository, config: AppConfig, connector: NonNullable<Awaited<ReturnType<TumblrRepository['getConnector']>>>, application: ReturnType<typeof managedCredentials>): Promise<TumblrOAuthGrant> => {
  const grant = decryptTumblrOAuthGrant(connector, config.externalTokenEncryptionKey || '');
  if (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now() + 60_000) return grant;
  if (!grant.refreshToken) throw new TumblrApiError('Tumblr authorization has expired and cannot be refreshed.', 401);
  const refreshed = await new TumblrApiClient(application, config.tumblrApiBaseUrl).refreshAccessToken(grant.refreshToken);
  const next: TumblrOAuthGrant = { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken || grant.refreshToken, expiresAt: refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString() : undefined, scopes: refreshed.scopes.length ? refreshed.scopes : grant.scopes };
  await repository.putConnector({ ...connector, credentialsEncrypted: encryptTumblrOAuthGrant(next, config.externalTokenEncryptionKey || ''), scopes: next.scopes, status: 'connected', lastValidatedAt: new Date().toISOString() });
  return next;
};

/** Executes one durable publication snapshot; canonical Work data is never mutated. */
export const processTumblrPublication = async (repository: TumblrRepository, config: AppConfig, publicationId: string, queue?: TumblrPublishQueue): Promise<void> => {
  const publication = await repository.getPublication(config.tenantId, publicationId);
  if (!publication || publication.status === 'deleted' || publication.status === 'published' || publication.status === 'queued' || publication.status === 'draft' || publication.status === 'private') return;
  const connector = await repository.getConnector(config.tenantId, publication.connectorId);
  const destination = await repository.getDestination(config.tenantId, publication.destinationId);
  if (!connector || connector.creatorId !== publication.creatorId || connector.status !== 'connected' || !destination || destination.connectorId !== connector.id || destination.creatorId !== publication.creatorId || !destination.enabled) {
    await repository.putPublication({ ...publication, status: 'failed', responseSnapshot: { errorType: 'permission', message: 'Tumblr connector or destination is unavailable.' }, updatedAt: new Date().toISOString() });
    return;
  }
  const snapshot = publication.requestSnapshot || {};
  const declarations = snapshot.declarations && typeof snapshot.declarations === 'object' ? snapshot.declarations as TumblrContentDeclarations : {};
  const eligibility = evaluateTumblrEligibility(declarations, connector.ownership, rules(config));
  if (!eligibility.allowed) {
    await repository.putPublication({ ...publication, status: 'failed', responseSnapshot: { errorType: 'policy', eligibility }, updatedAt: new Date().toISOString() });
    console.info('[tumblr-audit]', JSON.stringify({ action: 'tumblr.eligibility.denied', publicationId, creatorId: publication.creatorId, eligibility: eligibility.eligibility }));
    return;
  }
  const npf = snapshot.npf as TumblrNpfPost | undefined;
  if (!npf || !Array.isArray(npf.content)) {
    await repository.putPublication({ ...publication, status: 'failed', responseSnapshot: { errorType: 'validation', message: 'Stored Tumblr request snapshot is invalid.' }, updatedAt: new Date().toISOString() });
    return;
  }
  const application = connector.ownership === 'creator_owned' ? decryptTumblrCreatorApplication(connector, config.externalTokenEncryptionKey || '') : managedCredentials(config);
  const attempt = typeof snapshot.deliveryAttempt === 'number' ? snapshot.deliveryAttempt + 1 : 1;
  if (!(await repository.consumeQuota(application.clientId, new Date(), config.tumblrHourlyRequestLimit, config.tumblrDailyRequestLimit))) {
    const delaySeconds = Math.min(3600, config.tumblrRetryBaseDelaySeconds * (2 ** Math.max(0, attempt - 1)));
    const retryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    const canRetry = Boolean(queue && attempt < config.tumblrPublishMaxAttempts);
    await repository.putPublication({ ...publication, status: canRetry ? 'pending' : 'failed', requestSnapshot: { ...snapshot, deliveryAttempt: attempt }, responseSnapshot: { errorType: 'rate_limit', retryable: canRetry, ...(canRetry ? { retryAt } : {}), message: 'Tumblr consumer quota is temporarily exhausted.' }, updatedAt: new Date().toISOString() });
    if (canRetry) await queue!.enqueue(publication.id, delaySeconds);
    return;
  }
  await repository.putPublication({ ...publication, status: 'publishing', requestSnapshot: { ...snapshot, deliveryAttempt: attempt }, updatedAt: new Date().toISOString() });
  try {
    const grant = await usableGrant(repository, config, connector, application);
    const result = remoteResult(await new TumblrApiClient(application, config.tumblrApiBaseUrl).createPost(destination.identifier, npf, grant.accessToken));
    const now = new Date().toISOString();
    const status = npf.state === 'queue' ? 'queued' : npf.state === 'draft' ? 'draft' : npf.state === 'private' ? 'private' : 'published';
    await repository.putPublication({ ...publication, status, tumblrPostId: result.id, tumblrPostUrl: result.url, responseSnapshot: { postId: result.id, postUrl: result.url }, publishedAt: status === 'published' ? now : undefined, updatedAt: now });
    console.info('[tumblr-audit]', JSON.stringify({ action: 'tumblr.publish.completed', publicationId, creatorId: publication.creatorId, destinationId: destination.id, postId: result.id, status }));
  } catch (error) {
    const apiError = error instanceof TumblrApiError ? error : undefined;
    const retryable = apiError?.retryable || error instanceof TypeError;
    const errorType = apiError?.errorType || (error instanceof TypeError ? 'network' : 'unknown');
    if (retryable && attempt < config.tumblrPublishMaxAttempts && queue) {
      const delaySeconds = Math.min(3600, apiError?.retryAfterSeconds || config.tumblrRetryBaseDelaySeconds * (2 ** Math.max(0, attempt - 1)));
      const retryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      await repository.putPublication({ ...publication, status: 'pending', requestSnapshot: { ...snapshot, deliveryAttempt: attempt }, responseSnapshot: { errorType, retryable: true, retryAt, message: error instanceof Error ? error.message : 'Tumblr publishing failed.' }, updatedAt: new Date().toISOString() });
      await queue.enqueue(publication.id, delaySeconds);
      return;
    }
    if (errorType === 'auth') await repository.putConnector({ ...connector, status: 'expired', lastValidatedAt: new Date().toISOString() });
    await repository.putPublication({ ...publication, status: 'failed', requestSnapshot: { ...snapshot, deliveryAttempt: attempt }, responseSnapshot: { errorType, retryable: false, message: error instanceof Error ? error.message : 'Tumblr publishing failed.' }, updatedAt: new Date().toISOString() });
    console.info('[tumblr-audit]', JSON.stringify({ action: 'tumblr.publish.failed', publicationId, creatorId: publication.creatorId, destinationId: destination.id, errorType, attempt }));
  }
};
