/* Palette distilled from ui/style.css so the app matches the desktop UI. */
export const colors = {
  bg: "#07090f",
  panel: "rgba(255,255,255,0.028)",
  panelStrong: "rgba(255,255,255,0.05)",
  border: "rgba(255,255,255,0.07)",
  borderStrong: "rgba(255,255,255,0.13)",
  text: "#eceef4",
  dim: "#8b91a5",
  faint: "#5b6072",
  a1: "#8b7cff",
  a2: "#38e1c8",
  green: "#4ade80",
  amber: "#fbbf24",
  red: "#f87171",
  // Solid stand-ins where RN can't do CSS gradients.
  accent: "#8b7cff",
  onAccent: "#0a0c14",
} as const;

export const radius = 16;

export const mono = { fontFamily: "Menlo" } as const;
