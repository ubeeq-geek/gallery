import type { Meta, StoryObj } from "@storybook/react";
import { AuditEventList, PolicyDisclosure, ReviewHoldNotice } from "@gallery/design-system";

const meta = { title: "Domain/Review and support/Review hold notice", component: ReviewHoldNotice,
  parameters: { docs: { description: { component: "Creator-safe destination hold presentation. It accepts public wording only and deliberately has no internal evidence, note, threshold, or risk-score properties." } } },
  args: { destinationLabel: "Eversally", publicReason: "This destination Publication is unavailable while review is in progress.", lastUpdatedAt: "2026-08-26T12:00:00Z" }
} satisfies Meta<typeof ReviewHoldNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const HeldOnEversally: Story = {};
export const HeldOnNightframe: Story = { args: { destinationLabel: "Nightframe", publicReason: "Nightframe is reviewing availability for this Publication." } };
export const WithPermittedNextStep: Story = { args: { nextStep: <a href="#support">View creator support options</a> } };
export const SuppliedPolicyDisclosure = { render: () => <PolicyDisclosure title="Before leaving Eversally" mode="caution" content={<p>This external profile is hosted by a separate service with its own account and policy.</p>} acknowledgement={<button type="button" className="ds-button">Continue to external profile</button>} /> };
export const OperationsAuditHistory = { render: () => <AuditEventList events={[
  { id: "1", timestamp: "2026-08-26T10:00:00Z", actorCategory: "creator", action: "Publication requested", objectLabel: "Garden Study", destinationLabel: "Eversally" },
  { id: "2", timestamp: "2026-08-26T10:03:00Z", actorCategory: "service", action: "Publication held", objectLabel: "Garden Study", destinationLabel: "Eversally", permissibleDetail: "Creator notification sent" },
  { id: "3", timestamp: "2026-08-26T11:30:00Z", actorCategory: "moderation", action: "Review assigned", objectLabel: "Destination Publication", destinationLabel: "Eversally", permissibleDetail: "Queue: standard review" }
]} /> };
export const EmptyAuditHistory = { render: () => <AuditEventList events={[]} /> };
