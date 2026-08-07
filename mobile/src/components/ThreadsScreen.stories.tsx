import type { Meta, StoryObj } from "@storybook/react-native";
import { fixtureThreads } from "@agora/core/testing/fixtures";
import ThreadsScreen, { RenameModal } from "../../app/(app)/threads";

const meta = {
  title: "Native/Screens/Threads inbox",
  component: ThreadsScreen,
  parameters: {
    apiRoutes: { "GET /api/threads?limit=100": { threads: fixtureThreads } },
  },
} satisfies Meta<typeof ThreadsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UnreadThread: Story = {};
/* Dialog opens prefilled with the thread's current alias. */
export const RenameDialog: Story = {
  render: () => (
    <RenameModal
      thread={{
        ...fixtureThreads[0],
        root: { ...fixtureThreads[0].root, alias: "Launch notes" },
      }}
      onClose={() => undefined}
    />
  ),
};
export const Empty: Story = {
  parameters: { apiRoutes: { "GET /api/threads?limit=100": { threads: [] } } },
};
