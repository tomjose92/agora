import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { AgentAvatar } from "./AgentAvatar";

function AvatarSizes() {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
      <AgentAvatar agentId="codex" size={24} />
      <AgentAvatar agentId="codex" size={40} />
      <AgentAvatar agentId="missing-agent" size={64} />
    </View>
  );
}

const meta = {
  title: "Native/Atoms/Agent avatar",
  component: AvatarSizes,
} satisfies Meta<typeof AvatarSizes>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SizesAndFallback: Story = {};
