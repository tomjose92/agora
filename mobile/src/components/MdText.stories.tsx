import type { Meta, StoryObj } from "@storybook/react-native";
import { MdText } from "./MdText";

const meta = {
  title: "Native/Atoms/Markdown",
  component: MdText,
} satisfies Meta<typeof MdText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RichContent: Story = {
  args: {
    text: [
      "## Native markdown",
      "",
      "Agora renders **bold text**, `inline code`, links, and lists.",
      "",
      "- iOS",
      "- Android",
    ].join("\n"),
  },
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
