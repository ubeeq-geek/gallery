import type { ReactNode } from "react";
import type { ProductId } from "./product-config.js";

export interface WorkspaceNavItem { id: string; label: string; href: string }

export interface ProductContextProps {
  productId: ProductId;
  displayName: string;
  workspaceName: string;
  authorityLabel: string;
}

export function ProductContext({ productId, displayName, workspaceName, authorityLabel }: ProductContextProps) {
  return <header className="ds-product-context" data-product={productId}>
    <strong>{displayName}</strong>
    <span>{workspaceName} · {authorityLabel}</span>
  </header>;
}

export interface WorkspaceShellProps extends ProductContextProps {
  navigationLabel?: string;
  items: readonly WorkspaceNavItem[];
  currentItemId: string;
  children: ReactNode;
}

export function WorkspaceShell({ items, currentItemId, navigationLabel = "Creator workspace", children, ...context }: WorkspaceShellProps) {
  return <div className="ds-workspace-shell" data-product-theme={context.productId}>
    <ProductContext {...context} />
    <div className="ds-workspace-shell__layout">
      <nav className="ds-workspace-nav" aria-label={navigationLabel}><ul>{items.map(item => <li key={item.id}>
        <a href={item.href} aria-current={item.id === currentItemId ? "page" : undefined}>{item.label}</a>
      </li>)}</ul></nav>
      <main className="ds-workspace-main">{children}</main>
    </div>
  </div>;
}

export interface PageHeaderProps { title: string; description?: string; eyebrow?: string; actions?: ReactNode }
export function PageHeader({ title, description, eyebrow, actions }: PageHeaderProps) {
  return <header className="ds-page-header"><div>
    {eyebrow && <div className="ds-work-card__eyebrow">{eyebrow}</div>}
    <h1>{title}</h1>{description && <p>{description}</p>}
  </div>{actions && <div className="ds-page-header__actions">{actions}</div>}</header>;
}

export interface EmptyStateProps { title: string; description: string; action?: ReactNode; secondaryAction?: ReactNode }
export function EmptyState({ title, description, action, secondaryAction }: EmptyStateProps) {
  return <section className="ds-empty-state"><h2>{title}</h2><p>{description}</p>
    {(action || secondaryAction) && <div className="ds-page-header__actions">{action}{secondaryAction}</div>}
  </section>;
}
