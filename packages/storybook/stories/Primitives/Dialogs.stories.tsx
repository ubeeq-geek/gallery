import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Button, ConfirmationDialog, Dialog, Drawer } from "@gallery/design-system";

const meta = {
  title: "Primitives/Dialogs/Dialog",
  component: Dialog,
  parameters: { docs: { description: { component: "Controlled modal dialog with native focus containment, Escape handling, labelled content, and an application-owned close event. Visual confirmation never replaces server-side authorization." } } }
} satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Informational: Story = { render: () => {
  const [open, setOpen] = useState(false);
  return <><Button onClick={() => setOpen(true)}>Review destination details</Button><Dialog open={open} onOpenChange={setOpen} title="Eversally publication" description="This status is separate from the canonical Work."><p>Publishing makes this Work visible only at the selected Eversally destination.</p></Dialog></>;
} };

export const DestructiveConfirmation: Story = { render: () => {
  const [open, setOpen] = useState(false);
  return <><Button variant="destructive" onClick={() => setOpen(true)}>Withdraw publication</Button><ConfirmationDialog open={open} onOpenChange={setOpen} title="Withdraw from Eversally?" description="This action affects one destination." consequence="The Eversally publication will become unavailable. The canonical Ubeeq Work and other destinations remain unchanged." confirmLabel="Withdraw from Eversally" destructive onConfirm={() => setOpen(false)} /></>;
} };

export const Confirming: Story = { render: () => <ConfirmationDialog open onOpenChange={() => undefined} title="Disconnect Discord?" consequence="New sync and publication requests will stop. Existing canonical Works remain unchanged." confirmLabel="Disconnect Discord" destructive confirming confirmingLabel="Disconnecting…" onConfirm={() => undefined} /> };

export const AssetDetailsDrawer = { render: () => {
  const [open, setOpen] = useState(false);
  return <><Button onClick={() => setOpen(true)}>Review Asset details</Button><Drawer open={open} onOpenChange={setOpen} title="Asset details" description="Canonical media stored by Ubeeq." actions={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button>Save metadata</Button></>}><dl><dt>Processing state</dt><dd>Needs review</dd><dt>Source control</dt><dd>Canonical Ubeeq Asset</dd></dl></Drawer></>;
} };

export const StartDrawerWithLongContent = { render: () => <Drawer open placement="start" onOpenChange={() => undefined} title="Destination filters" description="Filter the visible publication records without changing their authoritative states."><p>Destination, provider, publication state, verification time, creator permission, and recovery availability.</p></Drawer> };
