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
