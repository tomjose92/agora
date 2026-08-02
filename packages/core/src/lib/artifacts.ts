import type {
  MapArtifactData, MapArtifactPlace, MessageArtifact,
} from "../api/types";

export type MapMessageArtifact = MessageArtifact<MapArtifactData> & {
  type: "map";
  version: 1;
  data: MapArtifactData;
};

export function isMapArtifactV1(artifact: MessageArtifact): artifact is MapMessageArtifact {
  return artifact.type === "map"
    && artifact.version === 1
    && !!artifact.data
    && Array.isArray((artifact.data as MapArtifactData).places)
    && Array.isArray((artifact.data as MapArtifactData).regions);
}

export function googleMapsPlaceUrl(place: MapArtifactPlace): string {
  const query = `${place.position.lat},${place.position.lng}`;
  const params = new URLSearchParams({ api: "1", query });
  if (place.google_place_id) params.set("query_place_id", place.google_place_id);
  return `https://www.google.com/maps/search/?${params.toString()}`;
}

export function googleMapsDirectionsUrl(place: MapArtifactPlace): string {
  const params = new URLSearchParams({
    api: "1",
    destination: `${place.position.lat},${place.position.lng}`,
  });
  if (place.google_place_id) params.set("destination_place_id", place.google_place_id);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/* Distinct, colour-blind-friendly hues cycled per itinerary day so a place's
   marker reads as "which day". Places without a day fall back to the accent.
   Shared by the web MapLibre canvas and the mobile tile WebView so pins look
   identical across clients. */
export const DAY_COLORS = [
  "#5aa0ff", "#f97362", "#4ec9a8", "#e8a13c", "#b98bff",
  "#ec6ba8", "#54c1e0", "#c0b03a", "#7c9cff", "#5fbf7a",
];
const NEUTRAL_MARKER = "#8aa0c0";

export function colorForPlace(place: MapArtifactPlace, data: MapArtifactData): string {
  const dayId = place.day_ids[0];
  if (!dayId) return NEUTRAL_MARKER;
  const day = (data.days ?? []).find(d => d.id === dayId);
  if (!day) return NEUTRAL_MARKER;
  return DAY_COLORS[(day.number - 1 + DAY_COLORS.length) % DAY_COLORS.length];
}

export function formatDuration(minutes?: number): string | null {
  if (!minutes) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}
