import type { ReactNode } from 'react';

export function DataToolbar({
  search,
  onSearchChange,
  searchPlaceholder,
  filters,
  primaryAction
}: {
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  filters?: ReactNode;
  primaryAction?: ReactNode;
}) {
  return (
    <div className="studio-toolbar">
      <div className="studio-toolbar-search">
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
        />
      </div>
      <div className="studio-toolbar-actions">
        {filters}
        {primaryAction}
      </div>
    </div>
  );
}
