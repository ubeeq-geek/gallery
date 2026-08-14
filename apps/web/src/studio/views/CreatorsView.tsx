import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Card } from '../components/Card';
import { DataToolbar } from '../components/DataToolbar';
import { Pill } from '../components/Pill';
import type { StudioCreator, StudioFile, StudioPost } from '../types';

const slugSuggestion = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

type CreatorPayload = { name: string; slug: string; status: 'active' | 'inactive' };

export function CreatorsView({
  creators,
  posts,
  files,
  onCreateCreator,
  onUpdateCreator,
  onUploadProfileImage,
  onUploadCoverImage,
  onRemoveProfileImage,
  onRemoveCoverImage
}: {
  creators: StudioCreator[];
  posts: StudioPost[];
  files: StudioFile[];
  onCreateCreator: (payload: CreatorPayload) => Promise<StudioCreator>;
  onUpdateCreator: (creatorId: string, payload: CreatorPayload) => Promise<void>;
  onUploadProfileImage: (creatorId: string, file: File) => Promise<void>;
  onUploadCoverImage: (creatorId: string, file: File) => Promise<void>;
  onRemoveProfileImage: (creatorId: string) => Promise<void>;
  onRemoveCoverImage: (creatorId: string) => Promise<void>;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const requestedCreate = new URLSearchParams(location.search).get('create') === '1';
  const requestedEditId = new URLSearchParams(location.search).get('edit') || '';
  const [search, setSearch] = useState('');
  const [formMode, setFormMode] = useState<'list' | 'create' | 'edit'>('list');
  const [editingCreatorId, setEditingCreatorId] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive'>('active');
  const [profileImage, setProfileImage] = useState<File>();
  const [coverImage, setCoverImage] = useState<File>();
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return creators;
    return creators.filter((creator) => creator.name.toLowerCase().includes(query) || creator.slug.toLowerCase().includes(query));
  }, [creators, search]);
  const editingCreator = creators.find((creator) => creator.creatorId === editingCreatorId);

  const populateForm = (creator?: StudioCreator) => {
    setName(creator?.name || '');
    setSlug(creator?.slug || '');
    setStatus(creator?.status === 'inactive' ? 'inactive' : 'active');
    setProfileImage(undefined);
    setCoverImage(undefined);
    setFormError('');
  };

  useEffect(() => {
    if (requestedCreate) {
      setFormMode('create');
      setEditingCreatorId('');
      populateForm();
      return;
    }
    const requestedCreator = creators.find((creator) => creator.creatorId === requestedEditId);
    if (requestedCreator) {
      setFormMode('edit');
      setEditingCreatorId(requestedCreator.creatorId);
      populateForm(requestedCreator);
      return;
    }
    setFormMode('list');
    setEditingCreatorId('');
  // The route is the source of truth for this screen's mode.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedCreate, requestedEditId, creators]);

  const openCreate = () => navigate('/studio/workspace?section=creators&create=1');
  const openEdit = (creator: StudioCreator) => navigate(`/studio/workspace?section=creators&creatorId=${encodeURIComponent(creator.creatorId)}&edit=${encodeURIComponent(creator.creatorId)}`);
  const closeForm = (creatorId = '') => navigate(`/studio/workspace?section=creators${creatorId ? `&creatorId=${encodeURIComponent(creatorId)}` : ''}`);
  const workAsCreator = (creator: StudioCreator) => navigate(`/studio/workspace?section=dashboard&creatorId=${encodeURIComponent(creator.creatorId)}`);

  const archiveCreator = async (creator: StudioCreator) => {
    if (!window.confirm(`Archive “${creator.name}”? This creator will no longer be active, but its existing work and settings will be retained.`)) return;
    setSaving(true);
    setFormError('');
    try {
      await onUpdateCreator(creator.creatorId, { name: creator.name, slug: creator.slug, status: 'inactive' });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to archive this creator.');
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim() || slugSuggestion(trimmedName);
    if (!trimmedName || !trimmedSlug) return;
    setSaving(true);
    setFormError('');
    try {
      const payload = { name: trimmedName, slug: trimmedSlug, status };
      if (formMode === 'create') {
        const creator = await onCreateCreator(payload);
        if (profileImage) await onUploadProfileImage(creator.creatorId, profileImage);
        if (coverImage) await onUploadCoverImage(creator.creatorId, coverImage);
        closeForm(creator.creatorId);
      } else if (editingCreator) {
        await onUpdateCreator(editingCreator.creatorId, payload);
        if (profileImage) await onUploadProfileImage(editingCreator.creatorId, profileImage);
        if (coverImage) await onUploadCoverImage(editingCreator.creatorId, coverImage);
        closeForm(editingCreator.creatorId);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to save this creator.');
    } finally {
      setSaving(false);
    }
  };

  if (formMode !== 'list') {
    const isCreate = formMode === 'create';
    return (
      <Card
        title={isCreate ? 'Create a creator' : `Edit ${editingCreator?.name || 'creator'}`}
        eyebrow={isCreate ? 'Creators / Create' : 'Creators / Edit'}
        actions={<button type="button" className="auth-secondary-btn" onClick={() => closeForm()}>Cancel</button>}
        className="studio-creator-form-card"
      >
        <p className="studio-creator-form-lede">{isCreate ? 'Set up a new creator identity. You can connect integrations afterward.' : 'Update this creator identity and its public profile details.'}</p>
        <div className="studio-creator-form">
          <label><span>Creator name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Rex Studio" autoComplete="organization" /></label>
          <label><span>Handle / slug</span><input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder={slugSuggestion(name) || 'rex-studio'} autoCapitalize="none" autoCorrect="off" /></label>
          <label><span>Profile image</span><input type="file" accept="image/*" onChange={(event) => setProfileImage(event.target.files?.[0])} /></label>
          <label><span>Cover image</span><input type="file" accept="image/*" onChange={(event) => setCoverImage(event.target.files?.[0])} /></label>
          <label><span>Creator status</span><select value={status} onChange={(event) => setStatus(event.target.value as 'active' | 'inactive')}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        </div>
        <div className="studio-inline-actions">
          <button type="button" className="auth-primary-btn" disabled={!name.trim() || saving} onClick={() => void submit()}>{saving ? 'Saving…' : isCreate ? 'Create creator' : 'Save creator'}</button>
          {!isCreate && editingCreator?.branding?.profileImage && <button type="button" className="auth-secondary-btn" disabled={saving} onClick={() => void onRemoveProfileImage(editingCreator.creatorId)}>Remove profile image</button>}
          {!isCreate && editingCreator?.branding?.coverImage && <button type="button" className="auth-secondary-btn" disabled={saving} onClick={() => void onRemoveCoverImage(editingCreator.creatorId)}>Remove cover image</button>}
          <button type="button" className="auth-secondary-btn" disabled={saving} onClick={() => closeForm()}>Cancel</button>
        </div>
        {formError && <p className="error">{formError}</p>}
      </Card>
    );
  }

  return (
    <Card title="Creators" eyebrow="Ownership and identity" actions={<button type="button" className="auth-primary-btn" onClick={openCreate}>Add a New Creator</button>}>
      <DataToolbar search={search} onSearchChange={setSearch} searchPlaceholder="Search creators..." />
      {filtered.length ? (
        <div className="studio-creator-management-list">
          {filtered.map((creator) => (
            <article className="studio-creator-management-row" key={creator.creatorId}>
              <div>
                <strong>{creator.name}</strong>
                <span>@{creator.slug}</span>
                <small>{posts.filter((post) => post.creatorId === creator.creatorId).length} posts · {files.filter((file) => file.creatorId === creator.creatorId).length} files</small>
              </div>
              <div className="studio-creator-row-actions">
                <Pill label={creator.status === 'inactive' ? 'Archived' : 'Active'} tone={creator.status === 'inactive' ? 'warning' : 'success'} />
                <button type="button" className="auth-secondary-btn" onClick={() => workAsCreator(creator)}>Work as this Creator</button>
                <button type="button" className="auth-secondary-btn" onClick={() => openEdit(creator)}>Edit Creator</button>
                {creator.status !== 'inactive' && <button type="button" className="auth-secondary-btn" disabled={saving} onClick={() => void archiveCreator(creator)}>Archive Creator</button>}
              </div>
            </article>
          ))}
        </div>
      ) : <div className="studio-empty-state">No creators match this search.</div>}
      {formError && <p className="error">{formError}</p>}
    </Card>
  );
}
