import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Button, FilterBar, Pagination, ResultsSummary, SelectField, TextField } from "@gallery/design-system";

const meta = { title: "Patterns/List controls", component: FilterBar,
  parameters: { docs: { description: { component: "Responsive list controls compose application-owned search, filters, permitted actions, result ranges, and bounded pagination without accepting API response objects." } } }
} satisfies Meta<typeof FilterBar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WorksFilterBar: Story = { render: () => <FilterBar search={<TextField label="Search Works" placeholder="Title or identifier" />} filters={<><SelectField label="Visibility" options={[{ value: "all", label: "All visibility" }, { value: "private", label: "Private" }, { value: "public", label: "Public" }]} /><SelectField label="Destination state" options={[{ value: "all", label: "All states" }, { value: "held", label: "Held" }, { value: "failed", label: "Failed" }]} /></>} actions={<Button variant="secondary">Clear filters</Button>} status={<ResultsSummary from={1} to={24} total={238} noun="Works" />} /> };
export const ManyPages = { render: () => { const [page, setPage] = useState(48); return <Pagination currentPage={page} totalPages={120} onPageChange={setPage} label="Works pages" />; } };
export const FirstPage = { render: () => <Pagination currentPage={1} totalPages={4} onPageChange={() => undefined} /> };
export const EmptyResults = { render: () => <ResultsSummary from={0} to={0} total={0} noun="destinations" /> };
