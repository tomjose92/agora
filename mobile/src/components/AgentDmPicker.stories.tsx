import type { Meta, StoryObj } from "@storybook/react-native";
import { DmGroupCard } from "../../app/(app)/index";

const group = {
  id: "__dms", name: "Direct messages", description: "Private conversations with agents",
  created_by: null, created_at: 0, role: "member" as const, kind: "agent_dms" as const, channels: [],
};

const meta = {
  title: "Native/Overlays/Agent DM picker",
  component: DmGroupCard,
  args: { group, unreadsOnly: false, initialChoosing: true },
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
