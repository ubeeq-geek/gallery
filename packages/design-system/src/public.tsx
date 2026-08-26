import { useId, type ReactNode } from "react";
import { Avatar } from "./display.js";
import type { ProductId } from "./product-config.js";

export interface PublicNavigationItem {
  id: string;
  label: string;
  href: string;
}

export interface PublicProductHeaderProps {
  productId: ProductId;
  displayName: string;
  authorityLabel: string;
  navigationLabel?: string;
  navigation?: readonly PublicNavigationItem[];
  currentItemId?: string;
  actions?: ReactNode;
}

/** Identifies the service hosting a public page without implying shared identity or authority. */
export function PublicProductHeader({ productId, displayName, authorityLabel, navigationLabel = "Public navigation", navigation = [], currentItemId, actions }: PublicProductHeaderProps) {
  return <header className="ds-public-product-header" data-product={productId}>
    <div className="ds-public-product-header__identity">
      <strong>{displayName}</strong>
      <span>{authorityLabel}</span>
    </div>
    {navigation.length > 0 && <nav aria-label={navigationLabel}><ul>{navigation.map(item => <li key={item.id}>
      <a href={item.href} aria-current={item.id === currentItemId ? "page" : undefined}>{item.label}</a>
    </li>)}</ul></nav>}
    {actions && <div className="ds-public-product-header__actions" aria-label={`${displayName} account actions`}>{actions}</div>}
  </header>;
}

export interface CreatorProfileHeaderProps {
  creatorName: string;
  profileLabel: string;
  hostService: string;
  homeService: string;
  description?: string;
  imageUrl?: string;
  metadata?: ReactNode;
  actions?: ReactNode;
}

/** Presents public creator identity while keeping the current host and creator home service explicit. */
export function CreatorProfileHeader({ creatorName, profileLabel, hostService, homeService, description, imageUrl, metadata, actions }: CreatorProfileHeaderProps) {
  const headingId = useId();
  return <section className="ds-creator-profile-header" aria-labelledby={headingId}>
    <Avatar name={creatorName} src={imageUrl} size="large" />
    <div className="ds-creator-profile-header__body">
      <span className="ds-creator-profile-header__eyebrow">{profileLabel} on {hostService}</span>
      <h1 id={headingId}>{creatorName}</h1>
      <p className="ds-creator-profile-header__authority">Home service: <strong>{homeService}</strong>. This page is presented under {hostService}’s account and policy authority.</p>
      {description && <p className="ds-creator-profile-header__description">{description}</p>}
      {metadata && <div className="ds-creator-profile-header__metadata">{metadata}</div>}
    </div>
    {actions && <div className="ds-creator-profile-header__actions" aria-label={`${creatorName} profile actions`}>{actions}</div>}
  </section>;
}
