import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { PublishConfirmation, type PublishConfirmationProps } from "@gallery/design-system";

const meta = { title: "Feature flows/Publish a Work/Confirmation", component: PublishConfirmation,
  parameters: { docs: { description: { component: "The confirmation checkpoint after provider-specific validation and configuration. It states source, destination, effect, and unchanged canonical facts. Submission creates a request; it never presents an optimistic request as published." } } },
  args: { sourceLabel: "Garden after rain", sourceAuthority: "Canonical Work stored in Nightframe", destinationLabel: "Eversally Space", destinationAuthority: "Eversally account, review, and policy", effect: "Request a destination-local Eversally Publication", unchangedFacts: ["Delete or modify the Nightframe source Work", "Change existing YouTube or DeviantArt Publications", "Make the Work visible before Eversally confirms it"], eligibility: "eligible", eligibilityExplanation: "Provider fields and destination eligibility were validated at 2026-08-26T12:00:00Z.", confirmed: false }
} satisfies Meta<typeof PublishConfirmation>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ExplicitConfirmation: Story = { render: (args: PublishConfirmationProps) => { const [confirmed, setConfirmed] = useState(false); return <PublishConfirmation {...args} confirmed={confirmed} onConfirmedChange={setConfirmed} onSubmit={() => undefined} onCancel={() => undefined} />; } };
export const CheckingEligibility: Story = { args: { eligibility: "checking", eligibilityExplanation: "Waiting for the Eversally destination to return an authoritative preflight result." } };
export const IneligibleRoute: Story = { args: { sourceAuthority: "Canonical Work stored in Eversally", destinationLabel: "Nightframe", destinationAuthority: "Separate Nightframe service", eligibility: "ineligible", eligibilityExplanation: "Eversally-home creators do not publish to Nightframe through federation.", confirmed: false } };
export const PermissionRestricted: Story = { args: { eligibility: "permission_restricted", eligibilityExplanation: "The deployment backend did not authorize publication to this destination." } };
export const DestinationUnavailable: Story = { args: { eligibility: "unavailable", eligibilityExplanation: "Destination preflight is unavailable. The canonical Work and other Publications are unchanged." } };
export const SubmittingRequest: Story = { args: { confirmed: true, submitting: true } };
