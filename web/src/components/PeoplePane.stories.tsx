import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { fixtureMe, fixtureUsers } from "@agora/core/testing/fixtures";
import { useUiState } from "../state/ui";
import { PeoplePane } from "./PeoplePane";

const invite = fn(() => ({
  email: "new@example.test",
  instance_role: "member",
  invited_by: "tom",
}));

const meta = {
  title: "Web/Connected/People and invites",
  component: PeoplePane,
  parameters: {
    apiRoutes: {
      "GET /api/me": fixtureMe,
      "GET /api/users": { users: fixtureUsers },
      "GET /api/invites": {
        invites: [{
          email: "pending@example.test",
          instance_role: "member",
          invited_by: "tom",
          accepted_at: null,
        }],
        links: [],
      },
      "POST /api/invites": invite,
    },
    setup: () => useUiState.setState({ panel: "people" }),
  },
} satisfies Meta<typeof PeoplePane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UsersAndInvite: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText(/@tom · you/)).resolves.toBeVisible();
    await userEvent.type(canvas.getByPlaceholderText("person@example.com"), "new@example.test");
    await userEvent.click(canvas.getByRole("button", { name: "Invite" }));
    await expect(invite).toHaveBeenCalledWith({
      email: "new@example.test",
      instance_role: "member",
    });
  },
};
