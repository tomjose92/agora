import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureMarkdown } from "@agora/core/testing/fixtures";
import { MdText } from "./MdText";

const meta = {
  title: "Native/Atoms/Markdown",
  component: MdText,
} satisfies Meta<typeof MdText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RichContent: Story = {
  args: { text: fixtureMarkdown },
};

export const WideTable: Story = {
  args: {
    text: [
      "| Component | Platform | Responsive behavior |",
      "| --- | --- | --- |",
      "| Message | iOS and Android | Horizontal table scrolling |",
      "| Composer | Native | Keyboard-aware layout |",
    ].join("\n"),
  },
};
