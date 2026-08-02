jest.mock(
  "lucide-react-native",
  () => new Proxy({}, { get: () => () => null }),
);

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, ApiProvider, type MapMessageArtifact } from "@agora/core";
import { MapViewer } from "../src/components/MapArtifacts";

const artifact: MapMessageArtifact = {
  id: "map",
  type: "map",
  version: 1,
  title: "Viewer",
  data: {
    initial_view: { mode: "fit" },
    regions: [
      { id: "r", label: "Region", center: { lat: 1, lng: 2 }, day_ids: [] },
    ],
    days: [],
    places: [
      {
        id: "p",
        label: "Place",
        position: { lat: 1, lng: 2 },
        day_ids: [],
        category: "sight",
      },
    ],
    routes: [],
  },
};

function renderWithStyle(mapStyleUrl: string) {
  const client = new QueryClient();
  client.setQueryData(["me"], {
    username: "alice",
    map_style_url: mapStyleUrl,
  });
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          ApiProvider,
          { client: new ApiClient({ baseUrl: "http://test", token: "t" }) },
          React.createElement(MapViewer, { artifact, onClose: jest.fn() }),
        ),
      ),
    );
  });
  return tree;
}

test("empty map style uses the coordinate renderer", () => {
  const tree = renderWithStyle("");
  expect(
    tree.root.findAll((node) => node.props.testID === "coordinate-map").length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAll((node) => node.props.testID === "tile-map"),
  ).toHaveLength(0);
});

test("configured map style uses the tile WebView", () => {
  const tree = renderWithStyle("https://tiles.test/style.json");
  expect(
    tree.root.findAll((node) => node.props.testID === "tile-map").length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAll((node) => node.props.testID === "coordinate-map"),
  ).toHaveLength(0);
});
