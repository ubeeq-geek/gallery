import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { studioManagementNavSections, studioPrimaryNavSections, studioSectionDefs, type StudioSection } from '../config';
import { roleDisplayLabel } from '../rolePresentation';
import type { StudioCreator } from '../types';
import { brand } from '../../brand';

export function StudioLayout({
  section,
  title,
  description,
  onboarding = false,
  creators = [],
  activeCreatorId = '',
  children
}: {
  section: StudioSection;
  title: string;
  description: string;
  onboarding?: boolean;
  creators?: StudioCreator[];
  activeCreatorId?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const activeCreator = creators.find((creator) => creator.creatorId === activeCreatorId);
  const destination = (nextSection: StudioSection, creatorId = activeCreatorId) => {
    const params = new URLSearchParams({ section: nextSection });
    if (creatorId) params.set('creatorId', creatorId);
    return `/studio/workspace?${params.toString()}`;
  };
  const navItem = (key: StudioSection) => {
    const item = studioSectionDefs.find((candidate) => candidate.key === key);
    if (!item) return null;
    return (
      <Link
        key={item.key}
        className={`studio-nav-item no-underline${item.key === section ? ' studio-nav-item-active' : ''}`}
        to={destination(item.key)}
      >
        <span>{item.label}</span>
      </Link>
    );
  };

  return (
    <div className="layout studio-dashboard-shell">
      <aside className="studio-sidebar">
        <div className="studio-brand-card">
          <strong>{brand.productName}</strong>
          <span>STUDIO</span>
          {brand.attribution && <small>{brand.attribution}</small>}
        </div>
        {!onboarding && creators.length > 0 && (
          <div className="studio-creator-controls">
            <label className="studio-creator-switcher">
              <span>{brand.creatorName}</span>
              <select
                aria-label={`Active ${brand.creatorName}`}
                value={activeCreatorId}
                onChange={(event) => navigate(destination(section, event.target.value))}
              >
                {creators.map((creator) => <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>)}
              </select>
              <small>{activeCreator?.slug ? `@${activeCreator.slug}` : `${brand.creatorName} identity`}</small>
            </label>
            <div className="studio-creator-actions">
        {activeCreator?.slug && <Link className="auth-secondary-btn no-underline" to={`/creators/${encodeURIComponent(activeCreator.slug)}?preview=1`}>View Public {brand.creatorName} Profile</Link>}
              <Link className="auth-primary-btn no-underline" to="/studio/workspace?section=creators&create=1">Add a New {brand.creatorName}</Link>
              <Link className="auth-secondary-btn no-underline" to={destination('creators')}>Manage {brand.creatorPlural}</Link>
            </div>
          </div>
        )}
        {onboarding && <div className="studio-contributor-label"><strong>Your next step</strong><p>Become a {brand.creatorName} whenever you’re ready — nothing below is required today.</p></div>}
        <nav className="studio-sidebar-nav">
          {!onboarding && studioPrimaryNavSections.map(navItem)}
        </nav>
        {!onboarding && (
          <details className="studio-management-nav" open={studioManagementNavSections.includes(section)}>
            <summary>Management</summary>
            <nav className="studio-sidebar-nav">{studioManagementNavSections.map(navItem)}</nav>
          </details>
        )}
        {!onboarding && <p className="studio-account-note">You are {brand.id === 'eversally' ? 'an' : 'a'} {roleDisplayLabel('contributor')}.</p>}
      </aside>

      <section className="studio-main">
        <header className="studio-section-header">
          <div>
            {!onboarding && <p className="studio-page-eyebrow">{activeCreator ? activeCreator.name : brand.studioName}</p>}
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          {!onboarding && activeCreator && <span className="studio-context-chip">Working as {activeCreator.name}</span>}
        </header>
        {children}
      </section>
    </div>
  );
}
