import type { Meta, StoryObj } from "@storybook/react";
import { CheckboxField, DateField, DateTimeField, RadioGroup, SelectField, SwitchField, TextareaField, TextField, TimeField } from "@gallery/design-system";

const meta = { title: "Primitives/Forms/Text field", component: TextField,
  parameters: { docs: { description: { component: "Native form controls with persistent labels and associated help/error text. Error props represent validation or creator-safe server rejection; authorization must remain server-side." } } },
  args: { label: "Work title", description: "Used in the canonical catalogue and supplied to selected destinations.", defaultValue: "Garden after rain" }
} satisfies Meta<typeof TextField>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Optional: Story = { args: { label: "Alternative title", optional: true, defaultValue: "" } };
export const Invalid: Story = { args: { error: "Enter a title before saving.", defaultValue: "" } };
export const ServerRejected: Story = { args: { error: "The canonical service rejected this title. Review it and try again." } };
export const Disabled: Story = { args: { disabled: true, description: "You have read-only access to this Work." } };
export const LongContent: Story = { args: { label: "ローカライズされた非常に長いフィールドラベル", defaultValue: "夜明けの庭 — a deliberately long title that must remain readable in a narrow workspace" } };
export const DescriptionTextarea = { render: () => <TextareaField label="Description" description="Destination limits are validated by the provider flow." defaultValue="A multiline creator description." /> };
export const DestinationSelect = { render: () => <SelectField label="Destination" defaultValue="eversally" options={[{ value: "eversally", label: "Eversally Space" }, { value: "nightframe", label: "Nightframe — unavailable from this home service", disabled: true }]} /> };
export const ExplicitCheckbox = { render: () => <CheckboxField label="I understand this publication destination" description="This does not bypass destination eligibility or backend authorization." /> };
export const DestinationRadioGroup = { render: () => <RadioGroup label="Publication visibility" description="The destination applies its own visibility policy." name="visibility" defaultValue="public" options={[{ value: "public", label: "Public", description: "Request public visibility at the destination." }, { value: "unlisted", label: "Unlisted", description: "Available only with its destination link." }, { value: "members", label: "Members only", description: "Unavailable on this plan.", disabled: true }]} /> };
export const ServerRejectedRadioGroup = { render: () => <RadioGroup label="Publication visibility" name="rejected-visibility" error="The destination no longer supports this visibility." value="unlisted" options={[{ value: "public", label: "Public" }, { value: "unlisted", label: "Unlisted" }]} /> };
export const NotificationSwitch = { render: () => <SwitchField label="Publication updates" description="Receive an update when the destination verifies or rejects this request." defaultChecked /> };
export const DisabledSwitch = { render: () => <SwitchField label="Automatic retry" description="Unavailable while this Publication is reconciling." disabled /> };
export const PublicationSchedule = { render: () => <DateTimeField id="publish-at" label="Schedule publication" description="The destination will receive a request at this local date and time." timezone="Europe/London (UTC+01:00)" required dateInput={{ defaultValue: "2026-09-14", min: "2026-08-26" }} timeInput={{ defaultValue: "18:30" }} /> };
export const RejectedSchedule = { render: () => <DateTimeField label="Schedule publication" timezone="UTC" error="The selected time has already passed." dateInput={{ defaultValue: "2026-08-25" }} timeInput={{ defaultValue: "09:00" }} /> };
export const NativeDateAndTime = { render: () => <div style={{ display: "grid", gap: 16 }}><DateField label="Review date" min="2026-08-26" /><TimeField label="Reminder time" step={900} optional /></div> };
