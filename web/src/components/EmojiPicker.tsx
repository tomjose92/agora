/* Fixed-position reaction picker on document.body, anchored to the react
   button (above when there's headroom, below otherwise) — same markup and
   the same agoEmojiRecent localStorage recents as the vanilla picker. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EMOJI_CATEGORIES, type EmojiEntry } from "@agora/core";
import { create } from "zustand";

const RECENT_MAX = 24;
const VALID = new Set(EMOJI_CATEGORIES.flatMap(c => c.emoji.map(p => p[0])));

/* Stored recents are untrusted (any tab can write the key): keep only
   curated emoji. Same key + shape as the vanilla UI. */
function loadRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem("agoEmojiRecent") || "null");
    return Array.isArray(list) ? list.filter((ch: string) => VALID.has(ch)) : [];
  } catch {
    return [];
  }
}

function rememberRecent(ch: string): void {
  const list = [ch, ...loadRecent().filter(c => c !== ch)].slice(0, RECENT_MAX);
  try { localStorage.setItem("agoEmojiRecent", JSON.stringify(list)); } catch { /* full */ }
}

interface PickerState {
  /** message id the picker is open for, and its anchor element */
  openFor: number | null;
  anchor: HTMLElement | null;
  open: (mid: number, anchor: HTMLElement) => void;
  close: () => void;
}

export const useEmojiPicker = create<PickerState>((set, get) => ({
  openFor: null,
  anchor: null,
  open: (mid, anchor) => set(get().openFor === mid ? { openFor: null, anchor: null } : { openFor: mid, anchor }),
  close: () => set({ openFor: null, anchor: null }),
}));

export function EmojiPickerHost({ onPick }: { onPick: (mid: number, emoji: string) => void }) {
  const { openFor, anchor, close } = useEmojiPicker();
  const [query, setQuery] = useState("");
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(""); }, [openFor]);

  // Anchor positioning after layout, clamped to the viewport.
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8));
    const above = r.top - pop.offsetHeight - 6;
    const top = above >= 8 ? above : Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }, [anchor, openFor]);

  // Click-away closes (react buttons and the panel itself are exempt).
  useEffect(() => {
    if (openFor == null) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.(".ago-emoji-pop") || t.closest?.(".ago-react-btn") || t.closest?.(".ago-react-add")) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openFor, close]);

  if (openFor == null) return null;

  const q = query.trim().toLowerCase();
  const cell = (pair: EmojiEntry, i: number) => (
    <button key={`${pair[0]}-${i}`} className="ago-emoji-cell" title={pair[1] || undefined}
      onMouseDown={e => e.preventDefault()}
      onClick={() => {
        rememberRecent(pair[0]);
        close();
        onPick(openFor, pair[0]);
      }}>
      {pair[0]}
    </button>
  );

  let body;
  if (q) {
    const hits = EMOJI_CATEGORIES.flatMap(cat => cat.emoji.filter(p => p[1].includes(q))).slice(0, 64);
    body = hits.length
      ? <div className="ago-emoji-grid">{hits.map(cell)}</div>
      : <div className="ago-emoji-empty">No matching emoji.</div>;
  } else {
    const recent = loadRecent();
    const cats = (recent.length
      ? [{ name: "Recently used", emoji: recent.map(ch => [ch, ""] as EmojiEntry) }]
      : []).concat(EMOJI_CATEGORIES);
    body = cats.map((cat, ci) => (
      <div key={ci}>
        <div className="ago-emoji-cat">{cat.name}</div>
        <div className="ago-emoji-grid">{cat.emoji.map(cell)}</div>
      </div>
    ));
  }

  return createPortal(
    <div className="ago-emoji-pop" id="ago-emoji-pop" ref={popRef}>
      <input id="ago-emoji-search" type="search" placeholder="Search emoji…" autoComplete="off"
        autoFocus value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); close(); } }} />
      <div className="ago-emoji-body" id="ago-emoji-body">{body}</div>
    </div>,
    document.body,
  );
}
