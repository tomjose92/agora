import type { Meta, StoryObj } from "@storybook/react-native";
import { ServerSetupHelp } from "./ServerSetupHelp";

const meta = {
  title: "Native/Auth/Server setup help",
  component: ServerSetupHelp,
  args: { onOpenGuide: () => {} },
} satisfies Meta<typeof ServerSetupHelp>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
