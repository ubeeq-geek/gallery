import type { ReactNode } from "react";

export type MediaLifecycleState = "uploading" | "checking" | "queued" | "needs_review" | "available_for_policy_review" | "cannot_be_processed" | "unavailable_pending_review" | "ready";

const mediaPresentation: Record<MediaLifecycleState, { label: string; tone: string; icon: string }> = {
  uploading: { label: "Uploading", tone: "pending", icon: "↑" },
  checking: { label: "Checking media", tone: "pending", icon: "↻" },
  queued: { label: "Queued for processing", tone: "pending", icon: "◷" },
  needs_review: { label: "Needs review", tone: "attention", icon: "!" },
  available_for_policy_review: { label: "Available for policy review", tone: "attention", icon: "!" },
  cannot_be_processed: { label: "Cannot be processed", tone: "danger", icon: "×" },
  unavailable_pending_review: { label: "Unavailable pending review", tone: "restricted", icon: "◆" },
  ready: { label: "Ready", tone: "success", icon: "✓" }
};

export interface AssetStateProps {
  state: MediaLifecycleState;
  explanation: string;
  lastUpdatedAt?: string;
  action?: ReactNode;
}

export function AssetState({ state, explanation, lastUpdatedAt, action }: AssetStateProps) {
  const view = mediaPresentation[state];
  return <section className={`ds-status ds-status--${view.tone}`} role="status" aria-label={`Asset: ${view.label}`}>
    <span className="ds-status__icon" aria-hidden="true">{view.icon}</span>
    <div>
      <div className="ds-status__title">{view.label}</div>
      <p className="ds-status__detail">{explanation}</p>
      {lastUpdatedAt && <p className="ds-status__meta">Updated <time dateTime={lastUpdatedAt}>{lastUpdatedAt}</time></p>}
      {action && <div className="ds-status__action">{action}</div>}
    </div>
  </section>;
}

export interface SourceControlNoticeProps {
  kind: "canonical" | "external_reference";
  sourceName?: string;
}

export function SourceControlNotice({ kind, sourceName }: SourceControlNoticeProps) {
  const canonical = kind === "canonical";
  const title = canonical ? "Canonical source stored in Ubeeq" : "External reference only";
  const detail = canonical
    ? "Publishing changes do not remove this source Asset."
    : `The source file remains with ${sourceName ?? "the external provider"}; availability can change independently.`;
  return <aside className={`ds-status ds-status--${canonical ? "success" : "attention"}`} aria-label={title}>
    <span className="ds-status__icon" aria-hidden="true">{canonical ? "✓" : "↗"}</span>
    <div><div className="ds-status__title">{title}</div><p className="ds-status__detail">{detail}</p></div>
  </aside>;
}

export interface AssetGridItem {
  id: string;
  title: string;
  href: string;
  state: MediaLifecycleState;
  preview?: { src: string; alt: string };
  mediaSummary: string;
  sourceKind: "canonical" | "external_reference";
  sourceLabel: string;
  lastUpdatedAt?: string;
  lastUpdatedLabel?: string;
  actions?: ReactNode;
}

export interface AssetGridProps {
  items: readonly AssetGridItem[];
  label?: string;
  emptyTitle?: string;
  emptyDetail?: ReactNode;
}

/** Image-first Asset collection with explicit processing and source-control state. */
export function AssetGrid({ items, label = "Assets", emptyTitle = "No Assets", emptyDetail }: AssetGridProps) {
  if (items.length === 0) return <section className="ds-asset-grid__empty" aria-label={label}><strong>{emptyTitle}</strong>{emptyDetail && <div>{emptyDetail}</div>}</section>;
  return <ul className="ds-asset-grid" aria-label={label}>{items.map((item) => {
    const state = mediaPresentation[item.state];
    return <li key={item.id}><article className="ds-asset-card">
      <div className="ds-asset-card__preview">{item.preview ? <img src={item.preview.src} alt={item.preview.alt} /> : <span>No preview available</span>}</div>
      <div className="ds-asset-card__body">
        <h3><a href={item.href}>{item.title}</a></h3>
        <p>{item.mediaSummary}</p>
        <strong className={`ds-status-text--${state.tone}`} aria-label={`${item.title}: ${state.label}`}><span aria-hidden="true">{state.icon} </span>{state.label}</strong>
        <p><span aria-hidden="true">{item.sourceKind === "canonical" ? "●" : "↗"} </span>{item.sourceLabel}</p>
        {item.lastUpdatedAt && <p>Updated <time dateTime={item.lastUpdatedAt}>{item.lastUpdatedLabel ?? item.lastUpdatedAt}</time></p>}
        {item.actions && <div className="ds-asset-card__actions" aria-label={`${item.title} actions`}>{item.actions}</div>}
      </div>
    </article></li>;
  })}</ul>;
}
