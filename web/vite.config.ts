import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/* Builds into ui/app2/ so the existing static serving (agora-core ServeDir,
   the Docker COPY ui, and the Tauri resources copy) picks the React app up
   at /app2/ with zero infra changes. base must stay absolute: the app links
   root assets (/style.css, /mermaid.min.js) served by the vanilla ui/ root. */
export default defineConfig({
  base: "/app2/",
  plugins: [react()],
  build: {
    outDir: "../ui/app2",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4470",
      "/ws": { target: "ws://127.0.0.1:4470", ws: true },
      "/style.css": "http://127.0.0.1:4470",
      "/icon.png": "http://127.0.0.1:4470",
      "/mermaid.min.js": "http://127.0.0.1:4470",
    },
  },
});
