import type { ReactNode } from 'react';

export type CrudRow = {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
  badges?: ReactNode;
};

export function CrudTable({
  rows,
  selectedId,
  onSelect,
  emptyMessage
}: {
  rows: CrudRow[];
  selectedId?: string;
  onSelect: (row: CrudRow) => void;
  emptyMessage: string;
}) {
  if (!rows.length) {
    return <div className="studio-empty-state">{emptyMessage}</div>;
  }

  return (
    <div className="studio-crud-table">
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className={`studio-crud-row${row.id === selectedId ? ' studio-crud-row-active' : ''}`}
          onClick={() => onSelect(row)}
        >
          <div className="studio-crud-row-copy">
            <strong>{row.title}</strong>
            {row.subtitle && <span>{row.subtitle}</span>}
            {row.meta && <small>{row.meta}</small>}
          </div>
          {row.badges && <div className="studio-crud-row-badges">{row.badges}</div>}
        </button>
      ))}
    </div>
  );
}
