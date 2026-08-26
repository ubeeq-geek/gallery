import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Button, MenuButton, Tooltip } from "@gallery/design-system";

const meta = { title: "Primitives/Overlays/Action menu", component: MenuButton,
  parameters: { docs: { description: { component: "Controlled action menus support Arrow keys, Home, End, Escape, disabled actions, and focus return. Applications must pass only server-permitted actions. Tooltips are supplemental and appear on both hover and focus." } } }
} satisfies Meta<typeof MenuButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WorkActions: Story = { render: () => { const [open, setOpen] = useState(false); return <MenuButton label="Work actions" open={open} onOpenChange={setOpen} items={[{ id: "edit", label: "Edit canonical Work", onSelect: () => undefined }, { id: "retry", label: "Retry Eversally publication", onSelect: () => undefined }, { id: "nightframe", label: "Publish to Nightframe — unavailable", disabled: true, onSelect: () => undefined }, { id: "delete", label: "Delete canonical Work", destructive: true, onSelect: () => undefined }]} />; } };
export const EmptyMenu: Story = { args: { label: "Destination actions", open: true, onOpenChange: () => undefined, items: [] } };
export const DisabledMenu: Story = { args: { label: "Actions unavailable", open: false, disabled: true, onOpenChange: () => undefined, items: [] } };
export const FocusableTooltip = { render: () => <Tooltip content="Last verified by YouTube at 12:00 UTC"><Button variant="secondary">Verification details</Button></Tooltip> };
