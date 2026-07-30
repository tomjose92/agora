import type { Meta, StoryObj } from "@storybook/react-native";
import {
  fixtureChannelAgents,
  fixtureGroups,
  fixtureMembers,
  fixtureMessages,
} from "@agora/core/testing/fixtures";
import ChannelScreen from "../../app/(app)/channel/[id]";

const meta = {
  title: "Native/Screens/Channel",
  component: ChannelScreen,
  parameters: {
    apiRoutes: {
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/channels/general/messages?limit=50": { messages: fixtureMessages },
      "GET /api/channels/general/pins": { pins: [] },
      "GET /api/channels/general/stars": { stars: [] },
      "GET /api/channels/general/agents": { agents: fixtureChannelAgents },
      "GET /api/groups/product/members": { members: fixtureMembers },
      "GET /api/channels/general/activity": { typing: [], progress: [] },
      "PUT /api/channels/general/read": { ok: true, last_read_id: 43 },
    },
  },
} satisfies Meta<typeof ChannelScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const NoAgentsListening: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/channels/general/messages?limit=50": { messages: fixtureMessages },
      "GET /api/channels/general/pins": { pins: [] },
      "GET /api/channels/general/stars": { stars: [] },
      "GET /api/channels/general/agents": { agents: [] },
      "GET /api/groups/product/members": {
        members: fixtureMembers.filter((member) => member.member_type !== "agent"),
      },
      "GET /api/channels/general/activity": { typing: [], progress: [] },
      "PUT /api/channels/general/read": { ok: true, last_read_id: 43 },
    },
  },
};
