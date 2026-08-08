import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { changePassword, signOut, type CurrentUser } from '../cognitoAuth';
import type { AiFilterPreference, ContentRating, ManagedCreator, ManagedCollection, ManagedFavorite, UserProfile } from '../domainTypes';
import { aiFilterOptions, contentRatingOptions, heavyTopicLabels } from '../discoveryUtils';
import AutoLoadSentinel from '../components/AutoLoadSentinel';

export default function SettingsPage({ user, onProfileChanged }: { user: CurrentUser; onProfileChanged?: (profile: UserProfile) => void }) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [managedArtists, setManagedArtists] = useState<ManagedCreator[]>([]);
  const [selectedProfileKey, setSelectedProfileKey] = useState<string>('user');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
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
  const selectedArtistId = selectedProfileKey.startsWith('creator:') ? selectedProfileKey.slice('creator:'.length) : '';
  const selectedArtist = managedArtists.find((creator) => creator.creatorId === selectedArtistId) || null;
  const profileUrlPreview = `${window.location.origin.replace(/\/$/, '')}/${selectedArtist ? 'creators' : 'u'}/${(usernameInput || '').trim() || 'your-profile-url'}`;
  const selectedOwnerContext = selectedArtist
    ? { ownerProfileType: 'creator' as const, ownerProfileId: selectedArtist.creatorId }
    : { ownerProfileType: 'user' as const };

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
    const load = async () => {
      try {
        const loaded = await api.getMyProfile() as UserProfile;
        const myArtists = await api.getMyCreators() as ManagedCreator[];
        setProfile(loaded);
        setManagedArtists(myArtists);
        onProfileChanged?.(loaded);
        setDisplayName(loaded.displayName || '');
        setBio(loaded.bio || '');
        setLocation(loaded.location || '');
        setWebsite(loaded.website || '');
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
    try {
      setError('');
      setMessage('');
      if (selectedArtist) {
        const updatedArtist = await api.studioUpdateCreator(selectedArtist.creatorId, {
          name: displayName || selectedArtist.name
        }) as ManagedCreator;
        setManagedArtists((prev) => prev.map((item) => (item.creatorId === updatedArtist.creatorId ? { ...item, ...updatedArtist } : item)));
        setMessage('Creator profile updated');
        return;
      }
      const updated = await api.updateMyProfile({
        displayName: displayName || undefined,
        bio: bio || undefined,
        location: location || undefined,
        website: website || undefined,
        matureContentEnabled,
        maxAllowedContentRating,
        aiFilter,
        hideHeavyTopics,
        hidePoliticsPublicAffairs,
        hideCrimeDisastersTragedy
      }) as UserProfile;
      setProfile(updated);
      onProfileChanged?.(updated);
      setMessage('Profile updated');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    if (selectedArtist) {
      setDisplayName(selectedArtist.name || '');
      setUsernameInput(selectedArtist.slug || '');
      setUsernameError('');
      return;
    }
    if (profile) {
      setDisplayName(profile.displayName || '');
      setUsernameInput(profile.username || '');
      setMatureContentEnabled(Boolean(profile.matureContentEnabled));
      setMaxAllowedContentRating(profile.maxAllowedContentRating || 'graphic');
      setAiFilter(profile.aiFilter || 'show-all');
      setHideHeavyTopics(Boolean(profile.hideHeavyTopics));
      setHidePoliticsPublicAffairs(Boolean(profile.hidePoliticsPublicAffairs));
      setHideCrimeDisastersTragedy(Boolean(profile.hideCrimeDisastersTragedy));
    }
  }, [selectedArtistId, profile?.userId]);

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
  }, [selectedProfileKey, user?.username]);

  const changeUsername = async () => {
    try {
      setError('');
      setMessage('');
      setUsernameError('');
      if (selectedArtist) {
        const updatedArtist = await api.studioUpdateCreator(selectedArtist.creatorId, {
          slug: usernameInput
        }) as ManagedCreator;
        setManagedArtists((prev) => prev.map((item) => (item.creatorId === updatedArtist.creatorId ? { ...item, ...updatedArtist } : item)));
        setUsernameInput(updatedArtist.slug);
        setUsernameSuggestions([]);
        setMessage('Creator profile URL updated');
        return;
      }
      const updated = await api.updateMyUsername(usernameInput) as UserProfile;
      setProfile(updated);
      onProfileChanged?.(updated);
      setUsernameInput(updated.username);
      setUsernameSuggestions([]);
      setMessage('Username updated');
    } catch (e) {
      const err = e as Error;
      setUsernameError(err.message);
      if (!selectedArtist) {
        try {
          const result = await api.checkUsername(usernameInput) as { suggestions?: string[] };
          setUsernameSuggestions(result.suggestions || []);
        } catch {
          setUsernameSuggestions([]);
        }
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
    <div className="layout">
      <div className="panel max-w-6xl">
        <h1>Settings</h1>
        <h2>Profile Context</h2>
        <div className="grid">
          <div className="settings-field">
            <label htmlFor="settings-profile-context" className="settings-field-label">Edit profile as</label>
            <select
              id="settings-profile-context"
              className="settings-select"
              value={selectedProfileKey}
              onChange={(e) => setSelectedProfileKey(e.target.value)}
            >
              <option value="user">User Profile</option>
              {managedArtists.map((creator) => (
                <option key={creator.creatorId} value={`creator:${creator.creatorId}`}>
                  Creator: {creator.name} ({creator.memberRole || 'editor'})
                </option>
              ))}
            </select>
          </div>
        </div>
        <h2>Profile</h2>
        <div className="grid">
          <div className="settings-field">
            <label htmlFor="settings-display-name" className="settings-field-label">Display Name</label>
            <input
              id="settings-display-name"
              placeholder="Ubeeq Girl"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <p className="small">{selectedArtist ? 'The name shown on this creator profile' : 'The name shown on your profile'}</p>
          </div>
          <button onClick={saveProfile}>{selectedArtist ? 'Save Creator Name' : 'Save Display Name'}</button>
          {!selectedArtist && (
            <>
              <input placeholder="Location" value={location} onChange={(e) => setLocation(e.target.value)} />
              <input placeholder="Website" value={website} onChange={(e) => setWebsite(e.target.value)} />
              <textarea className="rounded-xl border px-3 py-2 text-sm" rows={4} placeholder="Bio" value={bio} onChange={(e) => setBio(e.target.value)} />
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
                  {contentRatingOptions.map((option) => (
                    <option key={`max-rating-${option.value}`} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-field">
                <label htmlFor="settings-ai-filter" className="settings-field-label">AI Content</label>
                <select
                  id="settings-ai-filter"
                  className="settings-select"
                  value={aiFilter}
                  onChange={(e) => setAiFilter(e.target.value as AiFilterPreference)}
                >
                  {aiFilterOptions.map((option) => (
                    <option key={`ai-filter-${option.value}`} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-field">
                <label className="settings-field-label">Heavy Topics</label>
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
                  <span>Hide Heavy Topics</span>
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
            </>
          )}
        </div>

        <h2 className="mt-6">Profile URL</h2>
        <div className="grid">
          <div className="settings-field">
            <label htmlFor="settings-profile-url" className="settings-field-label">Profile URL</label>
            <input
              id="settings-profile-url"
              name="preferred_username"
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="ubeeq-girl"
              data-lpignore="true"
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
            />
            <p className="small">{selectedArtist ? 'This creator profile will be available at:' : 'Your profile will be available at:'}</p>
            <p className="small settings-profile-url-preview">{profileUrlPreview}</p>
          </div>
          <button onClick={changeUsername}>{selectedArtist ? 'Save Creator URL' : 'Save Profile URL'}</button>
          {!selectedArtist && profile?.lastUsernameChangeAt && (
            <p className="small">Last changed: {new Date(profile.lastUsernameChangeAt).toLocaleDateString()}</p>
          )}
          {usernameError && <p className="error">{usernameError}</p>}
          {!selectedArtist && usernameSuggestions.length > 0 && (
            <div className="username-suggestions">
              {usernameSuggestions.map((candidate) => (
                <button key={candidate} className="username-suggestion-pill" onClick={() => setUsernameInput(candidate)}>
                  {candidate}
                </button>
              ))}
            </div>
          )}
        </div>

        {!selectedArtist && (
          <>
            <h2 className="mt-6">Security</h2>
            <div className="inline-form">
              <button onClick={() => setPasswordOpen(true)}>Change Password</button>
            </div>
          </>
        )}

        <h2 className="mt-6">Curation</h2>
        <div className="grid">
          <div className="inline-form">
            <input
              placeholder={selectedArtist ? `New collection for ${selectedArtist.name}` : 'New collection title'}
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
        {message && <p className="success">{message}</p>}
        {error && <p className="error">{error}</p>}
      </div>

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
