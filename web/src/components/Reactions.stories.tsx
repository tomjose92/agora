import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, userEvent, within, expect } from "storybook/test";
import { Reactions } from "./Reactions";
import { me, message } from "../stories/fixtures/data";

const meta = {
  title: "Web/Messages/Reactions",
  component: Reactions,
  args: { message, onPick: fn() },
  parameters: {
    apiRoutes: {
      "GET /api/me": me,
      "DELETE /api/channels/general/messages/42/reactions/%F0%9F%91%8D": message,
      "PUT /api/channels/general/messages/42/reactions/%F0%9F%8E%89": message,
    },
  },
} satisfies Meta<typeof Reactions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const mine = await canvas.findByRole("button", { name: /tom, alice reacted with 👍/ });
    await expect(mine).toHaveClass("mine");
    await userEvent.click(mine);
  },
};
