import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from './api';
import {
  changePassword,
  confirmForgotPassword,
  confirmRegistration,
  forgotPassword,
  getCurrentUser,
  setInitialPassword,
  signIn,
  signOut,
  type CurrentUser
} from './cognitoAuth';

type Artist = { artistId: string; name: string; slug: string; artistThumbnailUrl?: string };
type ManagedArtist = Artist & { memberRole?: 'owner' | 'manager' | 'editor' | 'admin' };
type ContentRating = 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
type AiDisclosure = 'none' | 'ai-assisted' | 'ai-generated';
type AiFilterPreference = 'show-all' | 'hide-ai-generated' | 'hide-all-ai';
type HeavyTopic = 'politics-public-affairs' | 'crime-disasters-tragedy';
const contentRatingOptions: Array<{ value: ContentRating; label: string }> = [
  { value: 'general', label: 'General' },
  { value: 'suggestive', label: 'Suggestive' },
  { value: 'mature', label: 'Mature' },
  { value: 'sexual', label: 'Sexual' },
  { value: 'fetish', label: 'Fetish' },
  { value: 'graphic', label: 'Graphic' }
];
const aiFilterOptions: Array<{ value: AiFilterPreference; label: string }> = [
  { value: 'show-all', label: 'Show all content' },
  { value: 'hide-ai-generated', label: 'Hide AI-generated content' },
  { value: 'hide-all-ai', label: 'Hide AI-generated and AI-assisted content' }
];
const heavyTopicLabels: Record<HeavyTopic, string> = {
  'politics-public-affairs': 'Politics & Public Affairs',
  'crime-disasters-tragedy': 'Crime, Disasters & Tragedy'
};
const formatDisclosureLine = (item: {
  displayedAiDisclosure?: string;
  displayedHeavyTopics?: string[];
}) => {
  const parts: string[] = [];
  if (item.displayedAiDisclosure && item.displayedAiDisclosure !== 'No AI') {
    parts.push(item.displayedAiDisclosure);
  }
  for (const topic of item.displayedHeavyTopics || []) {
    if (topic) parts.push(topic);
  }
  return parts.join(' • ');
};
type CollectionSummary = {
  collectionId: string;
  ownerUserId: string;
  title: string;
  description?: string;
  coverImageId?: string;
  visibility: 'public' | 'private';
  insertedDate: string;
  updatedDate: string;
  imageCount: number;
  favoriteCount: number;
};
type TrendingImage = {
  imageId: string;
  artistId: string;
  artistName: string;
  galleryId: string;
  gallerySlug: string;
  galleryVisibility?: 'free' | 'preview' | 'premium';
  discoverSquareCropEnabled?: boolean;
  effectiveContentRating?: ContentRating;
  displayedContentRating?: string;
  blurred?: boolean;
  effectiveAiDisclosure?: AiDisclosure;
  displayedAiDisclosure?: string;
  effectiveHeavyTopics?: HeavyTopic[];
  displayedHeavyTopics?: string[];
  title: string;
  previewUrl: string;
  width?: number;
  height?: number;
  aspectRatio?: number;
  favoriteCount: number;
  createdAt: string;
};
type ArtistProfilePayload = {
  artistId: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive';
  followerCount: number;
  imageCount: number;
  galleryCount: number;
  trendingImages: TrendingImage[];
  galleries: Array<{
    galleryId: string;
    title: string;
    slug: string;
    visibility: 'free' | 'preview' | 'premium';
    createdAt: string;
    imageCount: number;
    favoriteCount: number;
    galleryThumbnailUrl?: string;
  }>;
  publicFavoritesByType: {
    images: Array<{ targetId: string; targetType?: 'image'; createdAt?: string; title?: string; previewUrl?: string }>;
    galleries: Array<{ targetId: string; targetType?: 'gallery'; createdAt?: string; title?: string; slug?: string; galleryThumbnailUrl?: string }>;
    collections: Array<{ targetId: string; targetType?: 'collection'; createdAt?: string; title?: string }>;
  };
  publicCollections: Array<{
    collectionId: string;
    title: string;
    description?: string;
    visibility: 'public' | 'private';
    insertedDate: string;
    updatedDate: string;
    imageCount: number;
    favoriteCount: number;
  }>;
};
type GallerySummary = {
  galleryId: string;
  title: string;
  slug: string;
  visibility: 'free' | 'preview' | 'premium';
  hasAccess?: boolean;
  purchaseUrl?: string;
  galleryThumbnailUrl?: string;
  stackPreviewUrls?: string[];
};
type GalleryAsset = {
  imageId: string;
  assetType: 'image' | 'video';
  effectiveContentRating?: ContentRating;
  displayedContentRating?: string;
  blurred?: boolean;
  effectiveAiDisclosure?: AiDisclosure;
  displayedAiDisclosure?: string;
  effectiveHeavyTopics?: HeavyTopic[];
  displayedHeavyTopics?: string[];
  previewUrl: string;
  previewPosterUrl?: string;
  thumbnailUrls?: {
    w320?: string;
    w640?: string;
    w1280?: string;
    w1920?: string;
    square256?: string;
    square512?: string;
    square1024?: string;
  };
  favoriteCount: number;
};
type Gallery = {
  galleryId: string;
  title: string;
  visibility: 'free' | 'preview' | 'premium';
  hasAccess?: boolean;
  purchaseUrl?: string;
  coverMediaId?: string;
  coverPreviewUrl?: string;
  coverBlur?: boolean;
  premiumTeaserMedia?: Array<{
    imageId: string;
    assetType: 'image' | 'video';
    effectiveContentRating?: ContentRating;
    displayedContentRating?: string;
    blurred?: boolean;
    effectiveAiDisclosure?: AiDisclosure;
    displayedAiDisclosure?: string;
    effectiveHeavyTopics?: HeavyTopic[];
    displayedHeavyTopics?: string[];
    previewUrl: string;
    previewPosterUrl?: string;
  }>;
  favoriteCount: number;
  media: GalleryAsset[];
};
type Comment = {
  commentId: string;
  authorProfileType?: 'user' | 'artist';
  authorProfileId?: string;
  displayName: string;
  body: string;
  createdAt: string;
};
type SiteSettings = { siteName: string; theme: 'ubeeq' | 'sand' | 'forest' | 'slate'; logoUrl?: string };
type UserProfile = {
  userId: string;
  username: string;
  displayName?: string;
  bio?: string;
  location?: string;
  website?: string;
  matureContentEnabled?: boolean;
  maxAllowedContentRating?: ContentRating;
  aiFilter?: AiFilterPreference;
  hideHeavyTopics?: boolean;
  hidePoliticsPublicAffairs?: boolean;
  hideCrimeDisastersTragedy?: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsernameChangeAt?: string;
};
type ManagedFavorite = {
  targetType: 'gallery' | 'image' | 'collection';
  targetId: string;
  visibility?: 'public' | 'private';
  createdAt: string;
};
type ManagedCollection = {
  collectionId: string;
  title: string;
  description?: string;
  visibility: 'public' | 'private';
  imageCount: number;
  favoriteCount: number;
  updatedDate: string;
  imageIds?: string[];
};
type StoredAccessToken = { token: string; expiresAt: number };
type StoredAccessMap = Record<string, StoredAccessToken>;

const GALLERY_ACCESS_STORAGE_KEY = 'gallery.access.tokens';
const AUTH_PERSISTENCE_KEY = 'authPersistence';

const readAccessMap = (): StoredAccessMap => {
  try {
    const raw = localStorage.getItem(GALLERY_ACCESS_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as StoredAccessMap;
  } catch {
    return {};
  }
};

const getStoredGalleryAccessToken = (slug: string): string | undefined => {
  const map = readAccessMap();
  const item = map[slug];
  if (!item) return undefined;
  if (Date.now() > item.expiresAt) {
    delete map[slug];
    localStorage.setItem(GALLERY_ACCESS_STORAGE_KEY, JSON.stringify(map));
    return undefined;
  }
  return item.token;
};

const setStoredGalleryAccessToken = (slug: string, token: string, ttlSeconds: number) => {
  const map = readAccessMap();
  map[slug] = {
    token,
    expiresAt: Date.now() + ttlSeconds * 1000
  };
  localStorage.setItem(GALLERY_ACCESS_STORAGE_KEY, JSON.stringify(map));
};

type AuthMode = 'signin' | 'register' | 'confirm' | 'forgot' | 'initial';

const authLinks: Array<{ mode: AuthMode; label: string }> = [
  { mode: 'signin', label: 'Sign In' },
  { mode: 'register', label: 'Create Account' }
];

function AutoLoadSentinel({
  enabled,
  loading,
  onLoadMore,
  rootMargin = '240px 0px'
}: {
  enabled: boolean;
  loading: boolean;
  onLoadMore: () => Promise<void> | void;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!enabled || loading || !ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void onLoadMore();
      }
    }, { rootMargin });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [enabled, loading, onLoadMore, rootMargin]);

  if (!enabled) return null;
  return (
    <div ref={ref} className="inline-form mt-4">
      <button onClick={() => void onLoadMore()} disabled={loading}>{loading ? 'Loading...' : 'Load more'}</button>
    </div>
  );
}

function HeaderAuth({
  user,
  onSignOut,
  settings,
  profile
}: {
  user: CurrentUser;
  onSignOut: () => Promise<void>;
  settings: SiteSettings;
  profile?: UserProfile | null;
}) {
  const location = useLocation();
  const headerRef = useRef<HTMLElement | null>(null);
  const closeUserMenus = () => {
    document.querySelectorAll('details.user-menu[open]').forEach((item) => item.removeAttribute('open'));
  };
  const handleSignOutClick = async () => {
    closeUserMenus();
    await onSignOut();
  };
  const rawDisplay = (profile?.displayName || user?.displayName || '').trim();
  const fallbackIdentity = (user?.email || user?.username || profile?.username || '').trim();
  const initialsSource = rawDisplay || fallbackIdentity;
  const menuSecondaryLabel = (user?.email || fallbackIdentity || '').trim();
  const displayName = rawDisplay || initialsSource
    .split('@')[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  const initials = initialsSource
    .split('@')[0]
    .split(/[.\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || 'U';

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const header = headerRef.current;
    if (!header) return;
    const updateTopbarHeight = () => {
      const height = Math.max(0, Math.round(header.getBoundingClientRect().height));
      document.documentElement.style.setProperty('--topbar-height', `${height}px`);
    };
    updateTopbarHeight();
    let resizeObserver: ResizeObserver | null = null;
    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(() => updateTopbarHeight());
      resizeObserver.observe(header);
    }
    window.addEventListener('resize', updateTopbarHeight);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateTopbarHeight);
    };
  }, []);

  return (
    <>
      <header className="topbar" ref={headerRef}>
        <div className="topbar-inner">
          <div className="brand">
            <Link to="/" className="no-underline" aria-label="Go to home">
              <div className="brand-css-logo" role="img" aria-label={`${settings.siteName} logo`}>
                <div className="brand-css-orb-wrap">
                  <div className="brand-css-orb">
                    <div className="brand-css-orb-ring brand-css-orb-ring-outer" />
                    <div className="brand-css-orb-ring brand-css-orb-ring-inner" />
                    <div className="brand-css-orb-core" />
                  </div>
                </div>
                <div>
                  <div className="brand-css-wordmark">{settings.siteName}</div>
                  <div className="brand-css-tagline">Creativity. Everywhere.</div>
                </div>
              </div>
            </Link>
          </div>
          <section className={`auth-panel ${user ? 'auth-panel-user auth-panel-user-desktop' : 'auth-panel-guest'}`}>
            {user ? (
              <div className="auth-line">
                <details className="user-menu">
                  <summary className="user-menu-trigger" aria-label="Open account menu">{initials}</summary>
                  <div className="user-menu-items">
                    <div className="user-menu-email">{menuSecondaryLabel || displayName}</div>
                    <Link to="/settings" onClick={closeUserMenus}>Settings</Link>
                    <button onClick={() => void handleSignOutClick()}>Sign Out</button>
                  </div>
                </details>
              </div>
            ) : (
              <div className="auth-line">
                <div className="auth-links">
                  <Link
                    to="/auth/signin"
                    className={`auth-nav-btn auth-nav-btn-secondary${location.pathname.startsWith('/auth/signin') ? ' is-active' : ''}`}
                  >
                    Sign in
                  </Link>
                  <Link
                    to="/auth/register"
                    className={`auth-nav-btn auth-nav-btn-primary${location.pathname.startsWith('/auth/register') ? ' is-active' : ''}`}
                  >
                    Create account
                  </Link>
                </div>
              </div>
            )}
          </section>
        </div>
      </header>

      {user && (
        <div className="mobile-user-dock">
          <div className="mobile-user-dock-inner">
            <details className="user-menu">
              <summary className="user-menu-trigger" aria-label="Open account menu">
                <span className="mobile-user-email-label">{menuSecondaryLabel || displayName}</span>
              </summary>
              <div className="user-menu-items">
                <div className="user-menu-sheet-handle" />
                <div className="user-menu-profile">
                  <div className="user-menu-profile-avatar">{initials}</div>
                  <div>
                    <div className="user-menu-profile-name">{displayName}</div>
                    <div className="user-menu-profile-email">{menuSecondaryLabel || displayName}</div>
                  </div>
                </div>
                <Link to="/settings" className="user-menu-settings-row" onClick={closeUserMenus}>
                  <span>Settings</span>
                  <span aria-hidden="true">›</span>
                </Link>
                <button className="user-menu-signout-btn" onClick={() => void handleSignOutClick()}>Sign out</button>
              </div>
            </details>
          </div>
        </div>
      )}

      {!user && (
        <div className="mobile-auth-dock">
          <div className="mobile-auth-dock-inner">
            <Link
              to="/auth/signin"
              className={`auth-nav-btn auth-nav-btn-secondary${location.pathname.startsWith('/auth/signin') ? ' is-active' : ''}`}
            >
              Sign in
            </Link>
            <Link
              to="/auth/register"
              className={`auth-nav-btn auth-nav-btn-primary${location.pathname.startsWith('/auth/register') ? ' is-active' : ''}`}
            >
              Create account
            </Link>
          </div>
        </div>
      )}
    </>
  );
}

function AuthPage({ user, setUser }: { user: CurrentUser; setUser: (u: CurrentUser) => void }) {
  const navigate = useNavigate();
  const { mode = 'signin' } = useParams();
  const authMode = mode as AuthMode;

  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [forgotStage, setForgotStage] = useState<'request' | 'confirm'>('request');
  const [keepSignedIn, setKeepSignedIn] = useState(() => localStorage.getItem(AUTH_PERSISTENCE_KEY) !== 'session');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [usernameSuggestions, setUsernameSuggestions] = useState<string[]>([]);
  const [usernameReason, setUsernameReason] = useState<string>('');
  const socialEnabled = Boolean(
    import.meta.env.VITE_COGNITO_DOMAIN &&
    import.meta.env.VITE_COGNITO_CLIENT_ID &&
    import.meta.env.VITE_COGNITO_REDIRECT_URI
  );

  useEffect(() => {
    if (authMode === 'initial') {
      setEmail(sessionStorage.getItem('auth.initial.username') || '');
    }
    if (authMode === 'forgot') {
      setForgotStage('request');
      setCode('');
      setNewPassword('');
      setConfirmPassword('');
    }
  }, [authMode]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }, [authMode]);

  useEffect(() => {
    if (authMode !== 'register') return;
    const raw = username.trim();
    if (!raw) {
      setUsernameReason('');
      setUsernameSuggestions([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.checkUsername(raw) as { available: boolean; reasons?: string[]; suggestions?: string[] };
        if (result.available) {
          setUsernameReason('');
          setUsernameSuggestions([]);
          return;
        }
        setUsernameReason(result.reasons?.[0] || 'Username unavailable');
        setUsernameSuggestions(result.suggestions || []);
      } catch {
        setUsernameReason('');
        setUsernameSuggestions([]);
      }
    }, 260);
    return () => window.clearTimeout(timer);
  }, [authMode, username]);

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
    const result = await signIn(email, password, keepSignedIn);
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
    const check = await api.checkUsername(username) as { available: boolean; reasons?: string[]; suggestions?: string[] };
    if (!check.available) {
      setUsernameReason(check.reasons?.[0] || 'Username unavailable');
      setUsernameSuggestions(check.suggestions || []);
      throw new Error(check.reasons?.[0] || 'Username unavailable');
    }
    await api.registerAccount(email, password, username);
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
    setForgotStage('confirm');
    setMessage('Reset code sent. Enter code and new password.');
  });

  const doForgotConfirm = () => withFeedback(async () => {
    if (!email) throw new Error('Email is required');
    await confirmForgotPassword(email, code, newPassword);
    navigate('/auth/signin');
  });

  const doInitialPassword = () => withFeedback(async () => {
    if (newPassword !== confirmPassword) {
      throw new Error('Passwords do not match');
    }
    const username = sessionStorage.getItem('auth.initial.username') || email;
    const session = sessionStorage.getItem('auth.initial.session') || '';
    const loggedIn = await setInitialPassword(username, session, newPassword);
    sessionStorage.removeItem('auth.initial.username');
    sessionStorage.removeItem('auth.initial.session');
    setUser(loggedIn);
    navigate('/');
  });

  const startSocialSignIn = (provider: 'Google' | 'SignInWithApple') => {
    const domain = import.meta.env.VITE_COGNITO_DOMAIN;
    const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
    const redirectUri = import.meta.env.VITE_COGNITO_REDIRECT_URI;
    if (!domain || !clientId || !redirectUri) return;
    const url = `https://${domain}/oauth2/authorize?identity_provider=${encodeURIComponent(provider)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent('openid email profile')}`;
    window.location.href = url;
  };

  const isPrimaryAuth = authMode === 'signin' || authMode === 'register';

  if (isPrimaryAuth) {
    return (
      <div className="layout auth-layout">
        <div className="panel auth-card">
          <div className="auth-card-header">
            <h2>{authMode === 'signin' ? 'Welcome back' : 'Create account'}</h2>
            <span className="badge">Secure sign-in</span>
          </div>
          <p className="small">{authMode === 'signin' ? 'Sign in to continue to your account.' : 'Create your account to continue.'}</p>
          <input
            name="email"
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {authMode === 'register' && (
            <>
              <input
                name="preferred_username"
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Profile URL"
                data-lpignore="true"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              {usernameReason && <p className="error">{usernameReason}</p>}
              {usernameSuggestions.length > 0 && (
                <div className="username-suggestions">
                  {usernameSuggestions.map((candidate) => (
                    <button key={candidate} className="username-suggestion-pill" onClick={() => setUsername(candidate)}>
                      {candidate}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <div className="auth-inline-label">
            <span>Password</span>
            {authMode === 'signin' && <Link to="/auth/forgot">Forgot password?</Link>}
          </div>
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {authMode === 'register' && (
            <input
              type="password"
              className="auth-confirm-input"
              placeholder="Confirm password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          )}

          {authMode === 'signin' && (
            <label className="auth-checkbox">
              <input type="checkbox" checked={keepSignedIn} onChange={(e) => setKeepSignedIn(e.target.checked)} />
              <span>Keep me signed in on this device</span>
            </label>
          )}

          <div className="auth-main-actions">
            {authMode === 'signin'
              ? <button className="auth-primary-btn w-full" onClick={doSignIn}>Sign in</button>
              : <button className="auth-primary-btn w-full" onClick={doRegister}>Create account</button>}
            <button className="auth-secondary-btn w-full" onClick={() => navigate('/')}>Cancel</button>
          </div>

          <div className="auth-divider"><span>or</span></div>
          <div className="auth-social-grid">
            <button className="auth-secondary-btn" disabled={!socialEnabled} onClick={() => startSocialSignIn('Google')}>Continue with Google</button>
            <button className="auth-secondary-btn" disabled={!socialEnabled} onClick={() => startSocialSignIn('SignInWithApple')}>Continue with Apple</button>
          </div>

          <div className="auth-confirm-banner">
            Need to confirm your account? <Link to="/auth/confirm">Confirm registration</Link>
          </div>

          <div className="small">
            {authMode === 'signin'
              ? <>New to Ubeeq? <Link to="/auth/register">Create an account</Link></>
              : <>Already have an account? <Link to="/auth/signin">Sign in</Link></>}
          </div>

          {message && <p className="success">{message}</p>}
          {error && <p className="error">{error}</p>}
        </div>

        <div className="auth-showcase panel">
          <span className="auth-chip">Trusted access for collectors and creators</span>
          <h1>{`${authMode === 'signin' ? 'Sign in' : 'Create your account'} to follow artists, favourite work, and unlock early access.`}</h1>
          <p>A cleaner entrance experience for a curated gallery platform.</p>
          <div className="auth-feature-grid">
            <article><strong>Follow artists</strong><p>Unlock follower-access releases and stay current with new drops.</p></article>
            <article><strong>Favourite pieces</strong><p>Build your own collection trail and surface relevant work faster.</p></article>
            <article><strong>Early access</strong><p>See scheduled releases before wide release when artists enable it.</p></article>
          </div>
          <div className="auth-showcase-actions">
            {authMode === 'signin'
              ? <button className="auth-primary-btn" onClick={() => navigate('/auth/register')}>Create account</button>
              : <button className="auth-primary-btn" onClick={() => navigate('/auth/signin')}>Sign in</button>}
            <Link className="auth-secondary-btn" to="/">Browse public galleries</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="layout">
      <div className="panel max-w-3xl">
        <h1>Account</h1>

        {(authMode === 'confirm' || authMode === 'forgot' || authMode === 'initial') && (
          <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        )}

        {(authMode === 'confirm' || (authMode === 'forgot' && forgotStage === 'confirm')) && (
          <input placeholder="Confirmation code" value={code} onChange={(e) => setCode(e.target.value)} />
        )}

        {((authMode === 'forgot' && forgotStage === 'confirm') || authMode === 'initial') && (
          <input type="password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        )}

        {authMode === 'initial' && (
          <input type="password" placeholder="Confirm password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
        )}

        {authMode === 'confirm' && <button onClick={doConfirm}>Confirm Registration</button>}
        {authMode === 'forgot' && forgotStage === 'request' && <button onClick={doForgot}>Send Reset Code</button>}
        {authMode === 'forgot' && forgotStage === 'confirm' && <button onClick={doForgotConfirm}>Reset Password</button>}
        {authMode === 'initial' && <button onClick={doInitialPassword}>Set Initial Password</button>}

        {message && <p className="success">{message}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

function SettingsPage({ user, onProfileChanged }: { user: CurrentUser; onProfileChanged?: (profile: UserProfile) => void }) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [managedArtists, setManagedArtists] = useState<ManagedArtist[]>([]);
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
  const selectedArtistId = selectedProfileKey.startsWith('artist:') ? selectedProfileKey.slice('artist:'.length) : '';
  const selectedArtist = managedArtists.find((artist) => artist.artistId === selectedArtistId) || null;
  const profileUrlPreview = `${window.location.origin.replace(/\/$/, '')}/${selectedArtist ? 'artists' : 'u'}/${(usernameInput || '').trim() || 'your-profile-url'}`;
  const selectedOwnerContext = selectedArtist
    ? { ownerProfileType: 'artist' as const, ownerProfileId: selectedArtist.artistId }
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
        const myArtists = await api.getMyArtists() as ManagedArtist[];
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
        const updatedArtist = await api.updateArtist(selectedArtist.artistId, {
          name: displayName || selectedArtist.name
        }) as ManagedArtist;
        setManagedArtists((prev) => prev.map((item) => (item.artistId === updatedArtist.artistId ? { ...item, ...updatedArtist } : item)));
        setMessage('Artist profile updated');
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
        const updatedArtist = await api.updateArtist(selectedArtist.artistId, {
          slug: usernameInput
        }) as ManagedArtist;
        setManagedArtists((prev) => prev.map((item) => (item.artistId === updatedArtist.artistId ? { ...item, ...updatedArtist } : item)));
        setUsernameInput(updatedArtist.slug);
        setUsernameSuggestions([]);
        setMessage('Artist profile URL updated');
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
              {managedArtists.map((artist) => (
                <option key={artist.artistId} value={`artist:${artist.artistId}`}>
                  Artist: {artist.name} ({artist.memberRole || 'editor'})
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
            <p className="small">{selectedArtist ? 'The name shown on this artist profile' : 'The name shown on your profile'}</p>
          </div>
          <button onClick={saveProfile}>{selectedArtist ? 'Save Artist Name' : 'Save Display Name'}</button>
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
            <p className="small">{selectedArtist ? 'This artist profile will be available at:' : 'Your profile will be available at:'}</p>
            <p className="small settings-profile-url-preview">{profileUrlPreview}</p>
          </div>
          <button onClick={changeUsername}>{selectedArtist ? 'Save Artist URL' : 'Save Profile URL'}</button>
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

function HomePage({ viewerProfile }: { viewerProfile?: UserProfile | null }) {
  const currentUser = getCurrentUser();
  const dailySeed = new Date().toISOString().slice(0, 10);
  const trendingBaseLimit = 18;
  type FeedDensity = 'small' | 'medium' | 'large';
  type DensityViewport = 'mobile' | 'tablet' | 'desktop';
  type TrendingCardEntry = {
    item: TrendingImage;
    index: number;
  };
  type TrendingPairRow = {
    left: TrendingImage;
    right?: TrendingImage;
    startIndex: number;
  };
  type TrendingMediumBlock =
    | { kind: 'pair'; row: TrendingPairRow }
    | { kind: 'pair-with-insets'; row: TrendingPairRow; insets: TrendingCardEntry[]; insetOn: 'left' | 'right' };
  type MediumBlockBuildResult = {
    blocks: TrendingMediumBlock[];
    consumedBorrowedImageIds: Set<string>;
  };
  type DiscoveryGallery = GallerySummary & { artistName: string; artistSlug: string; stackPreviewUrls?: string[] };

  const [artists, setArtists] = useState<Artist[]>([]);
  const [galleries, setGalleries] = useState<DiscoveryGallery[]>([]);
  const [trendingImages, setTrendingImages] = useState<TrendingImage[]>([]);
  const [trendingCursor, setTrendingCursor] = useState<string | undefined>(undefined);
  const [trendingReloadNonce, setTrendingReloadNonce] = useState(0);
  const [trendingPeriod, setTrendingPeriod] = useState<'hourly' | 'daily'>('daily');
  const [feedDensity, setFeedDensity] = useState<FeedDensity>('medium');
  const [densityViewport, setDensityViewport] = useState<DensityViewport>(() => {
    if (typeof window === 'undefined') return 'desktop';
    if (window.innerWidth >= 1100) return 'desktop';
    if (window.innerWidth >= 700) return 'tablet';
    return 'mobile';
  });
  const [densityFadeState, setDensityFadeState] = useState<'idle' | 'fading-out' | 'fading-in'>('idle');
  const [densitySwitchLoading, setDensitySwitchLoading] = useState(false);
  const [favoriteIdentity, setFavoriteIdentity] = useState<string>('user');
  const [managedArtists, setManagedArtists] = useState<ManagedArtist[]>([]);
  const [favoriteImageIds, setFavoriteImageIds] = useState<Set<string>>(new Set());
  const [favoriteGalleryIds, setFavoriteGalleryIds] = useState<Set<string>>(new Set());
  const [loadingMoreTrending, setLoadingMoreTrending] = useState(false);
  const [loadingTrending, setLoadingTrending] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [loadingCollections, setLoadingCollections] = useState(false);
  const [deferredSectionsReady, setDeferredSectionsReady] = useState(false);
  const [disclosureAiFilter, setDisclosureAiFilter] = useState<AiFilterPreference>(viewerProfile?.aiFilter || 'show-all');
  const [hideHeavyTopics, setHideHeavyTopics] = useState<boolean>(Boolean(viewerProfile?.hideHeavyTopics));
  const [hidePoliticsPublicAffairs, setHidePoliticsPublicAffairs] = useState<boolean>(Boolean(viewerProfile?.hidePoliticsPublicAffairs));
  const [hideCrimeDisastersTragedy, setHideCrimeDisastersTragedy] = useState<boolean>(Boolean(viewerProfile?.hideCrimeDisastersTragedy));
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [followedArtistIds, setFollowedArtistIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const densityTransitionTimersRef = useRef<number[]>([]);
  const densitySwitchRequestRef = useRef<number | null>(null);
  const mediumBlockLayoutCacheRef = useRef<Map<string, MediumBlockBuildResult>>(new Map());
  const mediumTopBorrowRowsRef = useRef<TrendingPairRow[] | null>(null);
  const continuationFrozenRowsRef = useRef<number>(0);

  const fallbackAspectRatios = [1.6, 0.8, 1.5, 0.56, 1.78, 1.25, 1.33, 0.75];
  const collectionPalettes = [
    ['#d9edff', '#ead27e', '#88c1b2', '#6d97c8'],
    ['#f3dfbe', '#b7d0ff', '#d2d7de', '#a97d62'],
    ['#d6f1e4', '#ffd7b8', '#bdb37b', '#86b091']
  ];
  const densityTopRows: Record<FeedDensity, number> = {
    small: 3,
    medium: 4,
    large: 2
  };
  const densityLabel: Record<FeedDensity, string> = {
    small: 'Small',
    medium: 'Medium',
    large: 'Large'
  };
  const densityFadeOutMs = 130;
  const densityFadeInMs = 570;
  const densityOptions: FeedDensity[] = densityViewport === 'desktop' ? ['small', 'medium', 'large'] : ['small', 'large'];
  const disclosureFilters = {
    aiFilter: disclosureAiFilter,
    hideHeavyTopics,
    hidePoliticsPublicAffairs: hideHeavyTopics ? true : hidePoliticsPublicAffairs,
    hideCrimeDisastersTragedy: hideHeavyTopics ? true : hideCrimeDisastersTragedy
  };

  const clearDensityTransitionTimers = () => {
    if (typeof window === 'undefined') return;
    densityTransitionTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    densityTransitionTimersRef.current = [];
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const getViewport = (width: number): DensityViewport => {
      if (width >= 1100) return 'desktop';
      if (width >= 700) return 'tablet';
      return 'mobile';
    };
    const onResize = () => {
      const next = getViewport(window.innerWidth);
      setDensityViewport((prev) => (prev === next ? prev : next));
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    setDisclosureAiFilter(viewerProfile?.aiFilter || 'show-all');
    setHideHeavyTopics(Boolean(viewerProfile?.hideHeavyTopics));
    setHidePoliticsPublicAffairs(Boolean(viewerProfile?.hidePoliticsPublicAffairs));
    setHideCrimeDisastersTragedy(Boolean(viewerProfile?.hideCrimeDisastersTragedy));
  }, [
    viewerProfile?.aiFilter,
    viewerProfile?.hideHeavyTopics,
    viewerProfile?.hidePoliticsPublicAffairs,
    viewerProfile?.hideCrimeDisastersTragedy
  ]);

  useEffect(() => {
    if (densityViewport !== 'desktop' && feedDensity === 'medium') {
      setFeedDensity('large');
    }
  }, [densityViewport, feedDensity]);

  useEffect(() => {
    const requestNonce = trendingReloadNonce;
    const loadTrending = async () => {
      try {
        setLoadingTrending(true);
        const trendingData = await api.getTrendingImagesFiltered(
          trendingPeriod,
          undefined,
          trendingBaseLimit,
          disclosureFilters
        ) as { items: TrendingImage[]; nextCursor?: string };
        setTrendingImages(trendingData.items || []);
        setTrendingCursor(trendingData.nextCursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoadingTrending(false);
        if (densitySwitchRequestRef.current === requestNonce) {
          densitySwitchRequestRef.current = null;
          setDensitySwitchLoading(false);
        }
      }
    };
    void loadTrending();
  }, [trendingPeriod, trendingReloadNonce, disclosureFilters.aiFilter, disclosureFilters.hideHeavyTopics, disclosureFilters.hidePoliticsPublicAffairs, disclosureFilters.hideCrimeDisastersTragedy]);

  useEffect(() => () => clearDensityTransitionTimers(), []);

  useEffect(() => {
    mediumBlockLayoutCacheRef.current.clear();
    mediumTopBorrowRowsRef.current = null;
    continuationFrozenRowsRef.current = 0;
  }, [
    trendingReloadNonce,
    trendingPeriod,
    disclosureFilters.aiFilter,
    disclosureFilters.hideHeavyTopics,
    disclosureFilters.hidePoliticsPublicAffairs,
    disclosureFilters.hideCrimeDisastersTragedy,
    feedDensity
  ]);

  useEffect(() => {
    if (deferredSectionsReady || loadingTrending) return;
    const schedule = (cb: () => void): number => {
      if (typeof window.requestIdleCallback === 'function') {
        return window.requestIdleCallback(cb, { timeout: 1200 }) as unknown as number;
      }
      return window.setTimeout(cb, 0);
    };
    const cancel = (id: number) => {
      if (typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(id as unknown as any);
      } else {
        window.clearTimeout(id);
      }
    };
    const id = schedule(() => setDeferredSectionsReady(true));
    return () => cancel(id);
  }, [deferredSectionsReady, loadingTrending]);

  useEffect(() => {
    if (!deferredSectionsReady) return;
    const loadLatest = async () => {
      try {
        setLoadingLatest(true);
        const [artistList, latestGalleries] = await Promise.all([
          api.getArtists() as Promise<Artist[]>,
          api.getLatestGalleries(12) as Promise<DiscoveryGallery[]>
        ]);
        setArtists(artistList);
        setGalleries(latestGalleries || []);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoadingLatest(false);
      }
    };
    void loadLatest();
  }, [deferredSectionsReady]);

  useEffect(() => {
    if (!deferredSectionsReady) return;
    const loadCollectionData = async () => {
      try {
        setLoadingCollections(true);
        const collectionData = await api.getCollections(undefined, 9, { order: 'popular', seed: dailySeed }) as { items: CollectionSummary[] };
        setCollections(collectionData.items || []);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoadingCollections(false);
      }
    };
    void loadCollectionData();
  }, [dailySeed, deferredSectionsReady]);

  useEffect(() => {
    if (!deferredSectionsReady) return;
    const loadUserContext = async () => {
      if (!currentUser) {
        setFollowedArtistIds(new Set());
        setManagedArtists([]);
        return;
      }
      try {
        const [follows, myArtists] = await Promise.all([
          api.myFollows() as Promise<Array<{ artistId: string }>>,
          api.getMyArtists() as Promise<ManagedArtist[]>
        ]);
        setFollowedArtistIds(new Set((follows || []).map((item) => item.artistId)));
        setManagedArtists(myArtists || []);
      } catch {
        setFollowedArtistIds(new Set());
        setManagedArtists([]);
      }
    };
    void loadUserContext();
  }, [currentUser?.username, deferredSectionsReady]);

  const loadMoreTrending = async () => {
    if (!trendingCursor) return;
    try {
      setLoadingMoreTrending(true);
      const response = await api.getTrendingImagesFiltered(
        trendingPeriod,
        trendingCursor,
        trendingBaseLimit,
        disclosureFilters
      ) as { items: TrendingImage[]; nextCursor?: string };
      setTrendingImages((prev) => [...prev, ...(response.items || [])]);
      setTrendingCursor(response.nextCursor);
    } catch {
      // no-op
    } finally {
      setLoadingMoreTrending(false);
    }
  };

  const ratioFromImageId = (id: string): number => {
    let hash = 2166136261;
    for (let i = 0; i < id.length; i += 1) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const unit = (hash >>> 0) / 4294967296;
    return 0.58 + unit * 1.52;
  };

  const getTrendingRatio = (item: TrendingImage, index: number): number => {
    const width = Number(item.width || 0);
    const height = Number(item.height || 0);
    const aspectRatio = Number(item.aspectRatio || 0);
    if (Number.isFinite(aspectRatio) && aspectRatio > 0) {
      return aspectRatio;
    }
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return width / height;
    }
    if (item.imageId) return ratioFromImageId(item.imageId);
    return fallbackAspectRatios[index % fallbackAspectRatios.length];
  };

  const buildPairRows = (items: TrendingImage[]): TrendingPairRow[] => {
    const rows: TrendingPairRow[] = [];
    for (let i = 0; i < items.length; i += 2) {
      rows.push({ left: items[i], right: items[i + 1], startIndex: i });
    }
    return rows;
  };

  const pairTemplateColumns = (row: TrendingPairRow, density: FeedDensity): string => {
    if (!row.right) return '1fr';
    if (density === 'small') return '1fr 1fr';
    if (density === 'large') return '1fr';
    const leftRatio = getTrendingRatio(row.left, row.startIndex);
    const rightRatio = getTrendingRatio(row.right, row.startIndex + 1);
    const total = leftRatio + rightRatio;
    if (!total) return '1fr 1fr';
    const leftShare = Math.max(0.34, Math.min(0.66, leftRatio / total));
    const rightShare = 1 - leftShare;
    return `${(leftShare * 100).toFixed(2)}fr ${(rightShare * 100).toFixed(2)}fr`;
  };

  const rowsToEntries = (rows: TrendingPairRow[]): TrendingCardEntry[] => {
    const entries: TrendingCardEntry[] = [];
    rows.forEach((row) => {
      entries.push({ item: row.left, index: row.startIndex });
      if (row.right) entries.push({ item: row.right, index: row.startIndex + 1 });
    });
    return entries;
  };

  const buildMediumMixedBlocks = (
    rows: TrendingPairRow[],
    options?: { borrowedEntries?: TrendingCardEntry[] }
  ): MediumBlockBuildResult => {
    const primaryEntries = rowsToEntries(rows);
    const queue: Array<{ entry: TrendingCardEntry; borrowed: boolean }> = [
      ...primaryEntries.map((entry) => ({ entry, borrowed: false })),
      ...((options?.borrowedEntries || []).map((entry) => ({ entry, borrowed: true })))
    ];
    const blocks: TrendingMediumBlock[] = [];
    const consumedBorrowedImageIds = new Set<string>();
    let remainingPrimaryEntries = primaryEntries.length;
    const maxLayoutPromotionOffset = 100;
    const isSquareEligible = (entry: TrendingCardEntry): boolean => (
      entry.item.discoverSquareCropEnabled !== false && getTrendingRatio(entry.item, entry.index) <= 0.95
    );
    const canPromoteWithinWindow = (entry: TrendingCardEntry, baseIndex: number): boolean => (
      entry.index - baseIndex <= maxLayoutPromotionOffset
    );
    const consumeAt = (index: number): TrendingCardEntry | null => {
      const [removed] = queue.splice(index, 1);
      if (!removed) return null;
      if (removed.borrowed) {
        consumedBorrowedImageIds.add(removed.entry.item.imageId);
      } else {
        remainingPrimaryEntries = Math.max(0, remainingPrimaryEntries - 1);
      }
      return removed.entry;
    };

    while (remainingPrimaryEntries > 0 && queue.length > 0) {
      if (queue.length >= 3) {
        const left = queue[0]?.entry;
        const right = queue[1]?.entry;
        if (!left || !right) break;
        const leftRatio = getTrendingRatio(left.item, left.index);
        const rightRatio = getTrendingRatio(right.item, right.index);
        const oneVeryTallPortrait = (leftRatio <= 0.62 && rightRatio >= 1.05) || (rightRatio <= 0.62 && leftRatio >= 1.05);
        const ratioGapLarge = Math.abs(leftRatio - rightRatio) >= 0.85;

        if (oneVeryTallPortrait && ratioGapLarge) {
          const insetIndices: number[] = [];
          for (let i = 2; i < queue.length; i += 1) {
            const entry = queue[i]?.entry;
            if (!entry) continue;
            if (!isSquareEligible(entry)) continue;
            if (!canPromoteWithinWindow(entry, left.index)) continue;
            insetIndices.push(i);
            if (insetIndices.length === 2) break;
          }
          if (insetIndices.length >= 2) {
            const insets = insetIndices
              .slice(0, 2)
              .map((idx) => queue[idx]?.entry)
              .filter((entry): entry is TrendingCardEntry => Boolean(entry))
              .sort((a, b) => a.index - b.index);
            [...insetIndices].sort((a, b) => b - a).forEach((idx) => void consumeAt(idx));
            consumeAt(1);
            consumeAt(0);
            blocks.push({
              kind: 'pair-with-insets',
              row: {
                left: left.item,
                right: right.item,
                startIndex: left.index
              },
              insets,
              insetOn: leftRatio <= rightRatio ? 'right' : 'left'
            });
            continue;
          }
        }
      }

      const left = consumeAt(0);
      if (!left) break;
      const right = remainingPrimaryEntries > 0 ? consumeAt(0) : null;
      blocks.push({
        kind: 'pair',
        row: {
          left: left.item,
          right: right?.item,
          startIndex: left.index
        }
      });
    }

    return {
      blocks,
      consumedBorrowedImageIds
    };
  };

  const stableMediumBlockBuild = (
    rows: TrendingPairRow[],
    options?: { borrowedEntries?: TrendingCardEntry[] }
  ): MediumBlockBuildResult => {
    const serializeRows = (inputRows: TrendingPairRow[]): string => inputRows
      .map((row) => `${row.left.imageId}:${row.startIndex}:${row.right?.imageId || '-'}`)
      .join('|');
    const serializeBorrowed = (entries?: TrendingCardEntry[]): string => (entries || [])
      .slice(0, 60)
      .map((entry) => `${entry.item.imageId}:${entry.index}`)
      .join('|');
    const cacheKey = `${feedDensity}::${serializeRows(rows)}::${serializeBorrowed(options?.borrowedEntries)}`;
    const cached = mediumBlockLayoutCacheRef.current.get(cacheKey);
    if (cached) return cached;
    const built = buildMediumMixedBlocks(rows, options);
    mediumBlockLayoutCacheRef.current.set(cacheKey, built);
    return built;
  };

  const displayAspectRatio = (item: TrendingImage, index: number): number => {
    const base = getTrendingRatio(item, index);
    return Math.max(0.52, Math.min(2.8, base));
  };

  const trendingViewCount = (index: number): string => `${(1.8 + ((index % 9) * 0.17)).toFixed(1)}k`;

  const applyDensityChange = (nextDensity: FeedDensity, markDensityRequest = false) => {
    setFeedDensity(nextDensity);
    setTrendingImages([]);
    setTrendingCursor(undefined);
    setLoadingMoreTrending(false);
    setTrendingReloadNonce((value) => {
      const next = value + 1;
      if (markDensityRequest) {
        densitySwitchRequestRef.current = next;
      }
      return next;
    });
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        document.getElementById('trending')?.scrollIntoView({ behavior: 'auto', block: 'start' });
      });
    }
  };

  const resetTrendingViewForDensity = (nextDensity: FeedDensity) => {
    if (nextDensity === feedDensity || typeof window === 'undefined') return;
    clearDensityTransitionTimers();
    setDensitySwitchLoading(true);
    setDensityFadeState('fading-out');
    const fadeOutTimer = window.setTimeout(() => {
      applyDensityChange(nextDensity, true);
      setDensityFadeState('fading-in');
      const fadeInTimer = window.setTimeout(() => {
        setDensityFadeState('idle');
      }, densityFadeInMs);
      densityTransitionTimersRef.current.push(fadeInTimer);
    }, densityFadeOutMs);
    densityTransitionTimersRef.current.push(fadeOutTimer);
  };

  const trendingRenderable = trendingImages.filter((item) => Boolean(item.previewUrl));
  const smallTopItemCount = densityTopRows.small * 4;
  const smallTopItems = trendingRenderable.slice(0, smallTopItemCount);
  const smallContinuationItems = trendingRenderable.slice(smallTopItemCount);
  const allTrendingRows = buildPairRows(trendingRenderable);
  const topRows = allTrendingRows.slice(0, densityTopRows[feedDensity]);
  const continuationRowsSeed = allTrendingRows.slice(densityTopRows[feedDensity]);
  const dynamicTopBorrowRows = continuationRowsSeed.slice(0, 5);
  if (feedDensity === 'medium' && !mediumTopBorrowRowsRef.current && dynamicTopBorrowRows.length > 0) {
    mediumTopBorrowRowsRef.current = dynamicTopBorrowRows;
  }
  const topBorrowRows = feedDensity === 'medium'
    ? (mediumTopBorrowRowsRef.current || dynamicTopBorrowRows)
    : dynamicTopBorrowRows;
  const continuationEntriesSeed = rowsToEntries(topBorrowRows);
  const mediumTopBuild = feedDensity === 'medium'
    ? stableMediumBlockBuild(topRows, { borrowedEntries: continuationEntriesSeed })
    : null;
  const borrowedTopImageIds = mediumTopBuild?.consumedBorrowedImageIds || new Set<string>();
  const filterRowsByExcludedImageIds = (rows: TrendingPairRow[], excluded: Set<string>): TrendingPairRow[] => {
    if (excluded.size === 0) return rows;
    const filtered: TrendingPairRow[] = [];
    rows.forEach((row) => {
      const keptEntries = [
        { item: row.left, index: row.startIndex },
        ...(row.right ? [{ item: row.right, index: row.startIndex + 1 }] : [])
      ].filter((entry) => !excluded.has(entry.item.imageId));
      if (keptEntries.length === 0) return;
      if (keptEntries.length === 1) {
        filtered.push({
          left: keptEntries[0].item,
          right: undefined,
          startIndex: keptEntries[0].index
        });
        return;
      }
      const sorted = [...keptEntries].sort((a, b) => a.index - b.index);
      filtered.push({
        left: sorted[0].item,
        right: sorted[1].item,
        startIndex: sorted[0].index
      });
    });
    return filtered;
  };
  const continuationRows = feedDensity === 'medium'
    ? filterRowsByExcludedImageIds(continuationRowsSeed, borrowedTopImageIds)
    : continuationRowsSeed;
  const continuationBlockRowsByDensity: Record<FeedDensity, number> = {
    small: 3,
    medium: 2,
    large: 1
  };
  const continuationSmallBlockSize = continuationBlockRowsByDensity.small * 4;
  const continuationRowsBlockSize = continuationBlockRowsByDensity[feedDensity];

  const smallContinuationBlockOne = smallContinuationItems.slice(0, continuationSmallBlockSize);
  const smallContinuationBlockTwo = smallContinuationItems.slice(continuationSmallBlockSize, continuationSmallBlockSize * 2);
  const smallContinuationBlockThree = smallContinuationItems.slice(continuationSmallBlockSize * 2);

  const continuationBlockOneRows = continuationRows.slice(0, continuationRowsBlockSize);
  const continuationBlockTwoRows = continuationRows.slice(continuationRowsBlockSize, continuationRowsBlockSize * 2);
  const continuationBlockThreeRows = continuationRows.slice(continuationRowsBlockSize * 2);
  const continuationChunkSize = Math.max(1, continuationRowsBlockSize);
  let continuationFrozenRowsCount = 0;
  if (feedDensity !== 'small') {
    const fullChunkRows = Math.floor(continuationBlockThreeRows.length / continuationChunkSize) * continuationChunkSize;
    if (fullChunkRows > continuationFrozenRowsRef.current) {
      continuationFrozenRowsRef.current = fullChunkRows;
    }
    if (!trendingCursor && continuationBlockThreeRows.length > continuationFrozenRowsRef.current) {
      continuationFrozenRowsRef.current = continuationBlockThreeRows.length;
    }
    continuationFrozenRowsCount = Math.min(continuationFrozenRowsRef.current, continuationBlockThreeRows.length);
  }
  const continuationFrozenRows = feedDensity === 'small'
    ? []
    : continuationBlockThreeRows.slice(0, continuationFrozenRowsCount);
  const continuationTailRows = feedDensity === 'small'
    ? []
    : continuationBlockThreeRows.slice(continuationFrozenRowsCount);
  const continuationFrozenChunks: TrendingPairRow[][] = [];
  if (feedDensity !== 'small') {
    for (let i = 0; i < continuationFrozenRows.length; i += continuationChunkSize) {
      const chunk = continuationFrozenRows.slice(i, i + continuationChunkSize);
      if (chunk.length > 0) continuationFrozenChunks.push(chunk);
    }
  }

  const continuationBlockOneHasItems = feedDensity === 'small' ? smallContinuationBlockOne.length > 0 : continuationBlockOneRows.length > 0;
  const continuationBlockTwoHasItems = feedDensity === 'small' ? smallContinuationBlockTwo.length > 0 : continuationBlockTwoRows.length > 0;
  const continuationBlockThreeHasItems = feedDensity === 'small'
    ? (smallContinuationBlockThree.length > 0 || Boolean(trendingCursor))
    : (continuationBlockThreeRows.length > 0 || Boolean(trendingCursor));
  const densityTransitionClass = densityFadeState === 'idle' ? '' : ` ${densityFadeState}`;
  const isDensityTransitioning = densityFadeState !== 'idle';

  const latest = galleries
    .filter((gallery) => Boolean((gallery.stackPreviewUrls && gallery.stackPreviewUrls[0]) || gallery.galleryThumbnailUrl))
    .slice(0, 8);
  const latestItems: DiscoveryGallery[] = latest;
  const risingArtists = artists.slice(0, 4);
  const trendingCollections = collections.slice(0, 3);
  const showRisingArtistsSection = risingArtists.length >= 2;
  const showTrendingCollectionsSection = trendingCollections.length >= 2;

  const toggleFollow = async (artistId?: string) => {
    if (!artistId) return;
    try {
      if (followedArtistIds.has(artistId)) {
        await api.unfollowArtist(artistId);
        setFollowedArtistIds((prev) => {
          const next = new Set(prev);
          next.delete(artistId);
          return next;
        });
      } else {
        await api.followArtist(artistId);
        setFollowedArtistIds((prev) => new Set(prev).add(artistId));
      }
    } catch {
      // no-op
    }
  };

  const favoriteAsProfile = favoriteIdentity.startsWith('artist:')
    ? { ownerProfileType: 'artist' as const, ownerProfileId: favoriteIdentity.slice('artist:'.length) }
    : { ownerProfileType: 'user' as const };

  useEffect(() => {
    const loadFavorites = async () => {
      if (!deferredSectionsReady) return;
      if (!currentUser) {
        setFavoriteImageIds(new Set());
        setFavoriteGalleryIds(new Set());
        return;
      }
      try {
        const favorites = await api.myFavorites(favoriteAsProfile) as ManagedFavorite[];
        setFavoriteImageIds(new Set(favorites.filter((item) => item.targetType === 'image').map((item) => item.targetId)));
        setFavoriteGalleryIds(new Set(favorites.filter((item) => item.targetType === 'gallery').map((item) => item.targetId)));
      } catch {
        setFavoriteImageIds(new Set());
        setFavoriteGalleryIds(new Set());
      }
    };
    void loadFavorites();
  }, [currentUser?.username, favoriteIdentity, deferredSectionsReady]);

  const toggleImageFavorite = async (imageId: string) => {
    const wasFavorited = favoriteImageIds.has(imageId);
    setFavoriteImageIds((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(imageId);
      else next.add(imageId);
      return next;
    });
    setTrendingImages((prev) => prev.map((item) => (
      item.imageId === imageId
        ? { ...item, favoriteCount: Math.max(0, (item.favoriteCount || 0) + (wasFavorited ? -1 : 1)) }
        : item
    )));
    try {
      if (wasFavorited) {
        await api.unfavorite('image', imageId, favoriteAsProfile);
      } else {
        await api.favorite('image', imageId, 'public', favoriteAsProfile);
      }
    } catch {
      setFavoriteImageIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(imageId);
        else next.delete(imageId);
        return next;
      });
      setTrendingImages((prev) => prev.map((item) => (
        item.imageId === imageId
          ? { ...item, favoriteCount: Math.max(0, (item.favoriteCount || 0) + (wasFavorited ? 1 : -1)) }
          : item
      )));
    }
  };

  const toggleGalleryFavorite = async (galleryId: string) => {
    const wasFavorited = favoriteGalleryIds.has(galleryId);
    setFavoriteGalleryIds((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(galleryId);
      else next.add(galleryId);
      return next;
    });
    try {
      if (wasFavorited) {
        await api.unfavorite('gallery', galleryId, favoriteAsProfile);
      } else {
        await api.favorite('gallery', galleryId, 'public', favoriteAsProfile);
      }
    } catch {
      setFavoriteGalleryIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(galleryId);
        else next.delete(galleryId);
        return next;
      });
    }
  };

  const renderTrendingCard = (
    item: TrendingImage,
    cardIndex: number,
    options?: { forceSquareFrame?: boolean; compactCard?: boolean; preload?: boolean }
  ) => {
    const href = item.gallerySlug
      ? `/gallery/${item.gallerySlug}?image=${encodeURIComponent(item.imageId)}`
      : '/';
    const isPreview = item.galleryVisibility === 'preview';
    const isFavorite = favoriteImageIds.has(item.imageId);
    const displayedRating = item.displayedContentRating || 'General';
    const disclosureLine = formatDisclosureLine(item);
    const isBlurredByRating = item.blurred === true;
    const ratio = displayAspectRatio(item, cardIndex);
    const allowDiscoverSquareCrop = item.discoverSquareCropEnabled !== false;
    const forceSquareFrame = Boolean(options?.forceSquareFrame);
    const compactCard = Boolean(options?.compactCard);
    const preload = Boolean(options?.preload);
    const shouldSquareCrop = (feedDensity === 'small' || forceSquareFrame) && allowDiscoverSquareCrop;
    const shouldLargeCrop = feedDensity === 'large' && allowDiscoverSquareCrop;
    const frameRatio = shouldSquareCrop ? 1 : ratio;
    const isSmallLandscape = feedDensity === 'small' && !shouldSquareCrop && ratio >= 1.25;
    const largeCardClass = feedDensity === 'large' ? ' density-large-card' : '';
    const compactCardClass = compactCard ? ' is-compact' : '';
    const largeCropClass = shouldLargeCrop ? ' large-crop' : '';
    const nonCropClass = !shouldSquareCrop && !shouldLargeCrop ? ' no-crop' : '';

    return (
      <article
        key={item.imageId}
        className={`discovery-feature-card${isSmallLandscape ? ' is-landscape' : ''}${largeCardClass}${compactCardClass}`}
        style={{ '--media-aspect': frameRatio.toFixed(4) } as any}
      >
        <Link to={href} className="discovery-feature-link no-underline">
          <div
            className={`discovery-feature-media${shouldSquareCrop ? ' can-square-crop' : ''}${largeCropClass}${nonCropClass}`}
            style={{
              aspectRatio: `${frameRatio.toFixed(3)} / 1`
            }}
          >
            <img
              src={item.previewUrl}
              alt={item.title || 'Artwork preview'}
              loading={preload || cardIndex < 2 ? 'eager' : 'lazy'}
              fetchPriority={preload || cardIndex < 2 ? 'high' : (cardIndex < 8 ? 'auto' : 'low')}
              decoding="async"
              style={{
                objectPosition: 'center center',
                filter: isBlurredByRating ? 'blur(28px)' : undefined
              }}
            />
            {isPreview && <span className="discovery-chip">Preview</span>}
            {isBlurredByRating && <span className="discovery-chip" style={{ left: 'unset', right: '1rem' }}>Mature Content</span>}
          </div>
        </Link>
        <div className="discovery-feature-footer">
          <div className="discovery-feature-text">
            <h3 className="discovery-feature-title">{item.title || 'Artwork title'}</h3>
            <p className="discovery-feature-subtitle">by {item.artistName || 'Artist Name'}</p>
            {disclosureLine && !compactCard && <p className="discovery-feature-subtitle">{disclosureLine}</p>}
          </div>
          {!compactCard && (
            <div className="discovery-feature-stats">
              <span>❤ {item.favoriteCount || 0}</span>
              <span>👁 {trendingViewCount(cardIndex)}</span>
              <span>{isPreview ? 'Follower preview' : 'Public'}</span>
              <span>{displayedRating}</span>
            </div>
          )}
          <div className="discovery-feature-actions">
            <Link to={href} className="discovery-quick-view-link no-underline">Quick view</Link>
            {currentUser && !compactCard && (
              <button
                className="auth-secondary-btn discovery-inline-btn"
                onClick={() => void toggleImageFavorite(item.imageId)}
              >
                {isFavorite ? 'Unfavorite' : 'Favorite'}
              </button>
            )}
          </div>
        </div>
      </article>
    );
  };

  const renderTrendingBlockContent = (
    smallItems: TrendingImage[],
    smallStartIndex: number,
    rows: TrendingPairRow[],
    preparedMediumBlocks?: TrendingMediumBlock[],
    options?: { preloadAll?: boolean }
  ) => {
    const preloadAll = Boolean(options?.preloadAll);
    if (feedDensity === 'small') {
      return (
        <div className="discovery-small-grid">
          {smallItems.map((item, index) => renderTrendingCard(item, smallStartIndex + index, { preload: preloadAll }))}
        </div>
      );
    }
    if (feedDensity === 'medium') {
      const mediumBlocks = preparedMediumBlocks || stableMediumBlockBuild(rows).blocks;
      return (
        <div className="discovery-pair-feed density-medium-mixed">
          {mediumBlocks.map((block, blockIndex) => (
            block.kind === 'pair' ? (
              <div
                key={`medium-pair-${block.row.left.imageId}-${block.row.right?.imageId || 'single'}`}
                className={`discovery-pair-row density-medium${block.row.right ? '' : ' single'}`}
                style={{
                  '--pair-cols-mobile': '1fr 1fr',
                  '--pair-cols': pairTemplateColumns(block.row, 'medium')
                } as any}
              >
                {renderTrendingCard(block.row.left, block.row.startIndex, { preload: preloadAll })}
                {block.row.right && renderTrendingCard(block.row.right, block.row.startIndex + 1, { preload: preloadAll })}
              </div>
            ) : (
              <div
                key={`medium-pair-inset-${block.row.left.imageId}-${block.row.right?.imageId || 'single'}-${block.insets.map((entry) => entry.item.imageId).join('-')}`}
                className="discovery-pair-row density-medium discovery-pair-row-with-inset"
                style={{
                  '--pair-cols-mobile': '1fr 1fr',
                  '--pair-cols': pairTemplateColumns(block.row, 'medium')
                } as any}
              >
                {block.insetOn === 'left' ? (
                  <>
                    <div className="discovery-pair-column-with-inset">
                      {renderTrendingCard(block.row.left, block.row.startIndex, { preload: preloadAll })}
                      {block.insets.map((entry) => renderTrendingCard(entry.item, entry.index, { forceSquareFrame: true, compactCard: true, preload: preloadAll }))}
                    </div>
                    {block.row.right && renderTrendingCard(block.row.right, block.row.startIndex + 1, { preload: preloadAll })}
                  </>
                ) : (
                  <>
                    {renderTrendingCard(block.row.left, block.row.startIndex, { preload: preloadAll })}
                    <div className="discovery-pair-column-with-inset">
                      {block.row.right && renderTrendingCard(block.row.right, block.row.startIndex + 1, { preload: preloadAll })}
                      {block.insets.map((entry) => renderTrendingCard(entry.item, entry.index, { forceSquareFrame: true, compactCard: true, preload: preloadAll }))}
                    </div>
                  </>
                )}
              </div>
            )
          ))}
        </div>
      );
    }
    return (
      <div className={`discovery-pair-feed density-${feedDensity}`}>
        {rows.map((row) => (
          <div
            key={`row-${row.left.imageId}-${row.right?.imageId || 'single'}`}
            className={`discovery-pair-row density-${feedDensity}${row.right ? '' : ' single'}`}
            style={{
              '--pair-cols-mobile': feedDensity === 'large' ? '1fr' : '1fr 1fr',
              '--pair-cols': pairTemplateColumns(row, feedDensity)
            } as any}
          >
            {renderTrendingCard(row.left, row.startIndex, { preload: preloadAll })}
            {row.right && renderTrendingCard(row.right, row.startIndex + 1, { preload: preloadAll })}
          </div>
        ))}
      </div>
    );
  };

  const renderTrendingSimpleRows = (
    rows: TrendingPairRow[],
    options?: { preloadAll?: boolean }
  ) => {
    const preloadAll = Boolean(options?.preloadAll);
    if (rows.length === 0) return null;
    return (
      <div className={`discovery-pair-feed density-${feedDensity}`}>
        {rows.map((row) => (
          <div
            key={`simple-row-${row.left.imageId}-${row.right?.imageId || 'single'}`}
            className={`discovery-pair-row density-${feedDensity}${row.right ? '' : ' single'}`}
            style={{
              '--pair-cols-mobile': feedDensity === 'large' ? '1fr' : '1fr 1fr',
              '--pair-cols': pairTemplateColumns(row, feedDensity)
            } as any}
          >
            {renderTrendingCard(row.left, row.startIndex, { preload: preloadAll })}
            {row.right && renderTrendingCard(row.right, row.startIndex + 1, { preload: preloadAll })}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="layout discovery-layout">
      <section className="panel discovery-hero">
        <div>
          <h1>Discover trending artwork</h1>
          <p>
            A hybrid discovery layout: large featured images first for enjoyment, then denser browsing for exploration.
          </p>
        </div>
        <div className="discovery-hero-actions">
          <a href="#rising-artists" className="auth-primary-btn no-underline">Browse Artists</a>
          <a href="#latest-galleries" className="auth-secondary-btn no-underline">Latest Galleries</a>
        </div>
      </section>

      <section id="trending" aria-busy={densitySwitchLoading}>
        <div className="discovery-section-header">
          <div>
            <h2>Trending</h2>
            <p className="small m-0 mt-1">
              Variable-width rows based on image aspect ratio keep landscape and portrait media visually balanced.
            </p>
          </div>
          <div className="discovery-home-controls">
            <div className="discovery-trending-filter">
              <button className={trendingPeriod === 'hourly' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setTrendingPeriod('hourly')}>Hourly</button>
              <button className={trendingPeriod === 'daily' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setTrendingPeriod('daily')}>Daily</button>
              <Link className="auth-secondary-btn no-underline" to="/trending">View all</Link>
            </div>
            <div className="inline-form">
              <label className="small">Heavy Topics</label>
              <label className="inline-form">
                <input
                  type="checkbox"
                  checked={hideHeavyTopics}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    setHideHeavyTopics(enabled);
                    if (enabled) {
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
                    const enabled = e.target.checked;
                    setHidePoliticsPublicAffairs(enabled);
                    if (!enabled) setHideHeavyTopics(false);
                  }}
                />
                <span>{heavyTopicLabels['politics-public-affairs']}</span>
              </label>
              <label className="inline-form">
                <input
                  type="checkbox"
                  checked={hideCrimeDisastersTragedy}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    setHideCrimeDisastersTragedy(enabled);
                    if (!enabled) setHideHeavyTopics(false);
                  }}
                />
                <span>{heavyTopicLabels['crime-disasters-tragedy']}</span>
              </label>
            </div>
            <div className="discovery-density-card">
              <div className="discovery-density-head">
                <span>Feed density</span>
                <strong>{densityLabel[feedDensity]}</strong>
              </div>
              {densityViewport === 'desktop' && (
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={1}
                  value={feedDensity === 'small' ? 0 : (feedDensity === 'medium' ? 1 : 2)}
                  disabled={isDensityTransitioning}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    resetTrendingViewForDensity(next <= 0 ? 'small' : next === 1 ? 'medium' : 'large');
                  }}
                />
              )}
              <div className={`discovery-density-options${densityOptions.length === 2 ? ' is-two' : ''}`}>
                {densityOptions.map((option) => (
                  <button
                    key={`density-option-${option}`}
                    type="button"
                    disabled={isDensityTransitioning}
                    className={feedDensity === option ? 'is-active' : ''}
                    onClick={() => resetTrendingViewForDensity(option)}
                  >
                    {densityLabel[option]}
                  </button>
                ))}
              </div>
              <p className="small m-0">
                Small shows more rows before editorial sections. Large emphasizes image size.
              </p>
            </div>
          </div>
          {currentUser && (
            <div className="inline-form">
              <label className="small">Favorite as</label>
              <select
                className="settings-select"
                value={favoriteIdentity}
                onChange={(e) => setFavoriteIdentity(e.target.value)}
              >
                <option value="user">User Profile</option>
                {managedArtists.map((artist) => (
                  <option key={`home-favorite-${artist.artistId}`} value={`artist:${artist.artistId}`}>
                    Artist: {artist.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {densitySwitchLoading && densityViewport !== 'mobile' && (
          <div className="discovery-density-fold-loader" role="status" aria-live="polite">
            <div className="discovery-density-fold-loader-label">Updating feed layout…</div>
            <div className="discovery-density-fold-loader-grid">
              <div />
              <div />
              <div />
            </div>
          </div>
        )}
        <div className={`discovery-density-transition${densityTransitionClass}`}>
          {renderTrendingBlockContent(smallTopItems, 0, topRows, mediumTopBuild?.blocks, { preloadAll: true })}
        </div>
        {loadingTrending && !densitySwitchLoading && (feedDensity === 'small' ? smallTopItems.length === 0 : topRows.length === 0) && <p className="small">Loading trending artwork...</p>}
        {!loadingTrending && (feedDensity === 'small' ? smallTopItems.length === 0 : topRows.length === 0) && <p className="small">No trending artwork yet.</p>}
      </section>

      <section id="latest-galleries" className="discovery-editorial-section">
        <div className="discovery-section-header">
          <h2>Latest Galleries</h2>
          <a href="#latest-galleries" className="text-sm font-semibold no-underline">Browse all</a>
        </div>

        <div className="discovery-latest-row">
          {latestItems.map((gallery, i) => (
            <article key={gallery.galleryId} className="discovery-gallery-stack-card">
              <Link to={gallery.slug ? `/gallery/${gallery.slug}` : '/'} className="no-underline">
                {(() => {
                  const layerSet = gallery.stackPreviewUrls || [];
                  const frontImage = layerSet[0] || gallery.galleryThumbnailUrl;
                  const midImage = layerSet[1] || layerSet[0] || gallery.galleryThumbnailUrl;
                  const backImage = layerSet[2] || layerSet[1] || layerSet[0] || gallery.galleryThumbnailUrl;
                  return (
                    <div className="discovery-stack discovery-stack-tall">
                      <div className="discovery-stack-layer discovery-stack-layer-back">
                        <img src={backImage} alt="" loading="lazy" fetchPriority="low" decoding="async" aria-hidden="true" />
                      </div>
                      <div className="discovery-stack-layer discovery-stack-layer-mid">
                        <img src={midImage} alt="" loading="lazy" fetchPriority="low" decoding="async" aria-hidden="true" />
                      </div>
                      <div className="discovery-stack-layer discovery-stack-layer-front">
                        <img
                          src={frontImage}
                          alt={gallery.title || 'Gallery cover'}
                          loading={i < 2 ? 'eager' : 'lazy'}
                          fetchPriority={i < 2 ? 'high' : 'low'}
                          decoding="async"
                        />
                      </div>
                    </div>
                  );
                })()}
                <div className="discovery-gallery-stack-meta">
                  <div className="discovery-card-title">{gallery.title || 'Gallery title'}</div>
                  <div className="discovery-card-subtitle">by {gallery.artistName || 'Artist Name'}</div>
                </div>
              </Link>
              {currentUser && gallery.galleryId && (
                <div className="mt-3">
                  <button
                    className="auth-secondary-btn discovery-inline-btn"
                    onClick={() => void toggleGalleryFavorite(gallery.galleryId)}
                  >
                    {favoriteGalleryIds.has(gallery.galleryId) ? 'Unfavorite gallery' : 'Favorite gallery'}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
        {loadingLatest && latestItems.length === 0 && <p className="small">Loading latest galleries...</p>}
        {!loadingLatest && latestItems.length === 0 && <p className="small">No galleries yet.</p>}
      </section>

      {continuationBlockOneHasItems && (
        <section id="trending-block-three" className="discovery-trending-flow-section">
          <div className={`discovery-density-transition${densityTransitionClass}`}>
            {renderTrendingBlockContent(
              smallContinuationBlockOne,
              smallTopItemCount,
              continuationBlockOneRows,
              undefined,
              { preloadAll: true }
            )}
          </div>
        </section>
      )}

      {continuationBlockTwoHasItems && (
        <section id="trending-block-four" className="discovery-trending-flow-section">
          <div className={`discovery-density-transition${densityTransitionClass}`}>
            {renderTrendingBlockContent(
              smallContinuationBlockTwo,
              smallTopItemCount + smallContinuationBlockOne.length,
              continuationBlockTwoRows,
              undefined,
              { preloadAll: true }
            )}
          </div>
        </section>
      )}

      {showRisingArtistsSection && (
        <section id="rising-artists" className="discovery-editorial-section">
          <div className="discovery-section-header">
            <h2>Rising Artists</h2>
            <a href="#rising-artists" className="text-sm font-semibold no-underline">View all</a>
          </div>
          <div className="discovery-artists-grid discovery-artists-grid-wide">
            {risingArtists.map((artist, i) => (
              <article key={artist.artistId || artist.name || `artist-${i}`} className="discovery-artist-card">
                <div className="discovery-artist-avatar">
                  {artist.artistThumbnailUrl
                    ? <img src={artist.artistThumbnailUrl} alt={artist.name || 'Artist'} loading="lazy" decoding="async" />
                    : <span className="discovery-artist-initials">{(artist.name || 'Artist').split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('')}</span>}
                </div>
                <div className="discovery-artist-meta">
                  <div className="discovery-card-title">
                    {artist.slug ? <Link to={`/artists/${artist.slug}`} className="no-underline">{artist.name || 'Artist Name'}</Link> : (artist.name || 'Artist Name')}
                  </div>
                  <div className="discovery-card-subtitle">1.2k followers</div>
                </div>
                <button className="auth-secondary-btn discovery-inline-btn" onClick={() => void toggleFollow(artist.artistId)}>
                  {artist.artistId && followedArtistIds.has(artist.artistId) ? 'Following' : 'Follow'}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      {showTrendingCollectionsSection && (
        <section id="trending-collections" className="discovery-editorial-section">
          <div className="discovery-section-header">
            <h2>Trending Collections</h2>
            <Link to="/collections" className="text-sm font-semibold no-underline">View all</Link>
          </div>
          <div className="discovery-collection-grid">
            {trendingCollections.map((collection, index) => (
              <Link key={collection.collectionId} to={`/collections/${collection.collectionId}`} className="discovery-collection-card no-underline">
                <div className="discovery-collection-squares">
                  {(collectionPalettes[index % collectionPalettes.length] || collectionPalettes[0]).map((color, swatchIndex) => (
                    <div key={`${collection.collectionId}-sw-${swatchIndex}`} style={{ backgroundColor: color }} />
                  ))}
                </div>
                <div className="discovery-collection-meta">
                  <div className="discovery-card-title">{collection.title}</div>
                  <div className="discovery-card-subtitle">{collection.imageCount} images • {collection.favoriteCount} favorites</div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {continuationBlockThreeHasItems && (
        <section id="trending-continuation" className="discovery-trending-flow-section">
          {feedDensity === 'small' ? (
            <div className={`discovery-density-transition${densityTransitionClass}`}>
              {renderTrendingBlockContent(
                smallContinuationBlockThree,
                smallTopItemCount + smallContinuationBlockOne.length + smallContinuationBlockTwo.length,
                continuationBlockThreeRows
              )}
            </div>
          ) : (
            <>
              {continuationFrozenChunks.map((chunkRows, chunkIndex) => (
                <div key={`continuation-frozen-${feedDensity}-${chunkIndex}`} className={`discovery-density-transition${densityTransitionClass}`}>
                  {feedDensity === 'medium'
                    ? renderTrendingBlockContent([], 0, chunkRows, stableMediumBlockBuild(chunkRows).blocks)
                    : renderTrendingSimpleRows(chunkRows)}
                </div>
              ))}
              {continuationTailRows.length > 0 && (
                <div className={`discovery-density-transition${densityTransitionClass}`}>
                  {renderTrendingSimpleRows(continuationTailRows)}
                </div>
              )}
            </>
          )}
          <AutoLoadSentinel
            enabled={Boolean(trendingCursor)}
            loading={loadingMoreTrending}
            rootMargin="1200px 0px"
            onLoadMore={() => loadMoreTrending()}
          />
        </section>
      )}

      {error && (
        <section className="panel">
          <p className="error">Discovery data error: {error}</p>
        </section>
      )}
    </div>
  );
}
function GalleryPage() {
  const { slug = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentUser = getCurrentUser();
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const [managedArtists, setManagedArtists] = useState<ManagedArtist[]>([]);
  const [favoriteIdentity, setFavoriteIdentity] = useState<string>('user');
  const [favoriteGallerySelected, setFavoriteGallerySelected] = useState(false);
  const [favoriteImageIds, setFavoriteImageIds] = useState<Set<string>>(new Set());
  const [profileCollections, setProfileCollections] = useState<ManagedCollection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>('');
  const [commentIdentity, setCommentIdentity] = useState<string>('user');
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const [password, setPassword] = useState('');
  const [unlockToken, setUnlockToken] = useState<string>('');
  const [rememberToken, setRememberToken] = useState<string>(() => getStoredGalleryAccessToken(slug) || '');
  const [hasPremiumAccess, setHasPremiumAccess] = useState(false);
  const [teaserLimit, setTeaserLimit] = useState(9);
  const [premiumImages, setPremiumImages] = useState<Array<{
    imageId: string;
    assetType: 'image' | 'video';
    effectiveContentRating?: ContentRating;
    displayedContentRating?: string;
    blurred?: boolean;
    effectiveAiDisclosure?: AiDisclosure;
    displayedAiDisclosure?: string;
    effectiveHeavyTopics?: HeavyTopic[];
    displayedHeavyTopics?: string[];
    premiumUrl: string;
    premiumPosterUrl?: string;
  }>>([]);
  const [error, setError] = useState<string>('');

  const load = async () => {
    try {
      const stored = getStoredGalleryAccessToken(slug);
      if (stored && stored !== rememberToken) {
        setRememberToken(stored);
      }
      const [galleryData, commentData] = await Promise.all([api.getGallery(slug, stored || rememberToken), api.getGalleryComments(slug)]);
      setGallery(galleryData);
      setComments(commentData);
      const serverAccess = galleryData.visibility !== 'premium' ? Boolean(galleryData.hasAccess ?? true) : Boolean(galleryData.hasAccess);
      setHasPremiumAccess(serverAccess);
      if (galleryData.visibility === 'premium' && serverAccess) {
        try {
          if (stored || rememberToken) {
            const premium = await api.getPremiumImagesWithRemember(slug, stored || rememberToken);
            setPremiumImages(premium);
          } else {
            const premium = await api.getPremiumImages(slug, unlockToken);
            setPremiumImages(premium);
          }
        } catch {
          setPremiumImages([]);
          setHasPremiumAccess(false);
        }
      } else {
        setPremiumImages([]);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    setUnlockToken('');
    setPremiumImages([]);
    setHasPremiumAccess(false);
    setRememberToken(getStoredGalleryAccessToken(slug) || '');
  }, [slug]);

  useEffect(() => {
    const applyLimit = () => {
      const width = window.innerWidth;
      if (width >= 1280) setTeaserLimit(9);
      else if (width >= 768) setTeaserLimit(6);
      else setTeaserLimit(3);
    };
    applyLimit();
    window.addEventListener('resize', applyLimit);
    return () => window.removeEventListener('resize', applyLimit);
  }, []);

  useEffect(() => {
    void load();
  }, [slug, rememberToken]);

  useEffect(() => {
    if (!currentUser) {
      setManagedArtists([]);
      setCommentIdentity('user');
      setFavoriteIdentity('user');
      setFavoriteGallerySelected(false);
      setFavoriteImageIds(new Set());
      setProfileCollections([]);
      return;
    }
    const loadArtists = async () => {
      try {
        const myArtists = await api.getMyArtists() as ManagedArtist[];
        setManagedArtists(myArtists);
      } catch {
        setManagedArtists([]);
      }
    };
    void loadArtists();
  }, [currentUser?.username]);

  const favoriteAsProfile = favoriteIdentity.startsWith('artist:')
    ? { ownerProfileType: 'artist' as const, ownerProfileId: favoriteIdentity.slice('artist:'.length) }
    : { ownerProfileType: 'user' as const };

  useEffect(() => {
    const loadFavoritesAndCollections = async () => {
      if (!currentUser || !gallery) return;
      try {
        const [favorites, collections] = await Promise.all([
          api.myFavorites(favoriteAsProfile) as Promise<ManagedFavorite[]>,
          api.myCollections(favoriteAsProfile) as Promise<ManagedCollection[]>
        ]);
        setFavoriteGallerySelected((favorites || []).some((item) => item.targetType === 'gallery' && item.targetId === gallery.galleryId));
        setFavoriteImageIds(new Set((favorites || []).filter((item) => item.targetType === 'image').map((item) => item.targetId)));
        setProfileCollections(collections || []);
      } catch {
        setFavoriteGallerySelected(false);
        setFavoriteImageIds(new Set());
        setProfileCollections([]);
      }
    };
    void loadFavoritesAndCollections();
  }, [currentUser?.username, favoriteIdentity, gallery?.galleryId]);

  const submitComment = async () => {
    try {
      if (commentIdentity.startsWith('artist:')) {
        await api.postGalleryCommentAsProfile(slug, commentBody, {
          authorProfileType: 'artist',
          authorProfileId: commentIdentity.slice('artist:'.length)
        });
      } else {
        await api.postGalleryCommentAsProfile(slug, commentBody, { authorProfileType: 'user' });
      }
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
      if (response.rememberToken) {
        setRememberToken(response.rememberToken);
        setStoredGalleryAccessToken(slug, response.rememberToken, response.rememberExpiresInSeconds || 60 * 60 * 24 * 30);
      }
      const premium = await api.getPremiumImages(slug, response.unlockToken);
      setPremiumImages(premium);
      setHasPremiumAccess(true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const favoriteGallery = async () => {
    if (!gallery) return;
    const wasFavorited = favoriteGallerySelected;
    setFavoriteGallerySelected(!wasFavorited);
    setGallery((prev) => prev ? { ...prev, favoriteCount: Math.max(0, prev.favoriteCount + (wasFavorited ? -1 : 1)) } : prev);
    try {
      if (wasFavorited) await api.unfavorite('gallery', gallery.galleryId, favoriteAsProfile);
      else await api.favorite('gallery', gallery.galleryId, 'public', favoriteAsProfile);
    } catch (e) {
      setFavoriteGallerySelected(wasFavorited);
      setGallery((prev) => prev ? { ...prev, favoriteCount: Math.max(0, prev.favoriteCount + (wasFavorited ? 1 : -1)) } : prev);
      setError((e as Error).message);
    }
  };

  const toggleImageFavorite = async (imageId: string) => {
    const wasFavorited = favoriteImageIds.has(imageId);
    setFavoriteImageIds((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(imageId);
      else next.add(imageId);
      return next;
    });
    setGallery((prev) => prev ? ({
      ...prev,
      media: prev.media.map((item) => item.imageId === imageId ? { ...item, favoriteCount: Math.max(0, item.favoriteCount + (wasFavorited ? -1 : 1)) } : item)
    }) : prev);
    try {
      if (wasFavorited) await api.unfavorite('image', imageId, favoriteAsProfile);
      else await api.favorite('image', imageId, 'public', favoriteAsProfile);
    } catch (e) {
      setFavoriteImageIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(imageId);
        else next.delete(imageId);
        return next;
      });
      setGallery((prev) => prev ? ({
        ...prev,
        media: prev.media.map((item) => item.imageId === imageId ? { ...item, favoriteCount: Math.max(0, item.favoriteCount + (wasFavorited ? 1 : -1)) } : item)
      }) : prev);
      setError((e as Error).message);
    }
  };

  const addImageToCollection = async (imageId: string) => {
    try {
      if (!selectedCollectionId) throw new Error('Select a collection first');
      await api.addImageToCollection(selectedCollectionId, imageId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!gallery) return <div className="layout">Loading...</div>;

  const setFocusedImage = (imageId?: string) => {
    const next = new URLSearchParams(searchParams);
    if (imageId) next.set('image', imageId);
    else next.delete('image');
    setSearchParams(next, { replace: true });
  };
  const focusedImageId = searchParams.get('image') || '';
  const mediaItems = gallery.media || [];
  const focusedIndex = focusedImageId ? mediaItems.findIndex((item) => item.imageId === focusedImageId) : -1;
  const resolvedFocusedIndex = focusedIndex >= 0 ? focusedIndex : (mediaItems.length ? 0 : -1);
  const focusedMedia = resolvedFocusedIndex >= 0 ? mediaItems[resolvedFocusedIndex] : null;
  const previousMedia = resolvedFocusedIndex > 0 ? mediaItems[resolvedFocusedIndex - 1] : null;
  const nextMedia = resolvedFocusedIndex >= 0 && resolvedFocusedIndex < mediaItems.length - 1 ? mediaItems[resolvedFocusedIndex + 1] : null;

  return (
    <div className="layout">
      <Link to="/">Back</Link>
      <h1>{gallery.title}</h1>
      {currentUser && (
        <div className="inline-form">
          <label className="small">Favorite as</label>
          <select
            className="settings-select"
            value={favoriteIdentity}
            onChange={(e) => setFavoriteIdentity(e.target.value)}
          >
            <option value="user">User Profile</option>
                {managedArtists.map((artist) => (
                  <option key={`favorite-${artist.artistId}`} value={`artist:${artist.artistId}`}>
                    Artist: {artist.name}
                  </option>
                ))}
              </select>
              <label className="small">Add to collection</label>
              <select
                className="settings-select"
                value={selectedCollectionId}
                onChange={(e) => setSelectedCollectionId(e.target.value)}
              >
                <option value="">Select collection</option>
                {profileCollections.map((item) => (
                  <option key={`gallery-collection-${item.collectionId}`} value={item.collectionId}>
                    {item.title}
                  </option>
                ))}
              </select>
        </div>
      )}
      {gallery.coverPreviewUrl && (
        <img
          src={gallery.coverPreviewUrl}
          alt={`${gallery.title} cover`}
          className={gallery.coverBlur ? 'blur-md' : ''}
          style={{ maxHeight: '320px', width: '100%', objectFit: 'cover', borderRadius: '0.75rem' }}
        />
      )}
      <button onClick={favoriteGallery}>
        {favoriteGallerySelected ? 'Unfavorite Gallery' : 'Favorite Gallery'} ({gallery.favoriteCount})
      </button>
      {focusedMedia && (
        <section className="panel">
          <div className="discovery-section-header">
            <h2>Focused View</h2>
            <div className="inline-form">
              <button disabled={!previousMedia} onClick={() => setFocusedImage(previousMedia?.imageId)}>Previous</button>
              <button disabled={!nextMedia} onClick={() => setFocusedImage(nextMedia?.imageId)}>Next</button>
            </div>
          </div>
          {focusedMedia.assetType === 'video'
            ? <video controls poster={focusedMedia.previewPosterUrl} style={{ width: '100%', maxHeight: '70vh', borderRadius: '0.75rem', background: '#000', filter: focusedMedia.blurred ? 'blur(28px)' : undefined }}><source src={focusedMedia.previewUrl} /></video>
            : (
              <img
                src={focusedMedia.thumbnailUrls?.w1280 || focusedMedia.thumbnailUrls?.w640 || focusedMedia.previewUrl}
                srcSet={[
                  focusedMedia.thumbnailUrls?.w320 ? `${focusedMedia.thumbnailUrls.w320} 320w` : '',
                  focusedMedia.thumbnailUrls?.w640 ? `${focusedMedia.thumbnailUrls.w640} 640w` : '',
                  focusedMedia.thumbnailUrls?.w1280 ? `${focusedMedia.thumbnailUrls.w1280} 1280w` : '',
                  focusedMedia.thumbnailUrls?.w1920 ? `${focusedMedia.thumbnailUrls.w1920} 1920w` : ''
                ].filter(Boolean).join(', ')}
                sizes="100vw"
                alt={focusedMedia.imageId}
                style={{
                  width: '100%',
                  maxHeight: '70vh',
                  objectFit: 'contain',
                  borderRadius: '0.75rem',
                  background: '#111827',
                  filter: focusedMedia.blurred ? 'blur(28px)' : undefined
                }}
              />
            )}
          {focusedMedia.blurred && <p className="small">Mature Content</p>}
          {!focusedMedia.blurred && focusedMedia.displayedContentRating && <p className="small">{focusedMedia.displayedContentRating}</p>}
          {formatDisclosureLine(focusedMedia) && <p className="small">{formatDisclosureLine(focusedMedia)}</p>}
          <p className="small">Item {resolvedFocusedIndex + 1} of {mediaItems.length}</p>
        </section>
      )}
      <h2>Preview Media</h2>
      <div className="grid three">
        {gallery.media.map((image) => (
          <article key={image.imageId} className="image-card">
            {image.assetType === 'video'
              ? <video controls poster={image.previewPosterUrl} style={{ filter: image.blurred ? 'blur(24px)' : undefined }}><source src={image.previewUrl} /></video>
              : (
                <img
                  src={image.thumbnailUrls?.w640 || image.thumbnailUrls?.w320 || image.previewUrl}
                  srcSet={[
                    image.thumbnailUrls?.w320 ? `${image.thumbnailUrls.w320} 320w` : '',
                    image.thumbnailUrls?.w640 ? `${image.thumbnailUrls.w640} 640w` : '',
                    image.thumbnailUrls?.w1280 ? `${image.thumbnailUrls.w1280} 1280w` : ''
                  ].filter(Boolean).join(', ')}
                  sizes="(max-width: 768px) 100vw, 33vw"
                  alt="Preview"
                  loading="lazy"
                  style={{ filter: image.blurred ? 'blur(24px)' : undefined }}
                />
              )}
            <button onClick={() => setFocusedImage(image.imageId)}>
              {focusedImageId === image.imageId ? 'Viewing' : 'View Focus'}
            </button>
            <small>{image.displayedContentRating || 'General'}</small>
            {formatDisclosureLine(image) && <small>{formatDisclosureLine(image)}</small>}
            <small>Likes: {image.favoriteCount}</small>
            <div className="inline-form">
              <button onClick={() => void toggleImageFavorite(image.imageId)}>
                {favoriteImageIds.has(image.imageId) ? 'Unfavorite Image' : 'Favorite Image'}
              </button>
              {selectedCollectionId && (
                <button onClick={() => void addImageToCollection(image.imageId)}>Add to Collection</button>
              )}
            </div>
          </article>
        ))}
      </div>

      {gallery.visibility === 'preview' && !gallery.hasAccess && (
        <section>
          <h2>Premium Preview</h2>
          <div className="premium-preview-cta">
            <a href={gallery.purchaseUrl || '#'} target="_blank" rel="noreferrer" className="inline-block rounded-xl bg-black/80 px-8 py-4 text-white no-underline">
              Purchase Premium Access
            </a>
          </div>
          <div className="relative">
            <div className="grid three">
              {(gallery.premiumTeaserMedia || []).slice(0, teaserLimit).map((item) => (
                item.assetType === 'video'
                  ? <video key={item.imageId} controls={false} poster={item.previewPosterUrl} style={{ filter: item.blurred ? 'blur(24px)' : undefined }}><source src={item.previewUrl} /></video>
                  : <img key={item.imageId} src={item.previewUrl} alt="Premium teaser" style={{ filter: item.blurred ? 'blur(24px)' : undefined }} />
              ))}
            </div>
          </div>
        </section>
      )}

      {gallery.visibility === 'premium' && (
        <section>
          <h2>Premium Content</h2>
          {!hasPremiumAccess && (
            <div className="inline-form">
              <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter gallery password" />
              <button onClick={unlock}>Unlock</button>
            </div>
          )}
          <div className="grid three">
            {premiumImages.map((image) => (
              image.assetType === 'video'
                ? <video key={image.imageId} controls poster={image.premiumPosterUrl} style={{ filter: image.blurred ? 'blur(24px)' : undefined }}><source src={image.premiumUrl} /></video>
                : <img key={image.imageId} src={image.premiumUrl} alt="Premium" style={{ filter: image.blurred ? 'blur(24px)' : undefined }} />
            ))}
          </div>
          {premiumImages.some((item) => item.blurred) && <p className="small">Some items are blurred due to content rating settings.</p>}
        </section>
      )}

      <section>
        <h2>Comments</h2>
        <div className="inline-form">
          {currentUser && (
            <select
              className="settings-select"
              value={commentIdentity}
              onChange={(e) => setCommentIdentity(e.target.value)}
            >
              <option value="user">Comment as User</option>
              {managedArtists.map((artist) => (
                <option key={artist.artistId} value={`artist:${artist.artistId}`}>
                  Comment as {artist.name}
                </option>
              ))}
            </select>
          )}
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

function CollectionsPage() {
  const [items, setItems] = useState<CollectionSummary[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [order, setOrder] = useState<'random' | 'latest' | 'popular'>('random');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dailySeed = new Date().toISOString().slice(0, 10);

  const loadMore = async (reset = false) => {
    try {
      setLoading(true);
      setError('');
      const response = await api.getCollections(reset ? undefined : cursor, 24, { order, seed: dailySeed }) as { items: CollectionSummary[]; nextCursor?: string };
      setItems((prev) => reset ? (response.items || []) : [...prev, ...(response.items || [])]);
      setCursor(response.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMore(true);
  }, [order, dailySeed]);

  return (
    <div className="layout">
      <div className="discovery-section-header">
        <h1>All Collections</h1>
        <div className="discovery-trending-filter">
          <button className={order === 'random' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setOrder('random')}>Random</button>
          <button className={order === 'popular' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setOrder('popular')}>Popular</button>
          <button className={order === 'latest' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setOrder('latest')}>Latest</button>
        </div>
      </div>
      <div className="discovery-latest-grid">
        {items.map((item) => (
          <Link key={item.collectionId} to={`/collections/${item.collectionId}`} className="discovery-latest-item no-underline">
            <div className="discovery-stack">
              <div className="discovery-stack-layer discovery-stack-layer-back"><div className="discovery-swatch" /></div>
              <div className="discovery-stack-layer discovery-stack-layer-mid"><div className="discovery-swatch" /></div>
              <div className="discovery-stack-layer discovery-stack-layer-front"><div className="discovery-swatch" /></div>
            </div>
            <div className="discovery-latest-meta">
              <div className="discovery-card-title">{item.title}</div>
              <div className="discovery-card-subtitle">{item.imageCount} images • {item.favoriteCount} favorites</div>
            </div>
          </Link>
        ))}
      </div>
      <AutoLoadSentinel enabled={Boolean(cursor)} loading={loading} onLoadMore={() => loadMore(false)} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function CollectionDetailPage() {
  const { collectionId = '' } = useParams();
  const currentUser = getCurrentUser();
  const [managedArtists, setManagedArtists] = useState<ManagedArtist[]>([]);
  const [favoriteIdentity, setFavoriteIdentity] = useState<string>('user');
  const [isFavorited, setIsFavorited] = useState(false);
  const [collection, setCollection] = useState<(CollectionSummary & { imageIds?: string[] }) | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        setError('');
        const result = await api.getCollection(collectionId) as CollectionSummary & { imageIds?: string[] };
        setCollection(result);
      } catch (e) {
        setError((e as Error).message);
      }
    };
    void load();
  }, [collectionId]);

  useEffect(() => {
    if (!currentUser) {
      setManagedArtists([]);
      setFavoriteIdentity('user');
      return;
    }
    const loadArtists = async () => {
      try {
        const artists = await api.getMyArtists() as ManagedArtist[];
        setManagedArtists(artists);
      } catch {
        setManagedArtists([]);
      }
    };
    void loadArtists();
  }, [currentUser?.username]);

  const favoriteAsProfile = favoriteIdentity.startsWith('artist:')
    ? { ownerProfileType: 'artist' as const, ownerProfileId: favoriteIdentity.slice('artist:'.length) }
    : { ownerProfileType: 'user' as const };

  useEffect(() => {
    const loadFavoriteState = async () => {
      if (!currentUser || !collection) {
        setIsFavorited(false);
        return;
      }
      try {
        const favorites = await api.myFavorites(favoriteAsProfile) as ManagedFavorite[];
        setIsFavorited((favorites || []).some((item) => item.targetType === 'collection' && item.targetId === collection.collectionId));
      } catch {
        setIsFavorited(false);
      }
    };
    void loadFavoriteState();
  }, [currentUser?.username, favoriteIdentity, collection?.collectionId]);

  const toggleCollectionFavorite = async () => {
    if (!collection) return;
    const wasFavorited = isFavorited;
    setIsFavorited(!wasFavorited);
    setCollection((prev) => prev ? { ...prev, favoriteCount: Math.max(0, prev.favoriteCount + (wasFavorited ? -1 : 1)) } : prev);
    try {
      if (wasFavorited) await api.unfavorite('collection', collection.collectionId, favoriteAsProfile);
      else await api.favorite('collection', collection.collectionId, 'public', favoriteAsProfile);
    } catch (e) {
      setIsFavorited(wasFavorited);
      setCollection((prev) => prev ? { ...prev, favoriteCount: Math.max(0, prev.favoriteCount + (wasFavorited ? 1 : -1)) } : prev);
      setError((e as Error).message);
    }
  };

  if (!collection) return <div className="layout">Loading...</div>;

  return (
    <div className="layout">
      <Link to="/collections">Back to collections</Link>
      <h1>{collection.title}</h1>
      <p>{collection.description || 'No description yet.'}</p>
      <p className="small">{collection.imageCount} images • {collection.favoriteCount} favorites</p>
      {currentUser && (
        <div className="inline-form">
          <label className="small">Favorite as</label>
          <select
            className="settings-select"
            value={favoriteIdentity}
            onChange={(e) => setFavoriteIdentity(e.target.value)}
          >
            <option value="user">User Profile</option>
            {managedArtists.map((artist) => (
              <option key={`favorite-${artist.artistId}`} value={`artist:${artist.artistId}`}>
                Artist: {artist.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <button
        onClick={() => void toggleCollectionFavorite()}
      >
        {isFavorited ? 'Unfavorite Collection' : 'Favorite Collection'}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function TrendingPage({ viewerProfile }: { viewerProfile?: UserProfile | null }) {
  const currentUser = getCurrentUser();
  const [managedArtists, setManagedArtists] = useState<ManagedArtist[]>([]);
  const [favoriteIdentity, setFavoriteIdentity] = useState<string>('user');
  const [favoriteImageIds, setFavoriteImageIds] = useState<Set<string>>(new Set());
  const [period, setPeriod] = useState<'hourly' | 'daily'>('daily');
  const [items, setItems] = useState<TrendingImage[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [aiFilter, setAiFilter] = useState<AiFilterPreference>(viewerProfile?.aiFilter || 'show-all');
  const [hideHeavyTopics, setHideHeavyTopics] = useState<boolean>(Boolean(viewerProfile?.hideHeavyTopics));
  const [hidePoliticsPublicAffairs, setHidePoliticsPublicAffairs] = useState<boolean>(Boolean(viewerProfile?.hidePoliticsPublicAffairs));
  const [hideCrimeDisastersTragedy, setHideCrimeDisastersTragedy] = useState<boolean>(Boolean(viewerProfile?.hideCrimeDisastersTragedy));
  const swatches = ['#fda4af', '#7dd3fc', '#6ee7b7', '#a5b4fc', '#fcd34d', '#e9a8f4', '#5eead4', '#fdba74'];
  const masonryHeights = [220, 260, 300, 340, 380];
  const disclosureFilters = {
    aiFilter,
    hideHeavyTopics,
    hidePoliticsPublicAffairs: hideHeavyTopics ? true : hidePoliticsPublicAffairs,
    hideCrimeDisastersTragedy: hideHeavyTopics ? true : hideCrimeDisastersTragedy
  };

  useEffect(() => {
    setAiFilter(viewerProfile?.aiFilter || 'show-all');
    setHideHeavyTopics(Boolean(viewerProfile?.hideHeavyTopics));
    setHidePoliticsPublicAffairs(Boolean(viewerProfile?.hidePoliticsPublicAffairs));
    setHideCrimeDisastersTragedy(Boolean(viewerProfile?.hideCrimeDisastersTragedy));
  }, [
    viewerProfile?.aiFilter,
    viewerProfile?.hideHeavyTopics,
    viewerProfile?.hidePoliticsPublicAffairs,
    viewerProfile?.hideCrimeDisastersTragedy
  ]);

  const loadTrending = async (append = false) => {
    try {
      setLoading(true);
      setError('');
      const response = await api.getTrendingImagesFiltered(
        period,
        append ? cursor : undefined,
        36,
        disclosureFilters
      ) as { items: TrendingImage[]; nextCursor?: string };
      setItems((prev) => append ? [...prev, ...(response.items || [])] : (response.items || []));
      setCursor(response.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTrending(false);
  }, [period, disclosureFilters.aiFilter, disclosureFilters.hideHeavyTopics, disclosureFilters.hidePoliticsPublicAffairs, disclosureFilters.hideCrimeDisastersTragedy]);

  useEffect(() => {
    const loadArtists = async () => {
      if (!currentUser) {
        setManagedArtists([]);
        return;
      }
      try {
        const myArtists = await api.getMyArtists() as ManagedArtist[];
        setManagedArtists(myArtists || []);
      } catch {
        setManagedArtists([]);
      }
    };
    void loadArtists();
  }, [currentUser?.username]);

  const favoriteAsProfile = favoriteIdentity.startsWith('artist:')
    ? { ownerProfileType: 'artist' as const, ownerProfileId: favoriteIdentity.slice('artist:'.length) }
    : { ownerProfileType: 'user' as const };

  useEffect(() => {
    const loadFavorites = async () => {
      if (!currentUser) {
        setFavoriteImageIds(new Set());
        return;
      }
      try {
        const favorites = await api.myFavorites(favoriteAsProfile) as ManagedFavorite[];
        setFavoriteImageIds(new Set(favorites.filter((item) => item.targetType === 'image').map((item) => item.targetId)));
      } catch {
        setFavoriteImageIds(new Set());
      }
    };
    void loadFavorites();
  }, [currentUser?.username, favoriteIdentity]);

  const toggleImageFavorite = async (imageId: string) => {
    const wasFavorited = favoriteImageIds.has(imageId);
    setFavoriteImageIds((prev) => {
      const next = new Set(prev);
      if (wasFavorited) next.delete(imageId);
      else next.add(imageId);
      return next;
    });
    setItems((prev) => prev.map((item) => (
      item.imageId === imageId
        ? { ...item, favoriteCount: Math.max(0, (item.favoriteCount || 0) + (wasFavorited ? -1 : 1)) }
        : item
    )));
    try {
      if (wasFavorited) {
        await api.unfavorite('image', imageId, favoriteAsProfile);
      } else {
        await api.favorite('image', imageId, 'public', favoriteAsProfile);
      }
    } catch {
      setFavoriteImageIds((prev) => {
        const next = new Set(prev);
        if (wasFavorited) next.add(imageId);
        else next.delete(imageId);
        return next;
      });
      setItems((prev) => prev.map((item) => (
        item.imageId === imageId
          ? { ...item, favoriteCount: Math.max(0, (item.favoriteCount || 0) + (wasFavorited ? 1 : -1)) }
          : item
      )));
    }
  };

  return (
    <div className="layout discovery-layout">
      <section className="discovery-section-header">
        <h1>Trending Images</h1>
        <div className="discovery-trending-filter">
          <button className={period === 'hourly' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setPeriod('hourly')}>Hourly</button>
          <button className={period === 'daily' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setPeriod('daily')}>Daily</button>
        </div>
        {currentUser && (
          <div className="inline-form">
            <label className="small">Favorite as</label>
            <select
              className="settings-select"
              value={favoriteIdentity}
              onChange={(e) => setFavoriteIdentity(e.target.value)}
            >
              <option value="user">User Profile</option>
              {managedArtists.map((artist) => (
                <option key={`trending-favorite-${artist.artistId}`} value={`artist:${artist.artistId}`}>
                  Artist: {artist.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>
      <div className="discovery-masonry">
        {items.map((item, i) => (
          <article key={item.imageId} className="discovery-card">
            <Link to={item.gallerySlug ? `/gallery/${item.gallerySlug}?image=${encodeURIComponent(item.imageId)}` : '/'} className="no-underline">
              <div className="discovery-card-media" style={{ height: masonryHeights[i % masonryHeights.length] }}>
                {item.previewUrl
                  ? <img src={item.previewUrl} alt={item.title || 'Artwork preview'} loading="lazy" style={{ filter: item.blurred ? 'blur(24px)' : undefined }} />
                  : <div className="discovery-swatch" style={{ backgroundColor: swatches[i % swatches.length] }} />}
                {item.galleryVisibility !== 'free' && <span className="discovery-chip">Preview</span>}
                {item.blurred && <span className="discovery-chip" style={{ left: 'unset', right: '0.75rem' }}>Mature Content</span>}
              </div>
              <div className="discovery-card-body">
                <div className="discovery-card-title">{item.title || 'Artwork title'}</div>
                <div className="discovery-card-subtitle">by {item.artistName}</div>
                {formatDisclosureLine(item) && <div className="discovery-card-subtitle">{formatDisclosureLine(item)}</div>}
                <div className="discovery-card-stats">
                  <span>❤ {item.favoriteCount || 0}</span>
                  <span>👁 {(2.1 + (i % 7) * 0.2).toFixed(1)}k</span>
                  <span>{item.displayedContentRating || 'General'}</span>
                </div>
              </div>
            </Link>
            {currentUser && (
              <div className="p-3 pt-0">
                <button
                  className="auth-secondary-btn"
                  onClick={() => void toggleImageFavorite(item.imageId)}
                >
                  {favoriteImageIds.has(item.imageId) ? 'Unfavorite image' : 'Favorite image'}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      <AutoLoadSentinel enabled={Boolean(cursor)} loading={loading} onLoadMore={() => loadTrending(true)} />
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function ArtistProfilePage() {
  const { slug = '' } = useParams();
  const [profile, setProfile] = useState<ArtistProfilePayload | null>(null);
  const [period, setPeriod] = useState<'hourly' | 'daily'>('daily');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [trending, setTrending] = useState<TrendingImage[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const swatches = ['#fda4af', '#7dd3fc', '#6ee7b7', '#a5b4fc', '#fcd34d', '#e9a8f4', '#5eead4', '#fdba74'];

  const loadProfile = async () => {
    try {
      setLoading(true);
      setError('');
      const response = await api.getArtistProfile(slug) as ArtistProfilePayload;
      setProfile(response);
      setTrending(response.trendingImages || []);
      setCursor(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const loadTrending = async (append = false) => {
    try {
      setTrendingLoading(true);
      setError('');
      const response = await api.getArtistTrendingImages(slug, period, append ? cursor : undefined, 18) as { items: TrendingImage[]; nextCursor?: string };
      setTrending((prev) => append ? [...prev, ...(response.items || [])] : (response.items || []));
      setCursor(response.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTrendingLoading(false);
    }
  };

  useEffect(() => {
    void loadProfile();
  }, [slug]);

  useEffect(() => {
    if (!profile) return;
    void loadTrending(false);
  }, [period, slug, profile?.artistId]);

  if (loading && !profile) return <div className="layout">Loading...</div>;
  if (!profile) return <div className="layout">{error || 'Artist not found'}</div>;

  return (
    <div className="layout discovery-layout">
      <section className="panel discovery-hero">
        <div>
          <h1>{profile.name}</h1>
          <p>{profile.followerCount} followers • {profile.galleryCount} galleries • {profile.imageCount} images</p>
        </div>
        <div className="discovery-hero-actions">
          <button className="auth-primary-btn">Follow artist</button>
          <Link className="auth-secondary-btn no-underline" to="/">Back to discovery</Link>
        </div>
      </section>

      <section>
        <div className="discovery-section-header">
          <h2>Trending from {profile.name}</h2>
          <div className="discovery-trending-filter">
            <button className={period === 'hourly' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setPeriod('hourly')}>Hourly</button>
            <button className={period === 'daily' ? 'auth-primary-btn' : 'auth-secondary-btn'} onClick={() => setPeriod('daily')}>Daily</button>
          </div>
        </div>
        <div className="discovery-three-rows-grid">
          {(trending || []).slice(0, 18).map((item, i) => (
            <Link key={item.imageId} to={item.gallerySlug ? `/gallery/${item.gallerySlug}?image=${encodeURIComponent(item.imageId)}` : '/'} className="discovery-small-card no-underline">
              {item.previewUrl
                ? <img src={item.previewUrl} alt={item.title || 'Artwork preview'} loading="lazy" style={{ filter: item.blurred ? 'blur(24px)' : undefined }} />
                : <div className="discovery-swatch" style={{ backgroundColor: swatches[i % swatches.length], height: 160 }} />}
              <div className="discovery-small-card-body">
                <div className="discovery-card-title">{item.title || 'Artwork title'}</div>
                <div className="discovery-card-subtitle">{item.displayedContentRating || 'General'}</div>
                {formatDisclosureLine(item) && <div className="discovery-card-subtitle">{formatDisclosureLine(item)}</div>}
              </div>
            </Link>
          ))}
        </div>
        <AutoLoadSentinel enabled={Boolean(cursor)} loading={trendingLoading} onLoadMore={() => loadTrending(true)} />
      </section>

      <section>
        <div className="discovery-section-header">
          <h2>Latest Galleries</h2>
        </div>
        <div className="discovery-scroll-row">
          {(profile.galleries || []).map((gallery, i) => (
            <Link key={gallery.galleryId} to={`/gallery/${gallery.slug}`} className="discovery-row-card no-underline">
              {gallery.galleryThumbnailUrl
                ? <img src={gallery.galleryThumbnailUrl} alt={gallery.title} loading="lazy" />
                : <div className="discovery-swatch" style={{ backgroundColor: swatches[i % swatches.length], height: 160 }} />}
              <div className="discovery-small-card-body">
                <div className="discovery-card-title">{gallery.title}</div>
                <div className="discovery-card-subtitle">{gallery.imageCount} images • ❤ {gallery.favoriteCount}</div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <div className="discovery-section-header">
          <h2>Public Favorites</h2>
        </div>
        <div className="panel artist-public-grid">
          <article>
            <h3>Images</h3>
            <ul>
              {profile.publicFavoritesByType.images.length
                ? profile.publicFavoritesByType.images.slice(0, 6).map((item) => (
                  <li key={`fav-img-${item.targetId}`}>
                    {item.previewUrl && <img src={item.previewUrl} alt={item.title || item.targetId} className="artist-favorite-thumb" />}
                    <span>{item.title || item.targetId}</span>
                  </li>
                ))
                : <li className="small">No public image favorites yet.</li>}
            </ul>
          </article>
          <article>
            <h3>Galleries</h3>
            <ul>
              {profile.publicFavoritesByType.galleries.length
                ? profile.publicFavoritesByType.galleries.slice(0, 6).map((item) => (
                  <li key={`fav-gal-${item.targetId}`}>
                    {item.galleryThumbnailUrl && <img src={item.galleryThumbnailUrl} alt={item.title || item.targetId} className="artist-favorite-thumb" />}
                    {item.slug
                      ? <Link to={`/gallery/${item.slug}`} className="no-underline">{item.title || item.targetId}</Link>
                      : <span>{item.title || item.targetId}</span>}
                  </li>
                ))
                : <li className="small">No public gallery favorites yet.</li>}
            </ul>
          </article>
          <article>
            <h3>Collections</h3>
            <ul>
              {profile.publicFavoritesByType.collections.length
                ? profile.publicFavoritesByType.collections.slice(0, 6).map((item) => <li key={`fav-col-${item.targetId}`}>{item.title || item.targetId}</li>)
                : <li className="small">No public collection favorites yet.</li>}
            </ul>
          </article>
        </div>
      </section>

      <section>
        <div className="discovery-section-header">
          <h2>Public Collections</h2>
        </div>
        <div className="discovery-latest-grid">
          {profile.publicCollections.length ? profile.publicCollections.map((collection) => (
            <article key={collection.collectionId} className="discovery-latest-item">
              <div className="panel">
                <div className="discovery-card-title">{collection.title}</div>
                <div className="discovery-card-subtitle">{collection.imageCount} images • ❤ {collection.favoriteCount}</div>
                {collection.description && <p className="small">{collection.description}</p>}
              </div>
            </article>
          )) : (
            <div className="panel"><p className="small">No public collections yet.</p></div>
          )}
        </div>
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<CurrentUser>(() => getCurrentUser());
  const [myProfile, setMyProfile] = useState<UserProfile | null>(null);
  const [settings, setSettings] = useState<SiteSettings>({ siteName: 'Ubeeq', theme: 'ubeeq' });

  const handleSignOut = async () => {
    await signOut();
    setUser(null);
    setMyProfile(null);
  };

  useEffect(() => {
    api.getSiteSettings().then((data) => setSettings(data)).catch(console.error);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!user) return;
    api.getMyProfile()
      .then((profile) => {
        if (!cancelled) setMyProfile(profile as UserProfile);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user?.username]);

  return (
    <div className="app-shell" data-theme={settings.theme || 'ubeeq'}>
      <HeaderAuth user={user} onSignOut={handleSignOut} settings={settings} profile={myProfile} />
      <Routes>
        <Route path="/" element={<HomePage viewerProfile={myProfile} />} />
        <Route path="/trending" element={<TrendingPage viewerProfile={myProfile} />} />
        <Route path="/artists/:slug" element={<ArtistProfilePage />} />
        <Route path="/gallery/:slug" element={<GalleryPage />} />
        <Route path="/collections" element={<CollectionsPage />} />
        <Route path="/collections/:collectionId" element={<CollectionDetailPage />} />
        <Route path="/auth/:mode" element={<AuthPage user={user} setUser={setUser} />} />
        <Route path="/settings" element={<SettingsPage user={user} onProfileChanged={setMyProfile} />} />
      </Routes>
    </div>
  );
}
