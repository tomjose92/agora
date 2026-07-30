import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { Message } from "@agora/core";
import { MessageOptions } from "./MessageOptions";
import { message } from "../stories/fixtures/data";

const optionsMessage: Message = {
  ...message,
  id: 52,
  meta: {
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "revise", label: "Request changes", style: "danger" },
    ],
  },
};
const selectOption = fn(() => ({
  ...optionsMessage,
  meta: {
    ...optionsMessage.meta,
    resolved: { option_id: "approve", by: "tom", label: "Approve" },
  },
}));

const meta = {
  title: "Web/Messages/Options",
  component: MessageOptions,
  args: { message: optionsMessage },
  parameters: {
    apiRoutes: { "POST /api/messages/52/select": selectOption },
  },
} satisfies Meta<typeof MessageOptions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Selectable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Approve" }));
    await expect(selectOption).toHaveBeenCalledWith({ option_id: "approve" });
  },
};

export const Resolved: Story = {
  args: {
    message: {
      ...optionsMessage,
      meta: {
        ...optionsMessage.meta,
        resolved: { option_id: "approve", by: "tom", label: "Approved" },
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText("Approved by tom")).resolves.toBeVisible();
  },
};
