/* Server-fetched link previews (meta.unfurls) — same markup as
   agoUnfurlsHTML. */

import type { Message } from "@agora/core";

function urlHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export function Unfurls({ message }: { message: Message }) {
  const unfurls = message.meta?.unfurls || [];
  if (!unfurls.length) return null;
  return (
    <div className="ago-unfurls">
      {unfurls.map((u, i) => (
        <a key={i} className="ago-unfurl" href={u.url} target="_blank" rel="noopener noreferrer">
          <div className="ago-unfurl-body">
            <div className="ago-unfurl-site">{u.site || urlHost(u.url)}</div>
            <div className="ago-unfurl-title">{u.title || u.url}</div>
            {u.description ? <div className="ago-unfurl-desc">{u.description}</div> : null}
          </div>
          {u.image ? (
            <img className="ago-unfurl-img" src={u.image} alt="" loading="lazy"
              onError={e => (e.target as HTMLImageElement).remove()} />
          ) : null}
        </a>
      ))}
    </div>
  );
}

export { urlHost };
