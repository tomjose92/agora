/* Small formatting helpers ported from ui/shim.js + ui/agora.js. */

export function fmtTs(ts: number | null | undefined): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function slugify(name: string): string {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Splice `insert` into `text` over the [start, end] selection, clamping a
    stale selection to the current bounds. Returns the text and new caret. */
export function spliceText(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(start, text.length));
  const to = Math.min(Math.max(end, at), text.length);
  return { text: text.slice(0, at) + insert + text.slice(to), caret: at + insert.length };
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
