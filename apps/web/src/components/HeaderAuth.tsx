import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { CurrentUser } from '../cognitoAuth';
import { DISCOVERY_FILTER_EVENT_NAME, type DiscoveryDockSummary, type DiscoveryFilterSection, type SiteSettings, type UserProfile } from '../domainTypes';

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
  const initials = initialsSource
    .split('@')[0]
    .split(/[.\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || 'U';
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
                Filters
              </button>
              <div className="topbar-discovery-chip-list">
                <button type="button" className="topbar-discovery-chip topbar-discovery-chip-interactive" onClick={() => openDiscoveryFilters('period')}>
                  {discoveryDock.period === 'daily' ? 'Daily' : 'Hourly'}
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
                Filters
              </button>
            )}
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
                Filters
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
