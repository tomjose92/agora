/* In-memory attachment drafts. An entry's presence reserves one of the five
   composer slots, so pending and ready files share one concurrency invariant. */

import { create } from "zustand";

export type DraftAttachmentStatus = "preparing" | "ready" | "sending" | "failed";
type StageAttachmentStatus = Exclude<DraftAttachmentStatus, "failed">;

export interface DraftAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  status: DraftAttachmentStatus;
  file?: File;
  error?: string;
}

interface StageResult {
  accepted: DraftAttachment[];
  rejectedForCap: number;
}

interface AttachmentDraftState {
  byDraft: Record<string, DraftAttachment[]>;
  stage: (
    draftKey: string,
    files: File[],
    status: StageAttachmentStatus,
    max: number,
  ) => StageResult;
  complete: (draftKey: string, id: string, file: File) => boolean;
  fail: (draftKey: string, id: string, error: string) => boolean;
  beginSend: (draftKey: string, ids: string[]) => boolean;
  sendSucceeded: (draftKey: string, ids: string[]) => void;
  sendFailed: (draftKey: string, ids: string[]) => void;
  remove: (draftKey: string, id: string) => boolean;
  reset: () => void;
}

let sequence = 0;

function nextAttachmentId(): string {
  sequence += 1;
  return `attachment-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export const useAttachmentDrafts = create<AttachmentDraftState>((set, get) => ({
  byDraft: {},

  stage: (draftKey, files, status, max) => {
    const current = get().byDraft[draftKey] ?? [];
    const acceptedFiles = files.slice(0, Math.max(0, max - current.length));
    const accepted = acceptedFiles.map((file) => ({
      id: nextAttachmentId(),
      name: file.name || "file",
      type: file.type,
      size: file.size,
      status,
      ...(status === "ready" ? { file } : {}),
    }));
    if (accepted.length) {
      set((state) => ({
        byDraft: {
          ...state.byDraft,
          [draftKey]: [...(state.byDraft[draftKey] ?? []), ...accepted],
        },
      }));
    }
    return { accepted, rejectedForCap: files.length - accepted.length };
  },

  complete: (draftKey, id, file) => {
    let completed = false;
    set((state) => {
      const current = state.byDraft[draftKey] ?? [];
      const next = current.map((entry) => {
        if (entry.id !== id || entry.status !== "preparing") return entry;
        completed = true;
        return {
          ...entry,
          name: file.name || entry.name,
          type: file.type,
          size: file.size,
          status: "ready" as const,
          file,
        };
      });
      return completed
        ? { byDraft: { ...state.byDraft, [draftKey]: next } }
        : state;
    });
    return completed;
  },

  fail: (draftKey, id, error) => {
    let failed = false;
    set((state) => {
      const current = state.byDraft[draftKey] ?? [];
      const next = current.map((entry) => {
        if (entry.id !== id || entry.status !== "preparing") return entry;
        failed = true;
        return { ...entry, status: "failed" as const, error };
      });
      return failed
        ? { byDraft: { ...state.byDraft, [draftKey]: next } }
        : state;
    });
    return failed;
  },

  beginSend: (draftKey, ids) => {
    const selected = new Set(ids);
    const current = get().byDraft[draftKey] ?? [];
    if (!ids.length || ids.some((id) =>
      !current.some((entry) => entry.id === id && entry.status === "ready"))) {
      return false;
    }
    set((state) => ({
      byDraft: {
        ...state.byDraft,
        [draftKey]: (state.byDraft[draftKey] ?? []).map((entry) =>
          selected.has(entry.id) ? { ...entry, status: "sending" as const } : entry),
      },
    }));
    return true;
  },

  sendSucceeded: (draftKey, ids) => {
    const sent = new Set(ids);
    set((state) => {
      const current = state.byDraft[draftKey] ?? [];
      const next = current.filter((entry) =>
        !(sent.has(entry.id) && entry.status === "sending"));
      if (next.length === current.length) return state;
      const byDraft = { ...state.byDraft };
      if (next.length) byDraft[draftKey] = next;
      else delete byDraft[draftKey];
      return { byDraft };
    });
  },

  sendFailed: (draftKey, ids) => {
    const sent = new Set(ids);
    set((state) => {
      const current = state.byDraft[draftKey] ?? [];
      let changed = false;
      const next = current.map((entry) => {
        if (!sent.has(entry.id) || entry.status !== "sending") return entry;
        changed = true;
        return { ...entry, status: "ready" as const };
      });
      return changed
        ? { byDraft: { ...state.byDraft, [draftKey]: next } }
        : state;
    });
  },

  remove: (draftKey, id) => {
    let removed = false;
    set((state) => {
      const current = state.byDraft[draftKey] ?? [];
      const next = current.filter((entry) => {
        if (entry.id !== id) return true;
        if (entry.status === "sending") return true;
        removed = true;
        return false;
      });
      if (!removed) return state;
      const byDraft = { ...state.byDraft };
      if (next.length) byDraft[draftKey] = next;
      else delete byDraft[draftKey];
      return { byDraft };
    });
    return removed;
  },

  reset: () => set({ byDraft: {} }),
}));
