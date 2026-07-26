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

export function formatDuration(minutes?: number): string | null {
  if (!minutes) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}
