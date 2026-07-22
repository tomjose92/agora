/* Markdown-lite parser, ported from the retired vanilla shim.js mdLite() but emitting a
   structured tree instead of HTML so React Native can render it natively.
   Supported, same as desktop: fenced code, inline code, [label](url) and
   bare links, **bold**, *italic*, #-headings (rendered bold), and
   GitHub-style pipe tables. */

export type Span =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string }
  | { kind: "mention"; text: string };

export type Block =
  | { kind: "para"; spans: Span[] }
  | { kind: "heading"; spans: Span[] }
  | { kind: "codeblock"; text: string; lang?: string }
  | { kind: "table"; aligns: ("" | "left" | "center" | "right")[]; head: Span[][]; rows: Span[][][] };

const INLINE = new RegExp(
  [
    "`([^`\\n]+)`", // 1 inline code
    "\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)", // 2,3 md link
    "(https?:\\/\\/[^\\s<]+)", // 4 bare url
    "\\*\\*([^*\\n]+)\\*\\*", // 5 bold
    "(?:^|(?<=[\\s(]))\\*(\\S(?:[^*\\n]*\\S)?)\\*(?=$|[\\s).,!?:;])", // 6 italic
    "(?:^|(?<=[\\s(]))@([A-Za-z0-9][\\w.-]*)", // 7 @mention (server token shape)
  ].join("|"),
  "g",
);

export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) spans.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) spans.push({ kind: "link", text: m[2], url: m[3] });
    else if (m[4] !== undefined) spans.push({ kind: "link", text: m[4], url: m[4] });
    else if (m[5] !== undefined) spans.push({ kind: "bold", text: m[5] });
    else if (m[6] !== undefined) spans.push({ kind: "italic", text: m[6] });
    else if (m[7] !== undefined) spans.push({ kind: "mention", text: `@${m[7]}` });
    last = m.index! + m[0].length;
  }
  if (last < text.length) spans.push({ kind: "text", text: text.slice(last) });
  return spans;
}

const TABLE_SEP = /^\s*\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/;

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function parseMd(text: string): Block[] {
  const blocks: Block[] = [];
  // Fenced code blocks first; everything between them is line-parsed. The
  // fence's language tag is kept (a ```mermaid fence renders as a diagram).
  const parts = String(text ?? "").split(/```(\w*)\n?([\s\S]*?)```/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 1) {
      blocks.push({
        kind: "codeblock",
        lang: parts[i] ? parts[i].toLowerCase() : undefined,
        text: parts[i + 1].replace(/\n$/, ""),
      });
      i++; // the code group was consumed alongside its language group
      continue;
    }
    const lines = parts[i].split("\n");
    let para: string[] = [];
    const flush = () => {
      const joined = para.join("\n").replace(/^\n+|\n+$/g, "");
      if (joined) blocks.push({ kind: "para", spans: parseInline(joined) });
      para = [];
    };
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      const heading = /^#{1,4}\s+(.+)$/.exec(line);
      if (heading) {
        flush();
        blocks.push({ kind: "heading", spans: parseInline(heading[1]) });
        continue;
      }
      // Table: a |row| line whose next line is the separator row.
      if (/^\s*\|.*\|\s*$/.test(line) && j + 1 < lines.length && TABLE_SEP.test(lines[j + 1])) {
        flush();
        const head = splitRow(line).map(parseInline);
        const aligns = splitRow(lines[j + 1]).map((c) =>
          /^:-+:$/.test(c) ? "center" as const : /^-+:$/.test(c) ? "right" as const : "" as const,
        );
        const rows: Span[][][] = [];
        j += 2;
        while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
          rows.push(splitRow(lines[j]).map(parseInline));
          j++;
        }
        j--; // loop increment re-advances
        blocks.push({ kind: "table", aligns, head, rows });
        continue;
      }
      if (line.trim() === "") {
        flush();
        continue;
      }
      para.push(line);
    }
    flush();
  }
  return blocks;
}
