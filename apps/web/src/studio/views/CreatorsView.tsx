import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { brand } from '../../brand';
import { Card } from '../components/Card';
import { DataToolbar } from '../components/DataToolbar';
import { Pill } from '../components/Pill';
import type { StudioCreator, StudioFile, StudioPost } from '../types';
import { BrandingImageCropper, type BrandingImageSelection } from '../../components/BrandingImageCropper';
import { ProfileAvatar } from '../../components/ProfileAvatar';
import { defaultProfileCoverFor, defaultProfileCoverIdFor } from '../../profileDefaults';
import { ProfileCoverPicker } from '../../components/ProfileCoverPicker';
import { LimitedBioEditor } from '../../components/LimitedBioEditor';
import { ProfileExternalLinksEditor, type ProfileExternalLink, validateProfileExternalLinks } from '../../components/ProfileExternalLinksEditor';

const slugSuggestion = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const versionedMediaUrl = (url?: string, updatedAt?: string): string | undefined => {
  if (!url) return undefined;
  if (!updatedAt) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(updatedAt)}`;
};

type CreatorPayload = {
  name: string;
  slug: string;
  status: 'active' | 'inactive';
  space?: StudioCreator['space'];
};

export function CreatorsView({
  creators,
  posts,
  files,
  onCreateCreator,
  onUpdateCreator,
  onDeleteCreator,
  onUploadProfileImage,
  onUploadCoverImage,
  onRemoveProfileImage,
  onRemoveCoverImage,
  onSaved,
  profileCreatorId
}: {
  creators: StudioCreator[];
  posts: StudioPost[];
  files: StudioFile[];
  onCreateCreator: (payload: CreatorPayload) => Promise<StudioCreator>;
  onUpdateCreator: (creatorId: string, payload: CreatorPayload) => Promise<void>;
  onDeleteCreator: (creatorId: string) => Promise<void>;
  onUploadProfileImage: (creatorId: string, selection: BrandingImageSelection) => Promise<void>;
  onUploadCoverImage: (creatorId: string, selection: BrandingImageSelection) => Promise<void>;
  onRemoveProfileImage: (creatorId: string) => Promise<void>;
  onRemoveCoverImage: (creatorId: string) => Promise<void>;
  onSaved: () => Promise<void>;
  profileCreatorId?: string;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const requestedCreate = new URLSearchParams(location.search).get('create') === '1';
  const requestedEditId = new URLSearchParams(location.search).get('edit') || '';
  const profileMode = Boolean(profileCreatorId);
  const [search, setSearch] = useState('');
  const [formMode, setFormMode] = useState<'list' | 'create' | 'edit'>('list');
  const [editingCreatorId, setEditingCreatorId] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive'>('active');
  const [bio, setBio] = useState('');
  const [externalLinks, setExternalLinks] = useState<ProfileExternalLink[]>([]);
  const [spaceTheme, setSpaceTheme] = useState<'default' | 'ubeeq' | 'sand' | 'forest' | 'slate'>('default');
  const [showOnMemberProfile, setShowOnMemberProfile] = useState(false);
  const [spaceVisibility, setSpaceVisibility] = useState<'public-discoverable' | 'public-link' | 'private'>('private');
  const [shareCode, setShareCode] = useState('');
  const [profileImage, setProfileImage] = useState<BrandingImageSelection>();
  const [coverImage, setCoverImage] = useState<BrandingImageSelection>();
  const [coverPreset, setCoverPreset] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');
  const [savedCreatorId, setSavedCreatorId] = useState('');
  const [invalidExternalLinkIndexes, setInvalidExternalLinkIndexes] = useState<number[]>([]);
  const [invalidField, setInvalidField] = useState<'name' | 'slug' | 'external-links' | ''>('');
  const [nameSuggestions, setNameSuggestions] = useState<string[]>([]);
  const [slugSuggestions, setSlugSuggestions] = useState<string[]>([]);
  const [activeNameSuggestion, setActiveNameSuggestion] = useState('');
  const [activeSlugSuggestion, setActiveSlugSuggestion] = useState('');
  const formErrorRef = useRef<HTMLParagraphElement>(null);

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
    setExternalLinks(creator?.space?.externalLinks || []);
    setSpaceTheme(creator?.space?.theme || 'default');
    setShowOnMemberProfile(creator?.space?.showOnMemberProfile === true);
    setSpaceVisibility(creator?.space?.visibility || (creator ? 'public-discoverable' : 'private'));
    setShareCode(creator?.space?.shareCode || '');
    setProfileImage(undefined);
    setCoverImage(undefined);
    setCoverPreset(creator?.space?.coverPreset || '');
    setFormError('');
    setInvalidExternalLinkIndexes([]);
    setInvalidField('');
    setNameSuggestions([]);
    setSlugSuggestions([]);
    setActiveNameSuggestion('');
    setActiveSlugSuggestion('');
  };

  const showValidationError = (message: string, field: 'name' | 'slug' | 'external-links', linkIndexes: number[] = []) => {
    setFormError(message);
    setInvalidField(field);
    setInvalidExternalLinkIndexes(linkIndexes);
    requestAnimationFrame(() => {
      formErrorRef.current?.focus();
      const target = field === 'external-links'
        ? document.querySelector<HTMLInputElement>('[aria-label="External link 1 URL"][aria-invalid="true"], input[aria-invalid="true"]')
        : document.querySelector<HTMLInputElement>(`[data-creator-field="${field}"]`);
      target?.focus();
    });
  };

  const applyCreatorConflictSuggestions = (error: unknown) => {
    const details = (error as Error & { details?: { nameSuggestions?: unknown; slugSuggestions?: unknown } })?.details;
    setNameSuggestions(Array.isArray(details?.nameSuggestions) ? details.nameSuggestions.filter((value): value is string => typeof value === 'string') : []);
    setSlugSuggestions(Array.isArray(details?.slugSuggestions) ? details.slugSuggestions.filter((value): value is string => typeof value === 'string') : []);
    setActiveNameSuggestion('');
    setActiveSlugSuggestion('');
  };

  useEffect(() => {
    if (profileCreatorId) {
      const profileCreator = creators.find((creator) => creator.creatorId === profileCreatorId);
      if (profileCreator) {
        setFormMode('edit');
        setEditingCreatorId(profileCreator.creatorId);
        populateForm(profileCreator);
        return;
      }
    }
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
  }, [profileCreatorId, requestedCreate, requestedEditId, creators]);

  const openCreate = () => navigate('/studio/workspace?section=creators&create=1');
  const creatorProfileUrl = (creatorId: string) => `/studio/workspace?section=creator-profile&creatorId=${encodeURIComponent(creatorId)}`;
  const publicCreatorProfileUrl = (creator: Pick<StudioCreator, 'slug'>) => `/creators/${encodeURIComponent(creator.slug)}${import.meta.env.DEV ? '?preview=1' : ''}`;
  const openEdit = (creator: StudioCreator) => navigate(creatorProfileUrl(creator.creatorId));
  const closeForm = (creatorId = '') => navigate(profileMode
    ? creatorProfileUrl(creatorId || profileCreatorId || '')
    : `/studio/workspace?section=creators${creatorId ? `&creatorId=${encodeURIComponent(creatorId)}` : ''}`);
  const workAsCreator = (creator: StudioCreator) => navigate(`/studio/workspace?section=dashboard&creatorId=${encodeURIComponent(creator.creatorId)}`);

  const archiveCreator = async (creator: StudioCreator) => {
    if (!window.confirm(`Archive “${creator.name}”? This ${brand.creatorName.toLowerCase()} will no longer be active, but its existing work and settings will be retained.`)) return;
    setSaving(true);
    setFormError('');
    setFormSuccess('');
    setSavedCreatorId('');
    try {
      await onUpdateCreator(creator.creatorId, { name: creator.name, slug: creator.slug, status: 'inactive' });
      await onSaved();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : `Unable to archive this ${brand.creatorName.toLowerCase()}.`);
    } finally {
      setSaving(false);
    }
  };

  const generateShareCode = () => {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    setShareCode(Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''));
  };

  const deleteCreator = async (creator: StudioCreator) => {
    if (!window.confirm(`Permanently delete “${creator.name}”? This cannot be undone. Only use this for an empty or unwanted ${brand.creatorName.toLowerCase()} identity.`)) return;
    setSaving(true);
    setFormError('');
    try {
      await onDeleteCreator(creator.creatorId);
      await onSaved();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : `Unable to delete this ${brand.creatorName.toLowerCase()}.`);
    } finally {
      setSaving(false);
    }
  };

  const removeProfileImage = async () => {
    if (!editingCreator) return;
    if (!window.confirm('Remove this custom profile image? The assigned default icon will be shown instead.')) return;
    setSaving(true);
    setFormError('');
    try {
      await onRemoveProfileImage(editingCreator.creatorId);
      await onSaved();
      setProfileImage(undefined);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to remove the profile image.');
    } finally {
      setSaving(false);
    }
  };

  const removeCoverImage = async () => {
    if (!editingCreator) return;
    if (!window.confirm('Remove this custom cover image? The assigned default cover will be shown instead.')) return;
    setSaving(true);
    setFormError('');
    try {
      await onRemoveCoverImage(editingCreator.creatorId);
      await onSaved();
      setCoverImage(undefined);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to remove the cover image.');
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim() || slugSuggestion(trimmedName);
    if (!trimmedName) return showValidationError(`${brand.creatorName} name is required.`, 'name');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmedSlug)) return showValidationError('Handle / slug can use lowercase letters, numbers, and single hyphens only.', 'slug');
    if (formMode !== 'create') {
      const linkIssues = validateProfileExternalLinks(externalLinks);
      if (linkIssues.length) return showValidationError(linkIssues[0].message, 'external-links', linkIssues.map((issue) => issue.index));
    }
    const pendingProfileImage = profileImage;
    const pendingCoverImage = coverImage;
    setSaving(true);
    setFormError('');
    setFormSuccess('');
    setInvalidExternalLinkIndexes([]);
    setInvalidField('');
    setNameSuggestions([]);
    setSlugSuggestions([]);
    setActiveNameSuggestion('');
    setActiveSlugSuggestion('');
    try {
      // Creation is intentionally a small first step: establish an identity,
      // then let the Creator configure their full profile on its dedicated
      // page. New Spaces are private until explicitly changed there.
      const payload: CreatorPayload = formMode === 'create'
        ? {
            name: trimmedName,
            slug: trimmedSlug,
            status: 'active',
            space: { visibility: 'private' }
          }
        : {
            name: trimmedName,
            slug: trimmedSlug,
            status,
            space: {
              bio: bio.trim(),
              externalLinks,
              theme: spaceTheme,
              coverPreset: coverPreset || defaultProfileCoverIdFor(`creator:${trimmedSlug}`),
              visibility: spaceVisibility,
              shareCode: spaceVisibility === 'private' ? shareCode : '',
              showOnMemberProfile,
            }
          };
      if (formMode === 'create') {
        const creator = await onCreateCreator(payload);
        if (pendingProfileImage) await onUploadProfileImage(creator.creatorId, pendingProfileImage);
        if (pendingCoverImage) await onUploadCoverImage(creator.creatorId, pendingCoverImage);
        await onSaved();
        setFormSuccess(`${brand.creatorName} saved.`);
        setSavedCreatorId(creator.creatorId);
        navigate(publicCreatorProfileUrl(creator));
      } else if (editingCreator) {
        await onUpdateCreator(editingCreator.creatorId, payload);
        if (pendingProfileImage) await onUploadProfileImage(editingCreator.creatorId, pendingProfileImage);
        if (pendingCoverImage) await onUploadCoverImage(editingCreator.creatorId, pendingCoverImage);
        await onSaved();
        setFormSuccess(`${brand.creatorName} saved.`);
        setSavedCreatorId(editingCreator.creatorId);
        closeForm(editingCreator.creatorId);
      }
    } catch (error) {
      applyCreatorConflictSuggestions(error);
      setFormError(error instanceof Error ? error.message : `Unable to save this ${brand.creatorName.toLowerCase()}.`);
    } finally {
      setSaving(false);
    }
  };

  if (formMode !== 'list') {
    const isCreate = formMode === 'create';
    const currentIdentity = `creator:${editingCreator?.slug || slug || slugSuggestion(name) || 'new-creator'}`;
    const selectedCoverPreset = coverPreset || defaultProfileCoverIdFor(currentIdentity);
    const currentProfile = editingCreator?.branding?.profileImage;
    const currentProfileUrl = versionedMediaUrl(
      currentProfile?.thumbnailUrls?.square512 || currentProfile?.thumbnailUrls?.square256,
      currentProfile?.updatedAt
    );
    const currentCover = editingCreator?.branding?.coverImage;
    const assignedCover = defaultProfileCoverFor(currentIdentity, selectedCoverPreset);
    const currentDesktopCoverUrl = versionedMediaUrl(
      currentCover?.renditionUrls?.desktop || currentCover?.renditionUrls?.tablet || currentCover?.renditionUrls?.mobile,
      currentCover?.updatedAt
    ) || assignedCover;
    const currentMobileCoverUrl = versionedMediaUrl(
      currentCover?.renditionUrls?.mobile || currentCover?.renditionUrls?.tablet || currentCover?.renditionUrls?.desktop,
      currentCover?.updatedAt
    ) || assignedCover;
    return (
      <Card
        title={isCreate ? `Create ${brand.creatorName}` : profileMode ? `Edit ${brand.creatorName} Profile` : `Edit ${editingCreator?.name || brand.creatorName.toLowerCase()}`}
        eyebrow={isCreate ? `${brand.creatorPlural} / Create` : `${brand.creatorPlural} / Edit`}
        actions={profileMode
          ? <button type="button" className="auth-secondary-btn" onClick={() => navigate('/studio/workspace?section=creators')}>Manage {brand.creatorPlural}</button>
          : <button type="button" className="auth-secondary-btn" onClick={() => closeForm()}>Cancel</button>}
        className="studio-creator-form-card"
      >
        <p className="studio-creator-form-lede">{isCreate ? `Choose a name and handle. Once it is created, you can finish its profile, branding, visibility, and integrations.` : `Update this ${brand.creatorName.toLowerCase()} identity and its public profile details.`}</p>
        <div className="studio-creator-form">
          <label><span>{brand.creatorName} name</span><input data-creator-field="name" aria-invalid={invalidField === 'name' || undefined} value={name} onChange={(event) => { setName(event.target.value); setActiveNameSuggestion(''); setActiveSlugSuggestion(''); }} placeholder="e.g. Rex Studio" autoComplete="organization" />
            {nameSuggestions.length > 0 && <span className="studio-field-suggestions"><small>Try an available name:</small><span className="username-suggestions">{nameSuggestions.map((candidate) => {
              const relatedSlug = slugSuggestion(candidate);
              const isActive = activeNameSuggestion === candidate || (name.trim() === candidate && slug === relatedSlug);
              return <button type="button" key={candidate} className={`username-suggestion-pill${isActive ? ' username-suggestion-pill-active' : ''}`} aria-pressed={isActive} onClick={() => { setName(candidate); setSlug(relatedSlug); setActiveNameSuggestion(candidate); setActiveSlugSuggestion(relatedSlug); }}>{candidate}</button>;
            })}</span></span>}
          </label>
          <label><span>Handle / slug</span><input data-creator-field="slug" aria-invalid={invalidField === 'slug' || undefined} value={slug} onChange={(event) => { setSlug(event.target.value); setActiveSlugSuggestion(''); }} placeholder={slugSuggestion(name) || 'rex-studio'} autoCapitalize="none" autoCorrect="off" />
            {slugSuggestions.length > 0 && <span className="studio-field-suggestions"><small>Try an available handle:</small><span className="username-suggestions">{slugSuggestions.map((candidate) => {
              const selectedFromName = nameSuggestions.some((nameCandidate) => name.trim() === nameCandidate && slugSuggestion(nameCandidate) === candidate);
              const isActive = activeSlugSuggestion === candidate || selectedFromName;
              return <button type="button" key={candidate} className={`username-suggestion-pill${isActive ? ' username-suggestion-pill-active' : ''}`} aria-pressed={isActive} onClick={() => { setSlug(candidate); setActiveSlugSuggestion(candidate); }}>{candidate}</button>;
            })}</span></span>}
          </label>
          {!isCreate && <div className="studio-creator-form-wide studio-branding-editor">
            {!isCreate && editingCreator && (
              <section className="studio-current-branding studio-current-branding-profile" aria-label="Current profile image">
                <div className="studio-current-branding-heading">
                  <div>
                    <strong>Current profile image</strong>
                    <span>{currentProfile ? 'Custom image' : 'Assigned default icon'}</span>
                  </div>
                  {currentProfile && <button type="button" className="auth-secondary-btn studio-branding-remove-btn" disabled={saving} onClick={() => void removeProfileImage()}>Remove image</button>}
                </div>
                <div className="studio-current-profile-preview">
                  <ProfileAvatar src={currentProfileUrl} identity={currentIdentity} alt={`${editingCreator.name} profile`} />
                </div>
                <p>{currentProfile ? 'This is the image currently shown anywhere this Creator’s avatar appears.' : 'No custom profile image is set. The assigned Ubeeq icon is shown across the app.'}</p>
              </section>
            )}
            <BrandingImageCropper kind="profile" disabled={saving} onChange={setProfileImage} />
          </div>}
          {!isCreate && <div className="studio-creator-form-wide studio-branding-editor">
            {!isCreate && editingCreator && (
              <section className="studio-current-branding studio-current-branding-cover" aria-label="Current cover image">
                <div className="studio-current-branding-heading">
                  <div>
                    <strong>Current cover image</strong>
                    <span>{currentCover ? 'Custom responsive cover' : assignedCover ? 'Assigned default cover' : 'No cover set'}</span>
                  </div>
                  {currentCover && <button type="button" className="auth-secondary-btn studio-branding-remove-btn" disabled={saving} onClick={() => void removeCoverImage()}>Remove image</button>}
                </div>
                <div className="studio-current-cover-previews">
                  <figure className="studio-current-cover-desktop">
                    {currentDesktopCoverUrl ? <img src={currentDesktopCoverUrl} alt="Current desktop cover crop" /> : <span>No cover image</span>}
                    <figcaption>Desktop</figcaption>
                  </figure>
                  <figure className="studio-current-cover-mobile">
                    {currentMobileCoverUrl ? <img src={currentMobileCoverUrl} alt="Current mobile cover crop" /> : <span>No cover image</span>}
                    <figcaption>Mobile</figcaption>
                  </figure>
                </div>
                <p>{currentCover ? 'These are the responsive crops currently shown on this Creator’s public profile.' : assignedCover ? 'No custom cover is set. This assigned Eversally cover is currently shown.' : 'No custom or platform cover is currently shown.'}</p>
              </section>
            )}
            <ProfileCoverPicker
              identity={currentIdentity}
              selectedPreset={selectedCoverPreset}
              customCoverSet={Boolean(currentCover)}
              disabled={saving}
              onChange={setCoverPreset}
            />
            <BrandingImageCropper kind="cover" disabled={saving} onChange={setCoverImage} />
          </div>}
          {!isCreate && <><div className="studio-creator-form-wide"><span className="studio-profile-field-label">Space bio</span><LimitedBioEditor value={bio} onChange={setBio} maxLength={5000} placeholder="Tell visitors about this creator and their work." /></div>
          <div className="studio-creator-form-wide"><span className="studio-profile-field-label">External links</span><ProfileExternalLinksEditor value={externalLinks} onChange={setExternalLinks} invalidIndexes={invalidExternalLinkIndexes} /></div>
          <label><span>Space theme</span><select value={spaceTheme} onChange={(event) => setSpaceTheme(event.target.value as typeof spaceTheme)}><option value="default">Platform default</option><option value="ubeeq">Ubeeq</option><option value="sand">Sand</option><option value="forest">Forest</option><option value="slate">Slate</option></select></label>
          <fieldset className="studio-creator-form-wide studio-space-announcement">
            <legend>Member profile</legend>
            <label className="studio-work-metadata-option">
              <input type="checkbox" checked={showOnMemberProfile} onChange={(event) => setShowOnMemberProfile(event.target.checked)} />
              <span>Show this {brand.creatorName} on my public member profile</span>
            </label>
            <p className="small">Off by default. When enabled, visitors can find this identity under “A Creator” on your member profile.</p>
          </fieldset>
          <fieldset className="studio-creator-form-wide studio-space-announcement"><legend>Creator Space visibility</legend><label><span>Visibility</span><select value={spaceVisibility} onChange={(event) => setSpaceVisibility(event.target.value as typeof spaceVisibility)}><option value="public-discoverable">Public and discoverable</option><option value="public-link">Public — link only</option><option value="private">Private — share code required</option></select></label>{spaceVisibility === 'private' && <div className="studio-share-code"><p>Only people with this link can view your Creator profile, Works, and Collections. Replace or revoke the code any time to end access.</p><div className="studio-inline-actions"><input value={shareCode} readOnly placeholder="Generate a share code" aria-label="Creator Space share code" /><button type="button" className="auth-secondary-btn" onClick={generateShareCode}>Generate new code</button>{shareCode && <button type="button" className="auth-secondary-btn studio-danger-btn" onClick={() => setShareCode('')}>Revoke code</button>}{shareCode && <a className="auth-secondary-btn no-underline" target="_blank" rel="noreferrer" href={`/creators/${encodeURIComponent(editingCreator?.slug || slug)}?access=${encodeURIComponent(shareCode)}`}>Open shared Space</a>}</div></div>}</fieldset>
          </>}
        </div>
        <div className="studio-inline-actions">
          <button type="button" className="auth-primary-btn" disabled={!name.trim() || saving} onClick={() => void submit()}>{saving ? 'Saving…' : isCreate ? `Create ${brand.creatorName}` : 'Save Profile'}</button>
          {!profileMode && <button type="button" className="auth-secondary-btn" disabled={saving} onClick={() => closeForm()}>Cancel</button>}
          {formSuccess && savedCreatorId === editingCreator?.creatorId && <p className="success studio-inline-success" role="status">{formSuccess}</p>}
        </div>
        {formError && <p className="error" role="alert" tabIndex={-1} ref={formErrorRef}>{formError}</p>}
        {!isCreate && editingCreator && editingCreator.status !== 'inactive' && <section className="studio-creator-danger-zone"><h2>Deactivate {brand.creatorName}</h2><p>Deactivating hides this Creator and its public Space. You can reactivate it later. Account deletion will require deactivation first.</p><button type="button" className="auth-secondary-btn studio-danger-btn" disabled={saving} onClick={() => void archiveCreator(editingCreator)}>Deactivate {brand.creatorName}</button></section>}
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
                {creator.status !== 'inactive' && <button type="button" className="auth-secondary-btn" onClick={() => openEdit(creator)}>Profile & lifecycle</button>}
              </div>
            </article>
          ))}
        </div>
      ) : <div className="studio-empty-state">No {brand.creatorPlural.toLowerCase()} match this search.</div>}
      {formError && <p className="error">{formError}</p>}
    </Card>
  );
}
