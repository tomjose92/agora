import type { Meta, StoryObj } from "@storybook/react-native";
import type { MapMessageArtifact, MessageArtifact } from "@agora/core";
import { fn } from "storybook/test";
import { ArtifactList, MapViewer } from "./MapArtifacts";

export const mobileMapFixture: MapMessageArtifact = {
  id: "kerala-trip",
  type: "map",
  version: 1,
  title: "Kerala itinerary",
  summary: "Two days between the coast and tea country.",
  data: {
    initial_view: { mode: "fit" },
    regions: [
      {
        id: "kochi",
        label: "Kochi",
        center: { lat: 9.9312, lng: 76.2673 },
        day_ids: ["d1"],
      },
      {
        id: "munnar",
        label: "Munnar",
        center: { lat: 10.0889, lng: 77.0595 },
        day_ids: ["d2"],
      },
    ],
    days: [
      {
        id: "d1",
        number: 1,
        label: "Fort Kochi",
        region_id: "kochi",
        place_ids: ["fort"],
      },
      {
        id: "d2",
        number: 2,
        label: "Tea country",
        region_id: "munnar",
        place_ids: ["museum"],
      },
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
    routes: [
      {
        id: "overview",
        kind: "overview",
        label: "Trip",
        place_ids: ["fort", "museum"],
        region_ids: ["kochi", "munnar"],
        coordinates: [
          [76.2421, 9.9658],
          [77.0594, 10.1015],
        ],
      },
    ],
  },
};

const unsupported: MessageArtifact = {
  id: "future",
  type: "timeline",
  version: 99,
  title: "Future artifact",
  data: {},
};
const areaOnly: MapMessageArtifact = {
  ...mobileMapFixture,
  id: "areas",
  title: "Areas only",
  data: { ...mobileMapFixture.data, places: [], routes: [] },
};
const meta = {
  title: "Native/Messages/Map artifacts",
  component: ArtifactList,
  args: { artifacts: [mobileMapFixture] },
  parameters: {
    apiRoutes: { "GET /api/me": { username: "tom", map_style_url: "" } },
  },
} satisfies Meta<typeof ArtifactList>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Itinerary: Story = {};
export const AreaOnly: Story = { args: { artifacts: [areaOnly] } };
export const UnsupportedVersion: Story = { args: { artifacts: [unsupported] } };
export const MultipleArtifacts: Story = {
  args: { artifacts: [mobileMapFixture, unsupported] },
};
export const OpenCoordinateViewer: Story = {
  render: () => <MapViewer artifact={mobileMapFixture} onClose={fn()} />,
};
export const OpenAreaOnlyViewer: Story = {
  render: () => <MapViewer artifact={areaOnly} onClose={fn()} />,
};
export const OpenTileViewer: Story = {
  parameters: {
    apiRoutes: {
      "GET /api/me": {
        username: "tom",
        map_style_url: "https://demotiles.maplibre.org/style.json",
      },
    },
  },
  render: () => (
    <MapViewer
      artifact={mobileMapFixture}
      initialRegion="kochi"
      onClose={fn()}
    />
  ),
};
