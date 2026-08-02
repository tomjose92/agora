import { describe, expect, it } from "vitest";
import {
  DAY_COLORS, colorForPlace, formatDuration, googleMapsDirectionsUrl,
  googleMapsPlaceUrl, isMapArtifactV1,
  type MapArtifactData, type MapArtifactPlace,
} from "../src";

const place: MapArtifactPlace = {
  id: "hagia",
  label: "Hagia Sophia",
  position: { lat: 41.0086, lng: 28.9802 },
  day_ids: ["day-1"],
  category: "sight",
  duration_minutes: 90,
  google_place_id: "ChIJ-test",
};

describe("map artifacts", () => {
  it("recognizes the supported envelope", () => {
    expect(isMapArtifactV1({
      id: "trip", type: "map", version: 1, title: "Trip",
      data: { initial_view: { mode: "fit" }, regions: [], days: [], places: [], routes: [] },
    })).toBe(true);
    expect(isMapArtifactV1({
      id: "trip", type: "map", version: 2, title: "Trip", data: {},
    })).toBe(false);
  });

  it("builds keyless Google Maps URLs from sanitized values", () => {
    const placeUrl = new URL(googleMapsPlaceUrl(place));
    expect(placeUrl.searchParams.get("api")).toBe("1");
    expect(placeUrl.searchParams.get("query")).toBe("41.0086,28.9802");
    expect(placeUrl.searchParams.get("query_place_id")).toBe("ChIJ-test");

    const directionsUrl = new URL(googleMapsDirectionsUrl(place));
    expect(directionsUrl.searchParams.get("destination")).toBe("41.0086,28.9802");
    expect(directionsUrl.searchParams.get("destination_place_id")).toBe("ChIJ-test");
  });

  it("formats itinerary durations", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(90)).toBe("1 hr 30 min");
  });

  it("colors places by itinerary day with a neutral fallback", () => {
    const data: MapArtifactData = {
      initial_view: { mode: "fit" },
      regions: [],
      days: [
        { id: "day-1", number: 1, label: "One", region_id: "r", place_ids: [] },
        { id: "day-12", number: 12, label: "Twelve", region_id: "r", place_ids: [] },
      ],
      places: [],
      routes: [],
    };
    expect(colorForPlace({ ...place, day_ids: ["day-1"] }, data)).toBe(DAY_COLORS[0]);
    // Day numbers cycle through the palette.
    expect(colorForPlace({ ...place, day_ids: ["day-12"] }, data))
      .toBe(DAY_COLORS[(12 - 1) % DAY_COLORS.length]);
    expect(colorForPlace({ ...place, day_ids: [] }, data)).toBe("#8aa0c0");
    expect(colorForPlace({ ...place, day_ids: ["missing"] }, data)).toBe("#8aa0c0");
    expect(colorForPlace(place, { ...data, days: undefined as unknown as MapArtifactData["days"] }))
      .toBe("#8aa0c0");
  });
});
