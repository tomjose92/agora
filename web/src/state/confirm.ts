/* Two-step destructive actions: first click arms ("Sure?"), second within
   5s executes — the same scheme as agoArm/agoArmed in the retired vanilla agora.js. */

import { create } from "zustand";

interface ConfirmState {
  armed: string | null;
  arm: (key: string) => void;
  disarm: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

export const useConfirm = create<ConfirmState>((set) => ({
  armed: null,
  arm: (key) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => set({ armed: null }), 5000);
    set({ armed: key });
  },
  disarm: () => {
    if (timer) clearTimeout(timer);
    set({ armed: null });
  },
}));

/** First call arms and returns false; a second call while armed returns
    true (caller should then perform the action). */
export function confirmStep(key: string): boolean {
  const s = useConfirm.getState();
  if (s.armed === key) {
    s.disarm();
    return true;
  }
  s.arm(key);
  return false;
}
