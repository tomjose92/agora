import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import {
  fixtureGroups,
  fixtureMe,
  fixtureThreads,
} from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { ThreadsInbox } from "./ThreadsInbox";

const meta = {
  title: "Web/Connected/Threads inbox",
  component: ThreadsInbox,
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": { threads: fixtureThreads },
    },
    setup: () => useUiState.setState({ view: { kind: "inbox" }, mobileView: "main" }),
  },
} satisfies Meta<typeof ThreadsInbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UnreadThread: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("1")).resolves.toBeVisible();
    await userEvent.click(canvas.getByText("Can we validate the responsive component layout?"));
    expect(useUiState.getState().threadRoot).toBe(42);
    expect(useUiState.getState().sel).toEqual({ g: "product", c: "general" });
  },
};

export const Empty: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "GET /api/threads?limit=100": { threads: [] },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByText("No threads yet")).resolves.toBeVisible();
  },
};
