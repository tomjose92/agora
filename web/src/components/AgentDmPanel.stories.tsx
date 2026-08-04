import type { Meta, StoryObj } from "@storybook/react-vite";
import { fixtureMe } from "@agora/core/testing/fixtures";
import { AgentDmPanel } from "./AgentDmPanel";
import { expect, within } from "storybook/test";

const dms = {
  conversations: [{ channel_id: "dm-codex", agent_id: "codex", agent_name: "Codex", last_seen: 1, unread: 0 }],
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
    "GET /api/dms": dms,
  } },
} satisfies Meta<typeof AgentDmPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const EligibleAgents: Story = { play: async ({canvasElement}) => {
  const canvas=within(canvasElement);
  await expect(canvas.findByText("Claude")).resolves.toBeVisible();
  expect(canvas.queryByText("Codex")).not.toBeInTheDocument();
} };
