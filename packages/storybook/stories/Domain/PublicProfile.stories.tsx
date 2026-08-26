import type { Meta, StoryObj } from "@storybook/react";
import { Button, CreatorProfileHeader, PublicProductHeader } from "@gallery/design-system";

const meta = { title: "Domain/Public profile/Creator identity", component: CreatorProfileHeader,
  parameters: { layout: "fullscreen", docs: { description: { component: "Public identity surfaces name both the service presenting the page and the creator’s home service. They do not imply shared authentication, staff, or policy authority." } } }
} satisfies Meta<typeof CreatorProfileHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EversallyHostedNightframeCreator: Story = { render: () => <div data-product-theme="eversally"><PublicProductHeader productId="eversally" displayName="Eversally" authorityLabel="Eversally service and policy" currentItemId="discover" navigation={[{ id: "discover", label: "Discover", href: "#discover" }, { id: "challenges", label: "Challenges", href: "#challenges" }]} actions={<Button variant="secondary">Sign in to Eversally</Button>} /><main style={{ padding: "2rem" }}><CreatorProfileHeader creatorName="Aiko 山田" profileLabel="Space" hostService="Eversally" homeService="Nightframe" description="Light, motion, and long-exposure studies from an independent creator catalogue." metadata="12 Works · External home service" actions={<Button>Follow on Eversally</Button>} /></main></div> };

export const SelfHostedUbeeq: Story = { render: () => <div data-product-theme="ubeeq"><PublicProductHeader productId="ubeeq" displayName="Northlight Catalogue" authorityLabel="Independent Ubeeq deployment" /><main style={{ padding: "2rem" }}><CreatorProfileHeader creatorName="Northlight Studio With An Exceptionally Long Display Name" profileLabel="Creator Area" hostService="Northlight Catalogue" homeService="Northlight Catalogue" description="A self-hosted catalogue with no managed-service identity implied." /></main></div> };
