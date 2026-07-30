import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureAgentMessage } from "@agora/core/testing/fixtures";
import { Sources } from "./Sources";

const message = {
  ...fixtureAgentMessage,
  text: "The catalog covers source navigation.\n\nSources:\nhttps://storybook.js.org/",
  meta: {
    ...fixtureAgentMessage.meta,
    sources_start: 38,
    sources: [
      {
        url: "https://storybook.js.org/",
        site: "storybook.js.org",
        title: "Storybook documentation",
        description: "Build and test isolated components.",
      },
      {
        url: "https://reactnative.dev/",
        site: "reactnative.dev",
        title: "React Native",
        description: "Native components for Android and iOS.",
      },
    ],
  },
};

const meta = {
  title: "Native/Messages/Sources",
  component: Sources,
  args: { message },
} satisfies Meta<typeof Sources>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MultipleSources: Story = {};
export const UrlFallback: Story = {
  args: {
    message: {
      ...message,
      meta: { sources: [{ url: "https://example.test/fallback" }] },
    },
  },
};
