import type { Meta, StoryObj } from "@storybook/react";
import { AssetGrid, AssetState, Button, SourceControlNotice, WorkCard, WorkListRow } from "@gallery/design-system";

const assetMeta = {
  title: "Domain/Works and Assets/Asset state", component: AssetState,
  parameters: { docs: { description: { component: "Describes media processing without treating a request or queued job as complete. Applications supply creator-safe explanations and permitted recovery actions." } } },
  args: { state: "checking", explanation: "The file is being checked before processing begins.", lastUpdatedAt: "2026-08-26T12:00:00Z" }
} satisfies Meta<typeof AssetState>;
export default assetMeta;
type Story = StoryObj<typeof assetMeta>;
export const Checking: Story = {};
export const NeedsReview: Story = { args: { state: "needs_review", explanation: "Review is required before this Asset can be used at this destination." } };
export const CannotBeProcessed: Story = { args: { state: "cannot_be_processed", explanation: "The file format could not be processed.", action: <button type="button">Choose another file</button> } };
export const UnavailablePendingReview: Story = { args: { state: "unavailable_pending_review", explanation: "This Asset is unavailable while review is in progress." } };
export const Ready: Story = { args: { state: "ready", explanation: "Processing is complete and the Asset is ready." } };

export const CanonicalSource = { render: () => <SourceControlNotice kind="canonical" /> };
export const ExternalReference = { render: () => <SourceControlNotice kind="external_reference" sourceName="YouTube" /> };
export const WorkWithoutPreview = { render: () => <div style={{ maxWidth: 420 }}><WorkCard title="夜明けの庭 — an intentionally long Work title" href="#work" visibilityLabel="Private canonical Work" assetSummary="3 Assets" destinations={[
  { id: "home", label: "Stored in Ubeeq", state: "published", stateLabel: "Stored" },
  { id: "eversally", label: "Eversally Space", state: "pending_review", stateLabel: "Pending review" },
  { id: "youtube", label: "YouTube", state: "reconciling", stateLabel: "Unknown — reconciling" }
]} /></div> };
const rowDestinations = [{ id: "home", label: "Stored in Ubeeq", state: "published" as const, stateLabel: "Stored" }, { id: "eversally", label: "Eversally", state: "held" as const, stateLabel: "Held" }];
export const WorkListDensity = { render: () => <div style={{ display: "grid", gap: 12 }}><WorkListRow title="Evening studies" href="#evening" visibilityLabel="Private" assetSummary="4 Assets" lastUpdatedAt="2026-08-26T12:00:00Z" lastUpdatedLabel="26 Aug 2026, 12:00" destinations={rowDestinations} actions={<Button variant="secondary">Review</Button>} /><WorkListRow title="夜明けの庭 — a deliberately long localized Work title that wraps safely" href="#garden" visibilityLabel="Public at one destination" assetSummary="No Assets" destinations={[{ id: "home", label: "Stored in Ubeeq", state: "published", stateLabel: "Stored" }, { id: "youtube", label: "YouTube", state: "reconciling", stateLabel: "Unknown — reconciling" }]} /></div> };
export const AssetGridStates = { render: () => <AssetGrid items={[{ id: "ready", title: "Primary still image", href: "#ready", state: "ready", mediaSummary: "2400 × 1600 · JPEG", sourceKind: "canonical", sourceLabel: "Canonical Asset in Ubeeq", lastUpdatedAt: "2026-08-26T12:00:00Z", lastUpdatedLabel: "26 Aug 2026, 12:00" }, { id: "checking", title: "夜の庭 — processing variant", href: "#checking", state: "checking", mediaSummary: "Video · metadata pending", sourceKind: "canonical", sourceLabel: "Canonical Asset in Ubeeq" }, { id: "external", title: "YouTube reference without a local preview", href: "#external", state: "unavailable_pending_review", mediaSummary: "External reference", sourceKind: "external_reference", sourceLabel: "Source remains with YouTube", actions: <Button variant="secondary">Review reference</Button> }]} /> };
export const EmptyAssetGrid = { render: () => <AssetGrid items={[]} emptyTitle="No Assets available" emptyDetail="Upload an Asset if your permission and plan allow it." /> };
