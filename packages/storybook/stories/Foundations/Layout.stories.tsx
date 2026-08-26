import type { Meta, StoryObj } from "@storybook/react";
import { Button, Cluster, Grid, Page, Section, Sidebar, Stack, StickyActionArea } from "@gallery/design-system";

const meta = { title: "Foundations/Spacing and layout", component: Stack,
  parameters: { docs: { description: { component: "Semantic layout primitives provide consistent spacing and responsive composition without embedding product policy or application data behavior." } } }
} satisfies Meta<typeof Stack>;
export default meta;
type Story = StoryObj<typeof meta>;
const panel = (text: string) => <div style={{ minHeight: 80, padding: 16, border: "1px solid var(--ds-border-muted)", borderRadius: 8 }}>{text}</div>;

export const FocusedWorkspace: Story = { render: () => <Page width="wide"><Stack gap="large"><Section title="Publishing destinations" description="Each destination retains its own authoritative status." actions={<Button>Choose destination</Button>}><Sidebar sidebar={panel("Filters and destination context")}>{panel("Destination-specific status and recovery workspace")}</Sidebar></Section><StickyActionArea><Button variant="secondary">Cancel</Button><Button>Save changes</Button></StickyActionArea></Stack></Page> };
export const ResponsiveEntityGrid = { render: () => <Grid minItemWidth="15rem">{["Work one", "Work two", "Work three", "Work with a very long localized title"].map(panel)}</Grid> };
export const ActionCluster = { render: () => <Cluster gap="small"><Button>Publish</Button><Button variant="secondary">Save draft</Button><Button variant="secondary">Export</Button></Cluster> };
