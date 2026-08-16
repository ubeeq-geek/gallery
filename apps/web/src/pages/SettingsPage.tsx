import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import {
  APPEARANCE_CHANGE_EVENT,
  readAppearancePreference,
  setAppearancePreference,
  type AppearancePreference
} from '../appearance';
import { brand } from '../brand';
import { changePassword, signOut, type CurrentUser } from '../cognitoAuth';
import type { AiFilterPreference, ContentRating, ManagedCollection, ManagedFavorite, UserProfile } from '../domainTypes';
import { aiFilterOptions, contentRatingOptions, heavyTopicLabels } from '../discoveryUtils';
import AutoLoadSentinel from '../components/AutoLoadSentinel';
import { BrandingImageCropper, type BrandingImageSelection } from '../components/BrandingImageCropper';
import { ProfileAvatar } from '../components/ProfileAvatar';
import { ProfileCoverPicker } from '../components/ProfileCoverPicker';
import { LimitedBioEditor } from '../components/LimitedBioEditor';
import { ProfileExternalLinksEditor, type ProfileExternalLink, validateProfileExternalLinks } from '../components/ProfileExternalLinksEditor';
import { defaultProfileCoverFor, defaultProfileCoverIdFor } from '../profileDefaults';

const versionedMediaUrl = (url?: string, updatedAt?: string): string | undefined => {
  if (!url || !updatedAt) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(updatedAt)}`;
};

type MemberSettingsSection = 'profile' | 'curation' | 'preferences' | 'security';

const memberSettingsSections: Array<{ key: MemberSettingsSection; label: string; description: string }> = [
  { key: 'profile', label: 'Profile', description: 'Manage your public member identity, profile imagery, and profile address.' },
  { key: 'curation', label: 'Collections & favourites', description: 'Organize the collections and favourites owned by your selected profile.' },
  { key: 'preferences', label: 'Preferences', description: 'Choose appearance, content, and discovery preferences for your account.' },
  { key: 'security', label: 'Security', description: 'Manage sign-in and account security settings.' }
];

export default function SettingsPage({ user, onProfileChanged }: { user: CurrentUser; onProfileChanged?: (profile: UserProfile) => void }) {
  const navigate = useNavigate();
  const routeLocation = useLocation();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [externalLinks, setExternalLinks] = useState<ProfileExternalLink[]>([]);
  const [location, setLocation] = useState('');
  const [website, setWebsite] = useState('');
  const [matureContentEnabled, setMatureContentEnabled] = useState(false);
  const [maxAllowedContentRating, setMaxAllowedContentRating] = useState<ContentRating>('graphic');
  const [aiFilter, setAiFilter] = useState<AiFilterPreference>('show-all');
  const [hideHeavyTopics, setHideHeavyTopics] = useState(false);
  const [hidePoliticsPublicAffairs, setHidePoliticsPublicAffairs] = useState(false);
  const [hideCrimeDisastersTragedy, setHideCrimeDisastersTragedy] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [usernameSuggestions, setUsernameSuggestions] = useState<string[]>([]);
  const [usernameError, setUsernameError] = useState('');
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [profileFavorites, setProfileFavorites] = useState<ManagedFavorite[]>([]);
  const [profileCollections, setProfileCollections] = useState<ManagedCollection[]>([]);
  const [favoritesCursor, setFavoritesCursor] = useState<string | undefined>(undefined);
  const [collectionsCursor, setCollectionsCursor] = useState<string | undefined>(undefined);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [collectionsLoading, setCollectionsLoading] = useState(false);
  const [newCollectionTitle, setNewCollectionTitle] = useState('');
  const [newCollectionVisibility, setNewCollectionVisibility] = useState<'public' | 'private'>('public');
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>('');
  const [selectedCollectionImageIds, setSelectedCollectionImageIds] = useState<string[]>([]);
  const [collectionImageIdInput, setCollectionImageIdInput] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [appearance, setAppearance] = useState<AppearancePreference>(() => readAppearancePreference());
  const [profileImageSelection, setProfileImageSelection] = useState<BrandingImageSelection>();
  const [coverImageSelection, setCoverImageSelection] = useState<BrandingImageSelection>();
  const [coverPreset, setCoverPreset] = useState('');
  const [mediaSaving, setMediaSaving] = useState(false);
  const [invalidExternalLinkIndexes, setInvalidExternalLinkIndexes] = useState<number[]>([]);
  const errorNoticeRef = useRef<HTMLParagraphElement>(null);
  const profileUrlPreview = `${window.location.origin.replace(/\/$/, '')}/u/${(usernameInput || '').trim() || 'your-profile-url'}`;
  const selectedOwnerContext = { ownerProfileType: 'user' as const };
  const profileAvatarUrl = profile?.branding?.profileImage?.thumbnailUrls?.square512
    || profile?.branding?.profileImage?.thumbnailUrls?.square256;
  const profileCoverUrl = profile?.branding?.coverImage?.renditionUrls?.desktop
    || profile?.branding?.coverImage?.renditionUrls?.tablet
    || profile?.branding?.coverImage?.renditionUrls?.mobile;
  const profileCoverMobileUrl = profile?.branding?.coverImage?.renditionUrls?.mobile
    || profile?.branding?.coverImage?.renditionUrls?.tablet
    || profile?.branding?.coverImage?.renditionUrls?.desktop;
  const memberIdentity = `member:${profile?.username || user?.username || 'member'}`;
  const selectedCoverPreset = coverPreset || defaultProfileCoverIdFor(memberIdentity);
  const defaultProfileCoverUrl = defaultProfileCoverFor(memberIdentity, selectedCoverPreset);
  const currentProfileAvatarUrl = versionedMediaUrl(profileAvatarUrl, profile?.branding?.profileImage?.updatedAt);
  const currentDesktopCoverUrl = versionedMediaUrl(profileCoverUrl, profile?.branding?.coverImage?.updatedAt) || defaultProfileCoverUrl;
  const currentMobileCoverUrl = versionedMediaUrl(profileCoverMobileUrl, profile?.branding?.coverImage?.updatedAt) || defaultProfileCoverUrl;
  const requestedSection = new URLSearchParams(routeLocation.search).get('section');
  const activeSection = memberSettingsSections.some((item) => item.key === requestedSection)
    ? requestedSection as MemberSettingsSection
    : 'profile';
  const sectionMeta = memberSettingsSections.find((item) => item.key === activeSection) || memberSettingsSections[0];
  const memberDisplayName = profile?.displayName || user?.displayName || profile?.username || user?.username || brand.memberName;
  const memberHandle = profile?.username || user?.username || 'member';
  const memberSectionHref = (section: MemberSettingsSection) => `/settings?section=${section}`;

  const reloadCuration = async () => {
    const [favoritesPage, collectionsPage] = await Promise.all([
      api.myFavoritesPage(selectedOwnerContext, undefined, 24) as Promise<{ items: ManagedFavorite[]; nextCursor?: string }>,
      api.myCollectionsPage(selectedOwnerContext, undefined, 24) as Promise<{ items: ManagedCollection[]; nextCursor?: string }>
    ]);
    setProfileFavorites(favoritesPage.items || []);
    setProfileCollections(collectionsPage.items || []);
    setFavoritesCursor(favoritesPage.nextCursor);
    setCollectionsCursor(collectionsPage.nextCursor);
  };

  if (!user) return <Navigate to="/auth/signin" replace />;

  useEffect(() => {
    const handleAppearanceChange = (event: Event) => {
      const preference = (event as CustomEvent<AppearancePreference>).detail;
      setAppearance(preference || readAppearancePreference());
    };
    window.addEventListener(APPEARANCE_CHANGE_EVENT, handleAppearanceChange);
    return () => window.removeEventListener(APPEARANCE_CHANGE_EVENT, handleAppearanceChange);
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const loaded = await api.getMyProfile() as UserProfile;
        setProfile(loaded);
        onProfileChanged?.(loaded);
        setDisplayName(loaded.displayName || '');
        setBio(loaded.bio || '');
        setExternalLinks(loaded.externalLinks || []);
        setLocation(loaded.location || '');
        setWebsite(loaded.website || '');
        setCoverPreset(loaded.coverPreset || '');
        setMatureContentEnabled(Boolean(loaded.matureContentEnabled));
        setMaxAllowedContentRating(loaded.maxAllowedContentRating || 'graphic');
        setAiFilter(loaded.aiFilter || 'show-all');
        setHideHeavyTopics(Boolean(loaded.hideHeavyTopics));
        setHidePoliticsPublicAffairs(Boolean(loaded.hidePoliticsPublicAffairs));
        setHideCrimeDisastersTragedy(Boolean(loaded.hideCrimeDisastersTragedy));
        setUsernameInput(loaded.username || '');
      } catch (e) {
        const msg = (e as Error).message || '';
        if (msg.toLowerCase().includes('authentication required') || msg.toLowerCase().includes('unauthorized')) {
          await signOut();
          navigate('/auth/signin', { replace: true });
          return;
        }
        setError(msg);
      }
    };
    void load();
  }, [navigate, onProfileChanged]);

  const saveProfile = async () => {
    const linkIssues = validateProfileExternalLinks(externalLinks, false);
    if (linkIssues.length) {
      setMessage('');
      setError(linkIssues[0].message);
      setInvalidExternalLinkIndexes(linkIssues.map((issue) => issue.index));
      requestAnimationFrame(() => {
        errorNoticeRef.current?.focus();
        document.querySelector<HTMLInputElement>('[aria-label="External link 1 URL"][aria-invalid="true"], input[aria-invalid="true"]')?.focus();
      });
      return;
    }
    try {
      setError('');
      setMessage('');
      setInvalidExternalLinkIndexes([]);
      const updated = await api.updateMyProfile({
        displayName: displayName || undefined,
        bio: bio || undefined,
        externalLinks,
        location: location || undefined,
        website: website || undefined,
        coverPreset: coverPreset || defaultProfileCoverIdFor(memberIdentity),
        matureContentEnabled,
        maxAllowedContentRating,
        aiFilter,
        hideHeavyTopics,
        hidePoliticsPublicAffairs,
        hideCrimeDisastersTragedy
      }) as UserProfile;
      setProfile(updated);
      setBio(updated.bio || '');
      setExternalLinks(updated.externalLinks || []);
      onProfileChanged?.(updated);
      setMessage('Profile updated');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const reloadProfile = async () => {
    const loaded = await api.getMyProfile() as UserProfile;
    setProfile(loaded);
    onProfileChanged?.(loaded);
    return loaded;
  };

  const uploadProfileMedia = async (kind: 'profile' | 'cover', selection?: BrandingImageSelection) => {
    if (!selection) return;
    const { file } = selection;
    setMediaSaving(true);
    setError('');
    setMessage('');
    try {
      const upload = await api.createMyProfileBrandingUploadUrl({ kind, contentType: file.type || 'image/jpeg' });
      await api.uploadPreparedFile(upload, file);
      if (kind === 'cover') await api.setMyProfileCover({
        sourceKey: upload.key,
        altText: `${displayName || profile?.username || 'Member'} cover image`,
        focalPoint: selection.focalPoint
      });
      else await api.setMyProfileImage({
        sourceKey: upload.key,
        altText: `${displayName || profile?.username || 'Member'} profile image`,
        squareCrop: selection.squareCrop
      });
      await reloadProfile();
      if (kind === 'cover') setCoverImageSelection(undefined);
      else setProfileImageSelection(undefined);
      setMessage(`${kind === 'cover' ? 'Cover' : 'Profile'} image updated`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setMediaSaving(false);
    }
  };

  const removeProfileMedia = async (kind: 'profile-image' | 'cover-image') => {
    const label = kind === 'cover-image' ? 'cover image' : 'profile image';
    if (!window.confirm(`Remove your custom ${label}? Your assigned default will be shown instead.`)) return;
    setMediaSaving(true);
    setError('');
    setMessage('');
    try {
      await api.deleteMyProfileBranding(kind);
      await reloadProfile();
      setMessage(`${kind === 'cover-image' ? 'Cover' : 'Profile'} image removed`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setMediaSaving(false);
    }
  };

  useEffect(() => {
    if (profile) {
      setDisplayName(profile.displayName || '');
      setUsernameInput(profile.username || '');
      setBio(profile.bio || '');
      setExternalLinks(profile.externalLinks || []);
      setLocation(profile.location || '');
      setWebsite(profile.website || '');
      setCoverPreset(profile.coverPreset || '');
      setMatureContentEnabled(Boolean(profile.matureContentEnabled));
      setMaxAllowedContentRating(profile.maxAllowedContentRating || 'graphic');
      setAiFilter(profile.aiFilter || 'show-all');
      setHideHeavyTopics(Boolean(profile.hideHeavyTopics));
      setHidePoliticsPublicAffairs(Boolean(profile.hidePoliticsPublicAffairs));
      setHideCrimeDisastersTragedy(Boolean(profile.hideCrimeDisastersTragedy));
    }
  }, [profile?.userId]);

  useEffect(() => {
    const loadProfileCuration = async () => {
      try {
        setError('');
        await reloadCuration();
      } catch (e) {
        setError((e as Error).message);
      }
    };
    if (!user) return;
    void loadProfileCuration();
  }, [user?.username]);

  const changeUsername = async () => {
    try {
      setError('');
      setMessage('');
      setUsernameError('');
      const updated = await api.updateMyUsername(usernameInput) as UserProfile;
      setProfile(updated);
      onProfileChanged?.(updated);
      setUsernameInput(updated.username);
      setUsernameSuggestions([]);
      setMessage('Username updated');
    } catch (e) {
      const err = e as Error;
      setUsernameError(err.message);
      try {
        const result = await api.checkUsername(usernameInput) as { suggestions?: string[] };
        setUsernameSuggestions(result.suggestions || []);
      } catch {
        setUsernameSuggestions([]);
      }
    }
  };

  const submitPasswordChange = async () => {
    try {
      setError('');
      setMessage('');
      if (newPassword !== confirmPassword) throw new Error('Passwords do not match');
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordOpen(false);
      setMessage('Password changed');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const createCollection = async () => {
    try {
      setError('');
      setMessage('');
      const title = newCollectionTitle.trim();
      if (!title) throw new Error('Collection title is required');
      await api.createCollection({
        title,
        visibility: newCollectionVisibility,
        ...selectedOwnerContext
      });
      setNewCollectionTitle('');
      await reloadCuration();
      setMessage('Collection created');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeFavorite = async (favorite: ManagedFavorite) => {
    try {
      setError('');
      await api.unfavorite(favorite.targetType, favorite.targetId, selectedOwnerContext);
      await reloadCuration();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggleFavoriteVisibility = async (favorite: ManagedFavorite) => {
    try {
      setError('');
      const nextVisibility: 'public' | 'private' = (favorite.visibility || 'public') === 'public' ? 'private' : 'public';
      await api.unfavorite(favorite.targetType, favorite.targetId, selectedOwnerContext);
      await api.favorite(favorite.targetType, favorite.targetId, nextVisibility, selectedOwnerContext);
      await reloadCuration();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const loadCollectionImages = async (collectionId: string) => {
    try {
      if (!collectionId) {
        setSelectedCollectionImageIds([]);
        return;
      }
      const detail = await api.getCollection(collectionId) as ManagedCollection & { imageIds?: string[] };
      setSelectedCollectionImageIds(detail.imageIds || []);
    } catch (e) {
      setError((e as Error).message);
      setSelectedCollectionImageIds([]);
    }
  };

  const loadMoreFavorites = async () => {
    try {
      if (!favoritesCursor) return;
      setFavoritesLoading(true);
      const page = await api.myFavoritesPage(selectedOwnerContext, favoritesCursor, 24) as { items: ManagedFavorite[]; nextCursor?: string };
      setProfileFavorites((prev) => [...prev, ...(page.items || [])]);
      setFavoritesCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFavoritesLoading(false);
    }
  };

  const loadMoreCollections = async () => {
    try {
      if (!collectionsCursor) return;
      setCollectionsLoading(true);
      const page = await api.myCollectionsPage(selectedOwnerContext, collectionsCursor, 24) as { items: ManagedCollection[]; nextCursor?: string };
      setProfileCollections((prev) => [...prev, ...(page.items || [])]);
      setCollectionsCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCollectionsLoading(false);
    }
  };

  const toggleCollectionVisibility = async (collection: ManagedCollection) => {
    try {
      setError('');
      const nextVisibility: 'public' | 'private' = collection.visibility === 'public' ? 'private' : 'public';
      await api.updateCollection(collection.collectionId, { visibility: nextVisibility });
      await reloadCuration();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteCollection = async (collectionId: string) => {
    try {
      setError('');
      await api.deleteCollection(collectionId);
      if (selectedCollectionId === collectionId) {
        setSelectedCollectionId('');
        setSelectedCollectionImageIds([]);
      }
      await reloadCuration();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addImageToSelectedCollection = async () => {
    try {
      setError('');
      const imageId = collectionImageIdInput.trim();
      if (!selectedCollectionId) throw new Error('Select a collection first');
      if (!imageId) throw new Error('Image ID is required');
      await api.addImageToCollection(selectedCollectionId, imageId);
      setCollectionImageIdInput('');
      await loadCollectionImages(selectedCollectionId);
      await reloadCuration();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeImageFromSelectedCollection = async (imageId: string) => {
    try {
      setError('');
      if (!selectedCollectionId) return;
      await api.removeImageFromCollection(selectedCollectionId, imageId);
      await loadCollectionImages(selectedCollectionId);
      await reloadCuration();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="layout studio-dashboard-shell member-dashboard-shell">
      <aside className="studio-sidebar member-sidebar">
        <div className="studio-brand-card">
          <strong>{brand.productName}</strong>
          <span>ACCOUNT</span>
          {brand.attribution && <small>{brand.attribution}</small>}
        </div>
        <div className="studio-creator-controls">
          <div className="studio-creator-switcher member-profile-context">
            <span>{brand.memberName}</span>
            <div className="member-profile-context-identity">
              <ProfileAvatar className="member-profile-context-avatar" src={currentProfileAvatarUrl} identity={memberIdentity} alt={`${memberDisplayName} profile`} />
              <div>
                <strong>{memberDisplayName}</strong>
                <small>@{memberHandle}</small>
              </div>
            </div>
          </div>
          {profile?.username && (
            <Link className="auth-secondary-btn no-underline member-view-profile-link" to={`/u/${encodeURIComponent(profile.username)}`}>
              View public profile
            </Link>
          )}
        </div>
        <nav className="studio-sidebar-nav" aria-label="Member account navigation">
          {memberSettingsSections.map((item) => (
            <Link
              key={item.key}
              className={`studio-nav-item no-underline${item.key === activeSection ? ' studio-nav-item-active' : ''}`}
              to={memberSectionHref(item.key)}
            >
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
        <p className="studio-account-note">You are {brand.id === 'eversally' ? 'an' : 'a'} {brand.memberName}.</p>
      </aside>

      <section className="studio-main member-settings-main">
        <header className="studio-section-header">
          <div>
            <p className="studio-page-eyebrow">{memberDisplayName}</p>
            <h1>{sectionMeta.label}</h1>
            <p>{sectionMeta.description}</p>
          </div>
          <span className="studio-context-chip">Your member account</span>
        </header>
        {message && <p className="success panel member-settings-notice">{message}</p>}
        {error && <p className="error panel member-settings-notice" role="alert" tabIndex={-1} ref={errorNoticeRef}>{error}</p>}
        <div className="panel settings-admin-panel member-settings-panel">
        {activeSection === 'preferences' && <section id="member-preferences" className="settings-admin-section">
        <h2>Appearance</h2>
        <div className="grid">
          <div className="settings-field settings-appearance-field">
            <label htmlFor="settings-appearance" className="settings-field-label">Colour mode</label>
            <select
              id="settings-appearance"
              className="settings-select"
              value={appearance}
              onChange={(event) => setAppearancePreference(event.target.value as AppearancePreference)}
            >
              <option value="system">System preference</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
            <p className="small">System preference follows this device and updates automatically.</p>
          </div>
        </div>
        <h2 className="mt-6">Content preferences</h2>
        <div className="studio-creator-form settings-profile-editor settings-member-profile-editor">
          <label className="inline-form">
            <input
              type="checkbox"
              checked={matureContentEnabled}
              onChange={(e) => setMatureContentEnabled(e.target.checked)}
            />
            <span>Enable mature content viewing</span>
          </label>
          <div className="settings-field">
            <label htmlFor="settings-max-content-rating" className="settings-field-label">Maximum feed rating</label>
            <select
              id="settings-max-content-rating"
              className="settings-select"
              value={maxAllowedContentRating}
              onChange={(e) => setMaxAllowedContentRating(e.target.value as ContentRating)}
            >
              {contentRatingOptions.map((option) => <option key={`max-rating-${option.value}`} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="settings-field">
            <label htmlFor="settings-ai-filter" className="settings-field-label">AI content</label>
            <select
              id="settings-ai-filter"
              className="settings-select"
              value={aiFilter}
              onChange={(e) => setAiFilter(e.target.value as AiFilterPreference)}
            >
              {aiFilterOptions.map((option) => <option key={`ai-filter-${option.value}`} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="settings-field settings-profile-bio">
            <label className="settings-field-label">Heavy topics</label>
            <label className="inline-form">
              <input
                type="checkbox"
                checked={hideHeavyTopics}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setHideHeavyTopics(checked);
                  if (checked) {
                    setHidePoliticsPublicAffairs(true);
                    setHideCrimeDisastersTragedy(true);
                  }
                }}
              />
              <span>Hide all heavy topics</span>
            </label>
            <label className="inline-form">
              <input
                type="checkbox"
                checked={hidePoliticsPublicAffairs}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setHidePoliticsPublicAffairs(checked);
                  if (!checked) setHideHeavyTopics(false);
                }}
              />
              <span>{heavyTopicLabels['politics-public-affairs']}</span>
            </label>
            <label className="inline-form">
              <input
                type="checkbox"
                checked={hideCrimeDisastersTragedy}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setHideCrimeDisastersTragedy(checked);
                  if (!checked) setHideHeavyTopics(false);
                }}
              />
              <span>{heavyTopicLabels['crime-disasters-tragedy']}</span>
            </label>
          </div>
          <div className="inline-form settings-profile-bio"><button onClick={saveProfile}>Save preferences</button></div>
        </div>
        </section>}
        {activeSection === 'profile' && <section id="member-profile" className="settings-admin-section">
        <h2>Profile</h2>
          <div className="studio-creator-form settings-profile-editor settings-member-profile-editor">
            <div className="settings-field">
              <label htmlFor="settings-display-name" className="settings-field-label">Display name</label>
              <input id="settings-display-name" placeholder="Creative display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <p className="small">The name shown on your public member profile.</p>
            </div>
            <div className="settings-field">
              <label htmlFor="settings-profile-url" className="settings-field-label">Handle / slug</label>
              <input
                id="settings-profile-url"
                name="preferred_username"
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="your-profile"
                data-lpignore="true"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
              />
              <p className="small">Your public profile address:</p>
              {profile?.username === usernameInput.trim()
                ? <Link className="small settings-profile-url-preview" to={`/u/${encodeURIComponent(profile.username)}`}>{profileUrlPreview}</Link>
                : <p className="small settings-profile-url-preview">{profileUrlPreview}</p>}
              <div className="inline-form">
                <button type="button" onClick={changeUsername}>Save profile URL</button>
                {profile?.lastUsernameChangeAt && <span className="small">Last changed: {new Date(profile.lastUsernameChangeAt).toLocaleDateString()}</span>}
              </div>
              {usernameError && <p className="error">{usernameError}</p>}
              {usernameSuggestions.length > 0 && (
                <div className="username-suggestions">
                  {usernameSuggestions.map((candidate) => (
                    <button type="button" key={candidate} className="username-suggestion-pill" onClick={() => setUsernameInput(candidate)}>
                      {candidate}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="settings-profile-media">
              <div className="settings-profile-media-actions">
                <div className="studio-branding-editor">
                  <section className="studio-current-branding studio-current-branding-profile" aria-label="Current profile image">
                    <div className="studio-current-branding-heading">
                      <div>
                        <strong>Current profile image</strong>
                        <span>{profile?.branding?.profileImage ? 'Custom image' : 'Assigned default icon'}</span>
                      </div>
                      {profile?.branding?.profileImage && <button type="button" className="auth-secondary-btn studio-branding-remove-btn" disabled={mediaSaving} onClick={() => void removeProfileMedia('profile-image')}>Remove image</button>}
                    </div>
                    <div className="studio-current-profile-preview">
                      <ProfileAvatar
                        src={currentProfileAvatarUrl}
                        identity={memberIdentity}
                        alt="Current member profile"
                      />
                    </div>
                    <p>{profile?.branding?.profileImage ? 'This is the image currently shown anywhere your member avatar appears.' : 'No custom profile image is set. Your assigned Ubeeq icon is shown across the app.'}</p>
                  </section>
                  <BrandingImageCropper kind="profile" disabled={mediaSaving} onChange={setProfileImageSelection} />
                  <div className="studio-inline-actions">
                    <button type="button" disabled={!profileImageSelection || mediaSaving} onClick={() => void uploadProfileMedia('profile', profileImageSelection)}>{mediaSaving ? 'Saving…' : 'Save profile image'}</button>
                  </div>
                </div>

                <div className="studio-branding-editor">
                  <section className="studio-current-branding studio-current-branding-cover" aria-label="Current cover image">
                    <div className="studio-current-branding-heading">
                      <div>
                        <strong>Current cover image</strong>
                        <span>{profile?.branding?.coverImage ? 'Custom responsive cover' : defaultProfileCoverUrl ? 'Assigned default cover' : 'No cover set'}</span>
                      </div>
                      {profile?.branding?.coverImage && <button type="button" className="auth-secondary-btn studio-branding-remove-btn" disabled={mediaSaving} onClick={() => void removeProfileMedia('cover-image')}>Remove image</button>}
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
                    <p>{profile?.branding?.coverImage ? 'These are the responsive crops currently shown on your public member profile.' : defaultProfileCoverUrl ? 'No custom cover is set. This assigned Eversally cover is currently shown.' : 'No custom or platform cover is currently shown.'}</p>
                  </section>
                  <ProfileCoverPicker
                    identity={memberIdentity}
                    selectedPreset={selectedCoverPreset}
                    customCoverSet={Boolean(profile?.branding?.coverImage)}
                    disabled={mediaSaving}
                    onChange={setCoverPreset}
                  />
                  <BrandingImageCropper kind="cover" disabled={mediaSaving} onChange={setCoverImageSelection} />
                  <div className="studio-inline-actions">
                    <button type="button" disabled={!coverImageSelection || mediaSaving} onClick={() => void uploadProfileMedia('cover', coverImageSelection)}>{mediaSaving ? 'Saving…' : 'Save cover image'}</button>
                  </div>
                </div>
              </div>
            </div>
            <div className="settings-field"><label className="settings-field-label">Location</label><input placeholder="City, region, or country" value={location} onChange={(e) => setLocation(e.target.value)} /></div>
            <div className="settings-field"><label className="settings-field-label">Website</label><input type="url" placeholder="https://example.com" value={website} onChange={(e) => setWebsite(e.target.value)} /></div>
            <div className="settings-field settings-profile-bio"><label className="settings-field-label">Bio</label><LimitedBioEditor value={bio} onChange={setBio} maxLength={600} /></div>
            <div className="settings-field settings-profile-bio"><label className="settings-field-label">External links</label><ProfileExternalLinksEditor value={externalLinks} onChange={setExternalLinks} allowCustom={false} invalidIndexes={invalidExternalLinkIndexes} /></div>
            <div className="inline-form"><button onClick={saveProfile}>Save member profile</button>{profile?.username && <button className="auth-secondary-btn" onClick={() => navigate(`/u/${encodeURIComponent(profile.username)}`)}>View public profile</button>}</div>

          </div>

        </section>}

        {activeSection === 'security' && (
          <section id="member-security" className="settings-admin-section">
            <h2 className="mt-6">Security</h2>
            <div className="inline-form">
              <button onClick={() => setPasswordOpen(true)}>Change Password</button>
            </div>
          </section>
        )}

        {activeSection === 'curation' && <section id="member-curation" className="settings-admin-section">
        <h2 className="mt-6">Curation</h2>
        <div className="grid">
          <div className="inline-form">
            <input
              placeholder="New collection title"
              value={newCollectionTitle}
              onChange={(e) => setNewCollectionTitle(e.target.value)}
            />
            <select
              className="settings-select"
              value={newCollectionVisibility}
              onChange={(e) => setNewCollectionVisibility(e.target.value === 'private' ? 'private' : 'public')}
            >
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
            <button onClick={createCollection}>Create Collection</button>
          </div>
          <div className="panel">
            <h3 className="m-0 mb-2 text-lg">Collections ({profileCollections.length})</h3>
            <div className="inline-form mb-3">
              <label className="small">Selected collection</label>
              <select
                className="settings-select"
                value={selectedCollectionId}
                onChange={(e) => {
                  const value = e.target.value;
                  setSelectedCollectionId(value);
                  void loadCollectionImages(value);
                }}
              >
                <option value="">Select collection</option>
                {profileCollections.map((item) => (
                  <option key={item.collectionId} value={item.collectionId}>{item.title}</option>
                ))}
              </select>
            </div>
            {selectedCollectionId && (
              <div className="inline-form mb-3">
                <input
                  placeholder="Image ID to add"
                  value={collectionImageIdInput}
                  onChange={(e) => setCollectionImageIdInput(e.target.value)}
                />
                <button onClick={addImageToSelectedCollection}>Add Image</button>
              </div>
            )}
            {selectedCollectionId && (
              <div className="grid">
                {selectedCollectionImageIds.length === 0 && <p className="small">No images in selected collection yet.</p>}
                {selectedCollectionImageIds.map((imageId) => (
                  <article key={imageId} className="inline-form">
                    <span className="small">{imageId}</span>
                    <button onClick={() => void removeImageFromSelectedCollection(imageId)}>Remove</button>
                  </article>
                ))}
              </div>
            )}
            <div className="grid">
              {profileCollections.map((item) => (
                <article key={item.collectionId} className="rounded-xl border p-3">
                  <strong>{item.title}</strong>
                  <p className="small">{item.imageCount} images • {item.visibility}</p>
                  <div className="inline-form">
                    <button onClick={() => void toggleCollectionVisibility(item)}>
                      Make {item.visibility === 'public' ? 'Private' : 'Public'}
                    </button>
                    <button onClick={() => void deleteCollection(item.collectionId)}>Delete</button>
                  </div>
                </article>
              ))}
            </div>
            <AutoLoadSentinel enabled={Boolean(collectionsCursor)} loading={collectionsLoading} onLoadMore={() => loadMoreCollections()} />
          </div>
          <div className="panel">
            <h3 className="m-0 mb-2 text-lg">Favorites ({profileFavorites.length})</h3>
            <div className="grid">
              {profileFavorites.map((item) => (
                <article key={`${item.targetType}:${item.targetId}`} className="inline-form">
                  <span className="small">{item.targetType}: {item.targetId} ({item.visibility || 'public'})</span>
                  <button onClick={() => void toggleFavoriteVisibility(item)}>
                    Make {(item.visibility || 'public') === 'public' ? 'Private' : 'Public'}
                  </button>
                  <button onClick={() => void removeFavorite(item)}>Remove</button>
                </article>
              ))}
            </div>
            <AutoLoadSentinel enabled={Boolean(favoritesCursor)} loading={favoritesLoading} onLoadMore={() => loadMoreFavorites()} />
          </div>
        </div>
        </section>}
        </div>
      </section>

      {passwordOpen && (
        <div className="settings-drawer-overlay" onClick={() => setPasswordOpen(false)}>
          <aside className="settings-drawer" onClick={(e) => e.stopPropagation()}>
            <h2>Change Password</h2>
            <div className="grid">
              <input type="password" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
              <input type="password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              <input type="password" placeholder="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
              <button onClick={submitPasswordChange}>Save Password</button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
