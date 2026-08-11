import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { studioNavSections, type StudioSection } from '../config';
import { roleDisplayLabel } from '../rolePresentation';

export function StudioLayout({
  section,
  title,
  description,
  onboarding = false,
  children
}: {
  section: StudioSection;
  title: string;
  description: string;
  onboarding?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="layout studio-dashboard-shell">
      <aside className="studio-sidebar panel">
        <div className="studio-brand-card">
          <strong>Ubeeq</strong>
          <span>STUDIO</span>
        </div>
        <div className="studio-contributor-label">
          <strong>{onboarding ? 'Your next step' : 'Ubeeqer account'}</strong>
          <p>{onboarding ? 'A free Space is ready whenever you are.' : `You are a ${roleDisplayLabel('contributor')}.`}</p>
        </div>
        <nav className="studio-sidebar-nav">
          <Link
            className={`studio-nav-item no-underline${section === 'dashboard' ? ' studio-nav-item-active' : ''}`}
            to="/studio/workspace"
          >
            <span>Dashboard</span>
            <span aria-hidden="true">›</span>
          </Link>
          {!onboarding && studioNavSections.map((item) => (
            <Link
              key={item.key}
              className={`studio-nav-item no-underline${item.key === section ? ' studio-nav-item-active' : ''}`}
              to={`/studio/workspace?section=${item.key}`}
            >
              <span>{item.label}</span>
              <span aria-hidden="true">›</span>
            </Link>
          ))}
        </nav>
      </aside>

      <section className="studio-main">
        <section className="panel studio-section-header">
          <h2>{title}</h2>
          <p className="small">{description}</p>
        </section>
        {children}
      </section>
    </div>
  );
}
