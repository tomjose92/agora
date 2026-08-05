import type { Meta, StoryObj } from "@storybook/react-native";
import React from "react";
import { Text, View } from "react-native";
import { AgentStatus } from "./AgentStatus";
import { colors } from "../lib/theme";

const meta = {
  title: "Native/Atoms/Agent status",
  component: AgentStatus,
  decorators: [(Story) => <View style={{ width: 220, padding: 16, backgroundColor: colors.bg }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text numberOfLines={1} style={{ color: colors.text, flex: 1 }}>An agent with an exceptionally long name</Text>
      <Story />
    </View>
  </View>],
} satisfies Meta<typeof AgentStatus>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Online: Story = { args: { live: true } };
export const Offline: Story = { args: { live: false } };
