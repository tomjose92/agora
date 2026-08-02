import type { MapArtifactData, MapArtifactPlace } from "@agora/core";

export type MapFilters = { region: string; day: string; category: string };
export type ProjectedPoint = { id: string; x: number; y: number };

export function filterMapPlaces(
  data: MapArtifactData,
  filters: MapFilters,
): MapArtifactPlace[] {
  return data.places.filter(
    (place) =>
      (!filters.region || place.region_id === filters.region) &&
      (!filters.day || place.day_ids.includes(filters.day)) &&
      (!filters.category || place.category === filters.category),
  );
}

export function projectMapPoints(
  points: Array<{ id: string; lat: number; lng: number }>,
): ProjectedPoint[] {
  if (!points.length) return [];
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;
  return points.map((point) => ({
    id: point.id,
    x: lngSpan < 0.000001 ? 50 : 8 + ((point.lng - minLng) / lngSpan) * 84,
    y: latSpan < 0.000001 ? 50 : 88 - ((point.lat - minLat) / latSpan) * 76,
  }));
}

export function mapArtifactHtml(
  data: MapArtifactData,
  styleUrl: string,
): string {
  const payload = JSON.stringify({
    places: data.places,
    routes: (data.routes ?? []).filter((route) => route.coordinates.length > 1),
  }).replace(/</g, "\\u003c");
  const style = JSON.stringify(styleUrl).replace(/</g, "\\u003c");
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta http-equiv="Content-Security-Policy"
      content="script-src 'unsafe-inline' https://unpkg.com blob:">
<link href="https://unpkg.com/maplibre-gl@6.0.0/dist/maplibre-gl.css" rel="stylesheet">
<style>
html,body,#map { margin:0; width:100%; height:100%; background:#0b1220; }
.pin { width:28px; height:28px; border:0; border-radius:50%; background:#8b7cff;
       color:#071019; font-weight:700; }
#err { color:#fca5a5; font:12px ui-monospace,monospace; padding:16px;
       white-space:pre-wrap; overflow-wrap:anywhere; }
</style></head><body><div id="map"></div>
<script type="module">
const data = ${payload};
const holder = document.getElementById("map");
let watchdog;
const reportError = (prefix, error) => {
  clearTimeout(watchdog);
  const detail = String(error?.message || error || "Unknown map error");
  window.ReactNativeWebView?.postMessage(JSON.stringify({ error: detail }));
  const message = document.createElement("div");
  message.id = "err";
  message.textContent = prefix + "\\n\\n" + detail;
  holder.replaceChildren(message);
};
(async () => {
  // This CDN keeps the renderer aligned with web's MapLibre major version;
  // operators still control the separate tile/style endpoint.
  const imported = await import("https://unpkg.com/maplibre-gl@6.0.0/dist/maplibre-gl.mjs");
  watchdog = setTimeout(
    () => reportError("The map renderer did not finish loading.", "Timed out after 8 seconds"),
    8000,
  );
  const maplibregl = imported.default || imported;
  const map = new maplibregl.Map({ container: holder, style: ${style}, dragRotate: false });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  map.on("error", (event) => {
    console.warn("Map resource error", event?.error || event);
  });
  const markers = new Map();
  const showPlaces = (visibleIds) => {
    const visible = new Set(visibleIds);
    const points = [];
    markers.forEach((marker, id) => {
      const shown = visible.has(id);
      marker.getElement().style.display = shown ? "" : "none";
      if (shown) points.push(marker.getLngLat());
    });
    if (!points.length) return;
    const bounds = points.reduce(
      (value, point) => value.extend(point),
      new maplibregl.LngLatBounds(points[0], points[0]),
    );
    map.fitBounds(bounds, { padding: 45, maxZoom: 14, duration: 400 });
  };
  window.__agoraSetVisible = showPlaces;
  map.on("load", () => {
    clearTimeout(watchdog);
    data.routes.forEach((route, index) => {
      map.addSource("route-" + index, {
        type: "geojson",
        data: { type: "LineString", coordinates: route.coordinates },
      });
      map.addLayer({
        id: "route-" + index,
        type: "line",
        source: "route-" + index,
        paint: { "line-color": "#5aa0ff", "line-width": 3 },
      });
    });
    data.places.forEach((place, index) => {
      const marker = document.createElement("button");
      marker.className = "pin";
      marker.textContent = place.order ?? index + 1;
      marker.onclick = () => window.ReactNativeWebView?.postMessage(
        JSON.stringify({ placeId: place.id }),
      );
      markers.set(place.id, new maplibregl.Marker({ element: marker })
        .setLngLat([place.position.lng, place.position.lat]).addTo(map));
    });
    showPlaces(data.places.map((place) => place.id));
    window.ReactNativeWebView?.postMessage(JSON.stringify({ ready: true }));
  });
})().catch((error) => reportError("Could not load the map renderer.", error));
</script></body></html>`;
}

export function mapVisibilityScript(placeIds: string[]): string {
  const ids = JSON.stringify(placeIds).replace(/</g, "\\u003c");
  return `window.__agoraSetVisible?.(${ids}); true;`;
}
