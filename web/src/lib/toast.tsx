/* Toasts with the vanilla UI's markup/classes (.toast-host > .toast.in) so
   style.css and the parity harness apply unchanged. toast() is imperative
   like the vanilla helper; <ToastHost/> renders the queue. */

import { create } from "zustand";

export interface ToastItem {
  id: number;
  message: string;
  variant?: string;
  actionLabel?: string;
  onAction?: () => void;
  leaving?: boolean;
}

let nextId = 1;

interface ToastState {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, "id">) => void;
  dismiss: (id: number) => void;
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => get().dismiss(id), 8000);
  },
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.map(t => t.id === id ? { ...t, leaving: true } : t) }));
    setTimeout(() =>
      set((s) => ({ toasts: s.toasts.filter(t => t.id !== id) })), 200);
  },
}));

export function toast(
  message: string,
  opts: { actionLabel?: string; onAction?: () => void; variant?: string } = {},
): void {
  useToasts.getState().push({ message, ...opts });
}

export function ToastHost() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toast-host" id="toast-host">
      {toasts.map(t => (
        <div key={t.id} className={`toast${t.variant ? " " + t.variant : ""} in${t.leaving ? " leaving" : ""}`}>
          <span className="toast-msg">{t.message}</span>
          {t.actionLabel && t.onAction && (
            <button className="toast-action"
              onClick={() => { dismiss(t.id); try { t.onAction?.(); } catch (e) { console.error(e); } }}>
              {t.actionLabel}
            </button>
          )}
          <button className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
