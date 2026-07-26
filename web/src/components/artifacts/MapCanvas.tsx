import { useEffect, useRef, useState } from "react";
import type {
  GeoJSONSource, Map as MlMap, Marker as MlMarker, Popup as MlPopup,
} from "maplibre-gl";
import Supercluster from "supercluster";
import type { MapArtifactData, MapArtifactPlace, MapArtifactRegion } from "@agora/core";
import { MapGraphic } from "./MapGraphic";
import { colorForPlace, loadMaplibre, prefersReducedMotion, webglAvailable } from "./maplibre";

/* The hover card shown over a pin: place name plus its day/category context,
   so the map answers "what is this?" without a trip to the side panel. */
function popupHtml(place: MapArtifactPlace, data: MapArtifactData): string {
  const esc = (text: string) => text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const chips = place.day_ids
    .map(id => data.days.find(d => d.id === id))
    .filter(Boolean)
    .map(d => `<span class="ago-gl-popup-day">Day ${d!.number}</span>`)
    .join("");
  const time = place.start_time ? `<span>${esc(place.start_time)}</span>` : "";
  return `<div class="ago-gl-popup">
    <strong>${esc(place.label)}</strong>
    <div class="ago-gl-popup-meta">${chips}${time}<span>${esc(place.category)}</span></div>
  </div>`;
}

/* One place carried as a supercluster point; `place` rides along so a click on
   an un-clustered marker maps straight back to the itinerary entry. */
type PointProps = { place: MapArtifactPlace; color: string; order: number };

/* Real slippy-map renderer over the configured vector style. Reuses the
   artifact's sanitized coordinates for clustered markers, labelled area chips,
   a route line, and bounds. Any failure — no WebGL, style/tiles unreachable —
   degrades to the SVG `MapGraphic` so the itinerary stays usable offline. */
export default function MapCanvas({
  data, styleUrl, activeRegion, visiblePlaces, selectedPlace, onPlace, onRegion,
}: {
  data: MapArtifactData;
  styleUrl: string;
  activeRegion?: string;
  visiblePlaces: MapArtifactPlace[];
  selectedPlace?: string;
  onPlace: (place: MapArtifactPlace) => void;
  onRegion?: (region: MapArtifactRegion) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  // Every marker currently on the map (points + cluster bubbles), cleared and
  // rebuilt each render; the by-id map drives selection highlighting.
  const shown = useRef<MlMarker[]>([]);
  const areaMarkers = useRef<MlMarker[]>([]);
  const pointEls = useRef<Map<string, HTMLElement>>(new Map());
  const clusterRef = useRef<Supercluster<PointProps> | null>(null);
  const renderRef = useRef<() => void>(() => {});
  const popupRef = useRef<MlPopup | null>(null);
  const selectedRef = useRef<string | undefined>(selectedPlace);
  selectedRef.current = selectedPlace;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const onPlaceRef = useRef(onPlace);
  onPlaceRef.current = onPlace;
  const onRegionRef = useRef(onRegion);
  onRegionRef.current = onRegion;

  // ---- map lifecycle -------------------------------------------------------
  useEffect(() => {
    if (!holder.current || !webglAvailable()) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const maplibre = await loadMaplibre();
        if (cancelled || !holder.current) return;
        const map = new maplibre.Map({
          container: holder.current,
          style: styleUrl,
          attributionControl: { compact: true },
          dragRotate: false,
          pitchWithRotate: false,
        });
        map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
        map.on("load", () => {
          if (cancelled) return;
          setReady(true);
          // Start with the compact attribution collapsed to its (i) toggle.
          holder.current?.querySelector(".maplibregl-ctrl-attrib")
            ?.classList.remove("maplibregl-compact-show");
        });
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
      areaMarkers.current.forEach(m => m.remove());
      areaMarkers.current = [];
      pointEls.current.clear();
      popupRef.current?.remove();
      popupRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [styleUrl]);

  // ---- labelled area chips -------------------------------------------------
  // City/region labels stay on the map at all times (Google-Maps-style):
  // they anchor an areas-only itinerary that would otherwise render as bare
  // tiles, and clicking one focuses that area's filter.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let cancelled = false;
    void (async () => {
      const maplibre = await loadMaplibre();
      if (cancelled || !mapRef.current) return;
      areaMarkers.current.forEach(m => m.remove());
      areaMarkers.current = data.regions.map(region => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "ago-gl-area";
        el.classList.toggle("selected", region.id === activeRegion);
        el.textContent = region.label;
        el.setAttribute("aria-label", `Focus ${region.label}`);
        el.addEventListener("click", event => {
          event.stopPropagation();
          onRegionRef.current?.(region);
        });
        return new maplibre.Marker({ element: el, anchor: "bottom", offset: [0, -6] })
          .setLngLat([region.center.lng, region.center.lat])
          .addTo(map);
      });
    })();
    return () => { cancelled = true; };
  }, [ready, data, activeRegion]);

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
      const maplibre = await loadMaplibre();
      if (cancelled) return;

      const applySelected = () => pointEls.current.forEach((el, id) =>
        el.classList.toggle("selected", id === selectedRef.current));

      const showPopup = (place: MapArtifactPlace, lngLat: [number, number]) => {
        const m = mapRef.current;
        if (!m) return;
        popupRef.current?.remove();
        popupRef.current = new maplibre.Popup({
          closeButton: false, closeOnClick: false, offset: 18,
          className: "ago-gl-popup-holder", maxWidth: "260px",
        })
          .setLngLat(lngLat)
          .setHTML(popupHtml(place, data))
          .addTo(m);
      };

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
            el.addEventListener("click", event => {
              event.stopPropagation();
              onPlaceRef.current(props.place);
              showPopup(props.place, [lng, lat]);
            });
            el.addEventListener("mouseenter", () => showPopup(props.place, [lng, lat]));
            el.addEventListener("mouseleave", () => {
              popupRef.current?.remove();
              popupRef.current = null;
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
      const maplibre = await loadMaplibre();
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
