import { describe, expect, it } from "vitest";
import { materializeDroppedFile } from "../src";

describe("materializeDroppedFile", () => {
  it("copies bytes and file metadata", async () => {
    const source = new File(["screenshot"], "shot.png", {
      type: "image/png",
      lastModified: 123,
    });

    const result = await materializeDroppedFile(source);

    expect(result).not.toBe(source);
    expect(await result.text()).toBe("screenshot");
    expect(result.name).toBe("shot.png");
    expect(result.type).toBe("image/png");
    expect(result.lastModified).toBe(123);
  });

  it("rejects empty reads", async () => {
    const source = new File([], "empty.txt");
    await expect(materializeDroppedFile(source)).rejects.toThrow("Dropped file was empty");
  });

  it("supplies a fallback name", async () => {
    const result = await materializeDroppedFile(new File(["data"], ""));
    expect(result.name).toBe("file");
  });

  it("returns oversized files without reading them", async () => {
    const source = new File(["large"], "large.mov");
    Object.defineProperty(source, "arrayBuffer", {
      value: () => Promise.reject(new Error("should not read")),
    });

    await expect(materializeDroppedFile(source, { maxBytes: 1 })).resolves.toBe(source);
  });

  it("bounds a read that never settles", async () => {
    const source = new File(["pending"], "pending.png");
    Object.defineProperty(source, "arrayBuffer", {
      value: () => new Promise<ArrayBuffer>(() => {}),
    });

    await expect(materializeDroppedFile(source, { timeoutMs: 5 }))
      .rejects.toThrow("Dropped file read timed out");
  });
});
