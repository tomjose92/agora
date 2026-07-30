import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { fixtureAgents } from "@agora/core/testing/fixtures";
import { AgentProfileCard } from "./AgentProfileCard";
import { useAgentProfile } from "./MessageItem";

const meta = {
  title: "Web/Connected/Agent profile",
  component: AgentProfileCard,
  parameters: {
    apiRoutes: { "GET /api/agents": { agents: fixtureAgents } },
    setup: () => useAgentProfile.getState().show("codex"),
  },
} satisfies Meta<typeof AgentProfileCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Online: Story = {
  parameters: {
    docs: { description: { story: "A connected agent profile backed by the fixture API. The interaction verifies close behavior, then reopens the card for visual inspection." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("@codex · agent")).resolves.toBeVisible();
    await expect(canvas.findByText("Online")).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("button"));
    expect(useAgentProfile.getState().openId).toBeNull();
    useAgentProfile.getState().show("codex");
    await expect(canvas.findByText("@codex · agent")).resolves.toBeVisible();
  },
};
