import type { Meta, StoryObj } from "@storybook/react-native";
import {
  fixtureAgentMessage,
  fixtureGroups,
} from "@agora/core/testing/fixtures";
import SearchScreen from "../../app/(app)/search";

const hit = {
  ...fixtureAgentMessage,
  channel_name: "storybook",
  group_id: "product",
  group_name: "Product",
  snippet: "The native \u0001catalog\u0002 result.",
};

const meta = {
  title: "Native/Screens/Search",
  component: SearchScreen,
  parameters: {
    apiRoutes: {
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/search?q=catalog": {
        query: "catalog",
        groups: [{ id: "product", name: "Product", description: "Planning", hidden: false }],
        channels: [],
        messages: { items: [hit], has_more: false, offset: 0 },
      },
    },
  },
} satisfies Meta<typeof SearchScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadyForQuery: Story = {};
