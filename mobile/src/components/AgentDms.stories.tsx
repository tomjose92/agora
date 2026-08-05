import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureGroups } from "@agora/core/testing/fixtures";
import Home from "../../app/(app)/index";

const dmGroup = {
  id: "__dms", name: "Direct messages", description: "Private conversations with agents",
  created_by: null, created_at: 0, role: "member" as const, kind: "agent_dms" as const,
  channels: [{ id: "dm-codex", group_id: "", name: "Codex", topic: "", created_at: 1,
    kind: "agent_dm" as const, dm_user_id: "tom", dm_agent_id: "codex", unread: 2 }],
};

const meta = {
  title: "Native/Screens/Agent DMs",
  component: Home,
  parameters: { apiRoutes: {
    "GET /api/groups": { groups: [dmGroup, ...fixtureGroups] },
    "GET /api/threads?limit=100": { threads: [] },
    "GET /api/agents": { agents: [
      { id: "codex", name: "Codex", live: true, avatar: null },
      { id: "claude", name: "Claude", live: false, avatar: null },
    ] },
    "GET /api/dms": { conversations: [{ channel_id: "dm-codex", agent_id: "codex", agent_name: "Codex", last_seen: 1, unread: 2 }], agents: [
      { id: "codex", name: "Codex", live: true, can_dm: true, is_public: true },
      { id: "claude", name: "Claude", live: false, can_dm: true, is_public: false },
    ] },
  } },
} satisfies Meta<typeof Home>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ConversationWithUnread: Story = {};
