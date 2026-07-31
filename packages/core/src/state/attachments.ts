/* In-memory attachment drafts. An entry's presence reserves one of the five
   composer slots, so pending and ready files share one concurrency invariant. */

import { create } from "zustand";

export type DraftAttachmentStatus = "preparing" | "ready" | "sending" | "failed";
type StageAttachmentStatus = "preparing" | "ready";

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
  beginSend: (draftKey: string, ids: string[], abort: () => void) => boolean;
  cancelSend: (draftKey: string, id: string) => boolean;
  sendSucceeded: (draftKey: string, ids: string[]) => void;
  sendFailed: (draftKey: string, ids: string[]) => void;
  remove: (draftKey: string, id: string) => boolean;
  reset: () => void;
}

let sequence = 0;
const sendingTransactions = new Map<string, { ids: Set<string>; abort: () => void }>();
const previewUrls = new Map<string, { file: File; url: string }>();

function revokePreviewUrl(id: string): void {
  const preview = previewUrls.get(id);
  if (!preview) return;
  URL.revokeObjectURL(preview.url);
  previewUrls.delete(id);
}

/** Lazily create the browser URL for a ready image draft. The draft store owns
    its lifetime because composer components unmount while per-channel drafts
    remain alive. */
export function draftAttachmentPreviewUrl(entry: DraftAttachment): string | null {
  if ((entry.status !== "ready" && entry.status !== "sending") || !entry.file || typeof URL === "undefined"
      || typeof URL.createObjectURL !== "function") {
    return null;
  }
  const current = previewUrls.get(entry.id);
  if (current?.file === entry.file) return current.url;
  if (current) revokePreviewUrl(entry.id);
  const url = URL.createObjectURL(entry.file);
  previewUrls.set(entry.id, { file: entry.file, url });
  return url;
}

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
    // A promised drop may replace the original File object.
    if (completed) revokePreviewUrl(id);
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

  beginSend: (draftKey, ids, abort) => {
    const selected = new Set(ids);
    const current = get().byDraft[draftKey] ?? [];
    if (sendingTransactions.has(draftKey) || !ids.length || ids.some((id) =>
      !current.some((entry) => entry.id === id && entry.status === "ready"))) {
      return false;
    }
    sendingTransactions.set(draftKey, { ids: selected, abort });
    set((state) => ({
      byDraft: {
        ...state.byDraft,
        [draftKey]: (state.byDraft[draftKey] ?? []).map((entry) =>
          selected.has(entry.id) ? { ...entry, status: "sending" as const } : entry),
      },
    }));
    return true;
  },

  cancelSend: (draftKey, id) => {
    const transaction = sendingTransactions.get(draftKey);
    if (!transaction?.ids.has(id)) return false;
    transaction.abort();
    return true;
  },

  sendSucceeded: (draftKey, ids) => {
    sendingTransactions.delete(draftKey);
    ids.forEach(revokePreviewUrl);
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
    sendingTransactions.delete(draftKey);
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
    if (removed) revokePreviewUrl(id);
    return removed;
  },

  reset: () => {
    for (const transaction of sendingTransactions.values()) transaction.abort();
    sendingTransactions.clear();
    for (const id of [...previewUrls.keys()]) revokePreviewUrl(id);
    set({ byDraft: {} });
  },
}));
