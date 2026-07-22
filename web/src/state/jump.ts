/* Jump-to-exact-message (search results, pins, stars): the target waits in
   this store until the right log has the message rendered, then the log
   scrolls it into view and flashes it — the React counterpart of
   agoJumpToMessage/agoFlashMessage. */

import { create } from "zustand";

export interface JumpTarget {
  mid: number;
  /** Which log should land on it. */
  container: "log" | "thread";
}

interface JumpState {
  target: JumpTarget | null;
  request: (t: JumpTarget) => void;
  clear: () => void;
}

export const useJump = create<JumpState>((set) => ({
  target: null,
  request: (t) => set({ target: t }),
  clear: () => set({ target: null }),
}));

/** Scroll to and flash a rendered message; true when it was found. */
export function flashMessage(root: HTMLElement, mid: number): boolean {
  const el = root.querySelector(`[data-mid="${mid}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.classList.add("ago-flash");
  setTimeout(() => el.classList.remove("ago-flash"), 1800);
  return true;
}
