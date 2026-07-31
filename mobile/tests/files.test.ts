import { NATIVE_IMAGE, WEB_SAFE_IMAGE } from "../src/lib/files";

describe("mobile attachment previews", () => {
  it("only treats formats shared with web and vision paths as previewable", () => {
    expect(WEB_SAFE_IMAGE.test("image/jpeg")).toBe(true);
    expect(WEB_SAFE_IMAGE.test("image/png")).toBe(true);
    expect(WEB_SAFE_IMAGE.test("image/webp")).toBe(true);
    expect(WEB_SAFE_IMAGE.test("image/heic")).toBe(false);
    expect(WEB_SAFE_IMAGE.test("application/pdf")).toBe(false);
  });

  it("supports native image formats in local draft previews", () => {
    expect(NATIVE_IMAGE.test("image/jpg")).toBe(true);
    expect(NATIVE_IMAGE.test("image/svg+xml")).toBe(true);
    expect(NATIVE_IMAGE.test("image/bmp")).toBe(true);
    expect(NATIVE_IMAGE.test("image/heic")).toBe(true);
    expect(NATIVE_IMAGE.test("image/heif")).toBe(true);
    expect(NATIVE_IMAGE.test("image/avif")).toBe(true);
  });

  it("can preview every format uploaded without re-encoding", () => {
    for (const mime of ["image/jpg", "image/jpeg", "image/png", "image/gif", "image/webp"]) {
      expect(WEB_SAFE_IMAGE.test(mime)).toBe(true);
      expect(NATIVE_IMAGE.test(mime)).toBe(true);
    }
  });
});
