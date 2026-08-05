import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { AgentStatus } from "./AgentStatus";

const meta = { title: "Web/Atoms/Agent status", component: AgentStatus } satisfies Meta<typeof AgentStatus>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Online: Story = { args: { live: true }, play: async ({ canvasElement }) => {
  const status = within(canvasElement).getByText("online").closest(".agent-presence");
  await expect(status).toHaveClass("online");
  await expect(status?.querySelector(".agent-presence-dot")).toHaveAttribute("aria-hidden", "true");
} };

export const Offline: Story = { args: { live: false }, play: async ({ canvasElement }) => {
  await expect(within(canvasElement).getByText("offline").closest(".agent-presence")).toHaveClass("offline");
} };
