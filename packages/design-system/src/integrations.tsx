import type { ReactNode } from "react";
import { Button } from "./controls.js";

export type IntegrationHealth = "connected" | "syncing" | "degraded" | "expired" | "restricted" | "unavailable" | "disconnected" | "reconciling";
export type IntegrationAction = "connect" | "reconnect" | "disconnect" | "test" | "sync" | "retry" | "review";

const healthPresentation: Record<IntegrationHealth, { label: string; tone: string; icon: string }> = {
  connected: { label: "Connected", tone: "success", icon: "✓" },
  syncing: { label: "Syncing", tone: "pending", icon: "↻" },
  degraded: { label: "Degraded", tone: "attention", icon: "!" },
  expired: { label: "Authorization expired", tone: "danger", icon: "×" },
  restricted: { label: "Restricted", tone: "restricted", icon: "◆" },
  unavailable: { label: "Provider unavailable", tone: "unavailable", icon: "–" },
  disconnected: { label: "Not connected", tone: "neutral", icon: "○" },
  reconciling: { label: "Unknown — reconciling", tone: "attention", icon: "?" }
};

export interface IntegrationHealthNoticeProps {
  providerName: string;
  health: IntegrationHealth;
  explanation: string;
  lastVerifiedAt?: string;
  action?: ReactNode;
}

export function IntegrationHealthNotice({ providerName, health, explanation, lastVerifiedAt, action }: IntegrationHealthNoticeProps) {
  const view = healthPresentation[health];
  return <section className={`ds-status ds-status--${view.tone}`} role="status" aria-label={`${providerName}: ${view.label}`}>
    <span className="ds-status__icon" aria-hidden="true">{view.icon}</span><div>
      <div className="ds-status__title">{view.label}</div>
      <p className="ds-status__detail">{explanation}</p>
      {lastVerifiedAt && <p className="ds-status__meta">Last verified <time dateTime={lastVerifiedAt}>{lastVerifiedAt}</time></p>}
      {action && <div className="ds-status__action">{action}</div>}
    </div>
  </section>;
}

export interface IntegrationCardProps {
  providerName: string;
  accountScope: string;
  health: IntegrationHealth;
  healthExplanation: string;
  capabilities: readonly string[];
  lastSuccessfulSyncAt?: string;
  lastVerifiedAt?: string;
  allowedActions: readonly IntegrationAction[];
  onAction?: (action: IntegrationAction) => void;
  busyAction?: IntegrationAction;
}

const actionLabels: Record<IntegrationAction, string> = { connect: "Connect", reconnect: "Reconnect", disconnect: "Disconnect", test: "Test connection", sync: "Sync now", retry: "Retry", review: "Review recovery" };

export function IntegrationCard(props: IntegrationCardProps) {
  return <article className="ds-integration-card">
    <header className="ds-integration-card__header"><h3>{props.providerName}</h3><span>{props.accountScope}</span></header>
    <IntegrationHealthNotice providerName={props.providerName} health={props.health} explanation={props.healthExplanation} lastVerifiedAt={props.lastVerifiedAt} />
    <dl>
      <dt>Current capabilities</dt><dd>{props.capabilities.length ? props.capabilities.join(", ") : "No capabilities available"}</dd>
      <dt>Last successful sync</dt><dd>{props.lastSuccessfulSyncAt ? <time dateTime={props.lastSuccessfulSyncAt}>{props.lastSuccessfulSyncAt}</time> : "No successful sync recorded"}</dd>
    </dl>
    {props.allowedActions.length > 0 && <div className="ds-integration-card__actions" aria-label={`${props.providerName} actions`}>
      {props.allowedActions.map(action => <Button variant="secondary" key={action} disabled={props.busyAction !== undefined} loading={props.busyAction === action} loadingLabel={`${actionLabels[action]}…`} onClick={() => props.onAction?.(action)}>{actionLabels[action]}</Button>)}
    </div>}
  </article>;
}
