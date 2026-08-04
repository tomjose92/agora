import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtureMe, fixtureUsers } from "@agora/core/testing/fixtures";
import { AgentDmPanel } from "./AgentDmPanel";

const dms = {
  conversations: [],
  agents: [
    { id: "codex", name: "Codex", live: true, can_dm: true, is_public: true },
    { id: "claude", name: "Claude", live: false, can_dm: true, is_public: false },
  ],
};

const meta = {
  title: "Web/Connected/Agent direct messages",
  component: AgentDmPanel,
  args: { onClose: () => undefined },
  parameters: { apiRoutes: {
    "GET /api/me": fixtureMe,
    "GET /api/users": { users: fixtureUsers },
    "GET /api/dms": dms,
    "GET /api/admin/agents/codex/dm-policy": { agent_id: "codex", is_public: true, grants: [] },
    "GET /api/admin/agents/claude/dm-policy": { agent_id: "claude", is_public: false, grants: ["alice"] },
  } },
} satisfies Meta<typeof AgentDmPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EligibleAgents: Story = {};
