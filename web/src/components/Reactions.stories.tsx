import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within, expect } from "storybook/test";
import { Reactions } from "./Reactions";
import { me, message } from "../stories/fixtures/data";
import { fixtureAgents, fixtureUsers } from "@agora/core/testing/fixtures";

const removeReaction = fn(() => message);

const meta = {
  title: "Web/Messages/Reactions",
  component: Reactions,
  args: { message, onPick: fn() },
  parameters: {
    apiRoutes: {
      "GET /api/me": me,
      "GET /api/users": { users: fixtureUsers },
      "GET /api/agents": { agents: fixtureAgents },
      "DELETE /api/channels/general/messages/42/reactions/%F0%9F%91%8D": removeReaction,
      "PUT /api/channels/general/messages/42/reactions/%F0%9F%8E%89": message,
    },
  },
} satisfies Meta<typeof Reactions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const mine = await canvas.findByRole("button", { name: /Tom, Alice, Codex reacted with 👍/ });
    await expect(mine).toHaveClass("mine");
    await userEvent.hover(mine);
    await expect(canvas.getByRole("tooltip")).toHaveTextContent("Codex");
    await userEvent.unhover(mine);
    await userEvent.click(mine);
    await expect(removeReaction).toHaveBeenCalled();
  },
};

export const LegacyServerPayload: Story = {
  args: {
    message: {
      ...message,
      reactions: [{ emoji: "👍", users: ["tom", "alice"] }],
    },
  },
  play: async ({ canvasElement }) => {
    const chip = await within(canvasElement).findByRole("button", {
      name: /tom, alice reacted with 👍/,
    });
    await expect(chip).toHaveClass("mine");
  },
};
