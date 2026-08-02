import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.AGORA_PORT || "4470";
const apiOrigin = `http://127.0.0.1:${apiPort}`;

/* Builds the web UI into web/dist (gitignored) — the directory the server
   serves (--ui-dir), the Docker image bakes in, and the desktop bundle
   copies. public/ carries the verbatim root assets: icon.png, the vendored
   mermaid.min.js (lazy-loaded at /mermaid.min.js), and connect.html (the
   desktop server picker, loaded by literal path from tauri://localhost). */
export default defineConfig({
  plugins: [react()],
  // MapLibre spawns an ES-module worker; emit workers as ESM so its
  // `?worker&url` bundle (see MapCanvas.tsx) is spawned in matching form.
  worker: { format: "es" },
  server: {
    port: Number(process.env.AGORA_WEB_PORT) || 5173,
    strictPort: Boolean(process.env.AGORA_WEB_PORT),
    proxy: {
      "/api": apiOrigin,
      "/ws": { target: apiOrigin, ws: true },
    },
  },
});
