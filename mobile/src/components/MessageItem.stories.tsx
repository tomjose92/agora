import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import type { Message } from "@agora/core";
import {
  fixtureAgentMessage,
  fixtureRootMessage,
} from "@agora/core/testing/fixtures";
import { MessageItem } from "./MessageItem";

const session = { baseUrl: "https://storybook.invalid", token: "storybook" };
const richMessage: Message = {
  ...fixtureAgentMessage,
  reply_count: 3,
  attachments: [{
    id: "plan",
    filename: "native-component-plan.pdf",
    mime: "application/pdf",
    size: 428_032,
  }],
  meta: {
    ...fixtureAgentMessage.meta,
    tldr: "Native rich content is covered.",
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "revise", label: "Request changes", style: "danger" },
    ],
  },
};

const meta = {
  title: "Native/Messages/Message item",
  component: MessageItem,
  args: {
    session,
    message: richMessage,
    onOpenThread: fn(),
    onLongPress: fn(),
    onAvatarPress: fn(),
    starred: true,
    pinned: true,
  },
  parameters: {
    apiRoutes: {
      "POST /api/messages/43/select": richMessage,
      "DELETE /api/channels/general/messages/43/reactions/%F0%9F%91%8D": richMessage,
      "PUT /api/channels/general/messages/43/reactions/%F0%9F%8E%89": richMessage,
    },
  },
} satisfies Meta<typeof MessageItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentRichContent: Story = {};
export const CurrentUser: Story = {
  args: {
    session,
    message: fixtureRootMessage,
    onOpenThread: fn(),
  },
};
export const ThreadReply: Story = {
  args: {
    session,
    message: {
      ...fixtureAgentMessage,
      id: 44,
      thread_id: 42,
      reply_count: 0,
      text: "Native thread reply presentation.",
    },
  },
};
