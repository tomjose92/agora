import { describe, expect, it } from "vitest";
import { mentionsMe } from "../src/lib/unread";
import { fmtTs, fmtSize } from "../src/lib/format";

describe("mentionsMe", () => {
  it("matches @username with word boundaries", () => {
    expect(mentionsMe("hey @alice look", "alice")).toBe(true);
    expect(mentionsMe("hey @alicedale look", "alice")).toBe(false);
    expect(mentionsMe("no mention here", "alice")).toBe(false);
  });
});

describe("format", () => {
  it("fmtTs empty on falsy", () => {
    expect(fmtTs(null)).toBe("");
    expect(fmtTs(undefined)).toBe("");
  });
  it("fmtSize scales", () => {
    expect(fmtSize(512)).toMatch(/B/);
    expect(fmtSize(2048)).toMatch(/KB|kB/i);
  });
});
