import type { Meta, StoryObj } from "@storybook/react-vite";
import { MdText } from "./MdText";

const meta = {
  title: "Web/Atoms/Markdown",
  component: MdText,
  args: { mentions: {} },
} satisfies Meta<typeof MdText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RichContent: Story = {
  args: {
    text: [
      "## Storybook message",
      "",
      "Agora supports **bold**, `inline code`, links, and lists:",
      "",
      "- Web and desktop",
      "- iOS and Android",
      "",
      "| Runtime | Renderer |",
      "| --- | --- |",
      "| Web | React DOM |",
      "| Mobile | React Native |",
    ].join("\n"),
  },
};

export const LongUnbrokenContent: Story = {
  args: {
    text: "A very long value must not force the message pane wider: " + "agora-responsive-".repeat(18),
  },
};
