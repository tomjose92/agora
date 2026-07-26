import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  formatDuration, googleMapsDirectionsUrl, googleMapsPlaceUrl, useMe,
  type MapArtifactPlace, type MapMessageArtifact,
} from "@agora/core";
import { Icon } from "../../lib/icons";
import { MapGraphic } from "./MapGraphic";

// MapLibre and its stylesheet are heavy; keep them out of the chat bundle and
// load them only when someone actually opens the viewer.
const MapCanvas = lazy(() => import("./MapCanvas"));

export function MapArtifactViewer({ artifact, initialRegion, onClose }: {
  artifact: MapMessageArtifact;
  initialRegion?: string;
  onClose: () => void;
}) {
  const { data } = artifact;
  const styleUrl = useMe().data?.map_style_url?.trim() || "";
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [region, setRegion] = useState(initialRegion || "");
  const [day, setDay] = useState("");
  const [category, setCategory] = useState("");
  const [selected, setSelected] = useState<MapArtifactPlace | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && panelRef.current) {
        const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
        )];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  useEffect(() => {
    if (day && !data.days.some(d => d.id === day && (!region || d.region_id === region))) {
      setDay("");
    }
    setSelected(null);
  }, [region]); // eslint-disable-line react-hooks/exhaustive-deps

  const places = useMemo(() => data.places.filter(place =>
    (!region || place.region_id === region)
    && (!day || place.day_ids.includes(day))
    && (!category || place.category === category)
  ), [data.places, region, day, category]);
  const categories = [...new Set(data.places.map(p => p.category))];
  const detail = selected || places[0] || null;

  return createPortal((
    <div className="conn-overlay ago-map-overlay" role="dialog" aria-modal="true"
      aria-label={artifact.title} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panelRef} className="conn-panel ago-map-panel">
        <header className="ago-map-modal-head">
          <div>
            <span className="ago-artifact-kicker">Interactive map</span>
            <h2>{artifact.title}</h2>
            {artifact.summary && <p>{artifact.summary}</p>}
          </div>
          <button ref={closeRef} className="btn sm" aria-label="Close map" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="ago-map-filters">
          <label>
            <span>Area</span>
            <select value={region} onChange={e => setRegion(e.target.value)}>
              <option value="">All areas</option>
              {data.regions.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </label>
          <label>
            <span>Day</span>
            <select value={day} onChange={e => setDay(e.target.value)}>
              <option value="">All days</option>
              {data.days.filter(d => !region || d.region_id === region).map(d =>
                <option key={d.id} value={d.id}>Day {d.number} · {d.label}</option>)}
            </select>
          </label>
          <label>
            <span>Category</span>
            <select value={category} onChange={e => setCategory(e.target.value)}>
              <option value="">Everything</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <button className="btn sm" onClick={() => { setRegion(""); setDay(""); setCategory(""); }}>
            Reset view
          </button>
        </div>
        <div className="ago-map-modal-body">
          <div className="ago-map-canvas">
            {styleUrl ? (
              <Suspense fallback={
                <MapGraphic data={data} activeRegion={region || undefined} visiblePlaces={places}
                  selectedPlace={selected?.id} onPlace={setSelected} />
              }>
                <MapCanvas data={data} styleUrl={styleUrl} activeRegion={region || undefined}
                  visiblePlaces={places} selectedPlace={selected?.id} onPlace={setSelected}
                  onRegion={r => setRegion(current => current === r.id ? "" : r.id)} />
              </Suspense>
            ) : (
              <>
                <MapGraphic data={data} activeRegion={region || undefined} visiblePlaces={places}
                  selectedPlace={selected?.id} onPlace={setSelected} />
                <span className="ago-map-attribution">
                  Coordinate view · configure a map style for full tiles
                </span>
              </>
            )}
          </div>
          <aside className="ago-map-details">
            {detail ? (
              <>
                <span className="ago-place-category">{detail.category}</span>
                <h3>{detail.label}</h3>
                <div className="ago-place-meta">
                  {detail.day_ids.map(id => {
                    const d = data.days.find(item => item.id === id);
                    return d ? <span key={id}>Day {d.number}</span> : null;
                  })}
                  {detail.start_time && <span>{detail.start_time}</span>}
                  {formatDuration(detail.duration_minutes) && <span>{formatDuration(detail.duration_minutes)}</span>}
                </div>
                {detail.description && <p>{detail.description}</p>}
                <div className="ago-map-actions">
                  <a href={googleMapsPlaceUrl(detail)} target="_blank" rel="noopener noreferrer">
                    <Icon name="external-link" /> Open in Google Maps
                  </a>
                  <a href={googleMapsDirectionsUrl(detail)} target="_blank" rel="noopener noreferrer">
                    <Icon name="external-link" /> Directions
                  </a>
                </div>
                <div className="ago-place-list">
                  <strong>{places.length} matching {places.length === 1 ? "place" : "places"}</strong>
                  {places.map(place => (
                    <button key={place.id} className={selected?.id === place.id ? "selected" : ""}
                      onClick={() => setSelected(place)}>
                      <span>{place.order || "•"}</span>{place.label}
                    </button>
                  ))}
                </div>
              </>
            ) : data.places.length === 0 ? (
              <div className="ago-map-empty-detail">
                <strong>No individual places pinned</strong>
                <span>
                  This map only marks {data.regions.length === 1 ? "an area" : "areas"} —
                  ask the agent for specific stops to see pins here.
                </span>
              </div>
            ) : (
              <div className="ago-map-empty-detail">
                <strong>No places match these filters</strong>
                <span>Change a filter or reset the view.</span>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  ), document.body);
}
