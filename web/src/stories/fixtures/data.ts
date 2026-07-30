import type { MapArtifactData, Me, Message } from "@agora/core";

export const me: Me = {
  username: "tom",
  display_name: "Tom",
  version: "storybook",
  instance_admin: true,
  voice: true,
  search_ai: true,
};

export const message: Message = {
  id: 42,
  channel_id: "general",
  thread_id: null,
  author_type: "agent",
  author_id: "codex",
  author_name: "Codex",
  text: "The component catalog is ready for inspection.",
  ts: 1_750_000_000,
  attachments: [],
  reactions: [
    { emoji: "👍", users: ["tom", "alice"] },
    { emoji: "🎉", users: ["alice"] },
  ],
};

export const mapArtifact: MapArtifactData = {
  initial_view: { mode: "fit" },
  regions: [
    { id: "kochi", label: "Kochi", center: { lat: 9.9312, lng: 76.2673 }, day_ids: ["d1"] },
    { id: "munnar", label: "Munnar", center: { lat: 10.0889, lng: 77.0595 }, day_ids: ["d2"] },
    { id: "alleppey", label: "Alleppey", center: { lat: 9.4981, lng: 76.3388 }, day_ids: ["d3"] },
  ],
  days: [],
  places: [],
  routes: [],
};
