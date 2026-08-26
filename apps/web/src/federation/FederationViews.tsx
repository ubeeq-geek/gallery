import { useEffect, useRef, useState } from 'react';

export type FederationPublicationStatus = 'pending' | 'processing' | 'published' | 'rejected' | 'held' | 'withdrawn' | 'removed';

export interface HomeFederationDashboardModel {
  destinations: Array<{ instanceId: string; name: string; policyVersion: string; status: string; profileRevision?: number }>;
  works: Array<{
    sourceWorkUri: string;
    title: string;
    destinations: Array<{ instanceId: string; publicationId: string; status: FederationPublicationStatus; sourceStatus: string; revision: number }>;
  }>;
}

export interface FederatedCreatorPageModel {
  actorUri: string;
  displayName: string;
  handle: string;
  avatarUrl?: string;
  shortBio?: string;
  approvedLinks: Array<{ label: string; url: string }>;
  attribution: { label: string; homeInstanceName: string };
  homeProfileLink?: { href: string; homeInstanceName: string; warningRequired: true };
  publications: Array<{ id: string; metadata: Record<string, unknown>; rating?: string; labels: string[]; publishedAt?: string }>;
}

const STATUS_LABELS: Record<FederationPublicationStatus, string> = {
  pending: 'Pending', processing: 'Processing', published: 'Published', rejected: 'Rejected', held: 'Held', withdrawn: 'Withdrawn', removed: 'Removed'
};

export function HomeFederationDashboard({
  model,
  onSelectDestination,
  onEditProfile,
  onPublish,
  onWithdraw,
  onRevoke
}: {
  model: HomeFederationDashboardModel;
  onSelectDestination: () => void;
  onEditProfile: (instanceId: string) => void;
  onPublish: (sourceWorkUri: string, instanceId: string) => void;
  onWithdraw: (publicationId: string) => void;
  onRevoke: (instanceId: string) => void;
}) {
  return <section className="federation-dashboard" aria-labelledby="federation-dashboard-title">
    <header className="federation-heading">
      <div><p className="eyebrow">Ubeeq federation</p><h2 id="federation-dashboard-title">Publish from your home instance</h2><p>Your identity and canonical Works stay here. Each destination reviews and presents its own copy.</p></div>
      <button type="button" className="auth-primary-btn" onClick={onSelectDestination}>Connect destination</button>
    </header>
    <div className="federation-destinations">
      {model.destinations.map((destination) => <article className="panel" key={destination.instanceId}>
        <p className="eyebrow">Destination</p><h3>{destination.name}</h3>
        <span className={`federation-status federation-status-${destination.status}`}>{destination.status.replace('_', ' ')}</span>
        {destination.profileRevision && <p>Distribution profile revision {destination.profileRevision}</p>}
        <div className="studio-inline-actions"><button type="button" onClick={() => onEditProfile(destination.instanceId)}>Edit distribution profile</button><button type="button" className="danger" onClick={() => onRevoke(destination.instanceId)}>Revoke</button></div>
      </article>)}
    </div>
    <div className="federation-work-list">
      {model.works.map((work) => <article className="panel" key={work.sourceWorkUri}>
        <h3>{work.title}</h3>
        {work.destinations.map((publication) => <div className="federation-publication-row" key={`${publication.instanceId}:${publication.publicationId}`}>
          <div><strong>{publication.instanceId}</strong><span className={`federation-status federation-status-${publication.status}`}>{STATUS_LABELS[publication.status]}</span><small>Source {publication.sourceStatus} · revision {publication.revision}</small></div>
          {['withdrawn', 'removed'].includes(publication.status)
            ? <button type="button" onClick={() => onPublish(work.sourceWorkUri, publication.instanceId)}>Publish again</button>
            : <button type="button" onClick={() => onWithdraw(publication.publicationId)}>Withdraw</button>}
        </div>)}
      </article>)}
    </div>
  </section>;
}

export function FederatedCreatorPage({ model, onHomeLinkConsent }: { model: FederatedCreatorPageModel; onHomeLinkConsent: () => void | Promise<void> }) {
  const [warningOpen, setWarningOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [consentError, setConsentError] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!warningOpen) return undefined;
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const focusable = dialogRef.current?.querySelector<HTMLElement>('button'); focusable?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !leaving) { setWarningOpen(false); triggerRef.current?.focus(); return; }
      if (event.key === 'Tab') { const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]; if (!items.length) return; const first = items[0]; const last = items[items.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keydown); };
  }, [warningOpen, leaving]);
  const continueHome = async () => {
    if (!model.homeProfileLink) return;
    setLeaving(true); setConsentError('');
    try { await onHomeLinkConsent(); window.location.assign(model.homeProfileLink.href); }
    catch { setConsentError('Eversally could not record your choice. Please try again.'); setLeaving(false); }
  };
  return <main className="page-shell federated-creator-page">
    <header className="federation-creator-header">
      {model.avatarUrl && <img src={model.avatarUrl} alt="" />}
      <div><p className="eyebrow">Federated creator</p><h1>{model.displayName}</h1><p>@{model.handle}</p>{model.shortBio && <p>{model.shortBio}</p>}<strong>{model.attribution.label}</strong></div>
    </header>
    <nav aria-label="Creator links">{model.approvedLinks.map((link) => <a href={link.url} rel="noreferrer" key={link.url}>{link.label}</a>)}{model.homeProfileLink && <button ref={triggerRef} type="button" className="federation-home-link" onClick={() => setWarningOpen(true)}>Creator’s home profile: {model.homeProfileLink.homeInstanceName}</button>}</nav>
    <section aria-labelledby="federated-works-title"><h2 id="federated-works-title">Works on Eversally</h2><div className="canonical-work-grid">{model.publications.map((publication) => <article className="panel" key={publication.id}><h3>{String(publication.metadata.title || 'Untitled Work')}</h3>{publication.rating && <span className="federation-status">{publication.rating}</span>}{publication.labels.map((label) => <span className="federation-status" key={label}>{label}</span>)}</article>)}</div></section>
    {warningOpen && model.homeProfileLink && <div className="federation-warning-backdrop" role="presentation"><section ref={dialogRef} className="federation-warning" role="dialog" aria-modal="true" aria-labelledby="federation-warning-title" aria-describedby="federation-warning-description"><p className="eyebrow">Leaving Eversally</p><h2 id="federation-warning-title">Creator’s home profile: {model.homeProfileLink.homeInstanceName}</h2><p id="federation-warning-description">This independently managed profile may contain mature content or material unavailable on Eversally.</p><p>You are continuing to <strong>{new URL(model.homeProfileLink.href).hostname}</strong>. Eversally does not review or approve the creator’s complete home profile.</p>{consentError && <p className="error" role="alert">{consentError}</p>}<div className="studio-inline-actions"><button type="button" className="auth-primary-btn" disabled={leaving} onClick={() => void continueHome()}>{leaving ? 'Continuing…' : 'Continue'}</button><button type="button" disabled={leaving} onClick={() => { setWarningOpen(false); triggerRef.current?.focus(); }}>Stay on Eversally</button></div></section></div>}
  </main>;
}
