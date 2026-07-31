import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureAgentMessage, fixtureAgents, fixtureUsers } from "@agora/core/testing/fixtures";
import { ReactionDetailsSheet } from "./Reactions";

const meta = {
  title: "Native/Messages/Reaction details sheet",
  component: ReactionDetailsSheet,
  args: {
    reactions: fixtureAgentMessage.reactions ?? [],
    initialEmoji: "👍",
    onClose: () => undefined,
  },
  parameters: { apiRoutes: {
    "GET /api/users": { users: fixtureUsers },
    "GET /api/agents": { agents: fixtureAgents },
  } },
} satisfies Meta<typeof ReactionDetailsSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PeopleAndAgent: Story = {};

export const LongAndMissingRosterNames: Story = {
  args: { reactions: [{ emoji: "🚀", users: ["A very long participant name"], reactors: [
    { type: "user", id: "departed-person", name: "A very long participant name retained as fallback" },
  ] }], initialEmoji: "🚀" },
};
