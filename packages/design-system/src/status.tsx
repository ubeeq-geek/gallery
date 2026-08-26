import type { ReactNode } from "react";

export type PublicationState = "draft" | "requested" | "queued" | "publishing" | "published" | "pending_review" | "held" | "rejected" | "withdrawn" | "removed" | "unavailable" | "reconciling" | "failed";
type Tone = "neutral" | "success" | "attention" | "danger" | "restricted" | "unavailable" | "pending";
const presentation: Record<PublicationState, { label: string; tone: Tone; icon: string }> = {
  draft: { label: "Draft", tone: "neutral", icon: "○" }, requested: { label: "Requested", tone: "pending", icon: "◷" },
  queued: { label: "Queued", tone: "pending", icon: "◷" }, publishing: { label: "Publishing", tone: "pending", icon: "↻" },
  published: { label: "Published", tone: "success", icon: "✓" }, pending_review: { label: "Pending review", tone: "attention", icon: "!" },
  held: { label: "Held", tone: "restricted", icon: "◆" }, rejected: { label: "Rejected", tone: "danger", icon: "×" },
  withdrawn: { label: "Withdrawn", tone: "neutral", icon: "←" }, removed: { label: "Removed", tone: "danger", icon: "×" },
  unavailable: { label: "Unavailable", tone: "unavailable", icon: "–" }, reconciling: { label: "Unknown — reconciling", tone: "attention", icon: "?" },
  failed: { label: "Failed", tone: "danger", icon: "!" }
};

export function getPublicationPresentation(state: PublicationState) {
  return presentation[state];
}

export interface DestinationStatusProps {
  destination: string; state: PublicationState; explanation: string; lastVerifiedAt?: string;
  action?: ReactNode;
}
export function DestinationStatus({ destination, state, explanation, lastVerifiedAt, action }: DestinationStatusProps) {
  const view = presentation[state];
  return <section className={`ds-status ds-status--${view.tone}`} aria-label={`${destination}: ${view.label}`}>
    <span className="ds-status__icon" aria-hidden="true">{view.icon}</span><div>
      <div className="ds-status__title">{destination} · {view.label}</div>
      <p className="ds-status__detail">{explanation}</p>
      {lastVerifiedAt && <p className="ds-status__meta">Last verified <time dateTime={lastVerifiedAt}>{lastVerifiedAt}</time></p>}
      {action && <div className="ds-status__action">{action}</div>}
    </div>
  </section>;
}

export interface PublicationEvent extends Omit<DestinationStatusProps, "action"> { id: string; occurredAt: string }
export function PublicationTimeline({ events }: { events: readonly PublicationEvent[] }) {
  return <ol className="ds-timeline" aria-label="Publication history">
    {events.map(({ id, occurredAt, ...event }) => <li key={id}><DestinationStatus {...event} lastVerifiedAt={occurredAt} /></li>)}
  </ol>;
}
