import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureAgentMessage } from "@agora/core/testing/fixtures";
import { Unfurls } from "./Unfurls";

const meta = {
  title: "Native/Messages/Link preview",
  component: Unfurls,
  args: { message: fixtureAgentMessage },
} satisfies Meta<typeof Unfurls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Enriched: Story = {};
export const Empty: Story = {
  args: { message: { ...fixtureAgentMessage, meta: null } },
};
export const PartialAndMultiple: Story = {
  args: {
    message: {
      ...fixtureAgentMessage,
      text: "Native fallback previews",
      meta: {
        unfurls: [
          { url: "https://example.test/fallback" },
          { url: "https://docs.example.test/native", title: "Native catalog" },
        ],
      },
    },
  },
};
