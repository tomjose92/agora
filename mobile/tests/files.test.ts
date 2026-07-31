import { BROWSER_IMAGE, WEB_SAFE_IMAGE } from "../src/lib/files";

describe("mobile attachment previews", () => {
  it("only treats formats shared with web and vision paths as previewable", () => {
    expect(WEB_SAFE_IMAGE.test("image/jpeg")).toBe(true);
    expect(WEB_SAFE_IMAGE.test("image/png")).toBe(true);
    expect(WEB_SAFE_IMAGE.test("image/webp")).toBe(true);
    expect(WEB_SAFE_IMAGE.test("image/heic")).toBe(false);
    expect(WEB_SAFE_IMAGE.test("application/pdf")).toBe(false);
  });

  it("keeps server-stored SVG and BMP attachments inline", () => {
    expect(BROWSER_IMAGE.test("image/svg+xml")).toBe(true);
    expect(BROWSER_IMAGE.test("image/bmp")).toBe(true);
    expect(BROWSER_IMAGE.test("image/heic")).toBe(false);
  });
});
