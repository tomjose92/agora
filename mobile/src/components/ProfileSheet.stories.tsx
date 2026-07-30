import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import {
  fixtureAgentMessage,
  fixtureRootMessage,
} from "@agora/core/testing/fixtures";
import { ProfileSheet } from "./ProfileSheet";

const meta = {
  title: "Native/Overlays/Profile sheet",
  component: ProfileSheet,
  args: { message: fixtureAgentMessage, onClose: fn() },
} satisfies Meta<typeof ProfileSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OnlineAgent: Story = {};
export const Person: Story = {
  args: { message: fixtureRootMessage, onClose: fn() },
};
