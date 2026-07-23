/* Source viewer overlay — one cited source at a time, paged with
   arrows/dots and arrow keys. */

import { useEffect, useState } from "react";
import type { LinkPreview } from "@agora/core";
import { Icon } from "../lib/icons";
import { urlHost } from "./Unfurls";
import { useSourcesView } from "./MessageItem";

export function SourcesViewer() {
  const { open, close } = useSourcesView();
  const [i, setI] = useState(0);
  const sources: LinkPreview[] = open?.message.meta?.sources || [];

  useEffect(() => {
    if (open) setI(Math.max(0, Math.min(open.index, sources.length - 1)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") setI(k => (k + 1) % sources.length);
      else if (e.key === "ArrowLeft") setI(k => (k - 1 + sources.length) % sources.length);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, sources.length, close]);

  if (!open || !sources.length) return null;
  const s = sources[Math.min(i, sources.length - 1)];

  return (
    <div className="conn-overlay" id="ago-sources-overlay"
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="conn-panel ago-src-panel">
        <div className="ago-src-top">
          <span className="ago-src-count">Source {i + 1} of {sources.length}</span>
          <button className="btn sm" onClick={close}><Icon name="x" /></button>
        </div>
        {s.image && <img className="ago-src-img" src={s.image} alt="" loading="lazy"
          onError={e => (e.target as HTMLImageElement).remove()} />}
        <div className="ago-src-body">
          <div className="ago-src-site"><Icon name="link" /> {s.site || urlHost(s.url) || "link"}</div>
          <div className="ago-src-title">{s.title || urlHost(s.url) || s.url}</div>
          {s.description && <div className="ago-src-desc">{s.description}</div>}
          <div className="ago-src-url" title={s.url}>{s.url}</div>
        </div>
        <div className="ago-src-nav">
          <button className="btn sm" title="Previous source" disabled={sources.length <= 1}
            onClick={() => setI(k => (k - 1 + sources.length) % sources.length)}>
            <Icon name="chevron-left" />
          </button>
          <div className="ago-src-dots">
            {sources.map((_, k) => (
              <button key={k} className={`ago-src-dot ${k === i ? "on" : ""}`}
                title={`Source ${k + 1}`} onClick={() => setI(k)}></button>
            ))}
          </div>
          <button className="btn sm" title="Next source" disabled={sources.length <= 1}
            onClick={() => setI(k => (k + 1) % sources.length)}>
            <Icon name="chevron-right" />
          </button>
        </div>
        <a className="ago-src-open" href={s.url} target="_blank" rel="noopener noreferrer">
          <Icon name="external-link" /> Open source
        </a>
      </div>
    </div>
  );
}
