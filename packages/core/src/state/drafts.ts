/* Session-level message drafts, keyed per conversation (channel id, or
   `<channel>:t<root>` for a thread). Lives only in memory so navigating away
   and back restores typed text without promising persistence across app
   restarts or devices. Web currently has an equivalent component-local store;
   consolidating it onto this shared store is intentionally left for later. */

import { create } from "zustand";

interface DraftState {
  byConvo: Record<string, string>;
  set: (key: string, text: string) => void;
  clear: (key: string) => void;
  resetAll: () => void;
}

export const useMessageDrafts = create<DraftState>((set) => ({
  byConvo: {},
  set: (key, text) => set((state) => {
    const byConvo = { ...state.byConvo };
    if (text) byConvo[key] = text;
    else delete byConvo[key];
    return { byConvo };
  }),
  clear: (key) => set((state) => {
    if (!(key in state.byConvo)) return state;
    const byConvo = { ...state.byConvo };
    delete byConvo[key];
    return { byConvo };
  }),
  resetAll: () => set({ byConvo: {} }),
}));
