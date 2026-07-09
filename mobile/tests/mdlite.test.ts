import { parseInline, parseMd } from "../src/lib/mdlite";

describe("parseInline", () => {
  it("passes plain text through", () => {
    expect(parseInline("hello world")).toEqual([{ kind: "text", text: "hello world" }]);
  });

  it("parses bold, italic and code", () => {
    expect(parseInline("a **b** *c* `d`")).toEqual([
      { kind: "text", text: "a " },
      { kind: "bold", text: "b" },
      { kind: "text", text: " " },
      { kind: "italic", text: "c" },
      { kind: "text", text: " " },
      { kind: "code", text: "d" },
    ]);
  });

  it("parses markdown links and bare urls", () => {
    expect(parseInline("[docs](https://example.com/x) and https://foo.bar")).toEqual([
      { kind: "link", text: "docs", url: "https://example.com/x" },
      { kind: "text", text: " and " },
      { kind: "link", text: "https://foo.bar", url: "https://foo.bar" },
    ]);
  });

  it("does not treat multiplication as italic", () => {
    // Same guard as the desktop regex: * must hug non-space content.
    expect(parseInline("2 * 3 * 4")).toEqual([{ kind: "text", text: "2 * 3 * 4" }]);
  });

  it("parses @mentions at token boundaries", () => {
    expect(parseInline("hey @tom, look")).toEqual([
      { kind: "text", text: "hey " },
      { kind: "mention", text: "@tom" },
      { kind: "text", text: ", look" },
    ]);
    // Emails are not mentions (the @ is glued to the local part).
    expect(parseInline("mail a@b.com")).toEqual([{ kind: "text", text: "mail a@b.com" }]);
  });
});

describe("parseMd", () => {
  it("extracts fenced code blocks", () => {
    const blocks = parseMd("before\n```js\nconst x = 1;\n```\nafter");
    expect(blocks).toEqual([
      { kind: "para", spans: [{ kind: "text", text: "before" }] },
      { kind: "codeblock", text: "const x = 1;" },
      { kind: "para", spans: [{ kind: "text", text: "after" }] },
    ]);
  });

  it("renders headings as their own block", () => {
    const blocks = parseMd("## Title\nbody");
    expect(blocks[0]).toEqual({ kind: "heading", spans: [{ kind: "text", text: "Title" }] });
    expect(blocks[1]).toEqual({ kind: "para", spans: [{ kind: "text", text: "body" }] });
  });

  it("parses github pipe tables with alignment", () => {
    const md = "| a | b |\n|:-:|--:|\n| 1 | 2 |\n| 3 | 4 |";
    const blocks = parseMd(md);
    expect(blocks).toHaveLength(1);
    const t = blocks[0];
    if (t.kind !== "table") throw new Error("expected table");
    expect(t.aligns).toEqual(["center", "right"]);
    expect(t.head.map((c) => c[0])).toEqual([
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
    ]);
    expect(t.rows).toHaveLength(2);
  });

  it("splits paragraphs on blank lines and keeps single newlines", () => {
    const blocks = parseMd("line1\nline2\n\npara2");
    expect(blocks).toEqual([
      { kind: "para", spans: [{ kind: "text", text: "line1\nline2" }] },
      { kind: "para", spans: [{ kind: "text", text: "para2" }] },
    ]);
  });

  it("handles empty input", () => {
    expect(parseMd("")).toEqual([]);
  });
});
