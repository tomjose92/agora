import { lazy, Suspense, useState } from "react";
import { useMe, type MapMessageArtifact } from "@agora/core";
import { Icon } from "../../lib/icons";
import { MapGraphic } from "./MapGraphic";
import { MapArtifactViewer } from "./MapArtifactViewer";

// Real-tiles preview rides in the same lazy chunk family as the viewer's
// canvas; the SVG sketch fills in while it loads (and stays for installs
// that opted out of external tiles).
const MapPreview = lazy(() => import("./MapPreview"));

export function MapArtifactCard({ artifact }: { artifact: MapMessageArtifact }) {
  const [openRegion, setOpenRegion] = useState<string | null>(null);
  const styleUrl = useMe().data?.map_style_url?.trim() || "";
  const data = artifact.data;
  return (
    <>
      <section className="ago-map-card" aria-label={artifact.title}>
        <button className="ago-map-card-head" onClick={() => setOpenRegion("")}>
          <span>
            <span className="ago-artifact-kicker">Interactive map</span>
            <strong>{artifact.title}</strong>
            {artifact.summary && <small>{artifact.summary}</small>}
          </span>
          <span className="ago-map-open">Open map <Icon name="maximize-2" /></span>
        </button>
        {/* Not a <button>: the GL attribution control nests a link, which is
            invalid (and unusable) inside one. */}
        <div className="ago-map-preview" role="button" tabIndex={0}
          aria-label={`Open ${artifact.title}`}
          onClick={e => {
            // Attribution links inside the preview open their own tab.
            if ((e.target as HTMLElement).closest("a, .maplibregl-ctrl")) return;
            setOpenRegion("");
          }}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenRegion(""); } }}>
          {styleUrl ? (
            <Suspense fallback={<MapGraphic data={data} />}>
              <MapPreview data={data} styleUrl={styleUrl} />
            </Suspense>
          ) : (
            <MapGraphic data={data} />
          )}
        </div>
        <div className="ago-map-card-foot">
          <span>{data.regions.length} {data.regions.length === 1 ? "area" : "areas"}</span>
          <span>{data.places.length} {data.places.length === 1 ? "place" : "places"}</span>
          <div className="ago-map-region-chips">
            {data.regions.map(region => (
              <button key={region.id} onClick={() => setOpenRegion(region.id)}>{region.label}</button>
            ))}
          </div>
        </div>
      </section>
      {openRegion !== null && (
        <MapArtifactViewer artifact={artifact} initialRegion={openRegion || undefined}
          onClose={() => setOpenRegion(null)} />
      )}
    </>
  );
}
