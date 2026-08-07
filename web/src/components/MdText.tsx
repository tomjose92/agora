/* Message prose: mdliteHtml + @mention decoration. Mermaid marker divs render
   lazily after paint; ECharts fences become stable direct React children. */

import { useEffect } from "react";
import { mdliteHtml } from "@agora/core";
import { decorateMentions, type MentionIndex } from "../lib/mentions";
import { renderMermaid } from "../lib/mermaid";
import { EChartBlock } from "./EChartBlock";

type MdPart = { kind: "html"; text: string } | { kind: "echarts"; source: string };

function splitECharts(text: string): MdPart[] {
  const parts: MdPart[] = [];
  // Keep this fence grammar aligned with mdliteHtml. Non-ECharts fences remain
  // inside their prose segment so the shared renderer handles them normally.
  const fences = /```(\w*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of text.matchAll(fences)) {
    if (match[1].toLowerCase() !== "echarts") continue;
    if (match.index > cursor) parts.push({ kind: "html", text: text.slice(cursor, match.index) });
    parts.push({ kind: "echarts", source: match[2].replace(/\n$/, "") });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: "html", text: text.slice(cursor) });
  return parts.length ? parts : [{ kind: "html", text }];
}

export function MdText({ text, mentions }: { text: string; mentions?: MentionIndex }) {
  const parts = splitECharts(text).map(part => part.kind === "html"
    ? { ...part, html: mentions ? decorateMentions(mdliteHtml(part.text), mentions) : mdliteHtml(part.text) }
    : part);
  const mermaidHtml = parts.flatMap(part => part.kind === "html" ? [part.html] : []).join("");
  useEffect(() => {
    if (mermaidHtml.includes("md-mermaid")) void renderMermaid();
  }, [mermaidHtml]);
  return (
    <div>
      {parts.map((part, index) => part.kind === "echarts"
        ? <EChartBlock key={index} source={part.source} />
        : <div key={index} className="md-text-segment" dangerouslySetInnerHTML={{ __html: part.html }} />)}
    </div>
  );
}
