import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { studioManagementNavSections, studioPrimaryNavSections, studioSectionDefs, type StudioSection } from '../config';
import { roleDisplayLabel } from '../rolePresentation';
import type { StudioCreator } from '../types';

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
          <strong>Ubeeq</strong>
          <span>STUDIO</span>
        </div>
        {!onboarding && creators.length > 0 && (
          <div className="studio-creator-controls">
            <label className="studio-creator-switcher">
              <span>Creator</span>
              <select
                aria-label="Active creator"
                value={activeCreatorId}
                onChange={(event) => navigate(destination(section, event.target.value))}
              >
                {creators.map((creator) => <option key={creator.creatorId} value={creator.creatorId}>{creator.name}</option>)}
              </select>
              <small>{activeCreator?.slug ? `@${activeCreator.slug}` : 'Creator identity'}</small>
            </label>
            <div className="studio-creator-actions">
              <Link className="auth-primary-btn no-underline" to="/studio/workspace?section=creators&create=1">Add a New Creator</Link>
              <Link className="auth-secondary-btn no-underline" to={destination('creators')}>Manage Creators</Link>
            </div>
          </div>
        )}
        {onboarding && <div className="studio-contributor-label"><strong>Your next step</strong><p>A free Space is ready whenever you are.</p></div>}
        <nav className="studio-sidebar-nav">
          {!onboarding && studioPrimaryNavSections.map(navItem)}
        </nav>
        {!onboarding && (
          <details className="studio-management-nav" open={studioManagementNavSections.includes(section)}>
            <summary>Management</summary>
            <nav className="studio-sidebar-nav">{studioManagementNavSections.map(navItem)}</nav>
          </details>
        )}
        {!onboarding && <p className="studio-account-note">You are a {roleDisplayLabel('contributor')}.</p>}
      </aside>

      <section className="studio-main">
        <header className="studio-section-header">
          <div>
            <p className="studio-page-eyebrow">{activeCreator ? activeCreator.name : 'Ubeeq Studio'}</p>
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
