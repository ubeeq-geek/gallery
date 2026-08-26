import { useId } from "react";

export interface CollectionOption {
  id: string;
  name: string;
  workCount: number;
  unavailableReason?: string;
}

export interface CollectionSelectorProps {
  label: string;
  collections: readonly CollectionOption[];
  selectedIds: readonly string[];
  query: string;
  onQueryChange?: (query: string) => void;
  onSelectionChange?: (collectionId: string, selected: boolean) => void;
  state?: "ready" | "loading" | "error" | "permission_restricted";
  readOnly?: boolean;
  message?: string;
}

export function CollectionSelector({ label, collections, selectedIds, query, onQueryChange, onSelectionChange, state = "ready", readOnly = false, message }: CollectionSelectorProps) {
  const inputId = useId();
  const messageId = useId();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = collections.filter(collection => collection.name.toLocaleLowerCase().includes(normalizedQuery));
  const unavailable = state === "loading" || state === "error" || state === "permission_restricted";

  return <section className="ds-collection-selector" aria-busy={state === "loading" || undefined}>
    <label className="ds-field-label" htmlFor={inputId}>{label}</label>
    <input id={inputId} className="ds-input" type="search" value={query} disabled={unavailable} readOnly={!onQueryChange} onChange={event => onQueryChange?.(event.currentTarget.value)} placeholder="Search collections" aria-describedby={message ? messageId : undefined} />
    {message && <div id={messageId} className="ds-field-message" role={state === "error" ? "alert" : "status"}>{message}</div>}
    {state === "loading" ? <div className="ds-selector-state" role="status">Loading collections…</div>
      : state === "error" ? <div className="ds-selector-state">Collections could not be loaded.</div>
      : state === "permission_restricted" ? <div className="ds-selector-state">You do not have permission to change collection associations.</div>
      : visible.length === 0 ? <div className="ds-selector-state">{collections.length === 0 ? "No collections yet." : "No collections match your search."}</div>
      : <>
        <div className="ds-field-message" aria-live="polite">{visible.length} {visible.length === 1 ? "collection" : "collections"}</div>
        <ul className="ds-collection-options" aria-label={label}>
          {visible.map(collection => {
            const checked = selectedIds.includes(collection.id);
            const disabled = readOnly || Boolean(collection.unavailableReason);
            return <li key={collection.id}>
              <label className={`ds-collection-option${collection.unavailableReason ? " ds-collection-option--restricted" : ""}`}>
                <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onSelectionChange?.(collection.id, event.currentTarget.checked)} />
                <span><strong>{collection.name}</strong><br /><span className="ds-collection-option__meta">{collection.workCount} {collection.workCount === 1 ? "Work" : "Works"}{collection.unavailableReason ? ` · ${collection.unavailableReason}` : ""}</span></span>
              </label>
            </li>;
          })}
        </ul>
      </>}
  </section>;
}
