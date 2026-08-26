import { useId, type ReactNode } from "react";

export interface PolicyDisclosureProps {
  title: string;
  content: ReactNode;
  mode?: "informational" | "caution";
  acknowledgement?: ReactNode;
}

export function PolicyDisclosure({ title, content, mode = "informational", acknowledgement }: PolicyDisclosureProps) {
  const titleId = useId();
  return <aside className="ds-disclosure" aria-labelledby={titleId}>
    <span className={`ds-status__icon ds-status-text--${mode === "caution" ? "attention" : "neutral"}`} aria-hidden="true">{mode === "caution" ? "!" : "i"}</span>
    <div><h2 id={titleId}>{title}</h2><div>{content}</div>{acknowledgement}</div>
  </aside>;
}

export interface ReviewHoldNoticeProps {
  destinationLabel: string;
  publicReason: string;
  lastUpdatedAt?: string;
  nextStep?: ReactNode;
}

export function ReviewHoldNotice({ destinationLabel, publicReason, lastUpdatedAt, nextStep }: ReviewHoldNoticeProps) {
  return <section className="ds-status ds-status--restricted" role="status" aria-label={`${destinationLabel}: Unavailable pending review`}>
    <span className="ds-status__icon" aria-hidden="true">◆</span><div>
      <div className="ds-status__title">Unavailable on {destinationLabel} pending review</div>
      <p className="ds-status__detail">{publicReason}</p>
      <p className="ds-status__detail">This destination state does not delete or change the canonical Work.</p>
      {lastUpdatedAt && <p className="ds-status__meta">Updated <time dateTime={lastUpdatedAt}>{lastUpdatedAt}</time></p>}
      {nextStep && <div className="ds-status__action">{nextStep}</div>}
    </div>
  </section>;
}

export type AuditActorCategory = "creator" | "collaborator" | "service" | "support" | "moderation" | "system";
export interface AuditEvent {
  id: string;
  timestamp: string;
  actorCategory: AuditActorCategory;
  action: string;
  objectLabel: string;
  destinationLabel?: string;
  permissibleDetail?: string;
}

export function AuditEventList({ events, emptyMessage = "No activity recorded." }: { events: readonly AuditEvent[]; emptyMessage?: string }) {
  if (events.length === 0) return <div className="ds-selector-state">{emptyMessage}</div>;
  return <ol className="ds-audit-list" aria-label="Audit events">{events.map(event => <li className="ds-audit-event" key={event.id}>
    <time dateTime={event.timestamp}>{event.timestamp}</time><div>
      <strong>{event.action}</strong><p>{event.objectLabel}{event.destinationLabel ? ` · ${event.destinationLabel}` : ""}</p>
      <div className="ds-audit-event__meta">Actor: {event.actorCategory}{event.permissibleDetail ? ` · ${event.permissibleDetail}` : ""}</div>
    </div>
  </li>)}</ol>;
}
