import { useEffect, useRef, useState } from "react";
import type { Map as MlMap, Marker as MlMarker } from "maplibre-gl";
import type { MapArtifactData } from "@agora/core";
import { MapGraphic } from "./MapGraphic";
import { colorForPlace, loadMaplibre, webglAvailable } from "./maplibre";

/* Non-interactive real-tiles preview for the inline chat card — the
   Google-Maps-style "route thumbnail" that the full viewer expands. The GL
   context is created only while the card is (near) the viewport and torn down
   when it scrolls far away, so a channel full of map cards can't exhaust the
   browser's WebGL context budget. Interaction stays with the card's button
   (click opens the viewer); any failure falls back to the SVG sketch. */
export default function MapPreview({ data, styleUrl }: {
  data: MapArtifactData;
  styleUrl: string;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markers = useRef<MlMarker[]>([]);
  const [inView, setInView] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!holder.current || typeof IntersectionObserver !== "function") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      entries => setInView(entries.some(entry => entry.isIntersecting)),
      { rootMargin: "240px" },
    );
    observer.observe(holder.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!inView || failed) return;
    if (!holder.current || !webglAvailable()) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const maplibre = await loadMaplibre();
        if (cancelled || !holder.current || mapRef.current) return;
        const coords: [number, number][] = data.places.length
          ? data.places.map(p => [p.position.lng, p.position.lat])
          : data.regions.map(r => [r.center.lng, r.center.lat]);
        if (!coords.length) {
          setFailed(true);
          return;
        }
        const bounds = coords.reduce(
          (acc, c) => acc.extend(c),
          new maplibre.LngLatBounds(coords[0], coords[0]),
        );
        const map = new maplibre.Map({
          container: holder.current,
          style: styleUrl,
          attributionControl: { compact: true },
          interactive: false,
          bounds,
          fitBoundsOptions: { padding: 32, maxZoom: 13 },
        });
        let loaded = false;
        map.on("load", () => {
          if (cancelled) return;
          loaded = true;
          setReady(true);
          // The compact attribution opens itself on load; collapsed to the
          // (i) toggle it stays out of the small thumbnail's way.
          holder.current?.querySelector(".maplibregl-ctrl-attrib")
            ?.classList.remove("maplibregl-compact-show");
          const routes = data.routes
            .filter(route => route.coordinates.length > 1)
            .map(route => ({
              type: "Feature" as const,
              properties: {},
              geometry: { type: "LineString" as const, coordinates: route.coordinates },
            }));
          if (routes.length) {
            map.addSource("ago-preview-routes", {
              type: "geojson",
              data: { type: "FeatureCollection", features: routes },
            });
            map.addLayer({
              id: "ago-preview-routes",
              type: "line",
              source: "ago-preview-routes",
              layout: { "line-cap": "round", "line-join": "round" },
              paint: {
                "line-color": "#5aa0ff",
                "line-width": 2,
                "line-opacity": 0.8,
                "line-dasharray": [2, 1.4],
              },
            });
          }
        });
        map.on("error", event => {
          if (!cancelled && event?.error && !loaded) setFailed(true);
        });
        markers.current = data.places.length
          ? data.places.map(place => {
            const el = document.createElement("span");
            el.className = "ago-gl-dot";
            el.style.setProperty("--marker", colorForPlace(place, data));
            return new maplibre.Marker({ element: el })
              .setLngLat([place.position.lng, place.position.lat])
              .addTo(map);
          })
          : data.regions.map(region => {
            const el = document.createElement("span");
            el.className = "ago-gl-area preview";
            el.textContent = region.label;
            return new maplibre.Marker({ element: el, anchor: "bottom", offset: [0, -4] })
              .setLngLat([region.center.lng, region.center.lat])
              .addTo(map);
          });
        mapRef.current = map;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      markers.current.forEach(m => m.remove());
      markers.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, [inView, failed, data, styleUrl]);

  if (failed) return <MapGraphic data={data} />;
  return (
    <div className="ago-map-preview-holder">
      {!ready && <MapGraphic data={data} />}
      <div ref={holder} className={`ago-map-preview-gl ${ready ? "ready" : ""}`} />
    </div>
  );
}
