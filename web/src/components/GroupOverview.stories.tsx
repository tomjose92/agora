import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { fixtureGroups, fixtureMe } from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { GroupOverview } from "./GroupOverview";

const hideChannel = fn(() => ({ ok: true }));

const meta = {
  title: "Web/Connected/Group overview",
  component: GroupOverview,
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/groups": { groups: fixtureGroups },
      "PATCH /api/groups/product/channels/general": hideChannel,
      "PATCH /api/groups/product": { ok: true },
    },
    setup: () => useUiState.setState({
      sel: { g: "product" },
      view: { kind: "group" },
      mobileView: "main",
    }),
  },
} satisfies Meta<typeof GroupOverview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ChannelsAndUnread: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Component development and responsive review")).resolves.toBeVisible();
    await userEvent.click(canvas.getByTitle("Hide #storybook from your sidebar"));
    await expect(hideChannel).toHaveBeenCalledWith({ hidden: true });
  },
};
