import { externalContentUpdateMismatches, mergeExternalMetadata } from '../src/externalSyncWorker';
import type { ExternalRemoteContent } from '../src/externalPlatformProvider';
import { InMemoryStore } from '../src/inMemoryStore';

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
});
