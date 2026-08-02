import {
  filterMapPlaces,
  mapArtifactHtml,
  projectMapPoints,
} from "../src/lib/mapArtifacts";
import type { MapArtifactData } from "@agora/core";

const data: MapArtifactData = {
  initial_view: { mode: "fit" },
  regions: [
    { id: "r1", label: "One", center: { lat: 10, lng: 20 }, day_ids: ["d1"] },
  ],
  days: [
    { id: "d1", number: 1, label: "Day", region_id: "r1", place_ids: ["p1"] },
  ],
  places: [
    {
      id: "p1",
      label: "One",
      position: { lat: 10, lng: 20 },
      region_id: "r1",
      day_ids: ["d1"],
      category: "food",
    },
    {
      id: "p2",
      label: "Two",
      position: { lat: 12, lng: 24 },
      region_id: "r2",
      day_ids: ["d2"],
      category: "sight",
    },
  ],
  routes: [
    {
      id: "route",
      kind: "overview",
      place_ids: ["p1", "p2"],
      region_ids: [],
      coordinates: [
        [20, 10],
        [24, 12],
      ],
    },
  ],
};

test("filters places by area, day, and category", () => {
  expect(
    filterMapPlaces(data, { region: "r1", day: "d1", category: "food" }).map(
      (p) => p.id,
    ),
  ).toEqual(["p1"]);
  expect(
    filterMapPlaces(data, { region: "r1", day: "", category: "sight" }),
  ).toEqual([]);
});

test("projection is stable for empty and coincident points", () => {
  expect(projectMapPoints([])).toEqual([]);
  expect(projectMapPoints([{ id: "x", lat: 1, lng: 1 }])).toEqual([
    { id: "x", x: 50, y: 50 },
  ]);
});

test("tile HTML uses the MapLibre module build, preserves GeoJSON, and escapes markup", () => {
  const hostile = "</script><img src=x onerror=alert(1)>";
  const html = mapArtifactHtml(
    { ...data, places: [{ ...data.places[0], label: hostile }] },
    "https://tiles.test/<style>.json",
    [{ ...data.places[0], label: hostile }],
  );
  expect(html).toContain('type="module"');
  expect(html).toContain("maplibre-gl@6.0.0/dist/maplibre-gl.mjs");
  expect(html).not.toContain("dist/maplibre-gl.js");
  expect(html).toContain("Could not load the map renderer");
  expect(html).toContain("ReactNativeWebView?.postMessage");
  expect(html).toContain("(async () => {");
  expect(html).toContain('"coordinates":[[20,10],[24,12]]');
  expect(html).toContain("https://tiles.test/\\u003cstyle>.json");
  expect(html).not.toContain("<style>.json");
  expect(html).not.toContain(hostile);
  expect(html).toContain("\\u003c/script>\\u003cimg src=x onerror=alert(1)>");
});
