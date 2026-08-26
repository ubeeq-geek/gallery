import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbsProps {
  items: readonly BreadcrumbItem[];
  label?: string;
}

/** A location trail. The final item is always rendered as the current page. */
export function Breadcrumbs({ items, label = "Breadcrumb" }: BreadcrumbsProps) {
  if (items.length === 0) return null;
  return <nav className="ds-breadcrumbs" aria-label={label}><ol>{items.map((item, index) => {
    const current = index === items.length - 1;
    return <li key={`${item.label}-${index}`}>
      {index > 0 && <span className="ds-breadcrumbs__separator" aria-hidden="true">/</span>}
      {current ? <span aria-current="page">{item.label}</span> : item.href ? <a href={item.href}>{item.label}</a> : <span>{item.label}</span>}
    </li>;
  })}</ol></nav>;
}

export interface TabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  label: string;
  items: readonly TabItem[];
  value: string;
  onValueChange: (value: string) => void;
}

/** Controlled tabs with roving focus and automatic activation for arrow keys. */
export function Tabs({ label, items, value, onValueChange }: TabsProps) {
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = items.find((item) => item.value === value && !item.disabled) ?? items.find((item) => !item.disabled);

  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const enabled = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled);
    if (enabled.length === 0) return;
    const position = enabled.findIndex(({ index }) => index === from);
    let target;
    if (event.key === "Home") target = enabled[0];
    else if (event.key === "End") target = enabled[enabled.length - 1];
    else if (event.key === "ArrowRight") target = enabled[(position + 1) % enabled.length];
    else if (event.key === "ArrowLeft") target = enabled[(position - 1 + enabled.length) % enabled.length];
    else return;
    event.preventDefault();
    onValueChange(target.item.value);
    tabRefs.current[target.index]?.focus();
  };

  return <div className="ds-tabs">
    <div className="ds-tabs__list" role="tablist" aria-label={label}>{items.map((item, index) => {
      const active = item.value === selected?.value;
      return <button
        key={item.value}
        ref={(node) => { tabRefs.current[index] = node; }}
        id={`${baseId}-tab-${index}`}
        type="button"
        role="tab"
        aria-selected={active}
        aria-controls={`${baseId}-panel-${index}`}
        tabIndex={active ? 0 : -1}
        disabled={item.disabled}
        onClick={() => onValueChange(item.value)}
        onKeyDown={(event) => move(event, index)}
      >{item.label}</button>;
    })}</div>
    {selected && (() => {
      const index = items.indexOf(selected);
      return <div className="ds-tabs__panel" id={`${baseId}-panel-${index}`} role="tabpanel" aria-labelledby={`${baseId}-tab-${index}`} tabIndex={0}>{selected.content}</div>;
    })()}
  </div>;
}

export interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  label?: string;
  previousLabel?: string;
  nextLabel?: string;
}

function paginationItems(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = [...new Set([1, total, current - 1, current, current + 1].filter((page) => page >= 1 && page <= total))].sort((a, b) => a - b);
  const result: Array<number | "ellipsis"> = [];
  pages.forEach((page, index) => {
    if (index > 0 && page - pages[index - 1] > 1) result.push("ellipsis");
    result.push(page);
  });
  return result;
}

/** Controlled, bounded pagination with explicit current-page and disabled-edge semantics. */
export function Pagination({ currentPage, totalPages, onPageChange, label = "Pagination", previousLabel = "Previous page", nextLabel = "Next page" }: PaginationProps) {
  const total = Number.isFinite(totalPages) ? Math.max(1, Math.floor(totalPages)) : 1;
  const requestedPage = Number.isFinite(currentPage) ? Math.floor(currentPage) : 1;
  const current = Math.min(Math.max(1, requestedPage), total);
  return <nav className="ds-pagination" aria-label={label}><ul>
    <li><button type="button" disabled={current === 1} aria-label={previousLabel} onClick={() => onPageChange(current - 1)}>← <span>Previous</span></button></li>
    {paginationItems(current, total).map((item, index) => item === "ellipsis"
      ? <li key={`ellipsis-${index}`}><span className="ds-pagination__ellipsis" aria-hidden="true">…</span></li>
      : <li key={item}><button type="button" aria-current={item === current ? "page" : undefined} aria-label={item === current ? `Page ${item}, current page` : `Go to page ${item}`} onClick={() => onPageChange(item)}>{item}</button></li>
    )}
    <li><button type="button" disabled={current === total} aria-label={nextLabel} onClick={() => onPageChange(current + 1)}><span>Next</span> →</button></li>
  </ul></nav>;
}

export interface ResultsSummaryProps {
  from: number;
  to: number;
  total: number;
  noun?: string;
}

/** Stable, screen-reader-friendly result range for paginated lists and tables. */
export function ResultsSummary({ from, to, total, noun = "results" }: ResultsSummaryProps) {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const requestedFrom = Number.isFinite(from) ? Math.floor(from) : 1;
  const requestedTo = Number.isFinite(to) ? Math.floor(to) : requestedFrom;
  const safeFrom = safeTotal === 0 ? 0 : Math.min(Math.max(1, requestedFrom), safeTotal);
  const safeTo = safeTotal === 0 ? 0 : Math.min(Math.max(safeFrom, requestedTo), safeTotal);
  return <p className="ds-results-summary" aria-live="polite">Showing <strong>{safeFrom}–{safeTo}</strong> of <strong>{safeTotal}</strong> {noun}</p>;
}
