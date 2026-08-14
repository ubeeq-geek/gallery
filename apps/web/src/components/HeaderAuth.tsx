import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { brand } from '../brand';
import type { CurrentUser } from '../cognitoAuth';
import { DISCOVERY_FILTER_EVENT_NAME, type DiscoveryDockSummary, type DiscoveryFilterSection, type SiteSettings, type UserProfile } from '../domainTypes';

type DiscoveryMediaKind = 'image' | 'video' | 'post' | 'audio';
const DEFAULT_PROFILE_ICON_SRC = brand.id === 'eversally'
  ? '/default-profile-icon-eversally.svg'
  : '/default-profile-icon.svg';

const DiscoveryMediaIcon = ({ kind, className }: { kind: DiscoveryMediaKind; className?: string }) => {
  if (kind === 'audio') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
        <path d="M8 14.2V5.4L15 4.2V13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="5.8" cy="14.2" r="2.1" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="12.8" cy="13" r="2.1" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  if (kind === 'video') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
        <rect x="2.5" y="4.5" width="10.5" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M9 8.2L12.4 10L9 11.8V8.2Z" fill="currentColor" />
        <path d="M13 8L17 5.8V14.2L13 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === 'post') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
        <rect x="3" y="2.8" width="14" height="14.4" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M6.2 7.1H13.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M6.2 10H13.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M6.2 12.9H10.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
      <rect x="2.8" y="3.3" width="14.4" height="13.4" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="7.2" cy="8.1" r="1.3" fill="currentColor" />
      <path d="M4.7 14L8.2 10.5C8.6 10.1 9.2 10.1 9.6 10.5L11 11.9C11.4 12.3 12 12.3 12.4 11.9L15.3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

const DiscoveryMediaIndicator = ({
  showImages,
  showVideos,
  showPosts,
  showAudio
}: {
  showImages: boolean;
  showVideos: boolean;
  showPosts: boolean;
  showAudio: boolean;
}) => (
  <span className="discovery-media-indicator" aria-hidden="true">
    {showImages && <DiscoveryMediaIcon kind="image" className="discovery-media-icon" />}
    {showVideos && <DiscoveryMediaIcon kind="video" className="discovery-media-icon" />}
    {showPosts && <DiscoveryMediaIcon kind="post" className="discovery-media-icon" />}
    {showAudio && <DiscoveryMediaIcon kind="audio" className="discovery-media-icon" />}
  </span>
);

export default function HeaderAuth({
  user,
  onSignOut,
  settings,
  profile,
  discoveryDock
}: {
  user: CurrentUser;
  onSignOut: () => Promise<void>;
  settings: SiteSettings;
  profile?: UserProfile | null;
  discoveryDock?: DiscoveryDockSummary | null;
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
  const showMobileDiscoveryButton = discoveryDock?.viewport === 'mobile';
  const openDiscoveryFilters = (section: DiscoveryFilterSection = 'period') => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent(DISCOVERY_FILTER_EVENT_NAME, {
        detail: { section }
      })
    );
  };

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
          {discoveryDock?.active && discoveryDock.viewport !== 'mobile' && (
            <div className="topbar-discovery-summary" aria-label="Discovery filter summary">
              <button type="button" className="topbar-discovery-chip topbar-discovery-chip-interactive topbar-discovery-open-btn" onClick={() => openDiscoveryFilters('period')}>
                <span>Filters</span>
                <DiscoveryMediaIndicator
                  showImages={discoveryDock.showImages}
                  showVideos={discoveryDock.showVideos}
                  showPosts={discoveryDock.showPosts}
                  showAudio={discoveryDock.showAudio}
                />
              </button>
              <div className="topbar-discovery-chip-list">
                <button type="button" className="topbar-discovery-chip topbar-discovery-chip-interactive" onClick={() => openDiscoveryFilters('period')}>
                  {discoveryDock.period === 'daily' ? 'Daily' : 'Hourly'}
                </button>
                <button type="button" className="topbar-discovery-chip topbar-discovery-chip-interactive" onClick={() => openDiscoveryFilters('media')}>
                  {discoveryDock.mediaLabel}
                </button>
                <button type="button" className="topbar-discovery-chip topbar-discovery-chip-interactive" onClick={() => openDiscoveryFilters('density')}>
                  Density: {discoveryDock.density[0].toUpperCase() + discoveryDock.density.slice(1)}
                </button>
                <button type="button" className="topbar-discovery-chip topbar-discovery-chip-interactive" onClick={() => openDiscoveryFilters('heavy')}>
                  {discoveryDock.heavyLabel}
                </button>
                <button type="button" className="topbar-discovery-chip topbar-discovery-chip-interactive" onClick={() => openDiscoveryFilters('search')}>
                  {discoveryDock.searchActive ? 'Search active' : 'Search'}
                </button>
              </div>
            </div>
          )}
          <section className={`auth-panel ${user ? 'auth-panel-user auth-panel-user-desktop' : 'auth-panel-guest'}`}>
            {user ? (
              <div className="auth-line">
                <details className="user-menu">
                  <summary className="user-menu-trigger" aria-label="Open account menu">
                    <img className="default-profile-icon" src={DEFAULT_PROFILE_ICON_SRC} alt="" />
                  </summary>
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
                    <span className="create-account-label-long">Create account</span>
                    <span className="create-account-label-short">Sign Up</span>
                  </Link>
                </div>
              </div>
            )}
          </section>
        </div>
      </header>

      {user && (
        <div className="mobile-user-dock">
          <div className={`mobile-user-dock-inner${showMobileDiscoveryButton ? ' has-discovery' : ''}`}>
            {showMobileDiscoveryButton && (
              <button type="button" className="mobile-discovery-dock-btn" onClick={() => openDiscoveryFilters('period')}>
                <span>Filters</span>
                {discoveryDock && (
                  <DiscoveryMediaIndicator
                    showImages={discoveryDock.showImages}
                    showVideos={discoveryDock.showVideos}
                    showPosts={discoveryDock.showPosts}
                  showAudio={discoveryDock.showAudio}
                  />
                )}
              </button>
            )}
            <details className="user-menu">
              <summary className="user-menu-trigger" aria-label="Open account menu">
                <span className="mobile-user-email-label">{menuSecondaryLabel || displayName}</span>
              </summary>
              <div className="user-menu-items">
                <div className="user-menu-sheet-handle" />
                <div className="user-menu-profile">
                  <div className="user-menu-profile-avatar">
                    <img className="default-profile-icon" src={DEFAULT_PROFILE_ICON_SRC} alt="" />
                  </div>
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
          <div className={`mobile-auth-dock-inner${showMobileDiscoveryButton ? ' has-discovery' : ''}`}>
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
              <span className="create-account-label-long">Create account</span>
              <span className="create-account-label-short">Sign Up</span>
            </Link>
            {showMobileDiscoveryButton && (
              <button type="button" className="mobile-discovery-dock-btn" onClick={() => openDiscoveryFilters('period')}>
                <span>Filters</span>
                {discoveryDock && (
                  <DiscoveryMediaIndicator
                    showImages={discoveryDock.showImages}
                    showVideos={discoveryDock.showVideos}
                    showPosts={discoveryDock.showPosts}
                  showAudio={discoveryDock.showAudio}
                  />
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
