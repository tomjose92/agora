import type { Meta, StoryObj } from "@storybook/react-native";
import React from "react";
import { Text, View } from "react-native";
import { DmGroupCard } from "../../app/(app)/index";

const group = {
  id: "__dms", name: "Direct messages", description: "Private conversations with agents",
  created_by: null, created_at: 0, role: "member" as const, kind: "agent_dms" as const, channels: [],
};

const meta = {
  title: "Native/Overlays/Agent DM picker",
  component: DmGroupCard,
  args: { group, unreadsOnly: false, initialChoosing: true },
  decorators: [(Story) => <View style={{ flex: 1, backgroundColor: "#07090f", padding: 16, gap: 12 }}>
    {["Health", "Finance", "Trip", "Bulwark"].map(name => <View key={name} style={{ padding: 18, borderWidth: 1, borderColor: "#30333c", borderRadius: 16 }}>
      <Text style={{ color: "#eceef4", fontSize: 18, fontWeight: "700" }}>{name}</Text>
      <Text style={{ color: "#8b91a5", marginTop: 12 }}># busy-background-channel</Text>
    </View>)}
    <Story />
  </View>],
  parameters: { apiRoutes: {
    "GET /api/dms": { conversations: [], agents: [
      { id: "claude", name: "Claude", live: true, can_dm: true, is_public: true },
      { id: "cursor", name: "Cursor", live: false, can_dm: true, is_public: true },
    ] },
    "GET /api/agents": { agents: [
      { id: "claude", name: "Claude", live: true, avatar: null },
      { id: "cursor", name: "Cursor", live: false, avatar: null },
    ] },
  } },
} satisfies Meta<typeof DmGroupCard>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Open: Story = {};
