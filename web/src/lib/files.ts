/* File/avatar URLs with the session token in the query — <img> and download
   links can't send the Authorization header (mirrors agoFileUrl and the
   avatar src logic in ui/agora.js). */

import { sessionToken } from "./auth";

export function fileUrl(id: string): string {
  const t = sessionToken();
  return `/api/files/${encodeURIComponent(id)}${t ? "?token=" + encodeURIComponent(t) : ""}`;
}

export function withToken(url: string): string {
  const t = sessionToken();
  if (!t) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t);
}

/* Image formats <img> can decode everywhere. HEIC/HEIF/AVIF render as
   download chips instead of broken inline images. */
export const BROWSER_IMAGE = /^image\/(jpeg|png|gif|webp|svg\+xml|bmp)$/;

export function humanSize(bytes: number): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
