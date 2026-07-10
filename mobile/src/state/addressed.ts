/* Session-level memory of the composer's "talk to" agent selection, keyed
   per conversation (channel id, or `<channel>:t<root>` for a thread). Lives
   only in memory — deliberately not persisted — so a conversation keeps
   addressing the same agents while the app is open, until changed. */

import { create } from "zustand";

interface AddressedState {
  byConvo: Record<string, string[]>;
  toggle: (key: string, agentId: string) => void;
  clear: (key: string) => void;
}

export const useAddressed = create<AddressedState>((set) => ({
  byConvo: {},

  toggle: (key, agentId) =>
    set((s) => {
      const cur = s.byConvo[key] ?? [];
      const next = cur.includes(agentId)
        ? cur.filter((id) => id !== agentId)
        : [...cur, agentId];
      const byConvo = { ...s.byConvo };
      if (next.length) byConvo[key] = next;
      else delete byConvo[key];
      return { byConvo };
    }),

  clear: (key) =>
    set((s) => {
      const byConvo = { ...s.byConvo };
      delete byConvo[key];
      return { byConvo };
    }),
}));

export function threadAddressKey(channelId: string, rootId: number): string {
  return `${channelId}:t${rootId}`;
}
