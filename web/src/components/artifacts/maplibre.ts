import type { MapArtifactData, MapArtifactPlace } from "@agora/core";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre loads its parser off a Web Worker. Vite 8/rolldown doesn't emit the
// package's internal `new URL('./maplibre-gl-worker.mjs', import.meta.url)`
// asset, so we hand it a `?worker&url` build (which bundles the shared chunk
// in) and register it before the first map is created.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

let workerRegistered = false;

/** Dynamic-import maplibre-gl (kept out of the chat bundle) with the worker
    URL registered exactly once. Both the viewer canvas and the inline card
    preview go through here. */
export async function loadMaplibre() {
  const maplibre = await import("maplibre-gl");
  if (!workerRegistered) {
    maplibre.setWorkerUrl(maplibreWorkerUrl);
    workerRegistered = true;
  }
  return maplibre;
}

/* A best-effort WebGL probe. MapLibre dropped its static `supported()` helper,
   and a failed context otherwise surfaces only as a runtime console error. */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* Distinct, colour-blind-friendly hues cycled per itinerary day so a place's
   marker reads as "which day". Places without a day fall back to the accent. */
export const DAY_COLORS = [
  "#5aa0ff", "#f97362", "#4ec9a8", "#e8a13c", "#b98bff",
  "#ec6ba8", "#54c1e0", "#c0b03a", "#7c9cff", "#5fbf7a",
];
const NEUTRAL = "#8aa0c0";

export function colorForPlace(place: MapArtifactPlace, data: MapArtifactData): string {
  const dayId = place.day_ids[0];
  if (!dayId) return NEUTRAL;
  const day = data.days.find(d => d.id === dayId);
  if (!day) return NEUTRAL;
  return DAY_COLORS[(day.number - 1 + DAY_COLORS.length) % DAY_COLORS.length];
}
