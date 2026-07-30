import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import MapPreview from "./MapPreview";
import { itinerary } from "./MapArtifacts.stories";

const meta = {
  title: "Web/Artifacts/Map preview",
  component: MapPreview,
  args: { data: itinerary.data, styleUrl: "" },
  decorators: [(Story) => <div style={{ width: 520 }}><Story /></div>],
} satisfies Meta<typeof MapPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SvgFallback: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByRole("img", {
      name: "Interactive itinerary map",
    })).resolves.toBeVisible();
  },
};
