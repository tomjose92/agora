/* Which messages are currently showing their TL;DR (the agent-supplied
   summary in meta.tldr) instead of the full text. In memory only and local
   to this device on purpose — which version you're reading isn't shared
   state, and a fresh app start falls back to the full text. */

import { create } from "zustand";

interface TldrViewState {
  showing: Record<number, true>;
  toggle: (messageId: number) => void;
}

export const useTldrView = create<TldrViewState>((set) => ({
  showing: {},

  toggle: (messageId) =>
    set((s) => {
      const showing = { ...s.showing };
      if (showing[messageId]) delete showing[messageId];
      else showing[messageId] = true;
      return { showing };
    }),
}));

/** The message's TL;DR when it has a usable one, else null. */
export function tldrOf(message: { meta?: { tldr?: string } | null }): string | null {
  const t = message.meta?.tldr;
  return typeof t === "string" && t.trim() ? t : null;
}
