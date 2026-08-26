import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Button, IconButton, LinkButton, SplitButton } from "@gallery/design-system";

const meta = { title: "Primitives/Buttons/Button", component: Button,
  parameters: { docs: { description: { component: "Standard action control with visible keyboard focus. Loading replaces the label, announces busy state, and disables repeated activation. Destructive styling communicates intent but never performs confirmation or authorization itself." } } },
  args: { children: "Save changes", variant: "primary" }
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Primary: Story = {};
export const Secondary: Story = { args: { variant: "secondary" } };
export const Destructive: Story = { args: { variant: "destructive", children: "Delete Work" } };
export const Disabled: Story = { args: { disabled: true } };
export const Loading: Story = { args: { loading: true, loadingLabel: "Saving changes…" } };
export const LongLocalizedLabel: Story = { args: { children: "変更を保存して公開ワークスペースに戻る" } };
export const IconOnly = { render: () => <IconButton accessibleName="Close dialog" icon="×" variant="secondary" /> };
export const LinkStyledAsButton = { render: () => <LinkButton href="#destination">Review destination</LinkButton> };
export const DisabledLink = { render: () => <LinkButton href="#destination" disabled>Destination unavailable</LinkButton> };
export const PublishSplitButton = { render: () => { const [open, setOpen] = useState(false); return <SplitButton primaryLabel="Publish to Eversally" onPrimaryAction={() => undefined} menuLabel="Other publication actions" open={open} onOpenChange={setOpen} items={[{ id: "schedule", label: "Schedule for Eversally", onSelect: () => undefined }, { id: "draft", label: "Save as draft", onSelect: () => undefined }, { id: "nightframe", label: "Publish to Nightframe — unavailable", disabled: true, onSelect: () => undefined }]} />; } };
export const LoadingSplitButton = { render: () => <SplitButton primaryLabel="Publish" onPrimaryAction={() => undefined} menuLabel="Other publication actions" open={false} onOpenChange={() => undefined} items={[]} loading loadingLabel="Submitting request…" /> };
export const DestructiveSplitButton = { render: () => <SplitButton primaryLabel="Withdraw publication" onPrimaryAction={() => undefined} menuLabel="Other withdrawal actions" open={false} onOpenChange={() => undefined} items={[]} variant="destructive" /> };
