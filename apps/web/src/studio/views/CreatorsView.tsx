import { useEffect, useMemo, useState } from 'react';
import { Card } from '../components/Card';
import { CrudTable, type CrudRow } from '../components/CrudTable';
import { DataToolbar } from '../components/DataToolbar';
import { InspectorPanel } from '../components/InspectorPanel';
import { Pill } from '../components/Pill';
import type { StudioCreator, StudioFile, StudioPost } from '../types';

const slugSuggestion = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function CreatorsView({
  creators,
  posts,
  files,
  onCreateCreator,
  onUploadProfileImage,
  onUploadCoverImage,
  onRemoveProfileImage,
  onRemoveCoverImage
}: {
  creators: StudioCreator[];
  posts: StudioPost[];
  files: StudioFile[];
  onCreateCreator: (payload: { name: string; slug: string }) => Promise<void>;
  onUploadProfileImage: (creatorId: string, file: File) => Promise<void>;
  onUploadCoverImage: (creatorId: string, file: File) => Promise<void>;
  onRemoveProfileImage: (creatorId: string) => Promise<void>;
  onRemoveCoverImage: (creatorId: string) => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string>('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [uploadingProfile, setUploadingProfile] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return creators;
    return creators.filter((creator) =>
      creator.name.toLowerCase().includes(query) || creator.slug.toLowerCase().includes(query)
    );
  }, [creators, search]);

  useEffect(() => {
    if (!filtered.length) {
      setSelectedId('');
      return;
    }
    if (!filtered.some((creator) => creator.creatorId === selectedId)) {
      setSelectedId(filtered[0].creatorId);
    }
  }, [filtered, selectedId]);

  const selected = filtered.find((creator) => creator.creatorId === selectedId) || filtered[0];
  const rows: CrudRow[] = filtered.map((creator) => ({
    id: creator.creatorId,
    title: creator.name,
    subtitle: `slug: ${creator.slug}`,
    meta: `${posts.filter((post) => post.creatorId === creator.creatorId).length} posts · ${files.filter((file) => file.creatorId === creator.creatorId).length} files`,
    badges: <Pill label={creator.status === 'inactive' ? 'Inactive' : 'Active'} tone={creator.status === 'inactive' ? 'warning' : 'success'} />
  }));

  const submit = async () => {
    const trimmedName = name.trim();
    const trimmedSlug = (slug.trim() || slugSuggestion(trimmedName));
    if (!trimmedName || !trimmedSlug) return;
    await onCreateCreator({ name: trimmedName, slug: trimmedSlug });
    setName('');
    setSlug('');
  };

  const uploadProfile = async (file?: File) => {
    if (!selected || !file) return;
    setUploadError('');
    setUploadingProfile(true);
    try {
      await onUploadProfileImage(selected.creatorId, file);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Failed to upload profile image');
    } finally {
      setUploadingProfile(false);
    }
  };

  const uploadCover = async (file?: File) => {
    if (!selected || !file) return;
    setUploadError('');
    setUploadingCover(true);
    try {
      await onUploadCoverImage(selected.creatorId, file);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Failed to upload cover image');
    } finally {
      setUploadingCover(false);
    }
  };

  return (
    <section className="studio-surface-grid">
      <Card title="Creators" eyebrow="Ownership and identity">
        <DataToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search creators..."
          primaryAction={<button type="button" className="auth-primary-btn" onClick={() => void submit()}>+ New Creator</button>}
        />
        <div className="studio-inline-form">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Creator name" />
          <input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="creator-slug" />
        </div>
        <CrudTable rows={rows} selectedId={selected?.creatorId} onSelect={(row) => setSelectedId(row.id)} emptyMessage="No creators match this search." />
      </Card>

      <Card title="Creator detail" eyebrow="Inspector">
        {selected ? (
          <InspectorPanel
            title={selected.name}
            subtitle={`/${selected.slug}`}
            status={<Pill label={selected.status === 'inactive' ? 'Inactive' : 'Active'} tone={selected.status === 'inactive' ? 'warning' : 'success'} />}
            actions={
              <>
                <button type="button" className="auth-secondary-btn">Edit</button>
                <button type="button" className="auth-secondary-btn">Ownership</button>
              </>
            }
          >
            <div className="studio-inspector-list">
              <div><strong>Creator ID</strong><span>{selected.creatorId || selected.creatorId}</span></div>
              <div><strong>Posts</strong><span>{posts.filter((post) => post.creatorId === selected.creatorId).length}</span></div>
              <div><strong>Files</strong><span>{files.filter((file) => file.creatorId === selected.creatorId).length}</span></div>
            </div>
            <div className="studio-inline-form" style={{ marginTop: '1rem', alignItems: 'center' }}>
              <label>
                <span className="small">Profile image/logo</span>
                <input
                  type="file"
                  accept="image/*"
                  disabled={uploadingProfile}
                  onChange={(event) => void uploadProfile(event.target.files?.[0])}
                />
              </label>
              <button type="button" className="auth-secondary-btn" disabled={uploadingProfile} onClick={() => void onRemoveProfileImage(selected.creatorId)}>
                Remove profile
              </button>
            </div>
            <div className="studio-inline-form" style={{ marginTop: '1rem', alignItems: 'center' }}>
              <label>
                <span className="small">Cover image</span>
                <input
                  type="file"
                  accept="image/*"
                  disabled={uploadingCover}
                  onChange={(event) => void uploadCover(event.target.files?.[0])}
                />
              </label>
              <button type="button" className="auth-secondary-btn" disabled={uploadingCover} onClick={() => void onRemoveCoverImage(selected.creatorId)}>
                Remove cover
              </button>
            </div>
            {(uploadingProfile || uploadingCover) && <p className="small">Uploading…</p>}
            {uploadError && <p className="error">{uploadError}</p>}
          </InspectorPanel>
        ) : (
          <div className="studio-empty-state">Select a creator to inspect ownership and content counts.</div>
        )}
      </Card>
    </section>
  );
}
