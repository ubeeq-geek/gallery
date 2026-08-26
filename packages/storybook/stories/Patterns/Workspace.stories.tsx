import type { Meta, StoryObj } from "@storybook/react";
import { EmptyState, PageHeader, WorkspaceShell, type WorkspaceShellProps } from "@gallery/design-system";

const items = [
  { id: "works", label: "Works", href: "#works" }, { id: "assets", label: "Assets", href: "#assets" },
  { id: "collections", label: "Collections", href: "#collections" }, { id: "publishing", label: "Publishing", href: "#publishing" },
  { id: "integrations", label: "Integrations", href: "#integrations" }
];
const meta = { title: "Patterns/Workspace/Focused workspace", component: WorkspaceShell,
  parameters: { layout: "fullscreen", docs: { description: { component: "A spacious creator control-centre shell. It always identifies the current product and authority; navigation leads to focused workspaces rather than competing dashboard panels." } } },
  args: { productId: "ubeeq", displayName: "Ubeeq", workspaceName: "Creator Area", authorityLabel: "This deployment’s account and policy", items, currentItemId: "works", children: null }
} satisfies Meta<typeof WorkspaceShell>;
export default meta;
type Story = StoryObj<typeof meta>;
export const WorksEmpty: Story = { render: (args: WorkspaceShellProps) => <WorkspaceShell {...args}><PageHeader eyebrow="Creator catalogue" title="Works" description="Manage canonical Works here. Destination visibility and remote Publications remain separate." actions={<button type="button" className="ds-button">Create Work</button>} /><EmptyState title="No Works yet" description="Create a Work to organize Assets and choose publication destinations." action={<button type="button" className="ds-button">Create your first Work</button>} /></WorkspaceShell> };
export const EversallyContext: Story = { args: { productId: "eversally", displayName: "Eversally", workspaceName: "Eversally Space", authorityLabel: "Eversally account and policy" }, render: (args: WorkspaceShellProps) => <WorkspaceShell {...args}><PageHeader title="Publishing" description="Review each destination independently before confirming publication." /><p>Focused publishing workspace content</p></WorkspaceShell> };
export const NightframeContext: Story = { args: { productId: "nightframe", displayName: "Nightframe", workspaceName: "Creator control centre", authorityLabel: "Nightframe account and policy", currentItemId: "integrations" }, render: (args: WorkspaceShellProps) => <WorkspaceShell {...args}><PageHeader title="Integrations" description="Connections and permissions belong to this Nightframe deployment." /><p>Focused integration workspace content</p></WorkspaceShell> };
