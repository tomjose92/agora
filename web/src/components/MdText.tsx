/* Message prose: mdliteHtml + @mention
   decoration, mermaid marker divs rendered lazily after paint. */

import { useEffect, useRef } from "react";
import { mdliteHtml } from "@agora/core";
import { decorateMentions, type MentionIndex } from "../lib/mentions";
import { renderMermaid } from "../lib/mermaid";

export function MdText({ text, mentions }: { text: string; mentions?: MentionIndex }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = mentions ? decorateMentions(mdliteHtml(text), mentions) : mdliteHtml(text);
  useEffect(() => {
    if (html.includes("md-mermaid")) void renderMermaid();
  }, [html]);
  return <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}
