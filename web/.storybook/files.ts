/* Storybook-only replacement for src/lib/files. Static attachment fixtures
   resolve beside iframe.html, so the same build works at /storybook/, at a
   GitHub Pages project path, and on the root local dev server. */

/* Captured once at preview load — story plays and the between-story reset
   rewrite history (deep-link pinning), so deriving from location.href at
   call time would see their paths, not the deployment base. */
const BASE = (() => {
  const path = new URL(".", window.location.href).pathname;
  return path === "/" ? "" : path.replace(/\/$/, "");
})();

export function fileUrl(id: string): string {
  return `${BASE}/api/files/${encodeURIComponent(id)}`;
}

export function withToken(url: string): string {
  return url.startsWith("/api/") ? BASE + url : url;
}

export const BROWSER_IMAGE = /^image\/(jpeg|png|gif|webp|svg\+xml|bmp)$/;

export function humanSize(bytes: number): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
