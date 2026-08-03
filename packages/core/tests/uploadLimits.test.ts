import { describe, expect, it } from "vitest";
import { droppedTooLargeMessage, uploadMaxBytes } from "../src/lib/uploadLimits";

describe("attachment upload limits", () => {
  it("uses the larger advertised video limit", () => {
    expect(uploadMaxBytes("video/mp4", 10, 100)).toBe(100 * 1024 * 1024);
    expect(uploadMaxBytes("application/pdf", 10, 100)).toBe(10 * 1024 * 1024);
    expect(uploadMaxBytes("video/x-matroska", 10, 100)).toBe(10 * 1024 * 1024);
    expect(uploadMaxBytes("video/mp4", 10, undefined)).toBe(10 * 1024 * 1024);
    expect(uploadMaxBytes("video/mp4", undefined, undefined)).toBeUndefined();
  });

  it("directs heap-clamped video drops to the paperclip", () => {
    expect(droppedTooLargeMessage("video/mp4", 10, 100))
      .toBe("Large files must be attached with the paperclip");
    expect(droppedTooLargeMessage("application/pdf", 10, 100))
      .toBe("File too large (max 10 MB)");
  });
});
