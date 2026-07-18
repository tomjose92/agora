import { fmtSize, slugify, spliceText } from "../src/lib/format";

describe("spliceText", () => {
  it("inserts at the caret", () => {
    expect(spliceText("hello world", 5, 5, "👍")).toEqual({ text: "hello👍 world", caret: 7 });
  });

  it("replaces a selection", () => {
    expect(spliceText("abc", 1, 2, "🔥")).toEqual({ text: "a🔥c", caret: 3 });
  });

  it("appends when the caret is at the end", () => {
    expect(spliceText("hi", 2, 2, "!")).toEqual({ text: "hi!", caret: 3 });
  });

  it("clamps a stale selection past the end of the text", () => {
    expect(spliceText("ab", 10, 12, "x")).toEqual({ text: "abx", caret: 3 });
  });

  it("clamps a negative or inverted selection", () => {
    expect(spliceText("ab", -1, 0, "x")).toEqual({ text: "xab", caret: 1 });
    expect(spliceText("abcd", 3, 1, "x")).toEqual({ text: "abcxd", caret: 4 });
  });

  it("inserts into empty text", () => {
    expect(spliceText("", 0, 0, "😀")).toEqual({ text: "😀", caret: 2 });
  });
});

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
