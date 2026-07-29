import { afterEach, describe, expect, it } from "vitest";
import { useAttachmentDrafts } from "../src";

const file = (name: string) => new File([name], name, { type: "text/plain" });

afterEach(() => useAttachmentDrafts.getState().reset());

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

    store.removeMany("c:a", sent.map((entry) => entry.id));

    expect(useAttachmentDrafts.getState().byDraft["c:a"].map((entry) => entry.name))
      .toEqual(["new"]);
  });
});
