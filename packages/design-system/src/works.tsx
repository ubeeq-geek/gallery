import type { ReactNode } from "react";
import { getPublicationPresentation, type PublicationState } from "./status.js";

export interface WorkDestinationSummary { id: string; label: string; state: PublicationState; stateLabel: string }
export interface WorkCardProps {
  title: string;
  href: string;
  media?: { src: string; alt: string };
  visibilityLabel: string;
  assetSummary: string;
  destinations: readonly WorkDestinationSummary[];
}

export function WorkCard({ title, href, media, visibilityLabel, assetSummary, destinations }: WorkCardProps) {
  return <article className="ds-work-card">
    <div className="ds-work-card__media">{media ? <img src={media.src} alt={media.alt} /> : <span>No preview available</span>}</div>
    <div className="ds-work-card__body">
      <p className="ds-work-card__eyebrow">{visibilityLabel} · {assetSummary}</p>
      <h3><a className="ds-status__action" href={href}>{title}</a></h3>
      <ul className="ds-destination-list" aria-label="Destination summary">
        {destinations.map(destination => {
          const status = getPublicationPresentation(destination.state);
          return <li key={destination.id}>
            <span>{destination.label}</span>
            <strong className={`ds-status-text--${status.tone}`} data-state={destination.state}><span aria-hidden="true">{status.icon} </span>{destination.stateLabel}</strong>
          </li>;
        })}
      </ul>
    </div>
  </article>;
}

export interface WorkListRowProps extends WorkCardProps {
  lastUpdatedAt?: string;
  lastUpdatedLabel?: string;
  actions?: ReactNode;
}

/** Dense Work presentation that retains independent destination states and a narrow-screen layout. */
export function WorkListRow({ title, href, media, visibilityLabel, assetSummary, destinations, lastUpdatedAt, lastUpdatedLabel, actions }: WorkListRowProps) {
  return <article className="ds-work-row">
    <div className="ds-work-row__media">{media ? <img src={media.src} alt={media.alt} /> : <span aria-hidden="true">□</span>}</div>
    <div className="ds-work-row__identity"><h3><a href={href}>{title}</a></h3><p>{visibilityLabel} · {assetSummary}</p>{lastUpdatedAt && <p>Updated <time dateTime={lastUpdatedAt}>{lastUpdatedLabel ?? lastUpdatedAt}</time></p>}</div>
    <ul className="ds-work-row__destinations" aria-label={`${title} destination summary`}>{destinations.map((destination) => {
      const status = getPublicationPresentation(destination.state);
      return <li key={destination.id}><span>{destination.label}</span><strong className={`ds-status-text--${status.tone}`} data-state={destination.state}><span aria-hidden="true">{status.icon} </span>{destination.stateLabel}</strong></li>;
    })}</ul>
    {actions && <div className="ds-work-row__actions" aria-label={`${title} actions`}>{actions}</div>}
  </article>;
}
