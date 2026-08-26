import type { Meta, StoryObj } from "@storybook/react";
import { DestinationStatus, PublicationTimeline } from "@gallery/design-system";

const meta = { title: "Domain/Publishing/Destination status", component: DestinationStatus,
  parameters: { docs: { description: { component: "Shows one authoritative destination snapshot. It does not grant publication access or change the canonical Work. State is conveyed with text, shape, and colour; provider errors must be converted to creator-safe explanations." } } },
  args: { destination: "Eversally Space", state: "published", explanation: "Visible in this Space. The canonical Work remains stored by its home service.", lastVerifiedAt: "2026-08-26T12:00:00Z" }
} satisfies Meta<typeof DestinationStatus>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Published: Story = {};
export const PendingReview: Story = { args: { state: "pending_review", explanation: "The destination is reviewing this request. It is not public yet." } };
export const Held: Story = { args: { destination: "Nightframe", state: "held", explanation: "Unavailable on Nightframe pending review. The source Work has not been deleted." } };
export const ReconciliationRequired: Story = { args: { destination: "YouTube", state: "reconciling", explanation: "The provider outcome is not confirmed. Wait for reconciliation before retrying." } };
export const FailedWithRecovery: Story = { args: { destination: "DeviantArt", state: "failed", explanation: "Publication failed without changing the source Work.", action: <button type="button">Review recovery options</button> } };

export const SeparateDestinationTimeline: StoryObj<typeof PublicationTimeline> = { render: () => <PublicationTimeline events={[
  { id: "1", destination: "Stored in Ubeeq", state: "published", explanation: "Canonical source confirmed.", occurredAt: "2026-08-26T10:00:00Z" },
  { id: "2", destination: "Eversally Space", state: "pending_review", explanation: "Destination review is in progress.", occurredAt: "2026-08-26T10:05:00Z" },
  { id: "3", destination: "YouTube", state: "reconciling", explanation: "Remote result has not been confirmed.", occurredAt: "2026-08-26T10:06:00Z" }
]} /> };
