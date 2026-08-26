import type { Meta, StoryObj } from "@storybook/react";
import { Avatar, Badge, Chip, ChipList, LoadingState, ProgressIndicator, Skeleton } from "@gallery/design-system";

const meta = { title: "Primitives/Display/Operational feedback", component: ProgressIndicator,
  parameters: { docs: { description: { component: "Accessible progress and loading feedback never presents indeterminate provider work as complete. Skeletons are decorative; LoadingState supplies the announced context." } } }
} satisfies Meta<typeof ProgressIndicator>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ProcessingMedia: Story = { args: { label: "Processing media", value: 42, detail: "Generating delivery variants. The Asset is not ready yet." } };
export const Reconciling: Story = { args: { label: "Reconciling YouTube publication", detail: "Waiting for the provider to verify the outcome." } };
export const WorkspaceLoading = { render: () => <LoadingState label="Loading destination states" detail="Fetching the latest permitted status for each destination." rows={5} /> };
export const SkeletonShapes = { render: () => <div style={{ display: "grid", gap: 12, maxWidth: 360 }}><Skeleton shape="circle" width={64} /><Skeleton /><Skeleton shape="rectangle" /></div> };
export const StatusBadges = { render: () => <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><Badge tone="success">Published</Badge><Badge tone="pending">Processing</Badge><Badge tone="restricted">Held</Badge><Badge tone="danger">Failed</Badge><Badge tone="unavailable">Unavailable</Badge></div> };
export const CreatorAvatarFallback = { render: () => <Avatar name="山田 Ana" size="large" /> };
export const CollectionChips = { render: () => <ChipList label="Selected collections"><Chip label="Portfolio" onRemove={() => undefined} removeLabel="Remove Portfolio" /><Chip label="夜の作品 — a collection with a deliberately long localized name" onRemove={() => undefined} removeLabel="Remove 夜の作品" /><Chip label="Editorial review" disabled onRemove={() => undefined} removeLabel="Remove Editorial review" /></ChipList> };
export const ReadOnlyMetadataChips = { render: () => <ChipList label="Work tags"><Chip label="Photography" /><Chip label="Long exposure" /><Chip label="城市夜景" /></ChipList> };
