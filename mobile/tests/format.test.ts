import { fmtSize, slugify } from "@agora/core";

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Code Reviewer 2")).toBe("code-reviewer-2");
  });
});

describe("fmtSize", () => {
  it("formats byte counts", () => {
    expect(fmtSize(512)).toBe("512 B");
    expect(fmtSize(2048)).toBe("2.0 KB");
  });
});
