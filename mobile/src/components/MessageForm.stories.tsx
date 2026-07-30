import type { Meta, StoryObj } from "@storybook/react-native";
import type { Message } from "@agora/core";
import { fixtureAgentMessage } from "@agora/core/testing/fixtures";
import { MessageForm } from "./MessageForm";

const formMessage: Message = {
  ...fixtureAgentMessage,
  id: 61,
  meta: {
    form: {
      fields: [
        { id: "owner", kind: "input", label: "Owner", placeholder: "Name" },
        { id: "approved", kind: "checkbox", label: "Approved" },
      ],
      buttons: [{ id: "submit", label: "Submit", style: "primary" }],
    },
    form_state: { owner: "Alice", approved: false },
  },
};

const meta = {
  title: "Native/Messages/Interactive form",
  component: MessageForm,
  args: { message: formMessage },
  parameters: {
    apiRoutes: {
      "POST /api/messages/61/form_state": formMessage,
      "POST /api/messages/61/form_submit": formMessage,
    },
  },
} satisfies Meta<typeof MessageForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Editable: Story = {};
export const Submitted: Story = {
  args: {
    message: {
      ...formMessage,
      meta: {
        ...formMessage.meta,
        form_submitted: {
          button_id: "submit",
          by: "tom",
          ts: 1_750_000_200,
          values: { owner: "Tom", approved: true },
        },
      },
    },
  },
};
