import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { fixtureAgentMessage } from "@agora/core/testing/fixtures";
import { useSourcesView } from "./MessageItem";
import { SourcesViewer } from "./SourcesViewer";

const message = {
  ...fixtureAgentMessage,
  meta: {
    sources: [
      {
        url: "https://storybook.js.org/",
        site: "storybook.js.org",
        title: "Storybook documentation",
        description: "Component development and testing.",
      },
      {
        url: "https://react.dev/",
        site: "react.dev",
        title: "React documentation",
        description: "Building component interfaces.",
      },
    ],
  },
};

const meta = {
  title: "Web/Overlays/Sources viewer",
  component: SourcesViewer,
  parameters: { setup: () => useSourcesView.getState().show(message, 0) },
} satisfies Meta<typeof SourcesViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const KeyboardAndButtons: Story = {
  parameters: {
    docs: { description: { story: "Moves between two cited sources, verifies Escape-close, then reopens on source two for visual inspection." } },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.findByText("Source 1 of 2")).resolves.toBeVisible();
    await userEvent.click(page.getByTitle("Next source"));
    await expect(page.findByText("React documentation")).resolves.toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(page.queryByText("React documentation")).not.toBeInTheDocument();
    useSourcesView.getState().show(message, 1);
    await expect(page.findByText("React documentation")).resolves.toBeVisible();
  },
};
