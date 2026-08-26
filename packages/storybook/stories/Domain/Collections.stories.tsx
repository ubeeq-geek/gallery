import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { CollectionSelector, type CollectionSelectorProps } from "@gallery/design-system";

const fixtures = [
  { id: "portfolio", name: "Portfolio · 作品集", workCount: 18 },
  { id: "archive", name: "An exceptionally long collection name used to verify robust wrapping in narrow workspaces", workCount: 204 },
  { id: "review", name: "Private review", workCount: 3, unavailableReason: "Editor permission required" }
];
const meta = { title: "Domain/Collections/Collection selector", component: CollectionSelector,
  parameters: { docs: { description: { component: "Searchable multi-select association for Collections. Selection props reflect application state; unavailable options and whole-selector permission restrictions are explicit and cannot be bypassed with Storybook controls." } } },
  args: { label: "Add this Work to collections", collections: fixtures, selectedIds: ["portfolio"], query: "" }
} satisfies Meta<typeof CollectionSelector>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Interactive: Story = { render: (args: CollectionSelectorProps) => {
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<readonly string[]>(["portfolio"]);
  return <CollectionSelector {...args} query={query} selectedIds={selectedIds} onQueryChange={setQuery} onSelectionChange={(id: string, selected: boolean) => setSelectedIds(current => selected ? [...current, id] : current.filter(value => value !== id))} />;
} };
export const Loading: Story = { args: { state: "loading", collections: [], selectedIds: [], message: "Loading associations from the canonical service." } };
export const Empty: Story = { args: { collections: [], selectedIds: [] } };
export const NoSearchResults: Story = { args: { query: "not present" } };
export const ReadOnly: Story = { args: { readOnly: true, message: "You can view associations but cannot change them." } };
export const PermissionRestricted: Story = { args: { state: "permission_restricted", collections: [], selectedIds: [], message: "The deployment backend did not grant edit access." } };
export const ServerError: Story = { args: { state: "error", collections: [], selectedIds: [], message: "The canonical service rejected this request. Try again later." } };
