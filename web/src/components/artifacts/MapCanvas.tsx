import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MlMap, Marker as MlMarker } from "maplibre-gl";
import Supercluster from "supercluster";
import type { MapArtifactData, MapArtifactPlace } from "@agora/core";
import { MapGraphic } from "./MapGraphic";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre loads its parser off a Web Worker. Vite 8/rolldown doesn't emit the
// package's internal `new URL('./maplibre-gl-worker.mjs', import.meta.url)`
// asset, so we hand it a `?worker&url` build (which bundles the shared chunk
// in) and register it before the first map is created.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

let workerRegistered = false;

/* Distinct, colour-blind-friendly hues cycled per itinerary day so a place's
   marker reads as "which day". Places without a day fall back to the accent. */
const DAY_COLORS = [
  "#5aa0ff", "#f97362", "#4ec9a8", "#e8a13c", "#b98bff",
  "#ec6ba8", "#54c1e0", "#c0b03a", "#7c9cff", "#5fbf7a",
];
const NEUTRAL = "#8aa0c0";

function colorForPlace(place: MapArtifactPlace, data: MapArtifactData): string {
  const dayId = place.day_ids[0];
  if (!dayId) return NEUTRAL;
  const day = data.days.find(d => d.id === dayId);
  if (!day) return NEUTRAL;
  return DAY_COLORS[(day.number - 1 + DAY_COLORS.length) % DAY_COLORS.length];
}

/* A best-effort WebGL probe. MapLibre dropped its static `supported()` helper,
   and a failed context otherwise surfaces only as a runtime console error. */
function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* One place carried as a supercluster point; `place` rides along so a click on
   an un-clustered marker maps straight back to the itinerary entry. */
type PointProps = { place: MapArtifactPlace; color: string; order: number };

/* Real slippy-map renderer over the operator-configured vector style. Reuses
   the artifact's sanitized coordinates for clustered markers, a route line, and
   bounds. Any failure — no WebGL, style/tiles unreachable — degrades to the SVG
   `MapGraphic` so the itinerary stays usable offline. */
export default function MapCanvas({
  data, styleUrl, activeRegion, visiblePlaces, selectedPlace, onPlace,
}: {
  data: MapArtifactData;
  styleUrl: string;
  activeRegion?: string;
  visiblePlaces: MapArtifactPlace[];
  selectedPlace?: string;
  onPlace: (place: MapArtifactPlace) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  // Every marker currently on the map (points + cluster bubbles), cleared and
  // rebuilt each render; the by-id map drives selection highlighting.
  const shown = useRef<MlMarker[]>([]);
  const pointEls = useRef<Map<string, HTMLElement>>(new Map());
  const clusterRef = useRef<Supercluster<PointProps> | null>(null);
  const renderRef = useRef<() => void>(() => {});
  const selectedRef = useRef<string | undefined>(selectedPlace);
  selectedRef.current = selectedPlace;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const onPlaceRef = useRef(onPlace);
  onPlaceRef.current = onPlace;

  // ---- map lifecycle -------------------------------------------------------
  useEffect(() => {
    if (!holder.current || !webglAvailable()) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const maplibre = await import("maplibre-gl");
        if (cancelled || !holder.current) return;
        if (!workerRegistered) {
          maplibre.setWorkerUrl(maplibreWorkerUrl);
          workerRegistered = true;
        }
        const map = new maplibre.Map({
          container: holder.current,
          style: styleUrl,
          attributionControl: { compact: true },
          dragRotate: false,
          pitchWithRotate: false,
        });
        map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
        map.on("load", () => { if (!cancelled) setReady(true); });
        // Re-cluster whenever the viewport changes.
        map.on("moveend", () => renderRef.current());
        // A broken style/tile endpoint should fall back, not render blank.
        map.on("error", event => {
          if (!cancelled && event?.error && !mapRef.current) setFailed(true);
        });
        mapRef.current = map;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      shown.current.forEach(m => m.remove());
      shown.current = [];
      pointEls.current.clear();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [styleUrl]);

  // ---- clustered markers ---------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let cancelled = false;

    const index = new Supercluster<PointProps>({ radius: 56, maxZoom: 16 });
    index.load(visiblePlaces.map((place, i) => ({
      type: "Feature",
      properties: { place, color: colorForPlace(place, data), order: place.order || i + 1 },
      geometry: { type: "Point", coordinates: [place.position.lng, place.position.lat] },
    })));
    clusterRef.current = index;

    void (async () => {
      const maplibre = await import("maplibre-gl");
      if (cancelled) return;

      const applySelected = () => pointEls.current.forEach((el, id) =>
        el.classList.toggle("selected", id === selectedRef.current));

      const render = () => {
        const m = mapRef.current;
        if (!m) return;
        shown.current.forEach(mk => mk.remove());
        shown.current = [];
        pointEls.current.clear();
        const b = m.getBounds();
        const bbox: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
        for (const feat of index.getClusters(bbox, Math.round(m.getZoom()))) {
          const [lng, lat] = feat.geometry.coordinates;
          const props = feat.properties as Supercluster.ClusterProperties & PointProps;
          const el = document.createElement("button");
          el.type = "button";
          if (props.cluster) {
            el.className = "ago-gl-cluster";
            el.textContent = String(props.point_count);
            el.setAttribute("aria-label", `${props.point_count} places`);
            el.addEventListener("click", event => {
              event.stopPropagation();
              const zoom = Math.min(index.getClusterExpansionZoom(props.cluster_id), 16);
              m.easeTo({ center: [lng, lat], zoom, duration: prefersReducedMotion() ? 0 : 500 });
            });
          } else {
            el.className = "ago-gl-marker";
            el.style.setProperty("--marker", props.color);
            const label = document.createElement("span");
            label.textContent = String(props.order);
            el.appendChild(label);
            el.setAttribute("aria-label", props.place.label);
            el.title = props.place.label;
            el.addEventListener("click", event => {
              event.stopPropagation();
              onPlaceRef.current(props.place);
            });
            pointEls.current.set(props.place.id, el);
          }
          shown.current.push(new maplibre.Marker({ element: el }).setLngLat([lng, lat]).addTo(m));
        }
        applySelected();
      };

      renderRef.current = render;
      render();
    })();

    return () => { cancelled = true; };
  }, [visiblePlaces, ready, data]);

  // ---- route lines (agent coordinates are already [lng,lat]) ---------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const features = data.routes
      .filter(route => route.coordinates.length > 1)
      .map(route => ({
        type: "Feature" as const,
        properties: {},
        geometry: { type: "LineString" as const, coordinates: route.coordinates },
      }));
    const collection = { type: "FeatureCollection" as const, features };
    const source = map.getSource<GeoJSONSource>("ago-routes");
    if (source) {
      source.setData(collection);
      return;
    }
    map.addSource("ago-routes", { type: "geojson", data: collection });
    map.addLayer({
      id: "ago-routes",
      type: "line",
      source: "ago-routes",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#5aa0ff",
        "line-width": 2.5,
        "line-opacity": 0.85,
        "line-dasharray": [2, 1.4],
      },
    });
  }, [ready, data]);

  // ---- selection highlight -------------------------------------------------
  useEffect(() => {
    pointEls.current.forEach((el, id) => el.classList.toggle("selected", id === selectedPlace));
  }, [selectedPlace, visiblePlaces]);

  // ---- fit to the active region / visible places ---------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    void (async () => {
      const maplibre = await import("maplibre-gl");
      const coords: [number, number][] = visiblePlaces.length
        ? visiblePlaces.map(p => [p.position.lng, p.position.lat])
        : (activeRegion
            ? data.regions.filter(r => r.id === activeRegion)
            : data.regions
          ).map(r => [r.center.lng, r.center.lat]);
      if (!coords.length) return;
      const duration = prefersReducedMotion() ? 0 : 600;
      if (coords.length === 1) {
        map.easeTo({ center: coords[0], zoom: 12, duration });
        return;
      }
      const bounds = coords.reduce(
        (acc, c) => acc.extend(c),
        new maplibre.LngLatBounds(coords[0], coords[0]),
      );
      map.fitBounds(bounds, { padding: 56, maxZoom: 14, duration });
    })();
  }, [ready, activeRegion, visiblePlaces, data]);

  if (failed) {
    return (
      <MapGraphic data={data} activeRegion={activeRegion}
        visiblePlaces={visiblePlaces} selectedPlace={selectedPlace} onPlace={onPlace} />
    );
  }
  return <div ref={holder} className="ago-map-gl" />;
}
