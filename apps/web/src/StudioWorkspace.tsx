import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from './api';
import { readStudioSection, studioSectionDefs } from './studio/config';
import { roleDisplayLabel } from './studio/rolePresentation';
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
import { PostsView } from './studio/views/PostsView';
import { ResourceView } from './studio/views/ResourceView';
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

export function StudioWorkspace() {
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

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [
        nextMetrics,
        nextCreators,
        nextFiles,
        nextPosts,
        nextGroupings,
        nextChallenges,
        nextEntries,
        nextUsers
      ] = await Promise.all([
        api.studioMetrics(),
        api.studioListCreators(),
        api.studioListFiles(),
        api.studioListPosts(),
        api.studioListGroupings(),
        api.studioListChallenges(),
        api.studioListEntries(),
        api.studioListUsers()
      ]);
      setMetrics((nextMetrics as StudioMetrics) || metrics);
      setCreators((nextCreators as StudioCreator[]) || []);
      setFiles((nextFiles as StudioFile[]) || []);
      setPosts((nextPosts as StudioPost[]) || []);
      setGroupings((nextGroupings as StudioGrouping[]) || []);
      setChallenges((nextChallenges as StudioChallenge[]) || []);
      setEntries((nextEntries as StudioEntry[]) || []);
      setUsers((nextUsers as StudioUser[]) || []);
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

  const renderSection = () => {
    if (!creators.length) {
      return <CreatorOnboardingView onCreated={async () => { await load(); }} />;
    }
    switch (section) {
      case 'dashboard':
        return (
          <DashboardView
            metrics={metrics}
            creators={creators}
            files={files}
            posts={posts}
            entries={entries}
            activeCreatorId={activeCreatorId}
          />
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
          <Card title="Creator and Studio settings" eyebrow="Preferences">
            <div className="studio-task-grid">
              <Link className="studio-task-link no-underline" to={`/studio/workspace?section=creators&creatorId=${encodeURIComponent(activeCreatorId)}`}>
                <strong>Manage creators</strong><span>Update creator identities, branding, and ownership.</span>
              </Link>
              <Link className="studio-task-link no-underline" to="/settings">
                <strong>Account settings</strong><span>Manage account-wide preferences and sign-in settings.</span>
              </Link>
            </div>
          </Card>
        );
      case 'creators':
        return (
          <CreatorsView
            creators={creators}
            posts={posts}
            files={files}
            onCreateCreator={async (payload) => {
              const creator = await api.studioCreateCreator(payload) as StudioCreator;
              await load();
              return creator;
            }}
            onUpdateCreator={async (creatorId, payload) => {
              await api.studioUpdateCreator(creatorId, payload);
              await load();
            }}
            onUploadProfileImage={async (creatorId, file) => {
              const upload = await api.studioCreateCreatorBrandingUploadUrl(creatorId, { kind: 'profile', contentType: file.type || 'image/jpeg' });
              await fetch(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': upload.contentType }, body: file });
              await api.studioUploadCreatorProfileImage(creatorId, { sourceKey: upload.key });
              await load();
            }}
            onUploadCoverImage={async (creatorId, file) => {
              const upload = await api.studioCreateCreatorBrandingUploadUrl(creatorId, { kind: 'cover', contentType: file.type || 'image/jpeg' });
              await fetch(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': upload.contentType }, body: file });
              await api.studioUploadCreatorCoverImage(creatorId, { sourceKey: upload.key });
              await load();
            }}
            onRemoveProfileImage={(creatorId) => api.studioDeleteCreatorProfileImage(creatorId).then(() => load())}
            onRemoveCoverImage={(creatorId) => api.studioDeleteCreatorCoverImage(creatorId).then(() => load())}
          />
        );
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
            eyebrow="Creator-owned content containers"
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
        return (
          <ResourceView
            title="Challenges"
            eyebrow="Challenge management"
            searchPlaceholder="Search challenges..."
            emptyMessage="No challenges are available in Studio yet."
            items={challenges.map((challenge) => ({
              id: challenge.contextId,
              title: challenge.title,
              subtitle: `slug: ${challenge.slug}`,
              meta: challenge.type,
              status: challenge.status,
              detail: [
                { label: 'Type', value: challenge.type },
                { label: 'Status', value: challenge.status }
              ]
            }))}
          />
        );
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
              meta: `${user.managedCreatorCount || 0} creator accounts`,
              status: user.role === 'contributor' ? roleDisplayLabel('contributor') : user.role,
              detail: [
                { label: 'Role', value: user.role === 'contributor' ? roleDisplayLabel('contributor') : user.role },
                { label: 'Managed creators', value: String(user.managedCreatorCount || 0) },
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
      title={creators.length ? sectionMeta.label : 'Welcome to Ubeeq Studio'}
      description={creators.length ? sectionMeta.description : 'Create a free Space when you are ready to share or manage your creative work.'}
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
