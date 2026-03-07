import { useEffect, useMemo, useState } from 'react';
import {
  changePassword,
  confirmForgotPassword,
  forgotPassword,
  getCurrentUser,
  setInitialPassword,
  signIn,
  signOut,
  type CurrentUser
} from './cognitoAuth';

type View = 'artists' | 'galleries' | 'media' | 'moderation' | 'users';

type Artist = { artistId: string; name: string; slug: string; status: 'active' | 'inactive'; sortOrder: number };
type Gallery = { galleryId: string; artistId: string; artistSlug?: string; title: string; slug: string; visibility: 'free' | 'premium'; status: 'draft' | 'published' };
type Media = { imageId: string; galleryId: string; sortOrder: number; assetType?: 'image' | 'video'; previewKey: string; premiumKey?: string };

type AuthMode = 'signin' | 'forgot' | 'reset' | 'initial' | 'change';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
const token = () => localStorage.getItem('idToken') || '';

const request = async (path: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token()}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    throw new Error(json.message || 'Request failed');
  }
  if (response.status === 204) return null;
  return response.json();
};

const views: Array<{ id: View; label: string }> = [
  { id: 'artists', label: 'Artists' },
  { id: 'galleries', label: 'Galleries' },
  { id: 'media', label: 'Media' },
  { id: 'moderation', label: 'Moderation' },
  { id: 'users', label: 'Users' }
];

export function AdminApp() {
  const [view, setView] = useState<View>('artists');
  const [artists, setArtists] = useState<Artist[]>([]);
  const [galleries, setGalleries] = useState<Gallery[]>([]);
  const [media, setMedia] = useState<Media[]>([]);

  const [artistForm, setArtistForm] = useState({ name: '', slug: '', sortOrder: 1 });
  const [galleryForm, setGalleryForm] = useState({ artistId: '', artistSlug: '', title: '', slug: '', visibility: 'free', premiumPassword: '' });
  const [mediaForm, setMediaForm] = useState({
    galleryId: '',
    assetType: 'image',
    previewKey: '',
    premiumKey: '',
    previewPosterKey: '',
    premiumPosterKey: '',
    width: 1600,
    height: 1067,
    durationSeconds: 0,
    sortOrder: 1
  });
  const [editingArtistId, setEditingArtistId] = useState<string | null>(null);
  const [editingGalleryId, setEditingGalleryId] = useState<string | null>(null);
  const [editingMediaId, setEditingMediaId] = useState<string | null>(null);
  const [artistEditForm, setArtistEditForm] = useState({ name: '', slug: '', status: 'active', sortOrder: 1 });
  const [galleryEditForm, setGalleryEditForm] = useState({
    artistId: '',
    artistSlug: '',
    title: '',
    slug: '',
    visibility: 'free',
    status: 'published',
    premiumPassword: ''
  });
  const [mediaEditForm, setMediaEditForm] = useState({
    galleryId: '',
    imageId: '',
    assetType: 'image',
    previewKey: '',
    premiumKey: '',
    previewPosterKey: '',
    premiumPosterKey: '',
    width: 0,
    height: 0,
    durationSeconds: 0,
    sortOrder: 0
  });

  const [mediaGalleryId, setMediaGalleryId] = useState('');
  const [commentId, setCommentId] = useState('');
  const [blockUserId, setBlockUserId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const [authMode, setAuthMode] = useState<AuthMode>('signin');
  const [user, setUser] = useState<CurrentUser>(() => getCurrentUser());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [session, setSession] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');

  const artistById = useMemo(() => new Map(artists.map((a) => [a.artistId, a])), [artists]);
  const isAdmin = user?.groups.includes('Admins');
  const isArtist = user?.groups.includes('Artists') || false;
  const canManageContent = Boolean(isAdmin || isArtist);
  const visibleViews = useMemo(
    () => views.filter((item) => {
      if (item.id === 'galleries' || item.id === 'media') return canManageContent;
      return Boolean(isAdmin);
    }),
    [canManageContent, isAdmin]
  );

  const loadArtists = async () => setArtists(await request('/admin/artists'));
  const loadGalleries = async () => setGalleries(await request('/admin/galleries'));
  const loadMedia = async (galleryId: string) => {
    if (!galleryId) return;
    setMedia(await request(`/admin/galleries/${galleryId}/images`));
  };

  const loadAll = async () => {
    if (!user) return;
    try {
      setError('');
      if (isAdmin) {
        await Promise.all([loadArtists(), loadGalleries()]);
      } else if (canManageContent) {
        await loadGalleries();
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    loadAll();
  }, [user, isAdmin, canManageContent]);

  useEffect(() => {
    if (!user) return;
    if (!visibleViews.some((item) => item.id === view) && visibleViews[0]) {
      setView(visibleViews[0].id);
    }
  }, [user, view, visibleViews]);

  const withFeedback = async (fn: () => Promise<void>, successMessage?: string) => {
    try {
      setError('');
      setMessage('');
      await fn();
      if (successMessage) setMessage(successMessage);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doSignIn = () => withFeedback(async () => {
    const result = await signIn(email, password);
    if (result.status === 'new_password_required') {
      setSession(result.session);
      setAuthMode('initial');
      setMessage('Set initial password to continue.');
      return;
    }
    setUser(result.user);
    setMessage('Signed in');
  });

  const doForgot = () => withFeedback(async () => {
    await forgotPassword(email);
    setAuthMode('reset');
    setMessage('Reset code sent.');
  });

  const doReset = () => withFeedback(async () => {
    await confirmForgotPassword(email, code, newPassword);
    setAuthMode('signin');
    setMessage('Password reset complete.');
  });

  const doInitialPassword = () => withFeedback(async () => {
    const loggedIn = await setInitialPassword(email, session, newPassword);
    setUser(loggedIn);
    setMessage('Initial password set. Signed in.');
    setAuthMode('signin');
  });

  const doChangePassword = () => withFeedback(async () => {
    await changePassword(currentPassword, newPassword);
    setMessage('Password changed');
    setCurrentPassword('');
    setNewPassword('');
  });

  const doSignOut = () => withFeedback(async () => {
    await signOut();
    setUser(null);
    setAuthMode('signin');
  }, 'Signed out');

  const createArtist = () => withFeedback(async () => {
    await request('/admin/artists', 'POST', { ...artistForm, status: 'active' });
    setArtistForm({ name: '', slug: '', sortOrder: 1 });
    await loadArtists();
  }, 'Artist created');

  const deleteArtist = (artistId: string) => withFeedback(async () => {
    await request(`/admin/artists/${artistId}`, 'DELETE');
    await loadArtists();
  }, 'Artist deleted');

  const startEditArtist = (artist: Artist) => {
    setEditingArtistId(artist.artistId);
    setArtistEditForm({
      name: artist.name,
      slug: artist.slug,
      status: artist.status,
      sortOrder: artist.sortOrder
    });
  };

  const saveEditArtist = (artistId: string) => withFeedback(async () => {
    await request(`/admin/artists/${artistId}`, 'PATCH', artistEditForm);
    setEditingArtistId(null);
    await loadArtists();
  }, 'Artist updated');

  const createGallery = () => withFeedback(async () => {
    await request('/admin/galleries', 'POST', { ...galleryForm, status: 'published' });
    setGalleryForm({ artistId: '', artistSlug: '', title: '', slug: '', visibility: 'free', premiumPassword: '' });
    await loadGalleries();
  }, 'Gallery created');

  const deleteGallery = (galleryId: string) => withFeedback(async () => {
    await request(`/admin/galleries/${galleryId}`, 'DELETE');
    await loadGalleries();
  }, 'Gallery deleted');

  const startEditGallery = (gallery: Gallery) => {
    setEditingGalleryId(gallery.galleryId);
    setGalleryEditForm({
      artistId: gallery.artistId,
      artistSlug: gallery.artistSlug || '',
      title: gallery.title,
      slug: gallery.slug,
      visibility: gallery.visibility,
      status: gallery.status,
      premiumPassword: ''
    });
  };

  const saveEditGallery = (galleryId: string) => withFeedback(async () => {
    await request(`/admin/galleries/${galleryId}`, 'PATCH', galleryEditForm);
    setEditingGalleryId(null);
    await loadGalleries();
  }, 'Gallery updated');

  const createMedia = () => withFeedback(async () => {
    await request('/admin/images', 'POST', mediaForm);
    if (mediaGalleryId === mediaForm.galleryId) {
      await loadMedia(mediaForm.galleryId);
    }
  }, 'Media created');

  const deleteMedia = (item: Media) => withFeedback(async () => {
    await request(`/admin/images/${item.galleryId}/${item.imageId}?sortOrder=${item.sortOrder}`, 'DELETE');
    if (mediaGalleryId) await loadMedia(mediaGalleryId);
  }, 'Media deleted');

  const startEditMedia = (item: Media) => {
    setEditingMediaId(item.imageId);
    setMediaEditForm({
      galleryId: item.galleryId,
      imageId: item.imageId,
      assetType: item.assetType || 'image',
      previewKey: item.previewKey,
      premiumKey: item.premiumKey || '',
      previewPosterKey: '',
      premiumPosterKey: '',
      width: 0,
      height: 0,
      durationSeconds: 0,
      sortOrder: item.sortOrder
    });
  };

  const saveEditMedia = () => withFeedback(async () => {
    await request(`/admin/images/${mediaEditForm.galleryId}/${mediaEditForm.imageId}`, 'PATCH', mediaEditForm);
    setEditingMediaId(null);
    if (mediaGalleryId) await loadMedia(mediaGalleryId);
  }, 'Media updated');

  const hideComment = () => withFeedback(async () => {
    await request(`/admin/comments/${commentId}`, 'PATCH', { hidden: true });
  }, `Comment ${commentId} hidden`);

  const deleteComment = () => withFeedback(async () => {
    await request(`/admin/comments/${commentId}`, 'DELETE');
  }, `Comment ${commentId} deleted`);

  const blockUser = () => withFeedback(async () => {
    await request(`/admin/users/${blockUserId}/block`, 'POST', { reason: 'policy' });
  }, `Blocked user ${blockUserId}`);

  const unblockUser = () => withFeedback(async () => {
    await request(`/admin/users/${blockUserId}/block`, 'DELETE');
  }, `Unblocked user ${blockUserId}`);

  return (
    <main className="admin-shell">
      <aside className="sidebar">
        <h1>Orchestration</h1>
        <div className="auth-card">
          {!user ? (
            <>
              <div className="auth-nav">
                <button onClick={() => setAuthMode('signin')}>Sign In</button>
                <button onClick={() => setAuthMode('forgot')}>Forgot</button>
              </div>
            </>
          ) : (
            <>
              <p>Signed in: <strong>{user.username}</strong></p>
              <p className="muted">Groups: {user.groups.join(', ') || 'none'}</p>
              <button onClick={() => setAuthMode('change')}>Change Password</button>
              <button onClick={doSignOut}>Sign Out</button>
            </>
          )}

          {(authMode === 'signin' || authMode === 'forgot' || authMode === 'reset' || authMode === 'initial' || authMode === 'change') && (
            <>
              {(authMode !== 'change') && (
                <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              )}
              {(authMode === 'signin') && (
                <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              )}
              {(authMode === 'reset') && (
                <input placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} />
              )}
              {(authMode === 'reset' || authMode === 'initial' || authMode === 'change') && (
                <input placeholder="New password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              )}
              {authMode === 'change' && (
                <input placeholder="Current password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
              )}

              {authMode === 'signin' && <button onClick={doSignIn}>Sign In</button>}
              {authMode === 'forgot' && <button onClick={doForgot}>Send Reset Code</button>}
              {authMode === 'reset' && <button onClick={doReset}>Reset Password</button>}
              {authMode === 'initial' && <button onClick={doInitialPassword}>Set Initial Password</button>}
              {authMode === 'change' && <button onClick={doChangePassword}>Change Password</button>}
            </>
          )}
        </div>

        {visibleViews.map((item) => (
          <button key={item.id} className={view === item.id ? 'nav-btn active' : 'nav-btn'} onClick={() => setView(item.id)}>
            {item.label}
          </button>
        ))}
      </aside>

      <section className="content">
        {!user && <p>Sign in to continue.</p>}
        {user && !canManageContent && <p className="error">You are signed in but not in the Cognito `Artists` or `Admins` groups.</p>}

        {user && isAdmin && view === 'artists' && (
          <>
            <h2>Artists</h2>
            <div className="list">
              {artists.map((artist) => (
                <div className="list-row" key={artist.artistId}>
                  <span>{artist.name} ({artist.slug})</span>
                  <div className="row-actions">
                    <button onClick={() => startEditArtist(artist)}>Edit</button>
                    <button onClick={() => deleteArtist(artist.artistId)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
            {editingArtistId && (
              <>
                <h3>Edit Artist</h3>
                <input placeholder="Name" value={artistEditForm.name} onChange={(e) => setArtistEditForm({ ...artistEditForm, name: e.target.value })} />
                <input placeholder="Slug" value={artistEditForm.slug} onChange={(e) => setArtistEditForm({ ...artistEditForm, slug: e.target.value })} />
                <select value={artistEditForm.status} onChange={(e) => setArtistEditForm({ ...artistEditForm, status: e.target.value })}>
                  <option value="active">active</option>
                  <option value="inactive">inactive</option>
                </select>
                <input type="number" placeholder="Sort order" value={artistEditForm.sortOrder} onChange={(e) => setArtistEditForm({ ...artistEditForm, sortOrder: Number(e.target.value || 0) })} />
                <button onClick={() => saveEditArtist(editingArtistId)}>Save Artist</button>
                <button onClick={() => setEditingArtistId(null)}>Cancel</button>
              </>
            )}
            <h3>Create Artist</h3>
            <input placeholder="Name" value={artistForm.name} onChange={(e) => setArtistForm({ ...artistForm, name: e.target.value })} />
            <input placeholder="Slug" value={artistForm.slug} onChange={(e) => setArtistForm({ ...artistForm, slug: e.target.value })} />
            <input type="number" placeholder="Sort order" value={artistForm.sortOrder} onChange={(e) => setArtistForm({ ...artistForm, sortOrder: Number(e.target.value || 1) })} />
            <button onClick={createArtist}>Create Artist</button>
          </>
        )}

        {user && canManageContent && view === 'galleries' && (
          <>
            <h2>Galleries</h2>
            <div className="list">
              {galleries.map((gallery) => (
                <div className="list-row" key={gallery.galleryId}>
                  <span>{gallery.title} ({gallery.slug})</span>
                  {isAdmin && (
                    <div className="row-actions">
                      <button onClick={() => startEditGallery(gallery)}>Edit</button>
                      <button onClick={() => deleteGallery(gallery.galleryId)}>Delete</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {isAdmin && editingGalleryId && (
              <>
                <h3>Edit Gallery</h3>
                <input placeholder="Artist ID" value={galleryEditForm.artistId} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, artistId: e.target.value })} />
                <input placeholder="Artist Slug" value={galleryEditForm.artistSlug} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, artistSlug: e.target.value })} />
                <input placeholder="Title" value={galleryEditForm.title} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, title: e.target.value })} />
                <input placeholder="Slug" value={galleryEditForm.slug} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, slug: e.target.value })} />
                <select value={galleryEditForm.visibility} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, visibility: e.target.value })}>
                  <option value="free">free</option>
                  <option value="premium">premium</option>
                </select>
                <select value={galleryEditForm.status} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, status: e.target.value })}>
                  <option value="published">published</option>
                  <option value="draft">draft</option>
                </select>
                <input placeholder="Set new premium password (optional)" value={galleryEditForm.premiumPassword} onChange={(e) => setGalleryEditForm({ ...galleryEditForm, premiumPassword: e.target.value })} />
                <button onClick={() => saveEditGallery(editingGalleryId)}>Save Gallery</button>
                <button onClick={() => setEditingGalleryId(null)}>Cancel</button>
              </>
            )}
            <h3>Create Gallery</h3>
            <input placeholder="Artist ID" value={galleryForm.artistId} onChange={(e) => setGalleryForm({ ...galleryForm, artistId: e.target.value })} />
            <input placeholder="Artist Slug" value={galleryForm.artistSlug} onChange={(e) => setGalleryForm({ ...galleryForm, artistSlug: e.target.value })} />
            <input placeholder="Title" value={galleryForm.title} onChange={(e) => setGalleryForm({ ...galleryForm, title: e.target.value })} />
            <input placeholder="Slug" value={galleryForm.slug} onChange={(e) => setGalleryForm({ ...galleryForm, slug: e.target.value })} />
            <select value={galleryForm.visibility} onChange={(e) => setGalleryForm({ ...galleryForm, visibility: e.target.value })}>
              <option value="free">free</option>
              <option value="premium">premium</option>
            </select>
            <input placeholder="Premium password" value={galleryForm.premiumPassword} onChange={(e) => setGalleryForm({ ...galleryForm, premiumPassword: e.target.value })} />
            <button onClick={createGallery}>Create Gallery</button>
          </>
        )}

        {user && canManageContent && view === 'media' && (
          <>
            <h2>Media</h2>
            <select value={mediaGalleryId} onChange={(e) => { setMediaGalleryId(e.target.value); void loadMedia(e.target.value); }}>
              <option value="">Select gallery</option>
              {galleries.map((g) => (
                <option key={g.galleryId} value={g.galleryId}>{g.title}</option>
              ))}
            </select>
            <div className="list">
              {media.map((item) => (
                <div className="list-row" key={item.imageId}>
                  <span>{item.assetType || 'image'}: {item.imageId} ({item.previewKey})</span>
                  {isAdmin && (
                    <div className="row-actions">
                      <button onClick={() => startEditMedia(item)}>Edit</button>
                      <button onClick={() => deleteMedia(item)}>Delete</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {isAdmin && editingMediaId && (
              <>
                <h3>Edit Media</h3>
                <input placeholder="Gallery ID" value={mediaEditForm.galleryId} onChange={(e) => setMediaEditForm({ ...mediaEditForm, galleryId: e.target.value })} />
                <input placeholder="Image ID" value={mediaEditForm.imageId} onChange={(e) => setMediaEditForm({ ...mediaEditForm, imageId: e.target.value })} />
                <select value={mediaEditForm.assetType} onChange={(e) => setMediaEditForm({ ...mediaEditForm, assetType: e.target.value })}>
                  <option value="image">image</option>
                  <option value="video">video</option>
                </select>
                <input placeholder="Preview key" value={mediaEditForm.previewKey} onChange={(e) => setMediaEditForm({ ...mediaEditForm, previewKey: e.target.value })} />
                <input placeholder="Premium key" value={mediaEditForm.premiumKey} onChange={(e) => setMediaEditForm({ ...mediaEditForm, premiumKey: e.target.value })} />
                <input placeholder="Preview poster key" value={mediaEditForm.previewPosterKey} onChange={(e) => setMediaEditForm({ ...mediaEditForm, previewPosterKey: e.target.value })} />
                <input placeholder="Premium poster key" value={mediaEditForm.premiumPosterKey} onChange={(e) => setMediaEditForm({ ...mediaEditForm, premiumPosterKey: e.target.value })} />
                <input type="number" placeholder="Width" value={mediaEditForm.width} onChange={(e) => setMediaEditForm({ ...mediaEditForm, width: Number(e.target.value || 0) })} />
                <input type="number" placeholder="Height" value={mediaEditForm.height} onChange={(e) => setMediaEditForm({ ...mediaEditForm, height: Number(e.target.value || 0) })} />
                <input type="number" placeholder="Duration seconds" value={mediaEditForm.durationSeconds} onChange={(e) => setMediaEditForm({ ...mediaEditForm, durationSeconds: Number(e.target.value || 0) })} />
                <input type="number" placeholder="Sort order" value={mediaEditForm.sortOrder} onChange={(e) => setMediaEditForm({ ...mediaEditForm, sortOrder: Number(e.target.value || 0) })} />
                <button onClick={saveEditMedia}>Save Media</button>
                <button onClick={() => setEditingMediaId(null)}>Cancel</button>
              </>
            )}
            <h3>Create Media</h3>
            <input placeholder="Gallery ID" value={mediaForm.galleryId} onChange={(e) => setMediaForm({ ...mediaForm, galleryId: e.target.value })} />
            <select value={mediaForm.assetType} onChange={(e) => setMediaForm({ ...mediaForm, assetType: e.target.value })}>
              <option value="image">image</option>
              <option value="video">video</option>
            </select>
            <input placeholder="Preview key" value={mediaForm.previewKey} onChange={(e) => setMediaForm({ ...mediaForm, previewKey: e.target.value })} />
            <input placeholder="Premium key" value={mediaForm.premiumKey} onChange={(e) => setMediaForm({ ...mediaForm, premiumKey: e.target.value })} />
            <input placeholder="Preview poster key" value={mediaForm.previewPosterKey} onChange={(e) => setMediaForm({ ...mediaForm, previewPosterKey: e.target.value })} />
            <input placeholder="Premium poster key" value={mediaForm.premiumPosterKey} onChange={(e) => setMediaForm({ ...mediaForm, premiumPosterKey: e.target.value })} />
            <input type="number" placeholder="Width" value={mediaForm.width} onChange={(e) => setMediaForm({ ...mediaForm, width: Number(e.target.value || 0) })} />
            <input type="number" placeholder="Height" value={mediaForm.height} onChange={(e) => setMediaForm({ ...mediaForm, height: Number(e.target.value || 0) })} />
            <input type="number" placeholder="Duration seconds" value={mediaForm.durationSeconds} onChange={(e) => setMediaForm({ ...mediaForm, durationSeconds: Number(e.target.value || 0) })} />
            <input type="number" placeholder="Sort order" value={mediaForm.sortOrder} onChange={(e) => setMediaForm({ ...mediaForm, sortOrder: Number(e.target.value || 0) })} />
            <button onClick={createMedia}>Create Media</button>
          </>
        )}

        {user && isAdmin && view === 'moderation' && (
          <>
            <h2>Moderation</h2>
            <input placeholder="Comment ID" value={commentId} onChange={(e) => setCommentId(e.target.value)} />
            <button onClick={hideComment}>Hide Comment</button>
            <button onClick={deleteComment}>Delete Comment</button>
          </>
        )}

        {user && isAdmin && view === 'users' && (
          <>
            <h2>User Controls</h2>
            <input placeholder="User ID" value={blockUserId} onChange={(e) => setBlockUserId(e.target.value)} />
            <button onClick={blockUser}>Block User</button>
            <button onClick={unblockUser}>Unblock User</button>
          </>
        )}

        {message && <p className="success">{message}</p>}
        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );
}
