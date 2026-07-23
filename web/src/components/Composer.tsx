/* Composer (.chat-input): textarea with autogrow, Enter-to-send, mention
   autocomplete (@…), the "talk to" agent addressing picker, file chips
   (paste/drag/pick, 5-file cap), and the thread-ask toggle. */

import { useEffect, useRef, useState } from "react";
import { useAgents, useSendMessage, type ChannelAgent, type OutgoingFile } from "@agora/core";
import { create } from "zustand";
import { Icon } from "../lib/icons";
import { autoGrow } from "../lib/autoGrow";
import { humanSize, withToken } from "../lib/files";
import { slugify } from "../lib/mentions";
import { toast } from "../lib/toast";
import { MicButton } from "./VoiceControls";

const MAX_FILES = 5;

export interface MentionCandidate {
  type: "agent" | "user";
  id: string;
  name: string;
  slug: string;
  avatar?: string;
}

/* Per-target drafts: keyed "c:<channelId>" or "t:<rootId>". */
interface DraftState {
  drafts: Record<string, string>;
  set: (key: string, text: string) => void;
}
export const useDrafts = create<DraftState>((set) => ({
  drafts: {},
  set: (key, text) => set(s => ({ drafts: { ...s.drafts, [key]: text } })),
}));

/* "Talk to" selection per composer target (channel / thread), ephemeral. */
interface AddrState {
  addr: Record<string, string[]>;
  toggle: (key: string, agentId: string) => void;
  clear: (key: string) => void;
}
const NO_ADDR: string[] = [];

export const useAddressing = create<AddrState>((set) => ({
  addr: {},
  toggle: (key, agentId) => set(s => {
    const cur = s.addr[key] || [];
    const next = cur.includes(agentId) ? cur.filter(id => id !== agentId) : [...cur, agentId];
    const addr = { ...s.addr };
    if (next.length) addr[key] = next; else delete addr[key];
    return { addr };
  }),
  clear: (key) => set(s => {
    const addr = { ...s.addr };
    delete addr[key];
    return { addr };
  }),
}));

/* Agent avatar for composer rows (addressing chips, "Talk to" picker, mention
   popup). The lists these rows iterate may be the bare channel-agents payload
   ({id, name} — no avatar), so resolve the picture from the full /api/agents
   roster by id, exactly like vanilla's agoAgentAvatarHTML and MessageItem. */
function AgentAv({ a, cls }: { a: { id: string; avatar?: string }; cls: string }) {
  const roster = useAgents().data || [];
  const [failed, setFailed] = useState(false);
  const av = a.avatar || roster.find(r => r.id === a.id)?.avatar;
  if (av && !failed) {
    return (
      <span className={`ago-av ${cls} has-avatar`}>
        <img src={withToken(av)} alt="" onError={() => setFailed(true)} />
      </span>
    );
  }
  return <span className={`ago-av ${cls}`}><Icon name="bot" /></span>;
}

export function Composer({ channelId, channelName, threadId, agents = [], candidates = [], voiceOK, replyInThread, onToggleReplyInThread }: {
  channelId: string;
  channelName: string;
  threadId: number | null;
  /** Live member agents of the channel (addressing picker + mention list). */
  agents?: ChannelAgent[];
  /** Everything @-mentionable (agents + group members). */
  candidates?: MentionCandidate[];
  /** Server has STT/TTS (me.voice): show the mic. */
  voiceOK?: boolean;
  replyInThread?: boolean;
  onToggleReplyInThread?: () => void;
}) {
  const send = useSendMessage(channelId);
  const draftKey = threadId != null ? `t:${threadId}` : `c:${channelId}`;
  const text = useDrafts(s => s.drafts[draftKey] ?? "");
  const setText = useDrafts(s => s.set);
  const [files, setFiles] = useState<File[]>([]);
  const [mention, setMention] = useState<{ items: MentionCandidate[]; active: number; start: number } | null>(null);
  const [addrOpen, setAddrOpen] = useState(false);
  const addrSel = useAddressing(s => s.addr[draftKey] ?? NO_ADDR);
  const addrToggle = useAddressing(s => s.toggle);
  const addrClear = useAddressing(s => s.clear);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const inThread = threadId != null;
  const inputId = inThread ? "ago-thread-msg" : "ago-msg";
  const selectedAgents = addrSel
    .map(id => agents.find(a => a.id === id))
    .filter(Boolean) as ChannelAgent[];

  // Click-away closes the addressing popup (button/popup exempt).
  useEffect(() => {
    if (!addrOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest?.(".ago-addr-pop") || t.closest?.(".ago-addr-btn")) return;
      setAddrOpen(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [addrOpen]);

  const addFiles = (list: FileList | File[]) => {
    const next = [...files];
    for (const f of Array.from(list)) {
      if (next.length >= MAX_FILES) {
        toast(`Up to ${MAX_FILES} files per message`, { variant: "warn" });
        break;
      }
      next.push(f);
    }
    setFiles(next);
  };

  /* Mention autocomplete: a live "@token" ending at the caret. */
  const updateMention = (value: string, caret: number) => {
    const upToCaret = value.slice(0, caret);
    const at = upToCaret.lastIndexOf("@");
    const live = at >= 0 && (at === 0 || /\s/.test(upToCaret[at - 1])) && !/\s/.test(upToCaret.slice(at + 1));
    if (!live) { setMention(null); return; }
    const q = upToCaret.slice(at + 1).toLowerCase();
    const items = candidates.filter(c =>
      c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q));
    if (!items.length) { setMention(null); return; }
    setMention(m => ({
      items,
      active: Math.min(m?.active || 0, items.length - 1),
      start: at,
    }));
  };

  const pickMention = (i: number) => {
    const c = mention?.items[i];
    const input = taRef.current;
    if (!c || !input || !mention) { setMention(null); return; }
    const caret = input.selectionStart ?? text.length;
    const next = text.slice(0, mention.start) + "@" + c.slug + " " + text.slice(caret);
    setText(draftKey, next);
    const pos = mention.start + c.slug.length + 2;
    setMention(null);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(pos, pos);
    });
  };

  const doSend = () => {
    const t = text.trim();
    if (!t && !files.length) return;
    // "Talk to" prefix: the chosen agents' mentions route the message.
    const addr = selectedAgents.map(a => "@" + slugify(a.name)).join(", ");
    const outText = addr ? (t ? `${addr}, ${t}` : addr) : t;
    const outgoing: OutgoingFile[] = files.map(f => ({ part: f, name: f.name }));
    send.mutate(
      { text: outText, threadId, files: outgoing.length ? outgoing : undefined, replyInThread },
      { onError: e => toast("Send failed: " + (e as Error).message, { variant: "warn" }) },
    );
    setText(draftKey, "");
    setFiles([]);
    if (replyInThread && onToggleReplyInThread) onToggleReplyInThread(); // an ask covers one message
    if (taRef.current) { autoGrow(taRef.current); taRef.current.focus(); }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention) {
      const n = mention.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMention({ ...mention, active: (mention.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mention.active);
        return;
      }
      if (e.key === "Escape") { setMention(null); return; }
    }
    if (e.key === "Escape" && addrOpen) { setAddrOpen(false); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
  };

  return (
    <>
      {selectedAgents.length > 0 && (
        <div className="ago-addr-bar">
          <span className="ago-addr-label">To</span>
          {selectedAgents.map(a => (
            <span key={a.id} className="ago-addr-chip" title={`@${slugify(a.name)}`}>
              <AgentAv a={a} cls="xs" />
              <span className="aname">{a.name}</span>
              <button className="ago-x" title={`Stop addressing ${a.name}`}
                onClick={() => addrToggle(draftKey, a.id)}>
                <Icon name="x" />
              </button>
            </span>
          ))}
          <button className="ago-addr-clear" title="Address everyone in the channel again"
            onClick={() => addrClear(draftKey)}>Clear</button>
        </div>
      )}
      {files.length > 0 && (
        <div className="ago-pending">
          {files.map((f, i) => (
            <span key={i} className="ago-pending-chip" title={f.name}>
              <Icon name={(f.type || "").startsWith("image/") ? "image" : "file-text"} />
              <span className="fname">{f.name}</span>
              <span className="fsize">{humanSize(f.size)}</span>
              <button className="ago-x" title="Remove"
                onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                <Icon name="x" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="chat-input"
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault();
          if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
        }}>
        {agents.length > 0 && (
          <button className={`btn ago-addr-btn ${addrSel.length ? "active" : ""}`}
            title="Choose which agents you're talking to"
            onClick={() => setAddrOpen(!addrOpen)}>
            <Icon name="bot" />{addrSel.length ? <span className="ago-addr-count">{addrSel.length}</span> : null}
          </button>
        )}
        <textarea id={inputId} ref={taRef} rows={1}
          placeholder={inThread ? "Reply in thread…" : `Message #${channelName}`}
          title="@mention an agent to address it directly"
          value={text}
          onChange={e => {
            setText(draftKey, e.target.value);
            autoGrow(e.target);
            updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          onPaste={e => {
            const items = Array.from(e.clipboardData?.files || []);
            if (items.length) { e.preventDefault(); addFiles(items); }
          }} />
        {mention && (
          <div className="ago-mention-pop" id="ago-mention-pop">
            {mention.items.map((c, i) => (
              <div key={`${c.type}-${c.id}`}
                className={`ago-mention-opt ${i === mention.active ? "active" : ""}`}
                onMouseDown={e => { e.preventDefault(); pickMention(i); }}>
                {c.type === "agent"
                  ? <AgentAv a={c} cls="sm" />
                  : <span className="ago-av sm"><Icon name="user" /></span>}
                <span className="mname">{c.name}</span>
                <span className="mmeta">{c.type}</span>
              </div>
            ))}
          </div>
        )}
        <input ref={fileRef} type="file" multiple style={{ display: "none" }}
          onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
        <button className="btn ago-attach-btn" title="Attach files"
          onClick={() => fileRef.current?.click()}>
          <Icon name="paperclip" />
        </button>
        {voiceOK && <MicButton channelId={channelId} threadId={threadId} />}
        {!inThread && onToggleReplyInThread && (
          <button className={`btn ago-thread-ask ${replyInThread ? "active" : ""}`} id="ago-thread-ask"
            title="Agents answer this message in a thread under it"
            onClick={onToggleReplyInThread}>
            <Icon name="messages-square" />
          </button>
        )}
        <button className="btn primary" onClick={doSend}>Send</button>
        {addrOpen && (
          <div className="ago-addr-pop" id="ago-addr-pop">
            <div className="ago-addr-pop-head">
              <span>Talk to</span>
              {addrSel.length > 0 && (
                <button className="ago-addr-clear" onClick={() => addrClear(draftKey)}>Clear</button>
              )}
            </div>
            {agents.length ? agents.map(a => {
              const on = addrSel.includes(a.id);
              return (
                <div key={a.id} className={`ago-addr-opt ${on ? "selected" : ""}`} role="option"
                  aria-selected={on} onClick={() => addrToggle(draftKey, a.id)}>
                  <AgentAv a={a} cls="sm" />
                  <span className="mname">{a.name}</span>
                  <span className="ago-addr-check">{on ? <Icon name="check" /> : null}</span>
                </div>
              );
            }) : <div className="ago-addr-empty">No agents in this channel yet.</div>}
          </div>
        )}
      </div>
    </>
  );
}
