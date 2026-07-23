/* One message bubble: .bubble.user|.assistant[.peer], the .who header,
   prose, attachments/unfurls/sources/forms/options/reactions, the foot
   buttons, and the agent avatar row wrapper. */

import { create } from "zustand";
import {
  fmtTs, tldrOf, useAgents, useDeleteMessage, useMe, usePinMessage, usePins,
  useStarMessage, useStars, useTldrView, type LinkPreview, type Message,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { withToken } from "../lib/files";
import { toast } from "../lib/toast";
import { useConfirm } from "../state/confirm";
import { type MentionIndex } from "../lib/mentions";
import { MdText } from "./MdText";
import { Attachments } from "./Attachments";
import { Unfurls, urlHost } from "./Unfurls";
import { MessageOptions } from "./MessageOptions";
import { MessageFormView } from "./MessageFormView";
import { Reactions } from "./Reactions";
import { useEmojiPicker } from "./EmojiPicker";

/* Source viewer state (the overlay itself mounts app-level). */
interface SourcesView {
  open: { message: Message; index: number } | null;
  show: (message: Message, index: number) => void;
  close: () => void;
}
export const useSourcesView = create<SourcesView>((set) => ({
  open: null,
  show: (message, index) => set({ open: { message, index } }),
  close: () => set({ open: null }),
}));

/* The text a bubble renders: cut a trailing "Sources:" block the server
   lifted into meta.sources. */
function visibleText(m: Message): string {
  const meta = m.meta || {};
  const cut = meta.sources_start;
  if (Array.isArray(meta.sources) && meta.sources.length
    && Number.isInteger(cut) && (cut as number) > 0 && (cut as number) < (m.text || "").length) {
    return m.text.slice(0, cut as number).replace(/\s+$/, "");
  }
  return m.text;
}

function AgentAvatar({ agentId }: { agentId: string }) {
  const agents = useAgents().data || [];
  const meta = agents.find(a => a.id === agentId);
  const av = (meta as { avatar?: string } | undefined)?.avatar;
  const title = `View ${meta?.name || agentId}'s profile`;
  const onClick = () => useAgentProfile.getState().show(agentId);
  if (av) {
    return (
      <span className="ago-av clickable has-avatar" role="button" title={title} onClick={onClick}>
        <img src={withToken(av)} alt=""
          onError={e => {
            const wrap = (e.target as HTMLImageElement).parentElement;
            if (wrap) wrap.classList.remove("has-avatar");
            (e.target as HTMLImageElement).style.display = "none";
          }} />
      </span>
    );
  }
  return (
    <span className="ago-av clickable" role="button" title={title} onClick={onClick}>
      <Icon name="bot" />
    </span>
  );
}

/* Agent profile card state (overlay mounts app-level, Phase 5). */
interface AgentProfileState {
  openId: string | null;
  show: (id: string) => void;
  close: () => void;
}
export const useAgentProfile = create<AgentProfileState>((set) => ({
  openId: null,
  show: (id) => set({ openId: id }),
  close: () => set({ openId: null }),
}));

function SourceChips({ message }: { message: Message }) {
  const sources = (message.meta?.sources || []) as LinkPreview[];
  if (!sources.length) return null;
  return (
    <div className="ago-sources">
      <span className="ago-sources-label"><Icon name="link" /> sources</span>
      {sources.map((s, i) => (
        <button key={i} className="ago-source-chip"
          title={s.title ? `${s.title}\n${s.url}` : s.url}
          onClick={() => useSourcesView.getState().show(message, i)}>
          <span className="n">{i + 1}</span>
          <span className="t">{s.title || urlHost(s.url) || s.url}</span>
        </button>
      ))}
    </div>
  );
}

export function MessageItem({ message: m, inThread, isAdmin, mentions, onOpenThread }: {
  message: Message;
  inThread: boolean;
  isAdmin: boolean;
  mentions?: MentionIndex;
  onOpenThread: (rootId: number) => void;
}) {
  const me = useMe().data;
  const mine = m.author_type === "user" && !!me && m.author_id === me.username;
  const cls = m.author_type === "agent" ? "assistant" : (mine ? "user" : "assistant peer");

  const pins = usePins(m.channel_id).data || [];
  const stars = useStars(m.channel_id).data || [];
  const pinMut = usePinMessage(m.channel_id);
  const starMut = useStarMessage(m.channel_id);
  const del = useDeleteMessage();
  const { showing, toggle: toggleTldr } = useTldrView();
  const armed = useConfirm(s => s.armed) === `msg:${m.id}`;
  const armKey = useConfirm(s => s.arm);
  const disarm = useConfirm(s => s.disarm);
  const openPicker = useEmojiPicker(s => s.open);

  const pinnable = m.thread_id == null;
  const pinned = pinnable && pins.some(p => p.id === m.id);
  const starred = stars.some(s => s.id === m.id);
  const tldr = tldrOf(m);
  const onTldr = tldr != null && !!showing[m.id];

  const onDelete = () => {
    if (!armed) { armKey(`msg:${m.id}`); return; }
    disarm();
    del.mutate({ message: m }, {
      onError: (e) => toast("Delete failed: " + (e as Error).message, { variant: "warn" }),
    });
  };

  const bubble = (
    <div className={`bubble ${cls} ago-bubble`} data-mid={m.id}>
      <div className="who">
        <span className="who-name">
          {(m.author_name || m.author_id)}{m.author_type === "agent" ? " · agent" : ""}
        </span>
        {pinned && <span className="ago-pinned-mark" title="Pinned"><Icon name="pin" /></span>}
        {starred && <span className="ago-starred-mark" title="Starred by you"><Icon name="star" cls="fill" /></span>}
        {onTldr && <span className="ago-tldr-mark" title="Short version — the full message is one click away">TL;DR</span>}
        <span className="bubble-ts">{fmtTs(m.ts)}</span>
      </div>
      <MdText text={onTldr ? (tldr as string) : visibleText(m)} mentions={mentions} />
      <Attachments message={m} />
      <Unfurls message={m} />
      <SourceChips message={m} />
      <MessageFormView message={m} />
      <MessageOptions message={m} />
      <Reactions message={m} onPick={(anchor) => openPicker(m.id, anchor)} />
      <div className="ago-bubble-foot">
        {!inThread && !!m.reply_count && (
          <button className="ago-replies" onClick={() => onOpenThread(m.id)}>
            {m.reply_count} repl{m.reply_count === 1 ? "y" : "ies"} →
          </button>
        )}
        {!inThread && (
          <button className="ago-thread-btn" title="Reply in thread" onClick={() => onOpenThread(m.id)}>
            <Icon name="corner-down-right" /> thread
          </button>
        )}
        <button className="ago-thread-btn ago-react-btn" title="Add reaction"
          onClick={e => openPicker(m.id, e.currentTarget)}>
          <Icon name="smile" /> react
        </button>
        {pinnable && (
          <button className={`ago-thread-btn ago-pin-btn ${pinned ? "pinned" : ""}`}
            title={pinned ? "Unpin this thread" : "Pin this thread for quick access"}
            onClick={() => pinMut.mutate({ messageId: m.id, pinned: !pinned })}>
            {pinned ? <><Icon name="pin-off" /> unpin</> : <><Icon name="pin" /> pin</>}
          </button>
        )}
        <button className={`ago-thread-btn ago-star-btn ${starred ? "starred" : ""}`}
          title={starred ? "Remove from your starred messages" : "Star this message"}
          onClick={() => starMut.mutate({ messageId: m.id, starred: !starred })}>
          {starred ? <><Icon name="star" cls="fill" /> starred</> : <><Icon name="star" /> star</>}
        </button>
        {tldr != null && (
          <button className={`ago-thread-btn ago-tldr-btn ${onTldr ? "on" : ""}`}
            title={onTldr ? "Show the full message" : "Show the short version"}
            onClick={() => toggleTldr(m.id)}>
            {onTldr ? <><Icon name="maximize-2" /> full</> : <><Icon name="minimize-2" /> tl;dr</>}
          </button>
        )}
        {(mine || isAdmin) && (
          <button className={`ago-thread-btn ago-del-btn ${armed ? "armed" : ""}`}
            title={armed ? "Click again to delete for everyone" : "Delete this message"}
            onClick={onDelete}>
            <Icon name="trash-2" /> {armed ? "sure?" : "delete"}
          </button>
        )}
      </div>
    </div>
  );

  if (m.author_type !== "agent") return bubble;
  return <div className="ago-msg-row"><AgentAvatar agentId={m.author_id} />{bubble}</div>;
}
