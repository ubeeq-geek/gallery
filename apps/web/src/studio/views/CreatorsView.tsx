import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { brand } from '../../brand';
import { Card } from '../components/Card';
import { DataToolbar } from '../components/DataToolbar';
import { Pill } from '../components/Pill';
import type { StudioCreator, StudioFile, StudioPost } from '../types';

const slugSuggestion = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

type CreatorPayload = {
  name: string;
  slug: string;
  status: 'active' | 'inactive';
  space?: StudioCreator['space'];
};

const parseExternalLinks = (value: string): Array<{ label: string; url: string }> => value
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .flatMap((line) => {
    const [first, ...rest] = line.split('|').map((part) => part.trim());
    const url = rest.length ? rest.join('|') : first;
    if (!url) return [];
    return [{ label: rest.length ? first : '', url }];
  });

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
  const [bio, setBio] = useState('');
  const [externalLinks, setExternalLinks] = useState('');
  const [spaceTheme, setSpaceTheme] = useState<'default' | 'ubeeq' | 'sand' | 'forest' | 'slate'>('default');
  const [announcementEnabled, setAnnouncementEnabled] = useState(false);
  const [announcementMessage, setAnnouncementMessage] = useState('');
  const [announcementUrl, setAnnouncementUrl] = useState('');
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
    setBio(creator?.space?.bio || '');
    setExternalLinks((creator?.space?.externalLinks || []).map((link) => `${link.label} | ${link.url}`).join('\n'));
    setSpaceTheme(creator?.space?.theme || 'default');
    setAnnouncementEnabled(creator?.space?.announcement?.enabled === true);
    setAnnouncementMessage(creator?.space?.announcement?.message || '');
    setAnnouncementUrl(creator?.space?.announcement?.url || '');
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
    if (!window.confirm(`Archive “${creator.name}”? This ${brand.creatorName.toLowerCase()} will no longer be active, but its existing work and settings will be retained.`)) return;
    setSaving(true);
    setFormError('');
    try {
      await onUpdateCreator(creator.creatorId, { name: creator.name, slug: creator.slug, status: 'inactive' });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : `Unable to archive this ${brand.creatorName.toLowerCase()}.`);
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
      const payload: CreatorPayload = {
        name: trimmedName,
        slug: trimmedSlug,
        status,
        space: {
          bio: bio.trim(),
          externalLinks: parseExternalLinks(externalLinks),
          theme: spaceTheme,
          announcement: {
            enabled: announcementEnabled,
            message: announcementMessage.trim(),
            url: announcementUrl.trim() || undefined
          }
        }
      };
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
      setFormError(error instanceof Error ? error.message : `Unable to save this ${brand.creatorName.toLowerCase()}.`);
    } finally {
      setSaving(false);
    }
  };

  if (formMode !== 'list') {
    const isCreate = formMode === 'create';
    return (
      <Card
        title={isCreate ? `Create ${brand.id === 'eversally' ? 'an' : 'a'} ${brand.creatorName}` : `Edit ${editingCreator?.name || brand.creatorName.toLowerCase()}`}
        eyebrow={isCreate ? `${brand.creatorPlural} / Create` : `${brand.creatorPlural} / Edit`}
        actions={<button type="button" className="auth-secondary-btn" onClick={() => closeForm()}>Cancel</button>}
        className="studio-creator-form-card"
      >
        <p className="studio-creator-form-lede">{isCreate ? `Set up a new ${brand.creatorName.toLowerCase()} identity. You can connect integrations afterward.` : `Update this ${brand.creatorName.toLowerCase()} identity and its public profile details.`}</p>
        <div className="studio-creator-form">
          <label><span>{brand.creatorName} name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Rex Studio" autoComplete="organization" /></label>
          <label><span>Handle / slug</span><input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder={slugSuggestion(name) || 'rex-studio'} autoCapitalize="none" autoCorrect="off" /></label>
          <label><span>Profile image</span><input type="file" accept="image/*" onChange={(event) => setProfileImage(event.target.files?.[0])} /></label>
          <label><span>Cover image</span><input type="file" accept="image/*" onChange={(event) => setCoverImage(event.target.files?.[0])} /></label>
          <label className="studio-creator-form-wide"><span>Space bio</span><textarea value={bio} onChange={(event) => setBio(event.target.value)} rows={5} placeholder="Tell visitors about this creator and their work." /></label>
          <label className="studio-creator-form-wide"><span>External links</span><textarea value={externalLinks} onChange={(event) => setExternalLinks(event.target.value)} rows={4} placeholder={'Portfolio | https://example.com\nBluesky | https://bsky.app/profile/example.com'} /><small>One link per line. Use “Label | URL”.</small></label>
          <label><span>Space theme</span><select value={spaceTheme} onChange={(event) => setSpaceTheme(event.target.value as typeof spaceTheme)}><option value="default">Platform default</option><option value="ubeeq">Ubeeq</option><option value="sand">Sand</option><option value="forest">Forest</option><option value="slate">Slate</option></select></label>
          <label><span>{brand.creatorName} status</span><select value={status} onChange={(event) => setStatus(event.target.value as 'active' | 'inactive')}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
          <fieldset className="studio-creator-form-wide studio-space-announcement"><legend>Space announcement</legend><label className="studio-work-metadata-option"><input type="checkbox" checked={announcementEnabled} onChange={(event) => setAnnouncementEnabled(event.target.checked)} /><span>Show an announcement on public Space pages</span></label><label><span>Message</span><input value={announcementMessage} onChange={(event) => setAnnouncementMessage(event.target.value)} placeholder="New collection available now" /></label><label><span>Optional link</span><input type="url" value={announcementUrl} onChange={(event) => setAnnouncementUrl(event.target.value)} placeholder="https://example.com/news" /></label></fieldset>
        </div>
        <div className="studio-inline-actions">
          <button type="button" className="auth-primary-btn" disabled={!name.trim() || saving} onClick={() => void submit()}>{saving ? 'Saving…' : isCreate ? `Create ${brand.creatorName}` : `Save ${brand.creatorName}`}</button>
          {!isCreate && editingCreator?.branding?.profileImage && <button type="button" className="auth-secondary-btn" disabled={saving} onClick={() => void onRemoveProfileImage(editingCreator.creatorId)}>Remove profile image</button>}
          {!isCreate && editingCreator?.branding?.coverImage && <button type="button" className="auth-secondary-btn" disabled={saving} onClick={() => void onRemoveCoverImage(editingCreator.creatorId)}>Remove cover image</button>}
          <button type="button" className="auth-secondary-btn" disabled={saving} onClick={() => closeForm()}>Cancel</button>
        </div>
        {formError && <p className="error">{formError}</p>}
      </Card>
    );
  }

  return (
    <Card title={brand.creatorPlural} eyebrow="Ownership and identity" actions={<button type="button" className="auth-primary-btn" onClick={openCreate}>Add a New {brand.creatorName}</button>}>
      <DataToolbar search={search} onSearchChange={setSearch} searchPlaceholder={`Search ${brand.creatorPlural.toLowerCase()}...`} />
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
                <button type="button" className="auth-secondary-btn" onClick={() => workAsCreator(creator)}>Work as this {brand.creatorName}</button>
                <button type="button" className="auth-secondary-btn" onClick={() => openEdit(creator)}>Edit {brand.creatorName}</button>
                {creator.status !== 'inactive' && <button type="button" className="auth-secondary-btn" disabled={saving} onClick={() => void archiveCreator(creator)}>Archive {brand.creatorName}</button>}
              </div>
            </article>
          ))}
        </div>
      ) : <div className="studio-empty-state">No {brand.creatorPlural.toLowerCase()} match this search.</div>}
      {formError && <p className="error">{formError}</p>}
    </Card>
  );
}
