import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureAgentMessage } from "@agora/core/testing/fixtures";
import { Reactions } from "./Reactions";

const meta = {
  title: "Native/Messages/Reactions",
  component: Reactions,
  args: { message: fixtureAgentMessage },
  parameters: {
    apiRoutes: {
      "DELETE /api/channels/general/messages/43/reactions/%F0%9F%91%8D": fixtureAgentMessage,
      "PUT /api/channels/general/messages/43/reactions/%F0%9F%8E%89": fixtureAgentMessage,
    },
  },
} satisfies Meta<typeof Reactions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MineAndOthers: Story = {};
export const SingleReaction: Story = {
  args: {
    message: {
      ...fixtureAgentMessage,
      reactions: [{ emoji: "👀", users: ["alice"] }],
    },
  },
};
