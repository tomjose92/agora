import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { EmojiPicker } from "./EmojiPicker";

const meta = {
  title: "Native/Overlays/Emoji picker",
  component: EmojiPicker,
  args: {
    visible: true,
    onPick: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof EmojiPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Categories: Story = {};
