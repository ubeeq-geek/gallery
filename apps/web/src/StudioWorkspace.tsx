import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from './api';
import { brand } from './brand';
import { readStudioSection, studioSectionDefs } from './studio/config';
import { roleDisplayLabel } from './studio/rolePresentation';
import { notifyCreatorProfileChanged } from './profileEvents';
import { StudioLayout } from './studio/components/StudioLayout';
import { Card } from './studio/components/Card';
import { DashboardView } from './studio/views/DashboardView';
import { CreatorsView } from './studio/views/CreatorsView';
import { FilesMediaView } from './studio/views/FilesMediaView';
import { DeviantArtView } from './studio/views/DeviantArtView';
import { CollectionsView } from './studio/views/CollectionsView';
import { WorksView } from './studio/views/WorksView';
import { ActivityView } from './studio/views/ActivityView';
import { CreatorOnboardingView } from './studio/views/CreatorOnboardingView';
import { CreatorLaunchChecklist } from './studio/views/CreatorLaunchChecklist';
import { PostsView } from './studio/views/PostsView';
import { ResourceView } from './studio/views/ResourceView';
import { ChallengesView } from './studio/views/ChallengesView';
import type {
  StudioChallenge,
  StudioCreator,
  StudioEntry,
  StudioFile,
  StudioGrouping,
  StudioMetrics,
  StudioPost,
  StudioUser
} from './studio/types';

function CreatorExportAction({ creatorId }: { creatorId: string }) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const download = async () => {
    setExporting(true);
    setExportError('');
    try {
      const { blob, filename } = await api.studioDownloadCreatorExport(creatorId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setExportError(downloadError instanceof Error ? downloadError.message : 'Unable to export this Creator.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="studio-export-action">
      <button type="button" className="studio-task-link" onClick={() => void download()} disabled={exporting}>
        <strong>{exporting ? 'Preparing export…' : `Export ${brand.creatorName} data`}</strong>
        <span>Download a portable Ubeeq JSON manifest containing canonical Works, Assets, Collections, Publications, and external account references.</span>
      </button>
      {exportError && <p className="error">{exportError}</p>}
    </div>
  );
}

export function StudioWorkspace({ onCreatorCreated }: { onCreatorCreated?: () => Promise<void> }) {
  const location = useLocation();
  const section = useMemo(() => readStudioSection(location.search), [location.search]);
  const sectionMeta = studioSectionDefs.find((item) => item.key === section) || studioSectionDefs[0];
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [metrics, setMetrics] = useState<StudioMetrics>({
    totalUsers: 0,
    creators: 0,
    groupings: 0,
    posts: 0,
    files: 0,
    mediaItems: 0,
    pendingEntries: 0,
    reviewItems: 0,
    contributors: 0
  });
  const [creators, setCreators] = useState<StudioCreator[]>([]);
  const [files, setFiles] = useState<StudioFile[]>([]);
  const [posts, setPosts] = useState<StudioPost[]>([]);
  const [groupings, setGroupings] = useState<StudioGrouping[]>([]);
  const [challenges, setChallenges] = useState<StudioChallenge[]>([]);
  const [entries, setEntries] = useState<StudioEntry[]>([]);
  const [users, setUsers] = useState<StudioUser[]>([]);
  const requestedCreatorId = new URLSearchParams(location.search).get('creatorId') || '';
  const activeCreatorId = creators.some((creator) => creator.creatorId === requestedCreatorId)
    ? requestedCreatorId
    : creators[0]?.creatorId || '';
  const activeCreator = creators.find((creator) => creator.creatorId === activeCreatorId);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const results = await Promise.allSettled([
        api.studioMetrics(),
        api.studioListCreators(),
        api.studioListFiles(),
        api.studioListPosts(),
        api.studioListGroupings(),
        api.studioListChallenges(),
        api.studioListEntries(),
        api.studioListUsers()
      ]);
      const value = <T,>(index: number, fallback: T): T => results[index].status === 'fulfilled'
        ? results[index].value as T
        : fallback;
      const failures = results.filter((result) => result.status === 'rejected');
      const nextMetrics = value<StudioMetrics>(0, metrics);
      const nextCreators = value<StudioCreator[]>(1, []);
      const nextFiles = value<StudioFile[]>(2, []);
      const nextPosts = value<StudioPost[]>(3, []);
      const nextGroupings = value<StudioGrouping[]>(4, []);
      const nextChallenges = value<StudioChallenge[]>(5, []);
      const nextEntries = value<StudioEntry[]>(6, []);
      const nextUsers = value<StudioUser[]>(7, []);
      setMetrics((nextMetrics as StudioMetrics) || metrics);
      setCreators((nextCreators as StudioCreator[]) || []);
      setFiles((nextFiles as StudioFile[]) || []);
      setPosts((nextPosts as StudioPost[]) || []);
      setGroupings((nextGroupings as StudioGrouping[]) || []);
      setChallenges((nextChallenges as StudioChallenge[]) || []);
      setEntries((nextEntries as StudioEntry[]) || []);
      setUsers((nextUsers as StudioUser[]) || []);
      if (failures.length) setError(`${failures.length} background Studio request${failures.length === 1 ? '' : 's'} could not be loaded.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Studio workspace');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderCreatorsView = (profileCreatorId?: string) => (
    <CreatorsView
      creators={creators}
      posts={posts}
      files={files}
      profileCreatorId={profileCreatorId}
      onCreateCreator={async (payload) => {
        const creator = await api.studioCreateCreator(payload) as StudioCreator;
        // Refresh the application-level ownership context before the create
        // flow opens the new public profile. Otherwise that first view has no
        // way to recognise its owner and incorrectly renders visitor actions.
        await onCreatorCreated?.();
        return creator;
      }}
      onUpdateCreator={async (creatorId, payload) => {
        await api.studioUpdateCreator(creatorId, payload);
      }}
      onDeleteCreator={async (creatorId) => {
        await api.studioDeleteCreator(creatorId);
      }}
      onUploadProfileImage={async (creatorId, selection) => {
        const upload = await api.studioCreateCreatorBrandingUploadUrl(creatorId, { kind: 'profile', contentType: selection.file.type || 'image/jpeg' });
        await api.uploadPreparedFile(upload, selection.file);
        await api.studioUploadCreatorProfileImage(creatorId, { sourceKey: upload.key, squareCrop: selection.squareCrop });
        notifyCreatorProfileChanged();
      }}
      onUploadCoverImage={async (creatorId, selection) => {
        const upload = await api.studioCreateCreatorBrandingUploadUrl(creatorId, { kind: 'cover', contentType: selection.file.type || 'image/jpeg' });
        await api.uploadPreparedFile(upload, selection.file);
        await api.studioUploadCreatorCoverImage(creatorId, { sourceKey: upload.key, focalPoint: selection.focalPoint });
      }}
      onRemoveProfileImage={(creatorId) => api.studioDeleteCreatorProfileImage(creatorId).then(() => {
        notifyCreatorProfileChanged();
      })}
      onRemoveCoverImage={(creatorId) => api.studioDeleteCreatorCoverImage(creatorId).then(() => undefined)}
      onSaved={load}
    />
  );

  const renderSection = () => {
    if (!creators.length) {
      return <CreatorOnboardingView onCreated={async () => { await load(); }} />;
    }
    switch (section) {
      case 'dashboard':
        return (
          <>
            {activeCreator && <CreatorLaunchChecklist creator={activeCreator} />}
            <DashboardView
              metrics={metrics}
              posts={posts}
              entries={entries}
            />
          </>
        );
      case 'publishing':
        return (
          <Card title="Publishing" eyebrow="Choose the next publishing task">
            <div className="studio-task-grid">
              <Link className="studio-task-link no-underline" to={`/studio/workspace?section=works&creatorId=${encodeURIComponent(activeCreatorId)}`}>
                <strong>Choose a work</strong><span>Review your local catalogue before preparing a publication.</span>
              </Link>
              <Link className="studio-task-link no-underline" to={`/studio/workspace?section=integrations&creatorId=${encodeURIComponent(activeCreatorId)}`}>
                <strong>Prepare DeviantArt</strong><span>Connect accounts, review sync status, and manage DeviantArt-specific work.</span>
              </Link>
            </div>
          </Card>
        );
      case 'activity':
        return <ActivityView creatorId={activeCreatorId} />;
      case 'settings':
        return (
          <>
            <Card title={`${brand.creatorName} and Studio settings`} eyebrow="Preferences">
              <div className="studio-task-grid">
                <Link className="studio-task-link no-underline" to={`/studio/workspace?section=creators&creatorId=${encodeURIComponent(activeCreatorId)}`}>
                  <strong>Manage {brand.creatorPlural}</strong><span>Update {brand.creatorName.toLowerCase()} identities, branding, and ownership.</span>
                </Link>
                <Link className="studio-task-link no-underline" to="/settings?section=preferences">
                  <strong>Account settings</strong><span>Manage account-wide preferences and sign-in settings.</span>
                </Link>
              </div>
            </Card>
            <Card title="Portable data export" eyebrow="Creator ownership">
              <p>Download the current canonical data for this {brand.creatorName.toLowerCase()}. The manifest contains no OAuth tokens or application secrets.</p>
              <CreatorExportAction creatorId={activeCreatorId} />
            </Card>
          </>
        );
      case 'creator-profile':
        return renderCreatorsView(activeCreatorId);
      case 'creators':
        return renderCreatorsView();
      case 'integrations':
        return <DeviantArtView creators={creators} />;
      case 'files-media':
        return (
          <FilesMediaView
            files={files}
            creators={creators}
            onCreateFile={(payload) => api.studioCreateFile(payload).then(() => load())}
          />
        );
      case 'posts':
        return <PostsView posts={posts} creators={creators} onPostSaved={async () => { await load(); }} />;
      case 'groupings':
        return (
          <ResourceView
            title="Groupings"
            eyebrow={`${brand.creatorName}-owned content containers`}
            searchPlaceholder="Search groupings..."
            emptyMessage="No groupings are registered yet."
            items={groupings.map((grouping) => ({
              id: grouping.groupingId,
              title: grouping.title,
              subtitle: `slug: ${grouping.slug || 'n/a'}`,
              meta: `creator: ${creators.find((creator) => creator.creatorId === grouping.creatorId)?.name || grouping.creatorId}`,
              status: grouping.status,
              detail: [
                { label: 'Visibility', value: grouping.visibility || 'free' },
                { label: 'Creator', value: creators.find((creator) => creator.creatorId === grouping.creatorId)?.name || grouping.creatorId }
              ]
            }))}
          />
        );
      case 'challenges':
        return <ChallengesView challenges={challenges} onChanged={load} />;
      case 'entries':
        return (
          <ResourceView
            title="Entries"
            eyebrow="Approval and promotion workflow"
            searchPlaceholder="Search entries..."
            emptyMessage="No entry records are available yet."
            items={entries.map((entry) => ({
              id: entry.submissionId,
              title: entry.title,
              subtitle: `user: ${entry.userId}`,
              meta: entry.promotionOutcome === 'contributor'
                ? `${roleDisplayLabel('contributor')} promotion unlocked`
                : 'Awaiting moderation outcome',
              status: entry.status,
              detail: [
                { label: 'Context', value: entry.contextId },
                { label: 'Promotion outcome', value: entry.promotionOutcome || 'none' },
                { label: 'Converted post', value: entry.convertedPostId || 'Not yet created' }
              ]
            }))}
          />
        );
      case 'users':
        return (
          <ResourceView
            title="Users"
            eyebrow="Role ladder and capabilities"
            searchPlaceholder="Search users..."
            emptyMessage="No users are visible in this Studio scope."
            items={users.map((user) => ({
              id: user.userId,
              title: user.displayName || user.username,
              subtitle: user.username,
              meta: `${user.managedCreatorCount || 0} ${brand.creatorName.toLowerCase()} accounts`,
              status: user.role === 'contributor' ? roleDisplayLabel('contributor') : user.role,
              detail: [
                { label: 'Role', value: user.role === 'contributor' ? roleDisplayLabel('contributor') : user.role },
                { label: `Managed ${brand.creatorPlural}`, value: String(user.managedCreatorCount || 0) },
                { label: `${roleDisplayLabel('contributor')} flag`, value: user.isBeeker ? 'Yes' : 'No' }
              ]
            }))}
          />
        );
      case 'collections':
        return <CollectionsView creators={creators} />;
      case 'works':
        return <WorksView creators={creators} />;
      case 'moderation':
        return (
          <ResourceView
            title="Moderation"
            eyebrow="Blocks, bans, and safeguards"
            searchPlaceholder="Search moderation items..."
            emptyMessage="Moderation-specific records will appear here as the block/ban split lands."
            items={[
              {
                id: 'destructive-safeguards',
                title: 'Destructive safeguards',
                subtitle: 'Typed confirmation + reason required',
                meta: 'Delete, unpublish, ban, winner replacement, admin role removal',
                status: 'active',
                detail: [
                  { label: 'Current scope', value: 'Studio-wide shared confirmation flow' },
                  { label: 'Dependency review', value: 'Required before action execution' }
                ]
              }
            ]}
          />
        );
      default:
        return (
          <ResourceView
            title={sectionMeta.label}
            eyebrow="Studio module"
            searchPlaceholder={`Search ${sectionMeta.label.toLowerCase()}...`}
            emptyMessage={`No ${sectionMeta.label.toLowerCase()} records are available in this Studio scope yet.`}
            items={[]}
          />
        );
    }
  };

  return (
    <StudioLayout
      section={section}
      title={creators.length ? sectionMeta.label : `Welcome to ${brand.studioName}`}
      description={creators.length ? sectionMeta.description : 'Become a Creator when you are ready to share or manage your creative work.'}
      onboarding={!creators.length}
      creators={creators}
      activeCreatorId={activeCreatorId}
    >
      {(loading || error) && (
        <Card title="Workspace status" eyebrow="Live data">
          {loading && <p className="small">Loading Studio data…</p>}
          {error && <p className="error">{error}</p>}
        </Card>
      )}
      {renderSection()}
    </StudioLayout>
  );
}
