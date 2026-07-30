import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import {
  fixtureAgentMessage,
  fixtureGroups,
  fixtureMe,
} from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { SearchPane } from "./SearchPane";

const hit = {
  ...fixtureAgentMessage,
  channel_name: "storybook",
  group_id: "product",
  group_name: "Product",
  snippet: "The real panes use \u0001fixture\u0002 data.",
};

const routes = {
  "GET /api/me": fixtureMe,
  "GET /api/groups": { groups: fixtureGroups },
  "GET /api/search?q=fixture": {
    query: "fixture",
    groups: [{ id: "product", name: "Product", description: "Product planning", hidden: false }],
    channels: [{
      id: "general",
      group_id: "product",
      name: "storybook",
      topic: "Component development",
      hidden: false,
      group_name: "Product",
    }],
    messages: { items: [hit], has_more: false, offset: 0 },
  },
};

const meta = {
  title: "Web/Connected/Search",
  component: SearchPane,
  parameters: {
    apiRoutes: routes,
    setup: () => useUiState.setState({ searchOpen: true }),
  },
} satisfies Meta<typeof SearchPane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ResultsAndKeyboardNavigation: Story = {
  parameters: {
    docs: { description: { story: "Searches fixture-backed groups, channels, and messages. Escape-close is tested mid-run, then results are reopened for inspection." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByPlaceholderText("Search messages, channels, groups…");
    await userEvent.type(input, "fixture");
    await expect(canvas.findByText("Product planning")).resolves.toBeVisible();
    await expect(canvas.findByText("fixture")).resolves.toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(useUiState.getState().searchOpen).toBe(false);
    useUiState.getState().setSearchOpen(true);
    const reopened = await canvas.findByPlaceholderText("Search messages, channels, groups…");
    // The pane keeps its query across close/reopen — clear it or the retype
    // appends and queries a route the fixtures don't define.
    await userEvent.clear(reopened);
    await userEvent.type(reopened, "fixture");
    await expect(canvas.findByText("Product planning")).resolves.toBeVisible();
  },
};
