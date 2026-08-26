import type { Meta, StoryObj } from "@storybook/react";
import { Banner, Button, InlineNotice, ToastRegion } from "@gallery/design-system";

const meta = {
  title: "Primitives/Feedback/Inline notice",
  component: InlineNotice,
  parameters: { docs: { description: { component: "Creator-safe feedback with written meaning and an icon in addition to colour. Danger notices interrupt immediately; other notices are announced politely." } } },
  args: { title: "Destination status changed", children: <p>Eversally is reviewing this Publication. The canonical Work remains unchanged.</p> }
} satisfies Meta<typeof InlineNotice>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Information: Story = {};
export const Success: Story = { args: { tone: "success", title: "Publication verified", children: <p>YouTube confirmed that the Publication is available.</p> } };
export const Warning: Story = { args: { tone: "warning", title: "Reconnect required", children: <p>Discord authorization expired. Reconnect before trying to publish.</p>, actions: <Button variant="secondary">Reconnect Discord</Button> } };
export const Restricted: Story = { args: { tone: "restricted", title: "Unavailable pending review", children: <p>This applies only to the Eversally destination.</p> } };
export const Danger: Story = { args: { tone: "danger", title: "Publication request failed", children: <p>The request was not accepted. The source Asset remains in Ubeeq.</p> } };
export const DismissibleBanner = { render: () => <Banner title="Provider maintenance" tone="unavailable" onDismiss={() => undefined}><p>Publishing is temporarily unavailable. Existing Works are unaffected.</p></Banner> };
export const Toasts = { render: () => <ToastRegion onDismiss={() => undefined} messages={[{ id: "saved", title: "Work saved", message: "Canonical changes are saved.", tone: "success" }, { id: "failed", title: "Remote publication failed", message: "Eversally did not accept the request.", tone: "danger" }]} /> };
export const LongLocalizedContent: Story = { args: { tone: "attention", title: "公開先で追加の確認が必要です", children: <p>この状態は公開先だけに適用され、Ubeeq に保存されている正規の作品や他の公開先には影響しません。</p> } };
