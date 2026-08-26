import { Children, type CSSProperties, type ReactNode } from "react";

export type BadgeTone = "neutral" | "success" | "attention" | "warning" | "danger" | "restricted" | "unavailable" | "pending";

const badgeIcons: Record<BadgeTone, string> = {
  neutral: "i", success: "✓", attention: "!", warning: "△", danger: "×", restricted: "◆", unavailable: "—", pending: "◷"
};

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
}

/** Compact written state with a non-colour cue. Use plain text for tags that do not represent state. */
export function Badge({ children, tone = "neutral" }: BadgeProps) {
  return <span className={`ds-badge ds-badge--${tone}`}><span aria-hidden="true">{badgeIcons[tone]}</span><span>{children}</span></span>;
}

export interface AvatarProps {
  name: string;
  src?: string;
  imageAlt?: string;
  size?: "small" | "medium" | "large";
}

function initials(name: string) {
  const segments = name.trim().split(/\s+/u).filter(Boolean);
  return segments.slice(0, 2).map((segment) => Array.from(segment)[0]).join("").toLocaleUpperCase() || "?";
}

/** Creator identity image with a deterministic text fallback and accessible name. */
export function Avatar({ name, src, imageAlt = `${name} avatar`, size = "medium" }: AvatarProps) {
  return <span className={`ds-avatar ds-avatar--${size}`}>
    {src ? <img src={src} alt={imageAlt} /> : <span role="img" aria-label={imageAlt}>{initials(name)}</span>}
  </span>;
}

export interface SkeletonProps {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  shape?: "text" | "rectangle" | "circle";
}

/** Decorative loading placeholder. Pair groups of skeletons with LoadingState. */
export function Skeleton({ width, height, shape = "text" }: SkeletonProps) {
  return <span className={`ds-skeleton ds-skeleton--${shape}`} style={{ width, height }} aria-hidden="true" />;
}

export interface ProgressIndicatorProps {
  label: string;
  value?: number;
  max?: number;
  detail?: ReactNode;
}

/** Announces operational progress without implying completion for indeterminate work. */
export function ProgressIndicator({ label, value, max = 100, detail }: ProgressIndicatorProps) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const determinate = typeof value === "number" && Number.isFinite(value);
  const safeValue = determinate ? Math.min(Math.max(value, 0), safeMax) : undefined;
  const percent = safeValue === undefined ? undefined : Math.round((safeValue / safeMax) * 100);
  return <div className="ds-progress" role="status" aria-live="polite">
    <div className="ds-progress__label"><strong>{label}</strong>{percent !== undefined && <span>{percent}%</span>}</div>
    <progress aria-label={label} max={safeMax} value={safeValue} />
    {detail && <div className="ds-progress__detail">{detail}</div>}
  </div>;
}

export interface LoadingStateProps {
  label: string;
  detail?: ReactNode;
  rows?: number;
}

/** A labelled loading region whose placeholders remain hidden from assistive technology. */
export function LoadingState({ label, detail, rows = 3 }: LoadingStateProps) {
  const count = Math.max(1, Math.min(Math.floor(rows), 12));
  return <div className="ds-loading-state" role="status" aria-live="polite" aria-label={label}>
    <strong>{label}</strong>{detail && <div className="ds-loading-state__detail">{detail}</div>}
    <div aria-hidden="true">{Array.from({ length: count }, (_, index) => <Skeleton key={index} width={index === count - 1 ? "65%" : "100%"} />)}</div>
  </div>;
}

interface ChipBaseProps { label: ReactNode; disabled?: boolean }
type ChipRemovalProps = { onRemove: () => void; removeLabel: string } | { onRemove?: undefined; removeLabel?: never };
export type ChipProps = ChipBaseProps & ChipRemovalProps;

/** Compact metadata tag. Operational state should use Badge rather than Chip. */
export function Chip({ label, disabled = false, onRemove, removeLabel }: ChipProps) {
  return <span className={`ds-chip${disabled ? " ds-chip--disabled" : ""}`}>
    <span>{label}</span>
    {onRemove && <button type="button" aria-label={removeLabel} disabled={disabled} onClick={onRemove}><span aria-hidden="true">×</span></button>}
  </span>;
}

export interface ChipListProps {
  label: string;
  children: ReactNode;
}

/** Named list for collection associations, filters, and other non-status metadata. */
export function ChipList({ label, children }: ChipListProps) {
  const chips = Children.toArray(children);
  return <ul className="ds-chip-list" aria-label={label}>{chips.map((chip, index) => <li key={index}>{chip}</li>)}</ul>;
}
