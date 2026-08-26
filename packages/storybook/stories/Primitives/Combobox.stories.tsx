import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Combobox, type ComboboxOption } from "@gallery/design-system";

const collections: ComboboxOption[] = [
  { value: "portfolio", label: "Portfolio", description: "24 Works" },
  { value: "night", label: "夜の作品 — Night studies", description: "8 Works" },
  { value: "review", label: "Editorial review", description: "Editor permission required", disabled: true }
];
const meta = { title: "Primitives/Fields/Combobox", component: Combobox,
  parameters: { docs: { description: { component: "Controlled searchable selection with combobox/listbox semantics, active-option announcement, keyboard navigation, loading, empty, restricted, and server-error states." } } }
} satisfies Meta<typeof Combobox>;
export default meta;
type Story = StoryObj<typeof meta>;

function Example({ options = collections, loading = false, error }: { options?: ComboboxOption[]; loading?: boolean; error?: string }) { const [query, setQuery] = useState(""); const [open, setOpen] = useState(true); return <Combobox label="Choose a collection" description="Search permitted collections." query={query} options={options.filter((option) => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))} open={open} onOpenChange={setOpen} onQueryChange={setQuery} onSelect={(option) => setQuery(option.label)} loading={loading} error={error} />; }
export const Populated: Story = { render: () => <Example /> };
export const Loading: Story = { render: () => <Example options={[]} loading /> };
export const NoMatches: Story = { render: () => <Example options={[]} /> };
export const ServerRejected: Story = { render: () => <Example error="Collections could not be loaded. Try again." /> };
export const Disabled: Story = { args: { label: "Choose a collection", query: "", options: [], open: false, disabled: true, onOpenChange: () => undefined, onQueryChange: () => undefined, onSelect: () => undefined } };
