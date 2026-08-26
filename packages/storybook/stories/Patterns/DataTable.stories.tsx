import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Badge, DataTable, type TableSort } from "@gallery/design-system";

type Row = { id: string; work: string; destination: string; state: "published" | "held" | "failed"; updated: string };
const rows: Row[] = [
  { id: "1", work: "Evening studies", destination: "Eversally", state: "published", updated: "26 Aug 2026, 12:00" },
  { id: "2", work: "夜の庭 — a deliberately long localized Work title", destination: "Nightframe", state: "held", updated: "26 Aug 2026, 11:32" },
  { id: "3", work: "No-preview composition", destination: "YouTube", state: "failed", updated: "25 Aug 2026, 18:14" }
];
const columns = [
  { id: "work", header: "Work", sortable: true, cell: (row: Row) => <strong>{row.work}</strong> },
  { id: "destination", header: "Destination", sortable: true, cell: (row: Row) => row.destination },
  { id: "state", header: "State", cell: (row: Row) => <Badge tone={row.state === "published" ? "success" : row.state === "held" ? "restricted" : "danger"}>{row.state}</Badge> },
  { id: "updated", header: "Last verified", cell: (row: Row) => <time dateTime="2026-08-26T12:00:00Z">{row.updated}</time> }
] as const;

const meta = { title: "Patterns/Data table", component: DataTable,
  parameters: { docs: { description: { component: "Semantic table for desktop with a labelled description-list card alternative on narrow screens. Sorting is controlled by the application and never changes authoritative data itself." } } }
} satisfies Meta<typeof DataTable<Row>>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DestinationStates: Story = { render: () => { const [sort, setSort] = useState<TableSort>({ columnId: "updated", direction: "descending" }); return <DataTable caption="Publication destinations" columns={columns} rows={rows} rowKey={(row) => row.id} sort={sort} onSortChange={setSort} />; } };
export const Empty: Story = { render: () => <DataTable caption="Publication destinations" columns={columns} rows={[]} rowKey={(row) => row.id} emptyTitle="No destinations match" emptyDetail="Clear filters or choose another publication state." /> };
