import { externalContentUpdateMismatches, MAX_AMBIGUOUS_PUBLISH_ATTEMPTS, mergeExternalMetadata, processExternalSyncJob, retryDelaySeconds, shouldRetryExternalJobFailure } from '../src/externalSyncWorker';
import { createExternalPlatformProvider, parseRetryAfterSeconds, type ExternalRemoteContent } from '../src/externalPlatformProvider';
import { InMemoryStore } from '../src/inMemoryStore';
import { encryptExternalCredential } from '../src/externalCredentials';
import type { AppConfig } from '../src/config';

const remoteContent = (overrides: Partial<ExternalRemoteContent> = {}): ExternalRemoteContent => ({
  externalContentId: 'deviation-1',
  title: 'Updated title',
  description: '<p>Updated <strong>description</strong></p>',
  tags: ['history', 'airship'],
  assetType: 'image',
  collectionExternalIds: [],
  rawMetadata: {
    allow_comments: false,
    is_mature: true,
    mature_level: 'moderate',
    mature_classification: ['ideology'],
    is_ai_generated: true,
    noai: true
  },
  ...overrides
});

describe('external metadata update verification', () => {
  it('leases refresh-token rotation so only one worker can spend a token', async () => {
    const store = new InMemoryStore();
    const expires = Math.floor(Date.now() / 1000) + 30;
    await expect(store.acquireExternalAccountRefreshLease('account-1', 'worker-1', expires)).resolves.toBe(true);
    await expect(store.acquireExternalAccountRefreshLease('account-1', 'worker-2', expires)).resolves.toBe(false);
    await store.releaseExternalAccountRefreshLease('account-1', 'worker-2');
    await expect(store.acquireExternalAccountRefreshLease('account-1', 'worker-2', expires)).resolves.toBe(false);
    await store.releaseExternalAccountRefreshLease('account-1', 'worker-1');
    await expect(store.acquireExternalAccountRefreshLease('account-1', 'worker-2', expires)).resolves.toBe(true);
  });

  it('imports SoundCloud tracks as metadata-only audio Works without canonical source Assets', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    const encryptionKey = 'soundcloud-worker-key';
    await store.createExternalPlatformCredential({
      externalPlatformCredentialId: 'sc-credential', userId: 'sc-user', platform: 'soundcloud', clientId: 'client',
      clientSecretEncrypted: encryptExternalCredential('secret', encryptionKey), redirectUri: 'https://studio.example/integrations/soundcloud/callback', createdAt: now, updatedAt: now
    });
    await store.createExternalAccount({
      externalAccountId: 'sc-account', userId: 'sc-user', creatorIdentityId: 'sc-creator', primaryCreatorIdentityId: 'sc-creator',
      externalPlatformCredentialId: 'sc-credential', platform: 'soundcloud', externalUserId: 'soundcloud:users:1', externalUsername: 'artist',
      accessTokenEncrypted: encryptExternalCredential('token', encryptionKey), connectionStatus: 'connected', includeSourceFilesOnSync: false, createdAt: now, updatedAt: now
    });
    await store.createExternalSyncJob({ externalSyncJobId: 'sc-import', externalAccountId: 'sc-account', type: 'account_import', status: 'queued', payload: { syncContent: true }, attemptCount: 0, createdAt: now, updatedAt: now });
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => ({ collection: [] }), headers: { get: () => null } } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ collection: [{ urn: 'soundcloud:tracks:1', title: 'External track', permalink_url: 'https://soundcloud.com/artist/track', tag_list: 'ambient' }] }), headers: { get: () => null } } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ urn: 'soundcloud:tracks:1', title: 'External track', permalink_url: 'https://soundcloud.com/artist/track', tag_list: 'ambient' }), headers: { get: () => null } } as unknown as Response);
    const queue = { enqueue: jest.fn(async () => undefined) };

    await processExternalSyncJob(store, { tenantId: 'test', externalTokenEncryptionKey: encryptionKey, externalSyncBaseDelaySeconds: 1, soundCloudEnabled: true } as AppConfig, 'sc-import', queue);

    const [work] = await store.listWorksByCreator('test', 'sc-creator');
    expect(work).toMatchObject({ kind: 'audio', status: 'draft', primaryAssetId: undefined, origin: { platform: 'soundcloud', remoteId: 'soundcloud:tracks:1' } });
    expect(await store.getCanonicalAsset('test', `${work.workId}:remote`)).toBeNull();
    expect((await store.listPublicationsByWork('test', work.workId))[0]).toMatchObject({ destination: 'soundcloud', remoteId: 'soundcloud:tracks:1' });
    expect((await store.listExternalSyncJobs('sc-account')).some((job) => job.type === 'content_sync')).toBe(false);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/streams') || String(url).includes('/download'))).toBe(false);
    const activityJob = (await store.listExternalSyncJobs('sc-account')).find((job) => job.type === 'activity_sync')!;
    fetchSpy
      .mockResolvedValueOnce({ ok: true, json: async () => ({ urn: 'soundcloud:users:1', username: 'artist', permalink_url: 'https://soundcloud.com/artist' }), headers: { get: () => null } } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ collection: [{ type: 'track-like', created_at: now, user: { urn: 'soundcloud:users:2', username: 'fan' }, track: { urn: 'soundcloud:tracks:1', title: 'External track' } }] }), headers: { get: () => null } } as unknown as Response);
    await processExternalSyncJob(store, { tenantId: 'test', externalTokenEncryptionKey: encryptionKey, externalSyncBaseDelaySeconds: 1, soundCloudEnabled: true } as AppConfig, activityJob.externalSyncJobId, queue);
    expect((await store.listExternalActivitiesByPublication((await store.listExternalPublications('sc-account'))[0].externalPublicationId))[0]).toMatchObject({ type: 'favourite', externalActorName: 'fan' });
    jest.restoreAllMocks();
  });

  it('paces consecutive DeviantArt API requests before relying on 429 backoff', async () => {
    jest.useFakeTimers({ now: 0 });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ userid: 'owner-1', username: 'owner' }),
      headers: { get: () => null }
    } as unknown as Response);
    const provider = createExternalPlatformProvider('deviantart', {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://localhost/callback',
      minimumRequestIntervalMs: 2_000
    });

    await provider.getAccount('access-token');
    const secondRequest = provider.getAccount('access-token');
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await secondRequest;
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('parses Retry-After seconds and dates and applies bounded jittered backoff', () => {
    expect(parseRetryAfterSeconds('90', 1_000)).toBe(90);
    expect(parseRetryAfterSeconds(new Date(121_000).toUTCString(), 1_000)).toBe(120);
    expect(parseRetryAfterSeconds('not-a-date', 1_000)).toBeUndefined();
    expect(retryDelaySeconds(1, 60, () => 0)).toBe(60);
    expect(retryDelaySeconds(2, 60, () => 0)).toBe(60);
    expect(retryDelaySeconds(2, 60, () => 0.999999)).toBe(120);
  });

  it('blocks a job before provider access when the owning Creator has an active review hold', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    await store.createExternalAccount({
      externalAccountId: 'account-held-creator', userId: 'user-1', creatorIdentityId: 'creator-held', primaryCreatorIdentityId: 'creator-held',
      externalPlatformCredentialId: 'credential-held-creator', platform: 'deviantart', externalUserId: 'owner-1', externalUsername: 'owner',
      accessTokenEncrypted: 'unused-before-policy', connectionStatus: 'connected', createdAt: now, updatedAt: now
    });
    await store.upsertIntegrationReviewHold({
      integrationReviewHoldId: 'hold-creator', targetType: 'creator', targetId: 'creator-held', holdType: 'manual_review',
      reason: 'Awaiting safety review', active: true, createdAt: now
    });
    await store.createExternalSyncJob({
      externalSyncJobId: 'job-held-creator', externalAccountId: 'account-held-creator', type: 'account_scan', status: 'queued',
      attemptCount: 0, createdAt: now, updatedAt: now
    });
    const fetchSpy = jest.spyOn(global, 'fetch');

    await processExternalSyncJob(store, {} as AppConfig, 'job-held-creator');

    expect(await store.getExternalSyncJob('job-held-creator')).toMatchObject({
      status: 'failed', errorCode: 'SAFETY_HOLD', errorMessage: expect.stringContaining('Awaiting safety review')
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('retries a missing Sta.sh item ID three total times, then requires attention', async () => {
    expect(shouldRetryExternalJobFailure('publish', 'ambiguous_submission', 1)).toBe(true);
    expect(shouldRetryExternalJobFailure('publish', 'ambiguous_submission', 2)).toBe(true);
    expect(shouldRetryExternalJobFailure('publish', 'ambiguous_submission', MAX_AMBIGUOUS_PUBLISH_ATTEMPTS)).toBe(false);
    expect(shouldRetryExternalJobFailure('publish', 'invalid_response', 1)).toBe(false);

    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '{}',
      headers: { get: () => null }
    } as unknown as Response);
    const provider = createExternalPlatformProvider('deviantart', {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://localhost/callback'
    });

    await expect(provider.submitContent('access-token', {
      body: Buffer.from('image'),
      filename: 'work.png',
      contentType: 'image/png',
      title: 'Work'
    })).rejects.toMatchObject({ code: 'ambiguous_submission' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  it('pauses an account and its queued source copies after the first 429', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    const encryptionKey = 'worker-rate-limit-test-key';
    await store.createExternalPlatformCredential({
      externalPlatformCredentialId: 'credential-rate-limit', userId: 'user-1', platform: 'deviantart', clientId: 'client-id',
      clientSecretEncrypted: encryptExternalCredential('client-secret', encryptionKey),
      redirectUri: 'http://localhost:4000/integrations/deviantart/callback', createdAt: now, updatedAt: now
    });
    await store.createExternalAccount({
      externalAccountId: 'account-rate-limit', userId: 'user-1', creatorIdentityId: 'creator-1', primaryCreatorIdentityId: 'creator-1',
      externalPlatformCredentialId: 'credential-rate-limit', platform: 'deviantart', externalUserId: 'owner-1', externalUsername: 'owner',
      accessTokenEncrypted: encryptExternalCredential('access-token', encryptionKey), connectionStatus: 'connected', createdAt: now, updatedAt: now
    });
    await store.createAsset({
      assetId: 'asset-rate-limit', userId: 'user-1', creatorIdentityId: 'creator-1', assetType: 'image', canonicalTitle: 'Rate-limited work',
      visibility: 'private', titleSyncPolicy: 'initially_mirrored', descriptionSyncPolicy: 'initially_mirrored', createdAt: now, updatedAt: now
    });
    await store.createExternalPublication({
      externalPublicationId: 'publication-rate-limit', assetId: 'asset-rate-limit', externalAccountId: 'account-rate-limit', platform: 'deviantart',
      externalContentId: 'deviation-rate-limit', syncStatus: 'active', rawMetadataJson: {}, createdAt: now, updatedAt: now
    });
    for (const externalSyncJobId of ['content-rate-limit-1', 'content-rate-limit-2']) {
      await store.createExternalSyncJob({
        externalSyncJobId, externalAccountId: 'account-rate-limit', type: 'content_sync', status: 'queued', attemptCount: 0,
        payload: { assetId: 'asset-rate-limit', externalPublicationId: 'publication-rate-limit' }, createdAt: now, updatedAt: now
      });
    }
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: 'rate_limit', error_description: 'Slow down' }),
      headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? '120' : null }
    } as unknown as Response);

    await processExternalSyncJob(store, {
      externalTokenEncryptionKey: encryptionKey,
      externalSyncBaseDelaySeconds: 60
    } as AppConfig, 'content-rate-limit-1');

    expect(await store.getExternalAccount('account-rate-limit')).toMatchObject({
      connectionStatus: 'rate_limited',
      rateLimitedUntil: expect.any(String)
    });
    expect(await store.getExternalSyncJob('content-rate-limit-1')).toMatchObject({ status: 'rate_limited', errorCode: 'rate_limited' });
    expect(await store.getExternalSyncJob('content-rate-limit-2')).toMatchObject({ status: 'rate_limited', errorCode: 'ACCOUNT_RATE_LIMITED' });
    expect(await store.getSpacePublication('asset-rate-limit')).toMatchObject({ contentSyncStatus: 'queued' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await processExternalSyncJob(store, {
      externalTokenEncryptionKey: encryptionKey,
      externalSyncBaseDelaySeconds: 60
    } as AppConfig, 'content-rate-limit-2');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  it('starts a fresh Creator import when a DeviantArt account is reassigned', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    const encryptionKey = 'worker-creator-reassignment-test-key';
    await store.createExternalPlatformCredential({
      externalPlatformCredentialId: 'credential-reassignment', userId: 'user-1', platform: 'deviantart', clientId: 'client-id',
      clientSecretEncrypted: encryptExternalCredential('client-secret', encryptionKey),
      redirectUri: 'http://localhost:4000/integrations/deviantart/callback', createdAt: now, updatedAt: now
    });
    await store.createExternalAccount({
      externalAccountId: 'account-reassignment', userId: 'user-1', creatorIdentityId: 'creator-new', primaryCreatorIdentityId: 'creator-new',
      externalPlatformCredentialId: 'credential-reassignment', platform: 'deviantart', externalUserId: 'owner-1', externalUsername: 'owner',
      accessTokenEncrypted: encryptExternalCredential('access-token', encryptionKey), connectionStatus: 'connected', createdAt: now, updatedAt: now
    });
    await store.createAsset({
      assetId: 'asset-old-creator', userId: 'user-1', creatorIdentityId: 'creator-old', assetType: 'image', canonicalTitle: 'Reassigned work',
      visibility: 'private', titleSyncPolicy: 'initially_mirrored', descriptionSyncPolicy: 'initially_mirrored', createdAt: now, updatedAt: now
    });
    await store.createWork({
      workId: 'asset-old-creator', tenantId: 'tenant-1', creatorId: 'creator-old', kind: 'image', title: 'Reassigned work', slug: 'reassigned-work',
      slugHistory: ['reassigned-work'], description: 'Old Creator copy', tags: ['old'], contentRating: 'general', aiDisclosure: 'none', heavyTopics: [], status: 'draft',
      origin: { type: 'import', platform: 'deviantart', integrationAccountId: 'account-reassignment', remoteId: 'deviation-reassigned', importedAt: now },
      revision: 1, createdAt: now, updatedAt: now
    });
    await store.createExternalPublication({
      externalPublicationId: 'publication-reassignment', assetId: 'asset-old-creator', externalAccountId: 'account-reassignment', platform: 'deviantart',
      externalContentId: 'deviation-reassigned', syncStatus: 'active', rawMetadataJson: {}, createdAt: now, updatedAt: now
    });
    await store.createExternalSyncJob({
      externalSyncJobId: 'account-import-reassignment', externalAccountId: 'account-reassignment', type: 'full_reconciliation', status: 'queued',
      progress: { discovered: 0, synchronized: 0, remaining: 0 }, attemptCount: 0, createdAt: now, updatedAt: now
    });
    await store.createExternalSyncJob({
      externalSyncJobId: 'old-source-copy-reassignment', externalAccountId: 'account-reassignment', type: 'content_sync', status: 'queued',
      payload: { assetId: 'asset-old-creator', externalPublicationId: 'publication-reassignment' }, attemptCount: 0, createdAt: now, updatedAt: now
    });

    const completeItem = {
      deviationid: 'deviation-reassigned', title: 'Reassigned work', url: 'https://www.deviantart.com/owner/art/reassigned-work-1',
      description: 'New Creator copy', tags: ['new'], is_mature: false, allows_comments: true, is_ai_generated: false, noai: false, published_time: 1786637885
    };
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const requestUrl = new URL(String(input));
      const ok = (payload: Record<string, unknown>) => ({ ok: true, status: 200, json: async () => payload, headers: { get: () => null } } as unknown as Response);
      if (requestUrl.pathname.endsWith('/gallery/folders')) return ok({ results: [], has_more: false });
      if (requestUrl.pathname.endsWith('/gallery/all')) return ok({ results: [completeItem], has_more: false });
      throw new Error(`Unexpected test request: ${requestUrl.pathname}`);
    });

    await processExternalSyncJob(store, {
      tenantId: 'tenant-1', externalTokenEncryptionKey: encryptionKey, externalSyncBaseDelaySeconds: 60
    } as AppConfig, 'account-import-reassignment', { enqueue: jest.fn(async () => undefined) });

    const publication = await store.getExternalPublication('account-reassignment', 'deviation-reassigned');
    expect(publication?.assetId).not.toBe('asset-old-creator');
    expect(await store.getAsset(publication!.assetId)).toMatchObject({ creatorIdentityId: 'creator-new' });
    expect(await store.getWork('tenant-1', 'asset-old-creator')).toMatchObject({ creatorId: 'creator-old', title: 'Reassigned work', description: 'Old Creator copy' });
    expect((await store.listWorksByCreator('tenant-1', 'creator-new'))).toEqual([
      expect.objectContaining({ workId: publication!.assetId, creatorId: 'creator-new', description: 'New Creator copy', tags: ['new'] })
    ]);
    expect(await store.getExternalSyncJob('old-source-copy-reassignment')).toMatchObject({ status: 'cancelled', errorCode: 'CREATOR_REASSIGNED' });
    expect(await store.getPublication('tenant-1', 'publication-reassignment')).toMatchObject({ creatorId: 'creator-new', workId: publication!.assetId });
    expect(fetchSpy).toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('accepts semantically equivalent HTML and normalized tag order', () => {
    expect(externalContentUpdateMismatches(remoteContent(), {
      title: 'Updated title',
      description: 'Updated <strong>description</strong>',
      tags: ['airship', 'history'],
      allowComments: false,
      isMature: true,
      matureLevel: 'moderate',
      matureClassification: ['ideology'],
      isAiGenerated: true,
      noAi: true
    })).toEqual([]);
  });

  it('reports a description that DeviantArt did not apply', () => {
    expect(externalContentUpdateMismatches(remoteContent({ description: '<p>Original description</p>' }), {
      description: '<p>Updated description</p>'
    })).toEqual(['description']);
  });

  it('does not invent a mismatch when DeviantArt omits AI labels from read-back metadata', () => {
    expect(externalContentUpdateMismatches(remoteContent({
      rawMetadata: { allows_comments: false, is_mature: true }
    }), {
      isAiGenerated: true,
      noAi: true
    })).toEqual([]);
  });

  it('retains known nested AI labels when a later DA scan omits them', () => {
    expect(mergeExternalMetadata({
      submission: { is_ai_generated: true, noai: true, mature_level: 'strict' }
    }, {
      submission: { mature_level: 'moderate' },
      title: 'Fresh remote title'
    })).toEqual({
      submission: { is_ai_generated: true, noai: true, mature_level: 'moderate' },
      title: 'Fresh remote title'
    });
  });

  it('moves a pending publication to its published content key without leaving a duplicate', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    const pending = {
      externalPublicationId: 'publication-1',
      assetId: 'asset-1',
      externalAccountId: 'account-1',
      platform: 'deviantart' as const,
      externalContentId: 'pending:asset-1',
      syncStatus: 'pending_publish' as const,
      rawMetadataJson: {},
      createdAt: now,
      updatedAt: now
    };
    await store.createExternalPublication(pending);

    await store.updateExternalPublication({
      ...pending,
      externalContentId: 'deviation-1',
      externalDraftId: '123456',
      syncStatus: 'active',
      updatedAt: new Date().toISOString()
    }, pending.externalContentId);

    expect(await store.getExternalPublication('account-1', 'pending:asset-1')).toBeNull();
    expect((await store.getExternalPublication('account-1', 'deviation-1'))?.externalDraftId).toBe('123456');
    expect(await store.listExternalPublications('account-1')).toHaveLength(1);
  });

  it('stores feedback activity and its comment, then queues an engagement refresh', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    const encryptionKey = 'worker-test-encryption-key';
    await store.createExternalPlatformCredential({
      externalPlatformCredentialId: 'credential-1',
      userId: 'user-1',
      platform: 'deviantart',
      clientId: 'client-id',
      clientSecretEncrypted: encryptExternalCredential('client-secret', encryptionKey),
      redirectUri: 'http://localhost:4000/integrations/deviantart/callback',
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalAccount({
      externalAccountId: 'account-1',
      userId: 'user-1',
      creatorIdentityId: 'creator-1',
      primaryCreatorIdentityId: 'creator-1',
      externalPlatformCredentialId: 'credential-1',
      platform: 'deviantart',
      externalUserId: 'owner-1',
      externalUsername: 'owner',
      accessTokenEncrypted: encryptExternalCredential('access-token', encryptionKey),
      connectionStatus: 'connected',
      createdAt: now,
      updatedAt: now
    });
    await store.createAsset({
      assetId: 'asset-1',
      userId: 'user-1',
      creatorIdentityId: 'creator-1',
      assetType: 'image',
      canonicalTitle: 'Work',
      visibility: 'private',
      titleSyncPolicy: 'initially_mirrored',
      descriptionSyncPolicy: 'initially_mirrored',
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalPublication({
      externalPublicationId: 'publication-1',
      assetId: 'asset-1',
      externalAccountId: 'account-1',
      platform: 'deviantart',
      externalContentId: 'deviation-1',
      syncStatus: 'active',
      rawMetadataJson: {},
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalSyncJob({
      externalSyncJobId: 'activity-job-1',
      externalAccountId: 'account-1',
      type: 'activity_sync',
      status: 'queued',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    });
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user: { userid: 'owner-1', username: 'owner', stats: { watchers: 1, friends: 0 } }, profile_url: 'https://www.deviantart.com/owner', stats: { user_deviations: 1, profile_pageviews: 10 } }),
        headers: { get: () => null }
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [{ messageid: 'message-1', type: 'comment', ts: 1786637885, originator: { userid: 'visitor-1', username: 'visitor' }, subject: { deviation: { deviationid: 'deviation-1' }, comment: { commentid: 'comment-1', body: 'Hello', posted: 1786637885 } } }], has_more: false }),
        headers: { get: () => null }
      } as unknown as Response)
      .mockResolvedValue({
        ok: true,
        json: async () => ({ results: [], has_more: false }),
        headers: { get: () => null }
      } as unknown as Response);
    const queue = { enqueue: jest.fn(async () => undefined) };
    const config = {
      externalTokenEncryptionKey: encryptionKey,
      externalSyncBaseDelaySeconds: 60
    } as AppConfig;

    await processExternalSyncJob(store, config, 'activity-job-1', queue);

    expect((await store.listExternalActivitiesByPublication('publication-1'))[0]).toMatchObject({
      remoteActivityId: 'comment:comment-1',
      externalActorName: 'visitor',
      type: 'comment'
    });
    expect((await store.listExternalComments('publication-1'))[0]).toMatchObject({
      externalCommentExternalId: 'comment-1',
      body: 'Hello'
    });
    expect(await store.getExternalSyncCheckpoint('account-1', 'feedback.comments', 'account-1')).toMatchObject({
      lastRemoteId: 'comment:comment-1'
    });
    expect((await store.listExternalSyncJobs('account-1')).some((job) => job.type === 'engagement_sync')).toBe(true);
    jest.restoreAllMocks();
  });

  it('imports the complete message feed, expands mention stacks, and reconciles watcher changes', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    const encryptionKey = 'worker-message-watcher-test-key';
    await store.createExternalPlatformCredential({
      externalPlatformCredentialId: 'credential-audience',
      userId: 'user-1',
      platform: 'deviantart',
      clientId: 'client-id',
      clientSecretEncrypted: encryptExternalCredential('client-secret', encryptionKey),
      redirectUri: 'http://localhost:4000/integrations/deviantart/callback',
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalAccount({
      externalAccountId: 'account-audience',
      userId: 'user-1',
      creatorIdentityId: 'creator-1',
      primaryCreatorIdentityId: 'creator-1',
      externalPlatformCredentialId: 'credential-audience',
      platform: 'deviantart',
      externalUserId: 'owner-1',
      externalUsername: 'owner',
      accessTokenEncrypted: encryptExternalCredential('access-token', encryptionKey),
      connectionStatus: 'connected',
      createdAt: now,
      updatedAt: now
    });
    await store.createAsset({
      assetId: 'asset-audience',
      userId: 'user-1',
      creatorIdentityId: 'creator-1',
      assetType: 'image',
      canonicalTitle: 'Mentioned work',
      visibility: 'private',
      titleSyncPolicy: 'initially_mirrored',
      descriptionSyncPolicy: 'initially_mirrored',
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalPublication({
      externalPublicationId: 'publication-audience',
      assetId: 'asset-audience',
      externalAccountId: 'account-audience',
      platform: 'deviantart',
      externalContentId: 'deviation-audience',
      syncStatus: 'active',
      rawMetadataJson: {},
      createdAt: now,
      updatedAt: now
    });

    let watcherScan = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.pathname.endsWith('/user/profile/owner')) {
        return {
          ok: true,
          json: async () => ({
            user: { userid: 'owner-1', username: 'owner', usericon: 'https://a.deviantart.net/avatar.png', details: { joindate: 1500000000 }, stats: { watchers: 2, friends: 1 } },
            profile_url: 'https://www.deviantart.com/owner',
            tagline: 'Creator profile',
            stats: { user_deviations: 4, user_favourites: 5, user_comments: 6, profile_pageviews: 7, profile_comments: 8 }
          }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      if (requestUrl.pathname.endsWith('/messages/feed')) {
        return {
          ok: true,
          json: async () => ({
            results: [{ messageid: 'feed-message-1', type: 'badge_given', ts: 1786637885, originator: { userid: 'visitor-feed', username: 'feed-user' } }],
            has_more: false,
            cursor: 'feed-cursor-1'
          }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      if (requestUrl.pathname.endsWith('/messages/mentions/mention-stack')) {
        return {
          ok: true,
          json: async () => ({
            results: [
              { messageid: 'mention-1', type: 'mention', ts: 1786637886, stackid: 'mention-stack', originator: { userid: 'visitor-mention-1', username: 'mention-one' }, subject: { deviation: { deviationid: 'deviation-audience' } } },
              { messageid: 'mention-2', type: 'mention', ts: 1786637887, stackid: 'mention-stack', originator: { userid: 'visitor-mention-2', username: 'mention-two' }, subject: { deviation: { deviationid: 'deviation-audience' } } }
            ],
            has_more: false,
            next_offset: null
          }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      if (requestUrl.pathname.endsWith('/messages/mentions')) {
        return {
          ok: true,
          json: async () => ({
            results: [{ messageid: 'mention-summary', type: 'mention', stackid: 'mention-stack', stack_count: 2, is_new: true }],
            has_more: false,
            next_offset: null
          }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      if (requestUrl.pathname.includes('/user/watchers/owner')) {
        watcherScan += 1;
        const users = watcherScan === 1
          ? [{ userid: 'watcher-a', username: 'alpha' }, { userid: 'watcher-b', username: 'beta' }]
          : [{ userid: 'watcher-a', username: 'alpha' }, { userid: 'watcher-c', username: 'charlie' }];
        return {
          ok: true,
          json: async () => ({
            results: users.map((user) => ({ user, is_watching: true, lastvisit: null, watch: { deviations: true } })),
            has_more: false,
            next_offset: null
          }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      if (requestUrl.pathname.endsWith('/messages/feedback')) {
        return {
          ok: true,
          json: async () => ({ results: [], has_more: false, next_offset: null }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      throw new Error(`Unexpected test request: ${requestUrl.pathname}`);
    });

    const queue = { enqueue: jest.fn(async () => undefined) };
    const config = { externalTokenEncryptionKey: encryptionKey, externalSyncBaseDelaySeconds: 60 } as AppConfig;
    for (const jobId of ['activity-audience-baseline', 'activity-audience-reconcile']) {
      await store.createExternalSyncJob({
        externalSyncJobId: jobId,
        externalAccountId: 'account-audience',
        type: 'activity_sync',
        status: 'queued',
        attemptCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      await processExternalSyncJob(store, config, jobId, queue);
    }

    const watchers = await store.listExternalWatchers('account-audience');
    expect(watchers.find((watcher) => watcher.externalUserId === 'watcher-a')).toMatchObject({ active: true, stateVersion: 0 });
    expect(watchers.find((watcher) => watcher.externalUserId === 'watcher-b')).toMatchObject({ active: false, stateVersion: 1 });
    expect(watchers.find((watcher) => watcher.externalUserId === 'watcher-c')).toMatchObject({ active: true, stateVersion: 1 });
    const activities = await store.listExternalActivitiesByAccount('account-audience', 100);
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ remoteActivityId: 'message:feed-message-1', type: 'activity', externalActorName: 'feed-user' }),
      expect.objectContaining({ remoteActivityId: 'message:mention-1', remoteMessageId: 'mention-1', type: 'mention', remoteStackId: 'mention-stack', externalPublicationId: 'publication-audience' }),
      expect.objectContaining({ remoteActivityId: 'message:mention-2', remoteMessageId: 'mention-2', type: 'mention', remoteStackId: 'mention-stack', externalPublicationId: 'publication-audience' }),
      expect.objectContaining({ type: 'watch', externalActorName: 'charlie' }),
      expect.objectContaining({ type: 'unwatch', externalActorName: 'beta' })
    ]));
    expect(activities.some((activity) => activity.externalActorName === 'alpha' && activity.type === 'watch')).toBe(false);
    expect(await store.getExternalSyncCheckpoint('account-audience', 'messages.feed', 'account-audience')).toMatchObject({
      lastRemoteId: 'message:feed-message-1'
    });
    expect(await store.getExternalSyncCheckpoint('account-audience', 'watchers', 'account-audience')).toMatchObject({
      lastSuccessfulSyncAt: expect.any(String),
      summary: { activeCount: 2, added: 1, removed: 1, truncated: false }
    });
    expect(await store.getExternalAccountProfile('account-audience')).toMatchObject({
      profileUrl: 'https://www.deviantart.com/owner',
      tagline: 'Creator profile',
      stats: { watchers: 2, profilePageviews: 7, profileComments: 8 }
    });
    expect(await store.listExternalAccountProfileSnapshots('account-audience')).toHaveLength(1);
    jest.restoreAllMocks();
  });

  it('prefers the DeviantArt original download when creating a Space backup', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    const encryptionKey = 'worker-original-download-test-key';
    await store.createExternalPlatformCredential({
      externalPlatformCredentialId: 'credential-original',
      userId: 'user-1',
      platform: 'deviantart',
      clientId: 'client-id',
      clientSecretEncrypted: encryptExternalCredential('client-secret', encryptionKey),
      redirectUri: 'http://localhost:4000/integrations/deviantart/callback',
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalAccount({
      externalAccountId: 'account-original',
      userId: 'user-1',
      creatorIdentityId: 'creator-1',
      primaryCreatorIdentityId: 'creator-1',
      externalPlatformCredentialId: 'credential-original',
      platform: 'deviantart',
      externalUserId: 'owner-1',
      externalUsername: 'owner',
      accessTokenEncrypted: encryptExternalCredential('access-token', encryptionKey),
      connectionStatus: 'connected',
      createdAt: now,
      updatedAt: now
    });
    await store.createAsset({
      assetId: 'asset-original',
      userId: 'user-1',
      creatorIdentityId: 'creator-1',
      assetType: 'image',
      canonicalTitle: 'Original work',
      visibility: 'private',
      titleSyncPolicy: 'initially_mirrored',
      descriptionSyncPolicy: 'initially_mirrored',
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalPublication({
      externalPublicationId: 'publication-original',
      assetId: 'asset-original',
      externalAccountId: 'account-original',
      platform: 'deviantart',
      externalContentId: 'deviation-original',
      syncStatus: 'active',
      rawMetadataJson: {},
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalSyncJob({
      externalSyncJobId: 'content-original-job',
      externalAccountId: 'account-original',
      type: 'content_sync',
      status: 'queued',
      payload: { assetId: 'asset-original', externalPublicationId: 'publication-original' },
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    });
    await store.createAsset({
      assetId: 'asset-display-copy',
      userId: 'user-1',
      creatorIdentityId: 'creator-1',
      assetType: 'image',
      canonicalTitle: 'Display-copy work',
      visibility: 'private',
      titleSyncPolicy: 'initially_mirrored',
      descriptionSyncPolicy: 'initially_mirrored',
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalPublication({
      externalPublicationId: 'publication-display-copy',
      assetId: 'asset-display-copy',
      externalAccountId: 'account-original',
      platform: 'deviantart',
      externalContentId: 'deviation-display-copy',
      syncStatus: 'active',
      rawMetadataJson: {},
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalSyncJob({
      externalSyncJobId: 'content-display-copy-job',
      externalAccountId: 'account-original',
      type: 'content_sync',
      status: 'queued',
      payload: { assetId: 'asset-display-copy', externalPublicationId: 'publication-display-copy' },
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    });
    const originalBytes = Buffer.from('original-file-bytes');
    const displayBytes = Buffer.from('display-copy-bytes');
    const fetchedUrls: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const requestUrl = new URL(String(input));
      fetchedUrls.push(requestUrl.toString());
      if (requestUrl.pathname.endsWith('/deviation/deviation-original')) {
        return {
          ok: true,
          json: async () => ({ deviationid: 'deviation-original', title: 'Original work', description: 'Description', content: { src: 'https://images.wixmp.com/display.jpg', filesize: 10 } }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      if (requestUrl.pathname.endsWith('/deviation/deviation-display-copy')) {
        return {
          ok: true,
          json: async () => ({ deviationid: 'deviation-display-copy', title: 'Display-copy work', description: 'Description', content: { src: 'https://images.wixmp.com/display-fallback.jpg', filesize: displayBytes.byteLength, content_type: 'image/jpeg' } }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      if (requestUrl.pathname.endsWith('/deviation/metadata')) {
        const deviationId = requestUrl.searchParams.get('deviationids[0]') || 'deviation-original';
        return {
          ok: true,
          json: async () => ({ metadata: [{ deviationid: deviationId, description: 'Description', is_ai_generated: false, noai: false }] }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      if (requestUrl.pathname.endsWith('/deviation/download/deviation-original')) {
        return {
          ok: true,
          json: async () => ({ src: 'https://images.wixmp.com/original.png', filename: 'original.png', filesize: originalBytes.byteLength, width: 1000, height: 800 }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      if (requestUrl.pathname.endsWith('/deviation/download/deviation-display-copy')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid_request', error_description: 'Deviation not downloadable', error_code: 2 }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      if (requestUrl.toString() === 'https://images.wixmp.com/original.png') {
        return {
          ok: true,
          arrayBuffer: async () => originalBytes,
          headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'image/png' : null }
        } as unknown as Response;
      }
      if (requestUrl.toString() === 'https://images.wixmp.com/display-fallback.jpg') {
        return {
          ok: true,
          arrayBuffer: async () => displayBytes,
          headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'image/jpeg' : null }
        } as unknown as Response;
      }
      throw new Error(`Unexpected test request: ${requestUrl}`);
    });

    await processExternalSyncJob(store, {
      externalTokenEncryptionKey: encryptionKey,
      externalSyncBaseDelaySeconds: 60,
      externalContentMaxBytes: 1024 * 1024,
      localMediaDirectory: '/tmp/ubeeq-original-download-test'
    } as AppConfig, 'content-original-job');
    await processExternalSyncJob(store, {
      externalTokenEncryptionKey: encryptionKey,
      externalSyncBaseDelaySeconds: 60,
      externalContentMaxBytes: 1024 * 1024,
      localMediaDirectory: '/tmp/ubeeq-original-download-test'
    } as AppConfig, 'content-display-copy-job');

    expect(await store.getSpacePublication('asset-original')).toMatchObject({
      contentSyncStatus: 'hosted',
      sourceCopyQuality: 'original',
      originalDownloadStatus: 'available',
      hostedByteSize: originalBytes.byteLength
    });
    expect(fetchedUrls).toContain('https://images.wixmp.com/original.png');
    expect(fetchedUrls).not.toContain('https://images.wixmp.com/display.jpg');
    expect(await store.getSpacePublication('asset-display-copy')).toMatchObject({
      contentSyncStatus: 'hosted',
      sourceCopyQuality: 'display_copy',
      originalDownloadStatus: 'not_downloadable',
      hostedByteSize: displayBytes.byteLength
    });
    expect(fetchedUrls).toContain('https://images.wixmp.com/display-fallback.jpg');
    jest.restoreAllMocks();
  });

  it('reconciles comments and favourites across DeviantArt metadata batches', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    const encryptionKey = 'worker-batch-test-encryption-key';
    await store.createExternalPlatformCredential({
      externalPlatformCredentialId: 'credential-batch',
      userId: 'user-1',
      platform: 'deviantart',
      clientId: 'client-id',
      clientSecretEncrypted: encryptExternalCredential('client-secret', encryptionKey),
      redirectUri: 'http://localhost:4000/integrations/deviantart/callback',
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalAccount({
      externalAccountId: 'account-batch',
      userId: 'user-1',
      creatorIdentityId: 'creator-1',
      primaryCreatorIdentityId: 'creator-1',
      externalPlatformCredentialId: 'credential-batch',
      platform: 'deviantart',
      externalUserId: 'owner-1',
      externalUsername: 'owner',
      accessTokenEncrypted: encryptExternalCredential('access-token', encryptionKey),
      connectionStatus: 'connected',
      createdAt: now,
      updatedAt: now
    });
    for (let index = 1; index <= 11; index += 1) {
      await store.createAsset({
        assetId: `asset-${index}`,
        userId: 'user-1',
        creatorIdentityId: 'creator-1',
        assetType: 'image',
        canonicalTitle: `Work ${index}`,
        visibility: 'private',
        titleSyncPolicy: 'initially_mirrored',
        descriptionSyncPolicy: 'initially_mirrored',
        createdAt: now,
        updatedAt: now
      });
      await store.createExternalPublication({
        externalPublicationId: `publication-${index}`,
        assetId: `asset-${index}`,
        externalAccountId: 'account-batch',
        platform: 'deviantart',
        externalContentId: `deviation-${index}`,
        syncStatus: 'active',
        rawMetadataJson: {},
        createdAt: now,
        updatedAt: now
      });
    }
    await store.createExternalSyncJob({
      externalSyncJobId: 'engagement-job-batch',
      externalAccountId: 'account-batch',
      type: 'engagement_sync',
      status: 'queued',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    });
    const metadataBatchSizes: number[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.pathname.endsWith('/deviation/metadata')) {
        const externalContentIds = [...requestUrl.searchParams.entries()]
          .filter(([key]) => key.startsWith('deviationids['))
          .map(([, value]) => value);
        metadataBatchSizes.push(externalContentIds.length);
        return {
          ok: true,
          json: async () => ({ metadata: externalContentIds.map((deviationid) => ({
            deviationid,
            stats: { views: 10, favourites: 1, comments: 1, downloads: 0 }
          })) }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      if (requestUrl.pathname.includes('/comments/deviation/')) {
        const externalContentId = decodeURIComponent(requestUrl.pathname.split('/').pop() || '');
        return {
          ok: true,
          json: async () => ({ thread: [{
            commentid: `comment-${externalContentId}`,
            body: 'Imported comment',
            posted: 1786637885,
            user: { userid: 'visitor-1', username: 'visitor' }
          }], has_more: false }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      if (requestUrl.pathname.endsWith('/deviation/whofaved')) {
        return {
          ok: true,
          json: async () => ({ results: [{
            user: { userid: 'visitor-1', username: 'visitor' },
            time: 1786637885
          }], has_more: false }),
          headers: { get: () => null }
        } as unknown as Response;
      }
      throw new Error(`Unexpected test request: ${requestUrl.pathname}`);
    });

    await processExternalSyncJob(store, {
      externalTokenEncryptionKey: encryptionKey,
      externalSyncBaseDelaySeconds: 60
    } as AppConfig, 'engagement-job-batch');

    expect(metadataBatchSizes).toEqual([10, 1]);
    expect(await store.listExternalComments('publication-11')).toHaveLength(1);
    expect(await store.listExternalFavourites('publication-11')).toHaveLength(1);
    expect(await store.getExternalSyncJob('engagement-job-batch')).toMatchObject({
      status: 'successful',
      progress: { discovered: 11, synchronized: 11, remaining: 0 }
    });
    jest.restoreAllMocks();
  });

  it('reconciles remote gallery membership and marks deleted publications during account import', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    const encryptionKey = 'worker-gallery-lifecycle-test-key';
    await store.createExternalPlatformCredential({
      externalPlatformCredentialId: 'credential-gallery',
      userId: 'user-1',
      platform: 'deviantart',
      clientId: 'client-id',
      clientSecretEncrypted: encryptExternalCredential('client-secret', encryptionKey),
      redirectUri: 'http://localhost:4000/integrations/deviantart/callback',
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalAccount({
      externalAccountId: 'account-gallery',
      userId: 'user-1',
      creatorIdentityId: 'creator-1',
      primaryCreatorIdentityId: 'creator-1',
      externalPlatformCredentialId: 'credential-gallery',
      platform: 'deviantart',
      externalUserId: 'owner-1',
      externalUsername: 'owner',
      accessTokenEncrypted: encryptExternalCredential('access-token', encryptionKey),
      connectionStatus: 'connected',
      createdAt: now,
      updatedAt: now
    });
    await store.createUbeeqCollection({
      ubeeqCollectionId: 'collection-local',
      userId: 'user-1',
      creatorIdentityId: 'creator-1',
      name: 'Portfolio',
      position: 0,
      visibility: 'private',
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalCollection({
      externalCollectionId: 'external-gallery-local',
      externalAccountId: 'account-gallery',
      platform: 'deviantart',
      externalCollectionExternalId: 'folder-remote',
      name: 'Old Portfolio',
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalCollectionMapping({
      externalCollectionMappingId: 'mapping-gallery',
      externalAccountId: 'account-gallery',
      externalCollectionId: 'external-gallery-local',
      ubeeqCollectionId: 'collection-local',
      syncMode: 'continuous',
      createdAt: now,
      updatedAt: now
    });
    await store.createAsset({
      assetId: 'asset-deleted',
      userId: 'user-1',
      creatorIdentityId: 'creator-1',
      assetType: 'image',
      canonicalTitle: 'Deleted remote work',
      visibility: 'private',
      titleSyncPolicy: 'initially_mirrored',
      descriptionSyncPolicy: 'initially_mirrored',
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalPublication({
      externalPublicationId: 'publication-deleted',
      assetId: 'asset-deleted',
      externalAccountId: 'account-gallery',
      platform: 'deviantart',
      externalContentId: 'deviation-deleted',
      syncStatus: 'active',
      rawMetadataJson: {},
      createdAt: now,
      updatedAt: now
    });
    await store.createExternalSyncJob({
      externalSyncJobId: 'account-import-gallery',
      externalAccountId: 'account-gallery',
      type: 'account_import',
      status: 'queued',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    });

    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const requestUrl = new URL(String(input));
      const ok = (payload: Record<string, unknown>) => ({
        ok: true,
        json: async () => payload,
        headers: { get: () => null }
      } as unknown as Response);
      if (requestUrl.pathname.endsWith('/gallery/folders')) {
        return ok({ results: [{ folderid: 'folder-remote', name: 'Portfolio', description: 'Remote portfolio', size: 1 }] });
      }
      if (requestUrl.pathname.endsWith('/gallery/all')) {
        return ok({ results: [{
          deviationid: 'deviation-current',
          title: 'Current work',
          url: 'https://www.deviantart.com/owner/art/current-work-1',
          description: 'Current description',
          tags: ['portfolio'],
          is_mature: false,
          allows_comments: true,
          is_ai_generated: false,
          noai: false,
          published_time: 1786637885
        }], has_more: false });
      }
      if (requestUrl.pathname.endsWith('/gallery/folder-remote')) {
        return ok({ results: [{ deviationid: 'deviation-current', title: 'Current work', tags: [] }], has_more: false });
      }
      if (requestUrl.pathname.endsWith('/deviation/deviation-deleted')) {
        return ok({ deviationid: 'deviation-deleted', title: 'Deleted remote work', is_deleted: true });
      }
      throw new Error(`Unexpected test request: ${requestUrl.pathname}`);
    });

    await processExternalSyncJob(store, {
      externalTokenEncryptionKey: encryptionKey,
      externalSyncBaseDelaySeconds: 60
    } as AppConfig, 'account-import-gallery', { enqueue: jest.fn(async () => undefined) });

    expect(await store.getExternalPublication('account-gallery', 'deviation-deleted')).toMatchObject({
      syncStatus: 'deleted',
      remoteStateReason: 'Deleted on DeviantArt'
    });
    const currentPublication = await store.getExternalPublication('account-gallery', 'deviation-current');
    expect(currentPublication).toMatchObject({ syncStatus: 'active', metadataSyncStatus: 'in_sync' });
    expect(await store.listUbeeqCollectionAssets('collection-local')).toEqual([
      expect.objectContaining({
        assetId: currentPublication?.assetId,
        manuallyAssigned: false,
        externalCollectionMappingIds: ['mapping-gallery']
      })
    ]);
    expect((await store.listExternalCollectionMappings('account-gallery'))[0]).toMatchObject({
      lastMembershipCount: 1,
      lastMembershipError: undefined
    });
    expect(await store.getExternalSyncJob('account-import-gallery')).toMatchObject({ status: 'successful' });
    jest.restoreAllMocks();
  });

  it('stops on the first reconciliation 429 and resumes from the saved item', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    const encryptionKey = 'worker-reconciliation-resume-test-key';
    await store.createExternalPlatformCredential({
      externalPlatformCredentialId: 'credential-resume', userId: 'user-1', platform: 'deviantart', clientId: 'client-id',
      clientSecretEncrypted: encryptExternalCredential('client-secret', encryptionKey),
      redirectUri: 'http://localhost:4000/integrations/deviantart/callback', createdAt: now, updatedAt: now
    });
    await store.createExternalAccount({
      externalAccountId: 'account-resume', userId: 'user-1', creatorIdentityId: 'creator-1', primaryCreatorIdentityId: 'creator-1',
      externalPlatformCredentialId: 'credential-resume', platform: 'deviantart', externalUserId: 'owner-1', externalUsername: 'owner',
      accessTokenEncrypted: encryptExternalCredential('access-token', encryptionKey), connectionStatus: 'connected', createdAt: now, updatedAt: now
    });
    await store.createExternalSyncJob({
      externalSyncJobId: 'account-import-resume', externalAccountId: 'account-resume', type: 'full_reconciliation', status: 'queued',
      progress: { discovered: 0, synchronized: 0, remaining: 0 }, attemptCount: 0, createdAt: now, updatedAt: now
    });

    const completeItem = (externalContentId: string) => ({
      deviationid: externalContentId,
      title: externalContentId,
      url: `https://www.deviantart.com/owner/art/${externalContentId}`,
      description: `${externalContentId} description`,
      tags: ['resume'],
      is_mature: false,
      allows_comments: true,
      is_ai_generated: false,
      noai: false,
      published_time: 1786637885
    });
    let rateLimitSecondItem = true;
    const detailedRequests: string[] = [];
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const requestUrl = new URL(String(input));
      const ok = (payload: Record<string, unknown>) => ({
        ok: true,
        status: 200,
        json: async () => payload,
        headers: { get: () => null }
      } as unknown as Response);
      if (requestUrl.pathname.endsWith('/gallery/folders')) return ok({ results: [], has_more: false });
      if (requestUrl.pathname.endsWith('/gallery/all')) {
        return ok({
          results: [completeItem('item-1'), { deviationid: 'item-2', title: 'item-2', tags: [] }, { deviationid: 'item-3', title: 'item-3', tags: [] }],
          has_more: false
        });
      }
      if (requestUrl.pathname.endsWith('/deviation/item-2') || requestUrl.pathname.endsWith('/deviation/item-3')) {
        const externalContentId = requestUrl.pathname.endsWith('item-2') ? 'item-2' : 'item-3';
        detailedRequests.push(externalContentId);
        if (externalContentId === 'item-2' && rateLimitSecondItem) {
          return {
            ok: false,
            status: 429,
            json: async () => ({ error: 'User request limit reached.' }),
            headers: { get: () => null }
          } as unknown as Response;
        }
        return ok(completeItem(externalContentId));
      }
      if (requestUrl.pathname.endsWith('/deviation/metadata')) {
        const externalContentId = requestUrl.searchParams.get('deviationids[0]') || '';
        return ok({ results: [completeItem(externalContentId)] });
      }
      throw new Error(`Unexpected test request: ${requestUrl.pathname}`);
    });
    const queue = { enqueue: jest.fn(async () => undefined) };
    const workerConfig = {
      externalTokenEncryptionKey: encryptionKey,
      externalSyncBaseDelaySeconds: 60
    } as AppConfig;

    await processExternalSyncJob(store, workerConfig, 'account-import-resume', queue);

    expect(detailedRequests).toEqual(['item-2']);
    expect(await store.getExternalSyncJob('account-import-resume')).toMatchObject({
      status: 'rate_limited',
      payload: {
        resumeCursor: '0',
        resumeItemIndex: 1,
        resumePageLoaded: true,
        contentScanComplete: false,
        seenExternalContentIds: ['item-1', 'item-2']
      },
      progress: { discovered: 3, synchronized: 1, remaining: 1 }
    });

    const pausedAccount = await store.getExternalAccount('account-resume');
    await store.updateExternalAccount({
      ...pausedAccount!,
      rateLimitedUntil: new Date(Date.now() - 1_000).toISOString(),
      updatedAt: new Date().toISOString()
    });
    const pausedJob = await store.getExternalSyncJob('account-import-resume');
    await store.updateExternalSyncJob({ ...pausedJob!, status: 'queued', nextAttemptAt: undefined, updatedAt: new Date().toISOString() });
    rateLimitSecondItem = false;

    await processExternalSyncJob(store, workerConfig, 'account-import-resume', queue);

    expect(detailedRequests).toEqual(['item-2', 'item-2', 'item-3']);
    expect(await store.getExternalSyncJob('account-import-resume')).toMatchObject({
      status: 'successful',
      payload: {},
      progress: { discovered: 3, synchronized: 3, remaining: 0 }
    });
    expect((await store.getExternalAccount('account-resume'))?.connectionStatus).toBe('connected');
    expect(fetchSpy).toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('retains comments that disappear remotely and marks them as deleted', async () => {
    const store = new InMemoryStore();
    const now = new Date().toISOString();
    const encryptionKey = 'worker-deleted-comment-test-key';
    await store.createExternalPlatformCredential({
      externalPlatformCredentialId: 'credential-comments', userId: 'user-1', platform: 'deviantart', clientId: 'client-id',
      clientSecretEncrypted: encryptExternalCredential('client-secret', encryptionKey),
      redirectUri: 'http://localhost:4000/integrations/deviantart/callback', createdAt: now, updatedAt: now
    });
    await store.createExternalAccount({
      externalAccountId: 'account-comments', userId: 'user-1', creatorIdentityId: 'creator-1', primaryCreatorIdentityId: 'creator-1',
      externalPlatformCredentialId: 'credential-comments', platform: 'deviantart', externalUserId: 'owner-1', externalUsername: 'owner',
      accessTokenEncrypted: encryptExternalCredential('access-token', encryptionKey), connectionStatus: 'connected', createdAt: now, updatedAt: now
    });
    await store.createAsset({
      assetId: 'asset-comments', userId: 'user-1', creatorIdentityId: 'creator-1', assetType: 'image', canonicalTitle: 'Commented work',
      visibility: 'private', titleSyncPolicy: 'initially_mirrored', descriptionSyncPolicy: 'initially_mirrored', createdAt: now, updatedAt: now
    });
    await store.createExternalPublication({
      externalPublicationId: 'publication-comments', assetId: 'asset-comments', externalAccountId: 'account-comments', platform: 'deviantart',
      externalContentId: 'deviation-comments', syncStatus: 'active', rawMetadataJson: {}, createdAt: now, updatedAt: now
    });
    await store.createExternalComment({
      externalCommentId: 'comment-local', externalPublicationId: 'publication-comments', externalCommentExternalId: 'comment-remote',
      platform: 'deviantart', externalAuthorId: 'visitor-1', externalAuthorName: 'visitor', body: 'Previously imported', createdAtRemote: now,
      rawPayload: {}, firstSeenAt: now, lastSeenAt: now, lastSyncedAt: now
    });
    await store.createExternalSyncJob({
      externalSyncJobId: 'comment-reconcile-deleted', externalAccountId: 'account-comments', type: 'comment_sync', status: 'queued',
      attemptCount: 0, payload: { externalPublicationId: 'publication-comments' }, createdAt: now, updatedAt: now
    });
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ thread: [], has_more: false }),
      headers: { get: () => null }
    } as unknown as Response);

    await processExternalSyncJob(store, {
      externalTokenEncryptionKey: encryptionKey,
      externalSyncBaseDelaySeconds: 60
    } as AppConfig, 'comment-reconcile-deleted');

    expect((await store.listExternalComments('publication-comments'))[0]).toMatchObject({
      externalCommentExternalId: 'comment-remote',
      remoteDeletedAt: expect.any(String)
    });
    jest.restoreAllMocks();
  });
});
