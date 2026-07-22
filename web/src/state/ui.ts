/* Which pane the main column shows, and which overlay panel is open.
   Selection persists to the SAME localStorage keys as the vanilla UI with
   byte-compatible shapes (agora_sel = {g,c}; agora_open = array of expanded
   group ids, or null meaning "just the selected group"; agora_thread =
   "expanded"/"open"; agora_unreads_only = "1"/"0"), so a session carries
   across the two UIs without clobbering either. */

import { create } from "zustand";

export type MainView =
  | { kind: "channel" }
  | { kind: "inbox" }
  | { kind: "group" };

export type Panel = "people" | "connections" | null;

interface Selection { g?: string | null; c?: string | null; }

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

interface UiState {
  sel: Selection;
  view: MainView;
  panel: Panel;
  /** Expanded group ids; null = "the selected group counts as expanded". */
  expanded: string[] | null;
  unreadsOnly: boolean;
  hiddenOpen: boolean;
  sideCollapsed: boolean;
  threadRoot: number | null;
  threadExpanded: boolean;
  membersOpen: boolean;
  searchOpen: boolean;
  selectChannel: (g: string, c: string) => void;
  openInbox: () => void;
  openGroupPage: (g: string) => void;
  backToGroups: () => void;
  isExpanded: (g: string) => boolean;
  setExpanded: (g: string, on: boolean) => void;
  toggleGroup: (g: string) => void;
  setUnreadsOnly: (on: boolean) => void;
  toggleHiddenSection: () => void;
  toggleSide: () => void;
  openThread: (rootId: number) => void;
  closeThread: () => void;
  toggleThreadSize: () => void;
  setMembersOpen: (on: boolean) => void;
  setSearchOpen: (on: boolean) => void;
  openPanel: (p: Panel) => void;
}

export const useUiState = create<UiState>((set, get) => ({
  sel: loadJSON<Selection>("agora_sel", {}),
  view: { kind: "channel" },
  panel: null,
  expanded: loadJSON<string[] | null>("agora_open", null),
  unreadsOnly: localStorage.getItem("agora_unreads_only") === "1",
  hiddenOpen: false,
  sideCollapsed: localStorage.getItem("agora_side") === "collapsed",
  threadRoot: null,
  threadExpanded: localStorage.getItem("agora_thread") === "expanded",
  membersOpen: false,
  searchOpen: false,

  selectChannel: (g, c) => set(() => {
    localStorage.setItem("agora_sel", JSON.stringify({ g, c }));
    return { sel: { g, c }, view: { kind: "channel" }, threadRoot: null };
  }),
  openInbox: () => set({ view: { kind: "inbox" }, threadRoot: null }),
  openGroupPage: (g) => set((s) => {
    const sel = { ...s.sel, g };
    localStorage.setItem("agora_sel", JSON.stringify(sel));
    return { sel, view: { kind: "group" } };
  }),
  backToGroups: () => set({ view: { kind: "channel" } }),

  isExpanded: (g) => {
    const s = get();
    return s.expanded ? s.expanded.includes(g) : g === s.sel.g;
  },
  setExpanded: (g, on) => set((s) => {
    const cur = s.expanded ? [...s.expanded] : (s.sel.g ? [s.sel.g] : []);
    const expanded = on ? [...new Set([...cur, g])] : cur.filter(x => x !== g);
    localStorage.setItem("agora_open", JSON.stringify(expanded));
    return { expanded };
  }),
  toggleGroup: (g) => get().setExpanded(g, !get().isExpanded(g)),

  setUnreadsOnly: (on) => {
    localStorage.setItem("agora_unreads_only", on ? "1" : "0");
    set({ unreadsOnly: on });
  },
  toggleHiddenSection: () => set((s) => ({ hiddenOpen: !s.hiddenOpen })),
  toggleSide: () => set((s) => {
    const next = !s.sideCollapsed;
    localStorage.setItem("agora_side", next ? "collapsed" : "open");
    return { sideCollapsed: next };
  }),
  openThread: (rootId) => set({ threadRoot: rootId }),
  closeThread: () => set({ threadRoot: null }),
  toggleThreadSize: () => set((s) => {
    const next = !s.threadExpanded;
    localStorage.setItem("agora_thread", next ? "expanded" : "open");
    return { threadExpanded: next };
  }),
  setMembersOpen: (on) => set({ membersOpen: on }),
  setSearchOpen: (on) => set({ searchOpen: on }),
  openPanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
}));
