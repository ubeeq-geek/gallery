import { externalContentUpdateMismatches, mergeExternalMetadata, processExternalSyncJob } from '../src/externalSyncWorker';
import type { ExternalRemoteContent } from '../src/externalPlatformProvider';
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
      expect.objectContaining({ remoteActivityId: 'message:mention-1', type: 'mention', remoteStackId: 'mention-stack', externalPublicationId: 'publication-audience' }),
      expect.objectContaining({ remoteActivityId: 'message:mention-2', type: 'mention', remoteStackId: 'mention-stack', externalPublicationId: 'publication-audience' }),
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
});
