import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { MapMessageArtifact, MessageArtifact } from "@agora/core";
import { ArtifactList } from "./ArtifactList";

export const itinerary: MapMessageArtifact = {
  id: "kerala-trip",
  type: "map",
  version: 1,
  title: "Kerala component itinerary",
  summary: "Interactive regions, days, places, and filters.",
  data: {
    initial_view: { mode: "fit" },
    regions: [
      { id: "kochi", label: "Kochi", center: { lat: 9.9312, lng: 76.2673 }, day_ids: ["d1"] },
      { id: "munnar", label: "Munnar", center: { lat: 10.0889, lng: 77.0595 }, day_ids: ["d2"] },
    ],
    days: [
      { id: "d1", number: 1, label: "Fort Kochi", region_id: "kochi", place_ids: ["fort"] },
      { id: "d2", number: 2, label: "Tea country", region_id: "munnar", place_ids: ["museum"] },
    ],
    places: [
      {
        id: "fort",
        label: "Fort Kochi",
        position: { lat: 9.9658, lng: 76.2421 },
        region_id: "kochi",
        day_ids: ["d1"],
        order: 1,
        category: "sight",
        description: "Historic waterfront district.",
        start_time: "09:00",
        duration_minutes: 120,
      },
      {
        id: "museum",
        label: "Tea Museum",
        position: { lat: 10.1015, lng: 77.0594 },
        region_id: "munnar",
        day_ids: ["d2"],
        order: 2,
        category: "activity",
        description: "Tea history and tasting.",
        duration_minutes: 90,
      },
    ],
    routes: [{
      id: "overview",
      kind: "overview",
      label: "Trip",
      place_ids: ["fort", "museum"],
      region_ids: ["kochi", "munnar"],
      coordinates: [[76.2421, 9.9658], [77.0594, 10.1015]],
    }],
  },
};

const unsupported: MessageArtifact = {
  id: "future",
  type: "timeline",
  version: 99,
  title: "Future artifact",
  data: {},
};

const meta = {
  title: "Web/Artifacts/Artifact list",
  component: ArtifactList,
  args: { artifacts: [itinerary, unsupported] },
  parameters: { apiRoutes: { "GET /api/me": { username: "tom", map_style_url: "" } } },
  // `itinerary` is fixture data shared with MapPreview stories, not a story.
  excludeStories: ["itinerary"],
} satisfies Meta<typeof ArtifactList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SupportedAndUnsupported: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByText("Future artifact")).resolves.toBeVisible();
    // Both the card head and the preview expose the title; target the preview.
    await userEvent.click(canvas.getByRole("button", { name: "Open Kerala component itinerary" }));
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.findByRole("dialog", { name: "Kerala component itinerary" })).resolves.toBeVisible();
    await userEvent.selectOptions(page.getByLabelText("Area"), "kochi");
    await expect(page.findByRole("heading", { name: "Fort Kochi" })).resolves.toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  },
};
