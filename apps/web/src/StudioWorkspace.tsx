import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from './api';
import { readStudioSection, studioSectionDefs } from './studio/config';
import { roleDisplayLabel } from './studio/rolePresentation';
import { StudioLayout } from './studio/components/StudioLayout';
import { Card } from './studio/components/Card';
import { DashboardView } from './studio/views/DashboardView';
import { CreatorsView } from './studio/views/CreatorsView';
import { FilesMediaView } from './studio/views/FilesMediaView';
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
    switch (section) {
      case 'dashboard':
        return (
          <DashboardView
            metrics={metrics}
            creators={creators}
            files={files}
            posts={posts}
            entries={entries}
          />
        );
      case 'creators':
        return (
          <CreatorsView
            creators={creators}
            posts={posts}
            files={files}
            onCreateCreator={(payload) => api.studioCreateCreator(payload).then(() => load())}
          />
        );
      case 'files-media':
        return (
          <FilesMediaView
            files={files}
            creators={creators}
            onCreateFile={(payload) => api.studioCreateFile(payload).then(() => load())}
          />
        );
      case 'posts':
        return <PostsView posts={posts} creators={creators} />;
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
        return (
          <ResourceView
            title="Collections"
            eyebrow="Registered-user collections"
            searchPlaceholder="Search collections..."
            emptyMessage="Collection CRUD is moving into this Studio shell next."
            items={[]}
          />
        );
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
    <StudioLayout section={section} title={sectionMeta.label} description={sectionMeta.description}>
      {(loading || error) && (
        <Card title="Workspace status" eyebrow="Live data">
          {loading && <p className="small">Loading Studio data…</p>}
          {error && <p className="error">{error}</p>}
        </Card>
      )}
      {renderSection()}
      <Card title="Scope summary" eyebrow="Studio contract">
        <p className="small">
          Studio now reads from `/studio/*` resources as the primary API surface. Creator, files, posts,
          entries, and challenge workflows are no longer modeled as a separate product area.
        </p>
        <p className="small">
          Loaded: {creators.length} creators · {files.length} files · {posts.length} posts · {groupings.length} groupings · {users.length} users.
        </p>
      </Card>
    </StudioLayout>
  );
}
