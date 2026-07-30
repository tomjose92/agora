import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useUiState } from "../state/ui";
import { ConnectionsPane } from "./ConnectionsPane";

const meta = {
  title: "Web/Connected/Connections",
  component: ConnectionsPane,
  parameters: {
    apiRoutes: {
      "GET /api/connections": {
        instance: { id: "story-instance", name: "Storybook Agora" },
        connections: [],
      },
      "GET /api/pairing": {
        tokens: [{
          token: "storybook-codex-token",
          name: "Codex",
          kind: "codex",
          created_at: 1_750_000_000,
          connected: true,
          agents: [{ id: "codex", name: "Codex" }],
        }],
      },
    },
    setup: () => useUiState.setState({ panel: "connections" }),
  },
} satisfies Meta<typeof ConnectionsPane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConnectedAgentAndCatalog: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Live: Codex")).resolves.toBeVisible();
    // "Add agent" is a role="tab" in the panel's tablist, not a button.
    await userEvent.click(canvas.getByRole("tab", { name: "Add agent" }));
    await expect(canvas.findByText("What would you like to connect?")).resolves.toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: /Coding agents/ }));
    await expect(canvas.findByText("Choose a coding agent")).resolves.toBeVisible();
  },
};
