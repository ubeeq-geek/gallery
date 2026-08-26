import type { ReactNode } from "react";

export type SortDirection = "ascending" | "descending";
export interface TableSort { columnId: string; direction: SortDirection }

export interface TableColumn<Row> {
  id: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  sortable?: boolean;
  numeric?: boolean;
  mobileLabel?: ReactNode;
}

export interface DataTableProps<Row> {
  caption: string;
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  sort?: TableSort;
  onSortChange?: (sort: TableSort) => void;
  emptyTitle?: string;
  emptyDetail?: ReactNode;
}

function nextDirection(columnId: string, sort?: TableSort): SortDirection {
  return sort?.columnId === columnId && sort.direction === "ascending" ? "descending" : "ascending";
}

/**
 * Semantic data table with a narrow-screen description-list alternative.
 * Sorting is controlled: applications remain responsible for authoritative data order.
 */
export function DataTable<Row>({ caption, columns, rows, rowKey, sort, onSortChange, emptyTitle = "No results", emptyDetail }: DataTableProps<Row>) {
  const renderEmpty = () => <div className="ds-data-table__empty"><strong>{emptyTitle}</strong>{emptyDetail && <div>{emptyDetail}</div>}</div>;
  return <div className="ds-data-table">
    <div className="ds-data-table__scroll">
      <table>
        <caption>{caption}</caption>
        <thead><tr>{columns.map((column) => {
          const active = sort?.columnId === column.id;
          return <th key={column.id} scope="col" aria-sort={column.sortable && active ? sort.direction : undefined} className={column.numeric ? "ds-data-table__numeric" : undefined}>
            {column.sortable && onSortChange ? <button type="button" onClick={() => onSortChange({ columnId: column.id, direction: nextDirection(column.id, sort) })}>{column.header}<span aria-hidden="true"> {active ? sort.direction === "ascending" ? "↑" : "↓" : "↕"}</span></button> : column.header}
          </th>;
        })}</tr></thead>
        <tbody>{rows.length === 0 ? <tr><td colSpan={Math.max(1, columns.length)}>{renderEmpty()}</td></tr> : rows.map((row) => <tr key={rowKey(row)}>{columns.map((column) => <td key={column.id} className={column.numeric ? "ds-data-table__numeric" : undefined}>{column.cell(row)}</td>)}</tr>)}</tbody>
      </table>
    </div>
    <div className="ds-data-table__cards" aria-label={`${caption}, compact view`}>
      {rows.length === 0 ? renderEmpty() : <ul>{rows.map((row) => <li key={rowKey(row)}><dl>{columns.map((column) => <div key={column.id}><dt>{column.mobileLabel ?? column.header}</dt><dd>{column.cell(row)}</dd></div>)}</dl></li>)}</ul>}
    </div>
  </div>;
}
