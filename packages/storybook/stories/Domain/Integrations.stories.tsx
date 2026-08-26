import type { Meta, StoryObj } from "@storybook/react";
import { IntegrationCard } from "@gallery/design-system";

const meta = { title: "Domain/Integrations/Integration card", component: IntegrationCard,
  parameters: { docs: { description: { component: "Displays provider identity, account scope, health, capabilities, verification, and only the recovery actions authorized by the application backend. Provider-specific configuration remains outside this card." } } },
  args: { providerName: "Discord", accountScope: "Ubeeq Studio · Community server", health: "connected", healthExplanation: "The provider confirmed this connection.", capabilities: ["Channel selection", "Announcements"], lastSuccessfulSyncAt: "2026-08-26T11:45:00Z", lastVerifiedAt: "2026-08-26T12:00:00Z", allowedActions: ["test", "sync", "disconnect"] }
} satisfies Meta<typeof IntegrationCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Connected: Story = {};
export const Syncing: Story = { args: { health: "syncing", healthExplanation: "A provider-specific sync is in progress.", busyAction: "sync" } };
export const ExpiredAuthorization: Story = { args: { providerName: "DeviantArt", accountScope: "Creator account", health: "expired", healthExplanation: "Authorization expired. Reconnect before publishing or syncing.", allowedActions: ["reconnect"] } };
export const ReconciliationRequired: Story = { args: { providerName: "YouTube", accountScope: "Channel · Studio fixtures", health: "reconciling", healthExplanation: "The latest remote outcome is not confirmed. Do not retry until reconciliation completes.", allowedActions: ["review"] } };
export const RestrictedReadOnly: Story = { args: { providerName: "Provider fixture", accountScope: "Read-only account", health: "restricted", healthExplanation: "This account can import metadata but cannot publish.", capabilities: ["Read-only import"], allowedActions: [] } };
export const ProviderUnavailable: Story = { args: { health: "unavailable", healthExplanation: "The provider is temporarily unavailable. The canonical Works are unchanged.", allowedActions: ["test"] } };
