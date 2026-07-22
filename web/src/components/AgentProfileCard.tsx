/* Agent profile overlay: avatar + everything /api/agents knows about the
   agent (port of agoShowAgentProfile). */

import { useAgents } from "@agora/core";
import { Icon } from "../lib/icons";
import { withToken } from "../lib/files";
import { useAgentProfile } from "./MessageItem";

function relTime(ts: number): string {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function AgentProfileCard() {
  const { openId, close } = useAgentProfile();
  const agents = useAgents().data || [];
  if (!openId) return null;
  const a = agents.find(x => x.id === openId) as (typeof agents)[number] & {
    avatar?: string; source?: string; last_seen?: number; requires_mention?: boolean;
  } | undefined;
  if (!a) return null;

  return (
    <div className="conn-overlay" id="ago-profile-overlay"
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="conn-panel ago-profile-panel">
        <div className="ago-profile-top">
          {a.avatar
            ? <span className="ago-av profile has-avatar"><img src={withToken(a.avatar)} alt="" /></span>
            : <span className="ago-av profile"><Icon name="bot" /></span>}
          <div className="ago-profile-id">
            <div className="ago-profile-name">{a.name || a.id}</div>
            <div className="ago-profile-sub dim">@{a.id} · agent</div>
          </div>
          <button className="btn sm ago-profile-close" onClick={close}><Icon name="x" /></button>
        </div>
        <div className="ago-profile-rows">
          <div className="ago-profile-row">
            <span className="k">Status</span>
            <span className="v">
              {a.live
                ? <><span className="ago-live-dot"></span> Online</>
                : <><span className="ago-off">Offline</span>{a.last_seen ? ` · last seen ${relTime(a.last_seen)}` : ""}</>}
            </span>
          </div>
          {a.source && (
            <div className="ago-profile-row"><span className="k">Connection</span><span className="v">{a.source}</span></div>
          )}
          <div className="ago-profile-row">
            <span className="k">Responds</span>
            <span className="v">{a.requires_mention ? "Only when @-mentioned" : "To every message in its channels"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
