import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { fixtureMe } from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { Topbar } from "./Topbar";

const rename = fn(() => ({ ...fixtureMe, display_name: "Thomas" }));

const meta = {
  title: "Web/Connected/Topbar",
  component: Topbar,
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/connections": {
        instance: { id: "agora-story", name: "Storybook Agora" },
        connections: [{
          name: "Pantheo",
          url: "wss://agents.example.test",
          enabled: true,
          status: {
            name: "Pantheo",
            url: "wss://agents.example.test",
            connected: true,
            agents: [{ id: "codex", name: "Codex" }],
            last_error: null,
          },
        }],
      },
      "PATCH /api/me": rename,
    },
  },
} satisfies Meta<typeof Topbar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AdminConnected: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("1/1 linked · 1 agent")).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "People" }));
    expect(useUiState.getState().panel).toBe("people");
  },
};

export const Rename: Story = {
  play: async ({ canvasElement }) => {
    const oldPrompt = window.prompt;
    window.prompt = fn(() => "Thomas");
    try {
      await userEvent.click(within(canvasElement).getByTitle("Change how your name appears"));
      await expect(rename).toHaveBeenCalledWith({ display_name: "Thomas" });
    } finally {
      window.prompt = oldPrompt;
    }
  },
};
