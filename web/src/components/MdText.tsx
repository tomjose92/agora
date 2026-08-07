/* Message prose: mdliteHtml + @mention
   decoration, mermaid marker divs rendered lazily after paint. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { mdliteHtml } from "@agora/core";
import { decorateMentions, type MentionIndex } from "../lib/mentions";
import { renderMermaid } from "../lib/mermaid";
import { EChartBlock } from "./EChartBlock";

export function MdText({ text, mentions }: { text: string; mentions?: MentionIndex }) {
  const ref = useRef<HTMLDivElement>(null);
  const [charts, setCharts] = useState<{ node: HTMLElement; source: string }[]>([]);
  const html = mentions ? decorateMentions(mdliteHtml(text), mentions) : mdliteHtml(text);
  useEffect(() => {
    if (html.includes("md-mermaid")) void renderMermaid();
  }, [html]);
  useLayoutEffect(() => {
    const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>(".md-echarts") ?? []);
    setCharts(nodes.map(node => ({ node, source: node.textContent?.trim() ?? "" })));
  }, [html]);
  return (
    <>
      <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      {charts.map((chart, index) => createPortal(
        <EChartBlock source={chart.source} />,
        chart.node,
        index,
      ))}
    </>
  );
}
