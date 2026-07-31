import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within, expect } from "storybook/test";
import { Reactions } from "./Reactions";
import { me, message } from "../stories/fixtures/data";
import { fixtureAgents, fixtureUsers } from "@agora/core/testing/fixtures";

const removeReaction = fn(() => message);

async function openAndCheckViewport(canvasElement: HTMLElement) {
  const chip = await within(canvasElement).findByRole("button", { name: /reacted with 👍/ });
  await userEvent.hover(chip);
  const tooltip = await within(document.body).findByRole("tooltip");
  const rect = tooltip.getBoundingClientRect();
  await expect(rect.left).toBeGreaterThanOrEqual(8);
  await expect(rect.right).toBeLessThanOrEqual(window.innerWidth - 8);
  await expect(rect.top).toBeGreaterThanOrEqual(8);
  await expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight - 8);
  return { chip, tooltip };
}

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
    const { tooltip } = await openAndCheckViewport(canvasElement);
    await expect(tooltip).toHaveTextContent("Codex");
    await userEvent.unhover(mine);
    await userEvent.click(mine);
    await expect(removeReaction).toHaveBeenCalled();
  },
};

export const LeftViewportEdge: Story = {
  decorators: [(Story) => <div style={{ position: "fixed", left: 0, top: 180 }}><Story /></div>],
  play: async ({ canvasElement }) => { await openAndCheckViewport(canvasElement); },
};

export const RightViewportEdge: Story = {
  decorators: [(Story) => <div style={{ position: "fixed", right: 0, top: 180 }}><Story /></div>],
  play: async ({ canvasElement }) => { await openAndCheckViewport(canvasElement); },
};

export const LongReactorList: Story = {
  args: {
    message: {
      ...message,
      reactions: [{
        emoji: "👍",
        users: Array.from({ length: 18 }, (_, i) => `person-${i + 1}`),
        reactors: Array.from({ length: 18 }, (_, i) => ({
          type: "user" as const,
          id: `person-${i + 1}`,
          name: `Person ${i + 1}`,
        })),
      }],
    },
  },
  play: async ({ canvasElement }) => {
    const { tooltip } = await openAndCheckViewport(canvasElement);
    await expect(tooltip).toHaveTextContent("Person 18");
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
