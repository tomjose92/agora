jest.mock(
  "lucide-react-native",
  () => new Proxy({}, { get: () => () => null }),
);

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClient, ApiProvider, type MapMessageArtifact } from "@agora/core";
import { ArtifactList, MapViewer } from "../src/components/MapArtifacts";
import { Text } from "react-native";
import { WebView } from "react-native-webview";

const mockWebView = WebView as typeof WebView & { injected: string[] };

beforeEach(() => {
  mockWebView.injected.length = 0;
});

const artifact: MapMessageArtifact = {
  id: "map",
  type: "map",
  version: 1,
  title: "Viewer",
  data: {
    initial_view: { mode: "fit" },
    regions: [
      { id: "r", label: "Region", center: { lat: 1, lng: 2 }, day_ids: [] },
      {
        id: "r2",
        label: "Region two",
        center: { lat: 3, lng: 4 },
        day_ids: [],
      },
      {
        id: "empty",
        label: "Empty region",
        center: { lat: 5, lng: 6 },
        day_ids: [],
      },
    ],
    days: [
      {
        id: "d1",
        number: 1,
        label: "Day one",
        region_id: "r",
        place_ids: ["p"],
      },
      {
        id: "d2",
        number: 2,
        label: "Day two",
        region_id: "r2",
        place_ids: ["p2"],
      },
    ],
    places: [
      {
        id: "p",
        label: "Place",
        position: { lat: 1, lng: 2 },
        region_id: "r",
        day_ids: ["d1"],
        category: "sight",
        order: 0,
      },
      {
        id: "p2",
        label: "Second place",
        position: { lat: 3, lng: 4 },
        region_id: "r2",
        day_ids: ["d2"],
        category: "food",
      },
    ],
    routes: [],
  },
};

function renderWithStyle(mapStyleUrl: string, viewedArtifact = artifact) {
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
          React.createElement(MapViewer, {
            artifact: viewedArtifact,
            onClose: jest.fn(),
          }),
        ),
      ),
    );
  });
  return tree;
}

function textOf(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .flat()
    .join(" ");
}

function pressText(tree: TestRenderer.ReactTestRenderer, text: string) {
  for (const label of tree.root
    .findAllByType(Text)
    .filter((node) => node.props.children === text)) {
    for (let node = label.parent; node; node = node.parent) {
      if (typeof node.props.onPress === "function") {
        act(() => node.props.onPress());
        return;
      }
    }
  }
  throw new Error(`No pressable text: ${text}`);
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
  const tile = tree.root.findAll(
    (node) =>
      node.props.testID === "tile-map" &&
      typeof node.props.onShouldStartLoadWithRequest === "function",
  )[0];
  expect(tile.props.source.baseUrl).toBe("https://unpkg.com/");
  expect(tile.props.originWhitelist).toEqual(["https://unpkg.com/*"]);
  expect(
    tile.props.onShouldStartLoadWithRequest({ url: "https://unpkg.com/a" }),
  ).toBe(true);
  expect(
    tile.props.onShouldStartLoadWithRequest({ url: "https://evil.test/" }),
  ).toBe(false);
});

test("filter changes keep the document stable and inject visible ids", () => {
  const tree = renderWithStyle("https://tiles.test/style.json");
  const tile = () =>
    tree.root.findAll((node) => node.props.testID === "tile-map")[0];
  const source = tile().props.source;
  const before = mockWebView.injected.length;
  pressText(tree, "sight");
  expect(tile().props.source).toBe(source);
  expect(mockWebView.injected).toHaveLength(before + 1);
  expect(mockWebView.injected.some((script) => script.includes('["p"]'))).toBe(
    true,
  );
});

test("reset always injects a refit even when filters are already clear", () => {
  const tree = renderWithStyle("https://tiles.test/style.json");
  const before = mockWebView.injected.length;
  pressText(tree, "Reset view");
  expect(mockWebView.injected).toHaveLength(before + 1);
  expect(mockWebView.injected.at(-1)).toContain('["p","p2"]');
});

test("configured style with zero matches keeps the tile document mounted", () => {
  const tree = renderWithStyle("https://tiles.test/style.json");
  const tile = tree.root.findAll((node) => node.props.testID === "tile-map")[0];
  const source = tile.props.source;
  pressText(tree, "Empty region");
  expect(
    tree.root.findAll((node) => node.props.testID === "tile-map")[0].props
      .source,
  ).toBe(source);
  expect(textOf(tree)).toContain("No places match these filters");
  expect(mockWebView.injected.at(-1)).toContain("[]");
});

test("tile bridge selects a place, ignores malformed data, and falls back on error", () => {
  const tree = renderWithStyle("https://tiles.test/style.json");
  const tile = () =>
    tree.root.findAll(
      (node) =>
        node.props.testID === "tile-map" &&
        typeof node.props.onMessage === "function",
    )[0];

  act(() => tile().props.onMessage({ nativeEvent: { data: "not json" } }));
  expect(tile()).toBeTruthy();
  act(() =>
    tile().props.onMessage({
      nativeEvent: { data: JSON.stringify({ ready: true }) },
    }),
  );
  expect(mockWebView.injected.some((script) => script.includes("p2"))).toBe(
    true,
  );
  act(() =>
    tile().props.onMessage({
      nativeEvent: { data: JSON.stringify({ placeId: "p2" }) },
    }),
  );
  expect(textOf(tree)).toContain("Second place");
  act(() =>
    tile().props.onMessage({
      nativeEvent: { data: JSON.stringify({ error: "offline" }) },
    }),
  );
  expect(
    tree.root.findAll((node) => node.props.testID === "tile-map"),
  ).toHaveLength(0);
  expect(
    tree.root.findAll((node) => node.props.testID === "coordinate-map").length,
  ).toBeGreaterThan(0);
});

test("changing filters cannot retain a selected place outside the result set", () => {
  const tree = renderWithStyle("");
  pressText(tree, "Second place");
  expect(textOf(tree)).toContain("Second place");
  pressText(tree, "1 · Day one");
  const labels = tree.root
    .findAllByType(Text)
    .map((node) => node.props.children);
  expect(labels.filter((value) => value === "Second place")).toHaveLength(0);
  expect(labels).toContain("Place");
});

test("category choices follow the active area and clear an invalid category", () => {
  const tree = renderWithStyle("");
  pressText(tree, "food");
  expect(textOf(tree)).toContain("Second place");
  pressText(tree, "Region");
  expect(textOf(tree)).toContain("Place");
  expect(
    tree.root.findAllByType(Text).map((node) => node.props.children),
  ).not.toContain("food");
});

test("places-only artifacts plot their places in the inline card", () => {
  const placesOnly = { ...artifact, data: { ...artifact.data, regions: [] } };
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(ArtifactList, { artifacts: [placesOnly] }),
    );
  });
  expect(
    tree.root.findAll((node) => node.props.accessibilityLabel === "Place")
      .length,
  ).toBeGreaterThan(0);
  expect(textOf(tree)).not.toContain("No mappable locations");
  expect(
    tree.root.findAll((node) => node.props.children === 0).length,
  ).toBeGreaterThan(0);
});

test("missing days default to an empty list", () => {
  const withoutDays = {
    ...artifact,
    data: {
      ...artifact.data,
      days: undefined as unknown as MapMessageArtifact["data"]["days"],
    },
  };
  expect(() => renderWithStyle("", withoutDays)).not.toThrow();
});
