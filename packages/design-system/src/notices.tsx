import { useId, type ReactNode } from "react";
import { IconButton } from "./controls.js";

export type NoticeTone = "information" | "success" | "attention" | "warning" | "danger" | "restricted" | "unavailable";

const noticeIcons: Record<NoticeTone, string> = {
  information: "i",
  success: "✓",
  attention: "!",
  warning: "△",
  danger: "×",
  restricted: "—",
  unavailable: "?"
};

export interface InlineNoticeProps {
  title: string;
  children: ReactNode;
  tone?: NoticeTone;
  actions?: ReactNode;
}

export function InlineNotice({ title, children, tone = "information", actions }: InlineNoticeProps) {
  const titleId = useId();
  const urgent = tone === "danger";

  return <section className={`ds-notice ds-notice--${tone}`} aria-labelledby={titleId} role={urgent ? "alert" : "status"}>
    <span className="ds-notice__icon" aria-hidden="true">{noticeIcons[tone]}</span>
    <div className="ds-notice__content">
      <h2 id={titleId}>{title}</h2>
      <div className="ds-notice__body">{children}</div>
      {actions && <div className="ds-notice__actions">{actions}</div>}
    </div>
  </section>;
}

export interface BannerProps extends InlineNoticeProps {
  dismissLabel?: string;
  onDismiss?: () => void;
}

export function Banner({ dismissLabel = "Dismiss notice", onDismiss, ...notice }: BannerProps) {
  const actions = notice.actions || onDismiss ? <>{notice.actions}{onDismiss && <IconButton accessibleName={dismissLabel} icon="×" onClick={onDismiss} variant="secondary" />}</> : undefined;
  return <div className="ds-banner">
    <InlineNotice {...notice} actions={actions} />
  </div>;
}

export interface ToastMessage {
  id: string;
  title: string;
  message: ReactNode;
  tone?: Extract<NoticeTone, "information" | "success" | "warning" | "danger">;
  dismissLabel?: string;
}

export interface ToastRegionProps {
  messages: readonly ToastMessage[];
  label?: string;
  onDismiss?: (id: string) => void;
}

export function ToastRegion({ messages, label = "Notifications", onDismiss }: ToastRegionProps) {
  return <section className="ds-toast-region" aria-label={label}>
    {messages.map(message => <div className={`ds-toast ds-toast--${message.tone ?? "information"}`} key={message.id} role={message.tone === "danger" ? "alert" : "status"}>
      <span className="ds-notice__icon" aria-hidden="true">{noticeIcons[message.tone ?? "information"]}</span>
      <div><strong>{message.title}</strong><div className="ds-toast__message">{message.message}</div></div>
      {onDismiss && <IconButton accessibleName={message.dismissLabel ?? `Dismiss ${message.title}`} icon="×" onClick={() => onDismiss(message.id)} variant="secondary" />}
    </div>)}
  </section>;
}
