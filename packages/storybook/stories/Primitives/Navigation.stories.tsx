import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Breadcrumbs, Tabs } from "@gallery/design-system";

const meta = {
  title: "Primitives/Navigation/Tabs",
  component: Tabs,
  parameters: { docs: { description: { component: "Controlled tabs use tablist semantics, roving focus, and automatic activation with Left/Right/Home/End. Disabled capabilities are skipped by keyboard navigation; authorization remains server-side." } } }
} satisfies Meta<typeof Tabs>;
export default meta;
type Story = StoryObj<typeof meta>;

const items = [
  { value: "details", label: "Work details", content: <p>Edit canonical Work metadata stored by the home service.</p> },
  { value: "destinations", label: "Destinations", content: <p>Review one independent publication state per destination.</p> },
  { value: "history", label: "Publication history", content: <p>Requested, processing, verified, and recovery events appear here.</p> },
  { value: "nightframe", label: "Publish to Nightframe", content: null, disabled: true }
] as const;

export const WorkspaceTabs: Story = { render: () => {
  const [value, setValue] = useState("details");
  return <Tabs label="Work sections" items={items} value={value} onValueChange={setValue} />;
} };

export const LongLocalizedLabels: Story = { render: () => {
  const [value, setValue] = useState("details");
  return <Tabs label="作品のセクション" value={value} onValueChange={setValue} items={[{ value: "details", label: "作品の詳細と標準メタデータ", content: "標準レコード" }, { value: "destinations", label: "公開先ごとの状態と復旧オプション", content: "公開先の状態" }]} />;
} };

export const LocationTrail = { render: () => <Breadcrumbs items={[{ label: "Works", href: "/works" }, { label: "Evening studies", href: "/works/evening-studies" }, { label: "Destinations" }]} /> };
