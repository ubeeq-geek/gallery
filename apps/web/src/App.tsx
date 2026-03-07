import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api } from './api';
import {
  changePassword,
  confirmForgotPassword,
  confirmRegistration,
  forgotPassword,
  getCurrentUser,
  register,
  setInitialPassword,
  signIn,
  signOut,
  type CurrentUser
} from './cognitoAuth';
import './styles.css';

type Artist = { artistId: string; name: string; slug: string };
type GallerySummary = { galleryId: string; title: string; slug: string; visibility: 'free' | 'premium' };
type GalleryAsset = { imageId: string; assetType: 'image' | 'video'; previewUrl: string; previewPosterUrl?: string; favoriteCount: number };
type Gallery = { galleryId: string; title: string; visibility: 'free' | 'premium'; favoriteCount: number; media: GalleryAsset[] };
type Comment = { commentId: string; displayName: string; body: string; createdAt: string };

type AuthMode = 'signin' | 'register' | 'confirm' | 'forgot' | 'reset' | 'initial' | 'change';

const authLinks: Array<{ mode: AuthMode; label: string }> = [
  { mode: 'signin', label: 'Sign In' },
  { mode: 'register', label: 'Register' },
  { mode: 'forgot', label: 'Forgot Password' },
  { mode: 'change', label: 'Change Password' }
];

function HeaderAuth({ user, onSignOut }: { user: CurrentUser; onSignOut: () => Promise<void> }) {
  return (
    <section className="auth-panel">
      {user ? (
        <div className="auth-line">
          <span>Signed in as <strong>{user.username}</strong></span>
          <div className="auth-links">
            <Link to="/auth/change">Change Password</Link>
            <button onClick={() => void onSignOut()}>Sign Out</button>
          </div>
        </div>
      ) : (
        <div className="auth-line">
          <span>Account</span>
          <div className="auth-links">
            <Link to="/auth/signin">Sign In</Link>
            <Link to="/auth/register">Register</Link>
            <Link to="/auth/forgot">Forgot Password</Link>
          </div>
        </div>
      )}
    </section>
  );
}

function AuthPage({ user, setUser }: { user: CurrentUser; setUser: (u: CurrentUser) => void }) {
  const navigate = useNavigate();
  const { mode = 'signin' } = useParams();
  const authMode = mode as AuthMode;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (authMode === 'initial') {
      setEmail(sessionStorage.getItem('auth.initial.username') || '');
    }
    if (authMode === 'reset') {
      setEmail(sessionStorage.getItem('auth.reset.username') || '');
    }
  }, [authMode]);

  const withFeedback = async (fn: () => Promise<void>) => {
    try {
      setError('');
      setMessage('');
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doSignIn = () => withFeedback(async () => {
    const result = await signIn(email, password);
    if (result.status === 'new_password_required') {
      sessionStorage.setItem('auth.initial.session', result.session);
      sessionStorage.setItem('auth.initial.username', result.username);
      navigate('/auth/initial');
      return;
    }
    setUser(result.user);
    navigate('/');
  });

  const doRegister = () => withFeedback(async () => {
    if (password !== confirmPassword) {
      throw new Error('Passwords do not match');
    }
    await register(email, password);
    sessionStorage.setItem('auth.confirm.username', email);
    navigate('/auth/confirm');
    setMessage('Registration started. Check your email for the code.');
  });

  const doConfirm = () => withFeedback(async () => {
    const username = email || sessionStorage.getItem('auth.confirm.username') || '';
    await confirmRegistration(username, code);
    navigate('/auth/signin');
  });

  const doForgot = () => withFeedback(async () => {
    await forgotPassword(email);
    sessionStorage.setItem('auth.reset.username', email);
    navigate('/auth/reset');
  });

  const doReset = () => withFeedback(async () => {
    const username = email || sessionStorage.getItem('auth.reset.username') || '';
    await confirmForgotPassword(username, code, newPassword);
    navigate('/auth/signin');
  });

  const doInitialPassword = () => withFeedback(async () => {
    const username = sessionStorage.getItem('auth.initial.username') || email;
    const session = sessionStorage.getItem('auth.initial.session') || '';
    const loggedIn = await setInitialPassword(username, session, newPassword);
    sessionStorage.removeItem('auth.initial.username');
    sessionStorage.removeItem('auth.initial.session');
    setUser(loggedIn);
    navigate('/');
  });

  const doChangePassword = () => withFeedback(async () => {
    if (!user) {
      throw new Error('Sign in first');
    }
    await changePassword(currentPassword, newPassword);
    setMessage('Password changed');
  });

  if (authMode === 'change' && !user) {
    return <Navigate to="/auth/signin" replace />;
  }

  return (
    <div className="layout">
      <h1>Account: {authLinks.find((item) => item.mode === authMode)?.label || 'Auth'}</h1>
      <div className="auth-page-links">
        <Link to="/auth/signin">Sign In</Link>
        <Link to="/auth/register">Register</Link>
        <Link to="/auth/confirm">Confirm Registration</Link>
        <Link to="/auth/forgot">Forgot Password</Link>
        <Link to="/auth/reset">Reset Password</Link>
        <Link to="/auth/change">Change Password</Link>
      </div>

      {(authMode === 'signin' || authMode === 'register' || authMode === 'confirm' || authMode === 'forgot' || authMode === 'reset' || authMode === 'initial') && (
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      )}

      {(authMode === 'signin' || authMode === 'register') && (
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      )}

      {authMode === 'register' && (
        <input type="password" placeholder="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
      )}

      {(authMode === 'confirm' || authMode === 'reset') && (
        <input placeholder="Confirmation code" value={code} onChange={(e) => setCode(e.target.value)} />
      )}

      {(authMode === 'reset' || authMode === 'initial' || authMode === 'change') && (
        <input type="password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
      )}

      {authMode === 'change' && (
        <input type="password" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
      )}

      {authMode === 'signin' && <button onClick={doSignIn}>Sign In</button>}
      {authMode === 'register' && <button onClick={doRegister}>Register</button>}
      {authMode === 'confirm' && <button onClick={doConfirm}>Confirm Registration</button>}
      {authMode === 'forgot' && <button onClick={doForgot}>Send Reset Code</button>}
      {authMode === 'reset' && <button onClick={doReset}>Reset Password</button>}
      {authMode === 'initial' && <button onClick={doInitialPassword}>Set Initial Password</button>}
      {authMode === 'change' && <button onClick={doChangePassword}>Change Password</button>}

      {message && <p className="success">{message}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function HomePage() {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [selected, setSelected] = useState<Artist | null>(null);
  const [galleries, setGalleries] = useState<GallerySummary[]>([]);

  useEffect(() => {
    api.getArtists().then(setArtists).catch(console.error);
  }, []);

  useEffect(() => {
    if (!selected) return;
    api.getGalleriesByArtist(selected.slug).then(setGalleries).catch(console.error);
  }, [selected]);

  return (
    <div className="layout">
      <h1>Artist Galleries</h1>
      <div className="grid two">
        <section>
          <h2>Artists</h2>
          {artists.map((artist) => (
            <button key={artist.artistId} className="list-btn" onClick={() => setSelected(artist)}>{artist.name}</button>
          ))}
        </section>
        <section>
          <h2>Galleries</h2>
          {galleries.map((gallery) => (
            <Link key={gallery.galleryId} className="card-link" to={`/gallery/${gallery.slug}`}>
              {gallery.title} <span className="badge">{gallery.visibility}</span>
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}

function GalleryPage() {
  const { slug = '' } = useParams();
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const [password, setPassword] = useState('');
  const [unlockToken, setUnlockToken] = useState<string>('');
  const [premiumImages, setPremiumImages] = useState<Array<{ imageId: string; assetType: 'image' | 'video'; premiumUrl: string; premiumPosterUrl?: string }>>([]);
  const [error, setError] = useState<string>('');

  const load = async () => {
    try {
      const [galleryData, commentData] = await Promise.all([api.getGallery(slug), api.getGalleryComments(slug)]);
      setGallery(galleryData);
      setComments(commentData);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, [slug]);

  const submitComment = async () => {
    try {
      await api.postGalleryComment(slug, commentBody);
      setCommentBody('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const unlock = async () => {
    try {
      const response = await api.unlockGallery(slug, password);
      setUnlockToken(response.unlockToken);
      const premium = await api.getPremiumImages(slug, response.unlockToken);
      setPremiumImages(premium);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const favoriteGallery = async () => {
    if (!gallery) return;
    try {
      await api.favorite('gallery', gallery.galleryId);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!gallery) return <div className="layout">Loading...</div>;

  return (
    <div className="layout">
      <Link to="/">Back</Link>
      <h1>{gallery.title}</h1>
      <button onClick={favoriteGallery}>Favorite Gallery ({gallery.favoriteCount})</button>
      <h2>Preview Media</h2>
      <div className="grid three">
        {gallery.media.map((image) => (
          <article key={image.imageId} className="image-card">
            {image.assetType === 'video' ? <video controls poster={image.previewPosterUrl}><source src={image.previewUrl} /></video> : <img src={image.previewUrl} alt="Preview" />}
            <small>Likes: {image.favoriteCount}</small>
            <button onClick={() => api.favorite('image', image.imageId)}>Favorite Image</button>
          </article>
        ))}
      </div>

      {gallery.visibility === 'premium' && (
        <section>
          <h2>Premium Content</h2>
          {!unlockToken && (
            <div className="inline-form">
              <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter gallery password" />
              <button onClick={unlock}>Unlock</button>
            </div>
          )}
          <div className="grid three">
            {premiumImages.map((image) => (
              image.assetType === 'video'
                ? <video key={image.imageId} controls poster={image.premiumPosterUrl}><source src={image.premiumUrl} /></video>
                : <img key={image.imageId} src={image.premiumUrl} alt="Premium" />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>Comments</h2>
        <div className="inline-form">
          <input value={commentBody} onChange={(e) => setCommentBody(e.target.value)} placeholder="Add a comment" />
          <button onClick={submitComment}>Post</button>
        </div>
        {comments.map((comment) => (
          <article key={comment.commentId} className="comment">
            <strong>{comment.displayName}</strong>
            <p>{comment.body}</p>
            <small>{new Date(comment.createdAt).toLocaleString()}</small>
          </article>
        ))}
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<CurrentUser>(() => getCurrentUser());

  const handleSignOut = async () => {
    await signOut();
    setUser(null);
  };

  return (
    <>
      <HeaderAuth user={user} onSignOut={handleSignOut} />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/gallery/:slug" element={<GalleryPage />} />
        <Route path="/auth/:mode" element={<AuthPage user={user} setUser={setUser} />} />
      </Routes>
    </>
  );
}
