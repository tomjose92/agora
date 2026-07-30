import type { Meta, StoryObj } from "@storybook/react-vite";
import { MapGraphic } from "./MapGraphic";
import { mapArtifact } from "../../stories/fixtures/data";

const meta = {
  title: "Web/Artifacts/Map graphic",
  component: MapGraphic,
  decorators: [(Story) => <div style={{ width: "min(700px, 100%)" }}><Story /></div>],
} satisfies Meta<typeof MapGraphic>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Regions: Story = {
  args: { data: mapArtifact },
};

export const Empty: Story = {
  args: { data: { ...mapArtifact, regions: [] } },
};
