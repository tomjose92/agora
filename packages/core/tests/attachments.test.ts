import { afterEach, describe, expect, it, vi } from "vitest";
import { draftAttachmentPreviewUrl, useAttachmentDrafts } from "../src";

const file = (name: string) => new File([name], name, { type: "text/plain" });

afterEach(() => {
  useAttachmentDrafts.getState().reset();
  vi.restoreAllMocks();
});

describe("attachment drafts", () => {
  it("reserves pending slots synchronously across concurrent staging", () => {
    const store = useAttachmentDrafts.getState();
    const drop = store.stage("c:a", [file("a"), file("b"), file("c")], "preparing", 5);
    const paste = store.stage("c:a", [file("d"), file("e"), file("f")], "ready", 5);

    expect(drop.accepted).toHaveLength(3);
    expect(paste.accepted).toHaveLength(2);
    expect(paste.rejectedForCap).toBe(1);
    expect(useAttachmentDrafts.getState().byDraft["c:a"]).toHaveLength(5);
  });

  it("isolates attachments by draft target", () => {
    const store = useAttachmentDrafts.getState();
    store.stage("c:a", [file("a")], "ready", 5);
    store.stage("c:b", [file("b")], "ready", 5);

    expect(useAttachmentDrafts.getState().byDraft["c:a"][0].name).toBe("a");
    expect(useAttachmentDrafts.getState().byDraft["c:b"][0].name).toBe("b");
  });

  it("ignores late completion after cancellation", () => {
    const store = useAttachmentDrafts.getState();
    const [pending] = store.stage("c:a", [file("pending")], "preparing", 5).accepted;

    expect(store.remove("c:a", pending.id)).toBe(true);
    expect(store.complete("c:a", pending.id, file("late"))).toBe(false);
    expect(useAttachmentDrafts.getState().byDraft["c:a"]).toBeUndefined();
  });

  it("ignores late failure removal after cancellation", () => {
    const store = useAttachmentDrafts.getState();
    const [pending] = store.stage("c:a", [file("pending")], "preparing", 5).accepted;

    expect(store.remove("c:a", pending.id)).toBe(true);
    expect(store.fail("c:a", pending.id, "late failure")).toBe(false);
  });

  it("keeps failures on their originating draft until dismissed", () => {
    const store = useAttachmentDrafts.getState();
    const [pending] = store.stage("c:a", [file("a")], "preparing", 5).accepted;

    expect(store.fail("c:a", pending.id, "read failed")).toBe(true);
    expect(useAttachmentDrafts.getState().byDraft["c:a"][0]).toMatchObject({
      status: "failed",
      error: "read failed",
    });
    expect(useAttachmentDrafts.getState().byDraft["c:b"]).toBeUndefined();
  });

  it("removes only attachments included in a successful send", () => {
    const store = useAttachmentDrafts.getState();
    const sent = store.stage("c:a", [file("sent")], "ready", 5).accepted;
    store.stage("c:a", [file("new")], "ready", 5);

    const ids = sent.map((entry) => entry.id);
    expect(store.beginSend("c:a", ids, () => {})).toBe(true);
    store.sendSucceeded("c:a", ids);

    expect(useAttachmentDrafts.getState().byDraft["c:a"].map((entry) => entry.name))
      .toEqual(["new"]);
  });

  it("restores a failed send and prevents removal while sending", () => {
    const store = useAttachmentDrafts.getState();
    const [entry] = store.stage("c:a", [file("sent")], "ready", 5).accepted;

    expect(store.beginSend("c:a", [entry.id], () => {})).toBe(true);
    expect(store.remove("c:a", entry.id)).toBe(false);
    expect(useAttachmentDrafts.getState().byDraft["c:a"][0].status).toBe("sending");

    store.sendFailed("c:a", [entry.id]);
    expect(useAttachmentDrafts.getState().byDraft["c:a"][0].status).toBe("ready");
  });

  it("ignores late send completion after a session reset", () => {
    const store = useAttachmentDrafts.getState();
    const [entry] = store.stage("c:a", [file("sent")], "ready", 5).accepted;
    expect(store.beginSend("c:a", [entry.id], () => {})).toBe(true);

    store.reset();
    store.sendSucceeded("c:a", [entry.id]);

    expect(useAttachmentDrafts.getState().byDraft).toEqual({});
  });

  it("keeps cancellation available through the draft transaction", () => {
    const store = useAttachmentDrafts.getState();
    const [entry] = store.stage("c:a", [file("sent")], "ready", 5).accepted;
    let aborted = false;
    expect(store.beginSend("c:a", [entry.id], () => { aborted = true; })).toBe(true);

    expect(store.cancelSend("c:a", entry.id)).toBe(true);
    expect(aborted).toBe(true);
    expect(store.cancelSend("c:a", "other")).toBe(false);

    store.sendFailed("c:a", [entry.id]);
    expect(useAttachmentDrafts.getState().byDraft["c:a"][0].status).toBe("ready");
  });

  it("keeps preview URLs until the owning draft removes them", () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const store = useAttachmentDrafts.getState();
    const [entry] = store.stage("c:a", [file("image")], "ready", 5).accepted;

    expect(draftAttachmentPreviewUrl(entry)).toBe("blob:preview");
    expect(draftAttachmentPreviewUrl(entry)).toBe("blob:preview");
    expect(create).toHaveBeenCalledTimes(1);

    store.remove("c:a", entry.id);
    expect(revoke).toHaveBeenCalledWith("blob:preview");
  });

  it("keeps a ready preview visible while its upload is sending", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sending");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const store = useAttachmentDrafts.getState();
    const [entry] = store.stage("c:a", [file("image")], "ready", 5).accepted;
    expect(draftAttachmentPreviewUrl(entry)).toBe("blob:sending");

    expect(store.beginSend("c:a", [entry.id], () => {})).toBe(true);
    const sending = useAttachmentDrafts.getState().byDraft["c:a"][0];
    expect(draftAttachmentPreviewUrl(sending)).toBe("blob:sending");
    expect(revoke).not.toHaveBeenCalled();

    store.sendSucceeded("c:a", [entry.id]);
    expect(revoke).toHaveBeenCalledWith("blob:sending");
  });

  it("does not create previews before a dropped file is ready", () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ready");
    const store = useAttachmentDrafts.getState();
    const [entry] = store.stage("c:a", [file("placeholder")], "preparing", 5).accepted;

    expect(draftAttachmentPreviewUrl(entry)).toBeNull();
    expect(create).not.toHaveBeenCalled();

    const readyFile = file("ready");
    expect(store.complete("c:a", entry.id, readyFile)).toBe(true);
    const ready = useAttachmentDrafts.getState().byDraft["c:a"][0];
    expect(draftAttachmentPreviewUrl(ready)).toBe("blob:ready");
  });
});
