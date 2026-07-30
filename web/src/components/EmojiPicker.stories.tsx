import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { EmojiPickerHost, useEmojiPicker } from "./EmojiPicker";

const pick = fn();

function PickerSurface() {
  return (
    <>
      <button
        className="ago-react-btn"
        onClick={(event) => useEmojiPicker.getState().open(42, event.currentTarget)}
      >
        Open reaction picker
      </button>
      <EmojiPickerHost onPick={pick} />
    </>
  );
}

const meta = {
  title: "Web/Overlays/Emoji picker",
  component: PickerSurface,
} satisfies Meta<typeof PickerSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SearchAndPick: Story = {
  parameters: {
    docs: { description: { story: "Searches for and selects 🎉, verifies the reaction callback and automatic close, then reopens the filtered picker for inspection." } },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByText("Open reaction picker"));
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.type(await page.findByPlaceholderText("Search emoji…"), "party");
    await userEvent.click(await page.findByTitle(/party popper celebration/));
    await expect(pick).toHaveBeenCalledWith(42, "🎉");
    await waitFor(() => expect(page.queryByPlaceholderText("Search emoji…")).not.toBeInTheDocument());
    await userEvent.click(within(canvasElement).getByText("Open reaction picker"));
    await userEvent.type(await page.findByPlaceholderText("Search emoji…"), "party");
    await expect(page.findByTitle(/party popper celebration/)).resolves.toBeVisible();
  },
};

export const NoMatches: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByText("Open reaction picker"));
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.type(await page.findByPlaceholderText("Search emoji…"), "not-an-emoji");
    await expect(page.findByText("No matching emoji.")).resolves.toBeVisible();
  },
};
