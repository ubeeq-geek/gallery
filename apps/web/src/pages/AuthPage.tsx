import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import {
  confirmForgotPassword,
  confirmRegistration,
  forgotPassword,
  setInitialPassword,
  signIn,
  type CurrentUser
} from '../cognitoAuth';

const AUTH_PERSISTENCE_KEY = 'authPersistence';

type AuthMode = 'signin' | 'register' | 'confirm' | 'forgot' | 'initial';

export default function AuthPage({ user, setUser }: { user: CurrentUser; setUser: (u: CurrentUser) => void }) {
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
