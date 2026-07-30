import type { Meta, StoryObj } from "@storybook/react-vite";
import { Unfurls } from "./Unfurls";
import { message } from "../stories/fixtures/data";

const meta = {
  title: "Web/Atoms/Link preview",
  component: Unfurls,
} satisfies Meta<typeof Unfurls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Enriched: Story = {
  args: {
    message: {
      ...message,
      meta: {
        unfurls: [{
          url: "https://storybook.js.org/",
          site: "storybook.js.org",
          title: "Storybook",
          description: "Build, test, and document UI components in isolation.",
        }],
      },
    },
  },
};
