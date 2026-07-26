import { useState } from "react";
import type { MapMessageArtifact } from "@agora/core";
import { Icon } from "../../lib/icons";
import { MapGraphic } from "./MapGraphic";
import { MapArtifactViewer } from "./MapArtifactViewer";

export function MapArtifactCard({ artifact }: { artifact: MapMessageArtifact }) {
  const [openRegion, setOpenRegion] = useState<string | null>(null);
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
        <button className="ago-map-preview" aria-label={`Open ${artifact.title}`}
          onClick={() => setOpenRegion("")}>
          <MapGraphic data={data} />
        </button>
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
