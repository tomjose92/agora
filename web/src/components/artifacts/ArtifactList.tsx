import { isMapArtifactV1, type MessageArtifact } from "@agora/core";
import { MapArtifactCard } from "./MapArtifactCard";

export function ArtifactList({ artifacts }: { artifacts?: MessageArtifact[] }) {
  if (!artifacts?.length) return null;
  return (
    <div className="ago-artifacts">
      {artifacts.map(artifact => isMapArtifactV1(artifact)
        ? <MapArtifactCard key={artifact.id} artifact={artifact} />
        : (
          <div className="ago-artifact-unsupported" key={artifact.id}>
            <span className="ago-artifact-kicker">{artifact.type} artifact</span>
            <strong>{artifact.title}</strong>
            <span>This version of Agora cannot display this artifact.</span>
          </div>
        ))}
    </div>
  );
}
