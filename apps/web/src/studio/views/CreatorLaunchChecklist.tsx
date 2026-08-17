import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { brand, creatorBaseUrl } from '../../brand';
import { Card } from '../components/Card';
import type { StudioCreator, StudioExternalAsset } from '../types';

type OnboardingData = {
  works: StudioExternalAsset[];
  collections: Array<{ ubeeqCollectionId: string; visibility: 'private' | 'unlisted' | 'public' }>;
  connectedAccounts: number;
};

export function CreatorLaunchChecklist({ creator }: { creator: StudioCreator }) {
  const [data, setData] = useState<OnboardingData | null>(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const publicUrl = `${creatorBaseUrl}${creator.slug}`;
  const feeds = api.getCreatorFeedUrls(creator.slug);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.studioListWorks(creator.creatorId) as Promise<{ items?: StudioExternalAsset[] }>,
      api.studioListDeviantArtCollections(creator.creatorId) as Promise<{ ubeeqCollections?: OnboardingData['collections'] }>,
      api.studioListDeviantArtAccounts(creator.creatorId) as Promise<Array<{ connectionStatus: string }>>
    ]).then(([works, collections, accounts]) => {
      if (!active) return;
      setData({
        works: works.items || [],
        collections: collections.ubeeqCollections || [],
        connectedAccounts: accounts.filter((account) => account.connectionStatus === 'connected').length
      });
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Unable to load setup progress.');
    });
    return () => { active = false; };
  }, [creator.creatorId]);

  const firstWork = data?.works[0];
  const hasSpacePublication = data?.works.some((work) => work.spacePublication?.published) || false;
  const hasPublicCollection = data?.collections.some((collection) => collection.visibility === 'public' || collection.visibility === 'unlisted') || false;
  const profileReady = Boolean(creator.space?.bio || creator.branding?.profileImage || creator.branding?.coverImage);
  const completeCount = useMemo(() => [profileReady, Boolean(firstWork), Boolean(data?.collections.length), hasSpacePublication].filter(Boolean).length, [profileReady, firstWork, data?.collections.length, hasSpacePublication]);

  const downloadExport = async () => {
    setExporting(true);
    setError('');
    try {
      const { blob, filename } = await api.studioDownloadCreatorExport(creator.creatorId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to download the portable export.');
    } finally {
      setExporting(false);
    }
  };

  return <Card title={`Finish setting up ${creator.name}`} eyebrow={`Your ${brand.workspaceName} · ${completeCount}/4 core steps`} className="studio-launch-checklist">
    <p className="studio-home-intro">Your Space is ready at <a href={publicUrl} target="_blank" rel="noreferrer">{publicUrl}</a>. Build the public presence first; discovery is always a separate, explicit choice.</p>
    {error && <p className="error">{error}</p>}
    <ol className="studio-launch-steps">
      <li className={profileReady ? 'is-complete' : ''}><div><strong>Profile and branding</strong><span>{profileReady ? 'Profile details or branding have been added.' : 'Add a bio, links, avatar, or cover so visitors know whose Space this is.'}</span></div><Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=creator-profile&creatorId=${encodeURIComponent(creator.creatorId)}`}>{profileReady ? 'Edit profile' : 'Set up profile'}</Link></li>
      <li className={firstWork ? 'is-complete' : ''}><div><strong>First work</strong><span>{firstWork ? `${firstWork.canonicalTitle || 'A work'} is in your catalogue.` : 'Upload an image or connect DeviantArt to import your catalogue.'}</span></div><div className="studio-inline-actions"><Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creator.creatorId)}&create=1`}>Upload</Link><Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=integrations&creatorId=${encodeURIComponent(creator.creatorId)}`}>{data?.connectedAccounts ? 'Manage DeviantArt' : 'Import from DeviantArt'}</Link></div></li>
      <li className={data?.collections.length ? 'is-complete' : ''}><div><strong>First collection</strong><span>{data?.collections.length ? `${data.collections.length} collection${data.collections.length === 1 ? '' : 's'} created${hasPublicCollection ? ', including a visible collection' : ''}.` : 'Group work into a collection, gallery, series, or playlist.'}</span></div><Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=collections&creatorId=${encodeURIComponent(creator.creatorId)}`}>Organize works</Link></li>
      <li className={hasSpacePublication ? 'is-complete' : ''}><div><strong>Publish to your Space</strong><span>{hasSpacePublication ? 'At least one Work is now visible in your Space.' : firstWork ? 'Open your first Work to choose Space visibility. Public Space visibility does not opt it into discovery.' : 'Create or import a Work before publishing it.'}</span></div>{firstWork ? <Link className="auth-secondary-btn no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(creator.creatorId)}&workId=${encodeURIComponent(firstWork.assetId)}`}>{hasSpacePublication ? 'Review publication' : 'Choose visibility'}</Link> : <span className="small">Waiting for a Work</span>}</li>
    </ol>
    <div className="studio-launch-resources">
      <a className="auth-secondary-btn no-underline" href={publicUrl} target="_blank" rel="noreferrer">Preview public Space</a>
      <a className="auth-secondary-btn no-underline" href={feeds.rss} target="_blank" rel="noreferrer">Open RSS feed</a>
      <button type="button" className="auth-secondary-btn" disabled={exporting} onClick={() => void downloadExport()}>{exporting ? 'Preparing export…' : 'Download portable export'}</button>
    </div>
    <small>Private and Unlisted Works stay out of public feeds. A Space-visible Work is not discovery-enabled unless you opt it in separately.</small>
  </Card>;
}
