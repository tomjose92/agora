import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/* Builds the web UI into web/dist (gitignored) — the directory the server
   serves (--ui-dir), the Docker image bakes in, and the desktop bundle
   copies. public/ carries the verbatim root assets: icon.png, the vendored
   mermaid.min.js (lazy-loaded at /mermaid.min.js), and connect.html (the
   desktop server picker, loaded by literal path from tauri://localhost). */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4470",
      "/ws": { target: "ws://127.0.0.1:4470", ws: true },
    },
  },
});
