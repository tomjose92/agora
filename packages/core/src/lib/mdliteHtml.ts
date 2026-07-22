/* HTML-emitting markdown-lite: a line-for-line TS port of esc() + mdLite()
   from the retired vanilla shim.js, so the React UI renders byte-identical message HTML to
   the vanilla UI. (lib/mdlite.ts is the tree-parsing variant the mobile app
   renders natively; both ship so either host can pick.) */

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export function mdliteHtml(s: string): string {
  let t = esc(s);
  const slots: string[] = [];
  const stash = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
    code = code.replace(/\n$/, "");
    // A mermaid fence keeps its code block visible inside a marker div; the
    // mermaid renderer swaps it for the SVG after render (and leaves the
    // code standing when the graph doesn't parse).
    if (lang.toLowerCase() === "mermaid") {
      return stash(`<div class="md-mermaid"><pre class="md-pre">${code}</pre></div>`);
    }
    return stash(`<pre class="md-pre"${lang ? ` data-lang="${lang}"` : ""}>${code}</pre>`);
  });
  t = t.replace(/`([^`\n]+)`/g, (_, c: string) => stash(`<code>${c}</code>`));
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_, label: string, url: string) => stash(`<a href="${url}" target="_blank" rel="noopener">${label}</a>`));
  t = t.replace(/(^|\s)(https?:\/\/[^\s<\u0000]+)/g,
    (_, pre: string, url: string) => pre + stash(`<a href="${url}" target="_blank" rel="noopener">${url}</a>`));
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s).,!?:;])/gm, "$1<i>$2</i>");
  t = t.replace(/^#{1,4}\s+(.+)$/gm, "<b>$1</b>");
  t = t.replace(
    /(^|\n)(\|[^\n]*\|[ \t]*\r?\n\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*(?:\r?\n\|[^\n]*\|[ \t]*)*)\r?\n?/g,
    (_, pre: string, block: string) => {
      const rows = block.trim().split(/\r?\n/).map(line =>
        line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim()));
      const aligns = rows[1].map(c =>
        /^:-+:$/.test(c) ? "center" : /^-+:$/.test(c) ? "right" : "");
      const cell = (tag: string, c: string, i: number) =>
        `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ""}>${c}</${tag}>`;
      const head = `<tr>${rows[0].map((c, i) => cell("th", c, i)).join("")}</tr>`;
      const body = rows.slice(2).map(r =>
        `<tr>${r.map((c, i) => cell("td", c, i)).join("")}</tr>`).join("");
      return pre + `<div class="md-table-wrap"><table class="md-table"><thead>${head}</thead>`
        + `<tbody>${body}</tbody></table></div>`;
    });
  return t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]);
}
