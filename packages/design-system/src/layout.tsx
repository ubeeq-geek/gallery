import { useId, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";

export type LayoutGap = "none" | "small" | "medium" | "large";

interface LayoutProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  gap?: LayoutGap;
}

function classes(base: string, gap: LayoutGap, className?: string) {
  return `${base} ${base}--gap-${gap}${className ? ` ${className}` : ""}`;
}

/** Vertical rhythm primitive for related content. */
export function Stack({ children, gap = "medium", className, ...props }: LayoutProps) {
  return <div {...props} className={classes("ds-stack", gap, className)}>{children}</div>;
}

/** Wrapping horizontal layout for actions, filters, and compact metadata. */
export function Cluster({ children, gap = "medium", className, ...props }: LayoutProps) {
  return <div {...props} className={classes("ds-cluster", gap, className)}>{children}</div>;
}

export interface GridProps extends LayoutProps {
  minItemWidth?: string;
}

/** Responsive grid that adds columns only when its minimum item width fits. */
export function Grid({ children, gap = "medium", minItemWidth = "16rem", className, style, ...props }: GridProps) {
  return <div {...props} className={classes("ds-grid", gap, className)} style={{ "--ds-grid-min": minItemWidth, ...style } as CSSProperties}>{children}</div>;
}

export interface SidebarProps extends LayoutProps {
  sidebar: ReactNode;
  side?: "start" | "end";
  sidebarWidth?: string;
  contentMinWidth?: string;
}

/** Two-area layout that collapses naturally when the primary content would become too narrow. */
export function Sidebar({ sidebar, children, side = "start", sidebarWidth = "18rem", contentMinWidth = "28rem", gap = "large", className, style, ...props }: SidebarProps) {
  return <div {...props} className={`ds-sidebar ds-sidebar--${side} ds-sidebar--gap-${gap}${className ? ` ${className}` : ""}`} style={{ "--ds-sidebar-width": sidebarWidth, "--ds-content-min": contentMinWidth, ...style } as CSSProperties}>
    {side === "start" && <div className="ds-sidebar__aside">{sidebar}</div>}
    <div className="ds-sidebar__content">{children}</div>
    {side === "end" && <div className="ds-sidebar__aside">{sidebar}</div>}
  </div>;
}

export interface PageProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  width?: "standard" | "wide" | "full";
}

/** Width-constrained page content; application shells remain responsible for the main landmark. */
export function Page({ children, width = "standard", className = "", ...props }: PageProps) {
  return <div {...props} className={`ds-page ds-page--${width}${className ? ` ${className}` : ""}`}>{children}</div>;
}

export interface SectionProps extends HTMLAttributes<HTMLElement> {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

/** Labelled page section with optional contextual actions. */
export function Section({ title, description, actions, children, className = "", ...props }: SectionProps) {
  const titleId = useId();
  return <section {...props} className={`ds-section${className ? ` ${className}` : ""}`} aria-labelledby={titleId}>
    <header className="ds-section__header"><div><h2 id={titleId}>{title}</h2>{description && <div className="ds-section__description">{description}</div>}</div>{actions && <div className="ds-section__actions">{actions}</div>}</header>
    {children}
  </section>;
}

export interface StickyActionAreaProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  label?: string;
}

/** Persistent action region with an explicit accessible label. */
export function StickyActionArea({ children, label = "Page actions", className = "", ...props }: StickyActionAreaProps) {
  return <div {...props} className={`ds-sticky-actions${className ? ` ${className}` : ""}`} role="region" aria-label={label}>{children}</div>;
}
