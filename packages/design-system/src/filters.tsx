import type { HTMLAttributes, ReactNode } from "react";

export interface FilterBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  label?: string;
  search?: ReactNode;
  filters?: ReactNode;
  actions?: ReactNode;
  status?: ReactNode;
}

/** Responsive search/filter composition; applications own query state and permitted options. */
export function FilterBar({ label = "Filter results", search, filters, actions, status, className = "", ...props }: FilterBarProps) {
  return <div {...props} className={`ds-filter-bar${className ? ` ${className}` : ""}`} role="search" aria-label={label}>
    {(search || filters) && <div className="ds-filter-bar__controls">{search}{filters && <div className="ds-filter-bar__filters">{filters}</div>}</div>}
    {actions && <div className="ds-filter-bar__actions">{actions}</div>}
    {status && <div className="ds-filter-bar__status">{status}</div>}
  </div>;
}
