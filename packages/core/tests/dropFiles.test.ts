import { describe, expect, it } from "vitest";
import {
  DROP_HEAP_MAX_BYTES,
  dropMaterializationLimit,
  materializeDroppedFile,
} from "../src";

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

  it("reads a promised file even when its initial size is zero", async () => {
    const source = new File([], "promised.png", { type: "image/png" });
    Object.defineProperty(source, "arrayBuffer", {
      value: () => Promise.resolve(new TextEncoder().encode("resolved").buffer),
    });

    await expect(materializeDroppedFile(source))
      .resolves.toMatchObject({ name: "promised.png", size: 8 });
  });

  it("starts reading synchronously", () => {
    const source = new File(["x"], "shot.png");
    let started = false;
    Object.defineProperty(source, "arrayBuffer", {
      value: () => {
        started = true;
        return Promise.resolve(new Uint8Array([1]).buffer);
      },
    });

    void materializeDroppedFile(source);
    expect(started).toBe(true);
  });

  it("enforces the byte limit again after reading", async () => {
    const source = new File([], "misreported.png");
    Object.defineProperty(source, "arrayBuffer", {
      value: () => Promise.resolve(new Uint8Array([1, 2]).buffer),
    });

    await expect(materializeDroppedFile(source, { maxBytes: 1 }))
      .rejects.toMatchObject({ code: "too_large" });
  });

  it("supplies a fallback name", async () => {
    const result = await materializeDroppedFile(new File(["data"], ""));
    expect(result.name).toBe("file");
  });

  it("rejects oversized files without reading them", async () => {
    const source = new File(["large"], "large.mov");
    Object.defineProperty(source, "arrayBuffer", {
      value: () => Promise.reject(new Error("should not read")),
    });

    await expect(materializeDroppedFile(source, { maxBytes: 1 }))
      .rejects.toMatchObject({ code: "too_large" });
  });

  it("bounds a read that never settles", async () => {
    const source = new File(["pending"], "pending.png");
    Object.defineProperty(source, "arrayBuffer", {
      value: () => new Promise<ArrayBuffer>(() => {}),
    });

    await expect(materializeDroppedFile(source, { timeoutMs: 5 }))
      .rejects.toThrow("Dropped file read timed out");
  });

  it("uses the lower of the server limit and heap ceiling", () => {
    expect(dropMaterializationLimit(10)).toBe(10 * 1024 * 1024);
    expect(dropMaterializationLimit(500)).toBe(DROP_HEAP_MAX_BYTES);
    expect(dropMaterializationLimit()).toBe(DROP_HEAP_MAX_BYTES);
  });
});
